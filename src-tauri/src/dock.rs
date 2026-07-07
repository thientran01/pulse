/*
 * Corner docking: the widget always rests in one of the four corners of the
 * monitor's work area (above the taskbar, MARGIN_LOGICAL from the edges).
 * Drags stay free; on release the window glides to the nearest corner. Mode
 * resizes grow/shrink out of the docked corner — size and position move in
 * the same SetWindowPos each frame (Tauri's setSize/setPosition pair paints
 * one frame at the wrong anchor).
 *
 * Corner persistence is derived, not stored: tauri-plugin-window-state
 * restores the last position, and the first positioning call (or the launch
 * Moved event) snaps to whichever corner that position is nearest — which
 * also self-heals positions persisted on a now-disconnected monitor.
 */
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Mutex, PoisonError};
use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager, State, WebviewWindow, Window};
use windows::core::BOOL;
use windows::Win32::Foundation::HWND;
use windows::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_LBUTTON, VK_RBUTTON};
use windows::Win32::UI::WindowsAndMessaging::{
    GetSystemMetrics, SetWindowPos, SystemParametersInfoW, SET_WINDOW_POS_FLAGS, SM_SWAPBUTTON,
    SPI_GETCLIENTAREAANIMATION, SWP_NOACTIVATE, SWP_NOSIZE, SWP_NOZORDER,
    SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS,
};

/// Gap between the window and the work-area edges, in logical px.
const MARGIN_LOGICAL: f64 = 12.0;
/// Snap-glide duration = DUR[3] in src/lib/tokens.ts. Keep in sync.
const SNAP_MS: u64 = 200;
/// A drag is considered released once Moved events go quiet this long.
const DEBOUNCE_MS: u64 = 200;
/// Animation frame pacing.
const FRAME_MS: u64 = 8;
/// Drag-release watcher poll interval.
const WATCH_MS: u64 = 60;

#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Corner {
    TopLeft,
    TopRight,
    BottomLeft,
    BottomRight,
}

pub struct Dock {
    /// Where resizes anchor. None until first derived from the restored position.
    corner: Mutex<Option<Corner>>,
    /// Every positioning op bumps this first; a stale snap animation dies on
    /// its next frame. Last write wins — no queue.
    epoch: AtomicU64,
    /// Set around self-inflicted moves so on_moved ignores them.
    animating: AtomicBool,
    last_moved: Mutex<Instant>,
    /// One debounce watcher at a time.
    watcher_armed: AtomicBool,
}

impl Default for Dock {
    fn default() -> Self {
        Self {
            corner: Mutex::new(None),
            epoch: AtomicU64::new(0),
            animating: AtomicBool::new(false),
            last_moved: Mutex::new(Instant::now()),
            watcher_armed: AtomicBool::new(false),
        }
    }
}

/// Work area (monitor minus taskbar) in physical px: (x, y, w, h).
struct WorkArea {
    x: i32,
    y: i32,
    w: i32,
    h: i32,
}

/// Work area of the window's monitor, falling back to the primary monitor —
/// a position persisted on a now-disconnected monitor must still resolve
/// somewhere visible so the corner math can pull the window back on-screen.
fn work_area(window: &WebviewWindow) -> Option<WorkArea> {
    let monitor = window
        .current_monitor()
        .ok()
        .flatten()
        .or_else(|| window.primary_monitor().ok().flatten())?;
    let r = monitor.work_area();
    Some(WorkArea {
        x: r.position.x,
        y: r.position.y,
        w: r.size.width as i32,
        h: r.size.height as i32,
    })
}

fn nearest_corner(cx: i32, cy: i32, wa: &WorkArea) -> Corner {
    let right = cx >= wa.x + wa.w / 2;
    let bottom = cy >= wa.y + wa.h / 2;
    match (right, bottom) {
        (false, false) => Corner::TopLeft,
        (true, false) => Corner::TopRight,
        (false, true) => Corner::BottomLeft,
        (true, true) => Corner::BottomRight,
    }
}

/// Physical top-left that puts a w×h window in `corner` of `wa`. When the
/// window outgrows the work area, keep the top-left reachable (chromeless
/// window — the drag surface must stay on-screen) and accept overflow.
fn corner_origin(corner: Corner, wa: &WorkArea, w: i32, h: i32, margin: i32) -> (i32, i32) {
    let x = match corner {
        Corner::TopLeft | Corner::BottomLeft => wa.x + margin,
        Corner::TopRight | Corner::BottomRight => wa.x + wa.w - w - margin,
    };
    let y = match corner {
        Corner::TopLeft | Corner::TopRight => wa.y + margin,
        Corner::BottomLeft | Corner::BottomRight => wa.y + wa.h - h - margin,
    };
    (x.max(wa.x), y.max(wa.y))
}

/// One SetWindowPos: move, or move+resize when `size` is given.
fn apply_pos(window: &WebviewWindow, x: i32, y: i32, size: Option<(i32, i32)>) {
    let Ok(hwnd) = window.hwnd() else { return };
    let hwnd = HWND(hwnd.0);
    let mut flags: SET_WINDOW_POS_FLAGS = SWP_NOZORDER | SWP_NOACTIVATE;
    if size.is_none() {
        flags |= SWP_NOSIZE;
    }
    let (cx, cy) = size.unwrap_or((0, 0));
    unsafe {
        let _ = SetWindowPos(hwnd, None, x, y, cx, cy, flags);
    }
}

/// Physical state of the primary mouse button (drag may still be in flight).
/// GetAsyncKeyState reports physical buttons — respect SM_SWAPBUTTON so a
/// left-handed mouse (dragging with physical-right) is read correctly.
fn primary_button_down() -> bool {
    unsafe {
        let swapped = GetSystemMetrics(SM_SWAPBUTTON) != 0;
        let vk = if swapped { VK_RBUTTON } else { VK_LBUTTON };
        (GetAsyncKeyState(vk.0 as i32) as u16 & 0x8000) != 0
    }
}

/// OS "animate controls and elements" toggle — the reduced-motion signal the
/// frontend also honors. Off → snaps jump instead of gliding.
fn snap_animation_enabled() -> bool {
    let mut on = BOOL(1);
    unsafe {
        let _ = SystemParametersInfoW(
            SPI_GETCLIENTAREAANIMATION,
            0,
            Some(&mut on as *mut _ as *mut core::ffi::c_void),
            SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS(0),
        );
    }
    on.as_bool()
}

/// Evaluate cubic-bezier(x1, y1, x2, y2) at time-fraction `p` by bisection on
/// the x-spline. Control points mirror EASE in src/lib/tokens.ts — keep in sync.
fn cubic_bezier(x1: f64, y1: f64, x2: f64, y2: f64, p: f64) -> f64 {
    fn bez(a: f64, b: f64, t: f64) -> f64 {
        3.0 * a * t * (1.0 - t) * (1.0 - t) + 3.0 * b * t * t * (1.0 - t) + t * t * t
    }
    if p <= 0.0 {
        return 0.0;
    }
    if p >= 1.0 {
        return 1.0;
    }
    let (mut lo, mut hi) = (0.0_f64, 1.0_f64);
    for _ in 0..24 {
        let mid = (lo + hi) / 2.0;
        if bez(x1, x2, mid) < p {
            lo = mid;
        } else {
            hi = mid;
        }
    }
    bez(y1, y2, (lo + hi) / 2.0)
}

/// EASE.out — for the drag-release snap: a direct response to letting go, it
/// starts fast to read as inheriting the drag's momentum (iOS-PiP-style).
/// Deliberately NOT used for the mode resize.
fn ease_out(p: f64) -> f64 {
    cubic_bezier(0.16, 1.0, 0.3, 1.0, p)
}

/// EASE.inOut — for the mode resize: a morph of an element already on screen
/// (Emil's framework: morph → ease-in-out; ease-out reads as "shoved open").
fn ease_in_out(p: f64) -> f64 {
    cubic_bezier(0.65, 0.0, 0.35, 1.0, p)
}

/// Glide the window to `target` over SNAP_MS with the EASE.out curve.
/// Cancelled (mid-flight, no landing) when any other positioning op bumps the
/// epoch.
fn animate_to(window: &WebviewWindow, from: (i32, i32), target: (i32, i32)) {
    let dock = window.state::<Dock>();
    let (dx, dy) = (target.0 - from.0, target.1 - from.1);
    if dx * dx + dy * dy <= 4 {
        // Too close to glide — but this is still a positioning op: cancel any
        // older in-flight animation and suppress the self-inflicted Moved.
        dock.epoch.fetch_add(1, Ordering::SeqCst);
        if (dx, dy) != (0, 0) {
            dock.animating.store(true, Ordering::SeqCst);
            apply_pos(window, target.0, target.1, None);
            dock.animating.store(false, Ordering::SeqCst);
        }
        return;
    }
    spawn_animation(window, ease_out, move |win, e| {
        let x = from.0 + (dx as f64 * e).round() as i32;
        let y = from.1 + (dy as f64 * e).round() as i32;
        apply_pos(win, x, y, None);
    });
}

/// Drive `frame(window, eased_fraction)` at FRAME_MS over SNAP_MS with the
/// given easing. The frame closure applies the geometry for its fraction;
/// `frame(_, 1.0)` must land exactly on the target. Dies mid-flight (no
/// landing) when another positioning op bumps the epoch; jumps straight to
/// 1.0 under reduced motion.
fn spawn_animation(
    window: &WebviewWindow,
    ease: fn(f64) -> f64,
    frame: impl Fn(&WebviewWindow, f64) + Send + 'static,
) {
    let dock = window.state::<Dock>();
    let my_epoch = dock.epoch.fetch_add(1, Ordering::SeqCst) + 1;
    dock.animating.store(true, Ordering::SeqCst);
    let window = window.clone();
    std::thread::spawn(move || {
        let dock = window.state::<Dock>();
        if snap_animation_enabled() {
            let start = Instant::now();
            loop {
                std::thread::sleep(Duration::from_millis(FRAME_MS));
                if dock.epoch.load(Ordering::SeqCst) != my_epoch {
                    // Superseded by a drag or resize — stop where we are.
                    dock.animating.store(false, Ordering::SeqCst);
                    return;
                }
                // Progress from wall-clock, not frame count: Windows timer
                // granularity (~15.6ms) drops frames instead of slowing down.
                let t = (start.elapsed().as_secs_f64() * 1000.0 / SNAP_MS as f64).min(1.0);
                frame(&window, ease(t));
                if t >= 1.0 {
                    break;
                }
            }
        } else {
            frame(&window, 1.0);
        }
        dock.animating.store(false, Ordering::SeqCst);
    });
}

/// Dock to the nearest work-area corner from the current position.
fn snap_to_nearest(window: &WebviewWindow) {
    let dock = window.state::<Dock>();
    let Some(wa) = work_area(window) else { return };
    let (Ok(pos), Ok(size)) = (window.outer_position(), window.outer_size()) else {
        return;
    };
    let (w, h) = (size.width as i32, size.height as i32);
    let corner = nearest_corner(pos.x + w / 2, pos.y + h / 2, &wa);
    *dock.corner.lock().unwrap_or_else(PoisonError::into_inner) = Some(corner);
    let scale = window.scale_factor().unwrap_or(1.0);
    let margin = (MARGIN_LOGICAL * scale).round() as i32;
    let target = corner_origin(corner, &wa, w, h, margin);
    animate_to(window, (pos.x, pos.y), target);
}

/// Resize to the mode's logical size, growing/shrinking out of the docked
/// corner — per-frame the size interpolates and the origin is re-derived from
/// the corner, so the anchored edges stay pixel-fixed while the container
/// visibly changes size. First call after launch derives the corner from
/// wherever window-state restored us — that IS the startup snap.
#[tauri::command]
pub fn set_window_size(window: WebviewWindow, dock: State<Dock>, width: f64, height: f64) {
    dock.epoch.fetch_add(1, Ordering::SeqCst); // cancel any in-flight animation
    let Some(wa) = work_area(&window) else {
        // No monitor info at all — still honor the size so the native window
        // matches the React layout; position keeps its last value.
        let _ = window.set_size(tauri::LogicalSize::new(width, height));
        return;
    };
    let scale = window.scale_factor().unwrap_or(1.0);
    let w = (width * scale).round() as i32;
    let h = (height * scale).round() as i32;
    let margin = (MARGIN_LOGICAL * scale).round() as i32;
    let from = window.outer_size().unwrap_or(tauri::PhysicalSize::new(w as u32, h as u32));
    let (w0, h0) = (from.width as i32, from.height as i32);
    let corner = {
        let mut c = dock.corner.lock().unwrap_or_else(PoisonError::into_inner);
        *c.get_or_insert_with(|| match window.outer_position() {
            Ok(pos) => nearest_corner(pos.x + w0 / 2, pos.y + h0 / 2, &wa),
            Err(_) => Corner::BottomRight,
        })
    };
    if (w0, h0) == (w, h) {
        // Same size (launch, usually) — just make sure we're docked.
        let (x, y) = corner_origin(corner, &wa, w, h, margin);
        dock.animating.store(true, Ordering::SeqCst);
        apply_pos(&window, x, y, Some((w, h)));
        dock.animating.store(false, Ordering::SeqCst);
        return;
    }
    spawn_animation(&window, ease_in_out, move |win, e| {
        let wi = (w0 as f64 + (w - w0) as f64 * e).round() as i32;
        let hi = (h0 as f64 + (h - h0) as f64 * e).round() as i32;
        let (xi, yi) = corner_origin(corner, &wa, wi, hi, margin);
        apply_pos(win, xi, yi, Some((wi, hi)));
    });
}

/// Native drag, killing any in-flight snap first so it can't fight the hand.
#[tauri::command]
pub fn start_drag(window: WebviewWindow, dock: State<Dock>) {
    dock.epoch.fetch_add(1, Ordering::SeqCst);
    let _ = window.start_dragging();
}

/// Wire from Builder::on_window_event for WindowEvent::Moved. Native drags
/// give no end signal (the webview never sees mouseup), so: debounce the
/// Moved stream, and only snap once the primary button is also up — a drag
/// held still mid-air keeps waiting.
pub fn on_moved(window: &Window) {
    let dock = window.state::<Dock>();
    if dock.animating.load(Ordering::SeqCst) {
        return; // self-inflicted move
    }
    *dock.last_moved.lock().unwrap_or_else(PoisonError::into_inner) = Instant::now();
    if dock
        .watcher_armed
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_ok()
    {
        let window = window.clone();
        std::thread::spawn(move || {
            let dock = window.state::<Dock>();
            loop {
                std::thread::sleep(Duration::from_millis(WATCH_MS));
                let last = *dock.last_moved.lock().unwrap_or_else(PoisonError::into_inner);
                if last.elapsed() < Duration::from_millis(DEBOUNCE_MS) {
                    continue; // still moving
                }
                if primary_button_down() {
                    continue; // drag paused mid-air
                }
                break;
            }
            dock.watcher_armed.store(false, Ordering::SeqCst);
            // Geometry lives on WebviewWindow (Window-level APIs are behind
            // tauri's `unstable` feature) — resolve it by label.
            if let Some(wv) = window.get_webview_window(window.label()) {
                snap_to_nearest(&wv);
            }
        });
    }
}

/// Tray recovery: show and re-dock to the bottom-right of the current
/// monitor. Launch snapping already heals disconnected-monitor positions;
/// this is the manual belt-and-braces path.
pub fn reset_position(app: &AppHandle) {
    let Some(window) = app.get_webview_window("main") else { return };
    let _ = window.show();
    let dock = app.state::<Dock>();
    *dock.corner.lock().unwrap_or_else(PoisonError::into_inner) = Some(Corner::BottomRight);
    let Some(wa) = work_area(&window) else { return };
    let (Ok(pos), Ok(size)) = (window.outer_position(), window.outer_size()) else {
        return;
    };
    let scale = window.scale_factor().unwrap_or(1.0);
    let margin = (MARGIN_LOGICAL * scale).round() as i32;
    let target = corner_origin(
        Corner::BottomRight,
        &wa,
        size.width as i32,
        size.height as i32,
        margin,
    );
    animate_to(&window, (pos.x, pos.y), target);
}
