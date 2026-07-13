/*
 * Corner docking: the widget anchors to one of the four corners of the
 * monitor's work area, but the OFFSET is free — the corner is a gravity
 * well, not a cage. Drags stay free; on release the nearest corner is
 * derived (it stays the anchor IDENTITY: shell-seat glide direction,
 * hit-rect anchor, queue popover direction all key on it, and all anchor
 * to the corner of the WINDOW rect, so they work at any position). A drop
 * within MAGNET_PX of the canonical seat glides home; a drop within
 * RAIL_PX of a seat coordinate settles that axis onto the margin rail;
 * anywhere else the drop stands, clamped on-screen. The same settle rule
 * classifies the restored position at launch: near a seat → re-seat
 * (heals DPI drift and disconnected monitors, exactly the old behavior),
 * else the free position survives — the magnet radius IS the
 * snapped-vs-free classifier, so no persisted bit can drift out of sync.
 *
 * The fullscreen seat: while settled fullscreen content owns the WIDGET's
 * monitor (presence.rs's monitor-scoped verdict — never the global QUNS
 * states, which can't say WHICH monitor), the widget re-seats against the
 * FULL MONITOR RECT: the taskbar is covered, and work-area seats float a
 * taskbar-height too high over game HUDs. The fullscreen position is its
 * own remembered seat (drags mid-episode update it; persisted
 * corner-relative in settings.json as "fsSeat" so resolution changes
 * adapt); the episode ending restores the exact desktop position — the
 * same episode/restore grammar as the courtesy conceal.
 *
 * The window NEVER RESIZES after launch: it is born at the largest mode's
 * size (tauri.conf.json = App.tsx WINDOW_MAX) and every mode change is the
 * shell's CSS glide inside it. Resizing a WebView2 window at all costs one
 * wrong frame — the rect updates synchronously while the composited content
 * lags a frame behind, so a per-frame animated resize shakes the whole UI
 * (measured, v0.5.0) and even a single snap blinks it (measured, PR #51) —
 * an origin-moving resize has no artifact-free ordering. Pure MOVES are
 * exempt (content rides the translation rigidly), which is why the
 * drag-release glide stays native. The price of the oversized window is
 * that its transparent gutter would eat clicks meant for whatever is
 * beneath; spawn_hit_watcher makes everything outside the frontend-reported
 * interactive rect click-through.
 *
 * Corner persistence is derived, not stored: tauri-plugin-window-state
 * restores the last position, and the first positioning call (or the launch
 * Moved event) settles it — which also self-heals positions persisted on a
 * now-disconnected monitor.
 */
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Mutex, PoisonError};
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow, Window};
use windows::core::BOOL;
use windows::Win32::Foundation::HWND;
use windows::Win32::Media::{timeBeginPeriod, timeEndPeriod};
use windows::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_LBUTTON, VK_RBUTTON};
use windows::Win32::UI::WindowsAndMessaging::{
    GetCursorPos, GetSystemMetrics, SetWindowPos, SystemParametersInfoW, SET_WINDOW_POS_FLAGS,
    SM_SWAPBUTTON, SPI_GETCLIENTAREAANIMATION, SWP_NOACTIVATE, SWP_NOCOPYBITS, SWP_NOSIZE,
    SWP_NOZORDER, SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS,
};

/// Gap between the window and the work-area edges, in logical px.
const MARGIN_LOGICAL: f64 = 12.0;
/// Free placement: a drop within this of the canonical corner seat glides
/// home. Doubles as the launch-time snapped-vs-free classifier — one rule,
/// two sites, so they can't disagree.
const MAGNET_PX: f64 = 80.0;
/// A free drop within this of a seat coordinate settles that axis onto the
/// margin rail (per-axis; must stay < MAGNET_PX so the magnet wins near a
/// full seat). Near-edge drops end up tidy-aligned; mid-screen drops stand.
const RAIL_PX: f64 = 24.0;
/// Snap-glide duration = DUR[3] in src/lib/tokens.ts. Keep in sync.
const SNAP_MS: u64 = 200;
/// A drag is considered released once Moved events go quiet this long.
const DEBOUNCE_MS: u64 = 200;
/// Animation frame pacing.
const FRAME_MS: u64 = 8;
/// Drag-release watcher poll interval.
const WATCH_MS: u64 = 60;
/// Hit watcher cadence: fast while the cursor is near the window (the gate
/// must flip before a click can land), relaxed when it's far away.
const HIT_NEAR_MS: u64 = 8;
const HIT_FAR_MS: u64 = 40;
/// "Near" halo around the window rect that switches the fast cadence on.
const HIT_NEAR_PAD: i32 = 64;

#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Corner {
    TopLeft,
    TopRight,
    BottomLeft,
    BottomRight,
}

impl Corner {
    fn as_str(self) -> &'static str {
        match self {
            Corner::TopLeft => "top-left",
            Corner::TopRight => "top-right",
            Corner::BottomLeft => "bottom-left",
            Corner::BottomRight => "bottom-right",
        }
    }

    /// Inverse of as_str, for the persisted fullscreen seat.
    fn from_str(s: &str) -> Option<Self> {
        match s {
            "top-left" => Some(Corner::TopLeft),
            "top-right" => Some(Corner::TopRight),
            "bottom-left" => Some(Corner::BottomLeft),
            "bottom-right" => Some(Corner::BottomRight),
            _ => None,
        }
    }
}

/// Which rect corner math runs against: the work area on the desktop; the
/// full monitor rect during a fullscreen episode (the taskbar is covered).
#[derive(Clone, Copy, PartialEq)]
enum Space {
    Desktop,
    Fullscreen,
}

/// The remembered fullscreen position, as a logical offset from its corner's
/// canonical monitor-rect seat — corner-relative so resolution/DPI changes
/// re-resolve instead of landing off-screen.
#[derive(Clone, Copy)]
struct FsSeat {
    corner: Corner,
    dx: f64,
    dy: f64,
}

impl FsSeat {
    fn to_json(self) -> Value {
        json!({ "corner": self.corner.as_str(), "dx": self.dx, "dy": self.dy })
    }

    fn from_json(v: &Value) -> Option<Self> {
        Some(FsSeat {
            corner: Corner::from_str(v.get("corner")?.as_str()?)?,
            dx: v.get("dx")?.as_f64()?,
            dy: v.get("dy")?.as_f64()?,
        })
    }
}

/// Tell the webview which corner resizes grow out of: App.tsx seats the
/// gliding shell (SHELL_SEAT) and its fixed content plane (CORNER_SEAT)
/// there, so the glide radiates out of the one corner that never moves —
/// anchoring anywhere else puts the content on a MOVING edge and it rides
/// the resize instead of being revealed by it. Fired wherever the corner is
/// derived or re-set; the frontend seeds via the dock_corner command against
/// the listener-attach race.
fn emit_corner(window: &WebviewWindow, corner: Corner) {
    let _ = window.emit("dock-corner", corner.as_str());
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
    /// The interactive footprint (logical px, anchored at the docked
    /// corner) the frontend reports per mode — everything outside it is
    /// click-through. None (pre-report) = the whole window is interactive.
    hit_size: Mutex<Option<(f64, f64)>>,
    /// Presence's monitor-scoped verdict: fullscreen content owns the
    /// widget's monitor. What sync_seat reconciles toward.
    want_fs: AtomicBool,
    /// The seat currently applied — diverges from want_fs only while a swap
    /// is deferred (mid-press) and the presence tick hasn't retried yet.
    seated_fs: AtomicBool,
    /// Exact position + corner at fullscreen-episode start, restored
    /// verbatim (clamped) when the episode ends.
    desktop_return: Mutex<Option<((i32, i32), Corner)>>,
    /// The remembered fullscreen seat (settings.json "fsSeat"). None →
    /// first episode defaults to the same corner against the monitor rect.
    fs_seat: Mutex<Option<FsSeat>>,
    /// Serializes sync_seat end to end: it's reachable from the presence
    /// tick AND from apply_visibility (hotkey/tray/any thread), and two
    /// callers both past the want==seated check would double-capture
    /// desktop_return — the second one reading a position the first
    /// already moved (3-agent quick-review convergence, 2026-07-12).
    seat_gate: Mutex<()>,
    /// A "desktopReturn" persisted by a quit mid-episode, stashed by init
    /// (logical px) for set_window_size to settle instead of the
    /// window-state position — which IS the fullscreen seat in that case.
    launch_pos: Mutex<Option<(f64, f64)>>,
}

impl Default for Dock {
    fn default() -> Self {
        Self {
            corner: Mutex::new(None),
            epoch: AtomicU64::new(0),
            animating: AtomicBool::new(false),
            last_moved: Mutex::new(Instant::now()),
            watcher_armed: AtomicBool::new(false),
            hit_size: Mutex::new(None),
            want_fs: AtomicBool::new(false),
            seated_fs: AtomicBool::new(false),
            desktop_return: Mutex::new(None),
            fs_seat: Mutex::new(None),
            seat_gate: Mutex::new(()),
            launch_pos: Mutex::new(None),
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

/// The window's monitor rect for the given space (work area on the desktop,
/// full monitor rect during a fullscreen episode), falling back to the
/// primary monitor — a position persisted on a now-disconnected monitor must
/// still resolve somewhere visible so the settle math can pull the window
/// back on-screen.
fn space_rect(window: &WebviewWindow, space: Space) -> Option<WorkArea> {
    let monitor = window
        .current_monitor()
        .ok()
        .flatten()
        .or_else(|| window.primary_monitor().ok().flatten())?;
    Some(match space {
        Space::Desktop => {
            let r = monitor.work_area();
            WorkArea {
                x: r.position.x,
                y: r.position.y,
                w: r.size.width as i32,
                h: r.size.height as i32,
            }
        }
        Space::Fullscreen => WorkArea {
            x: monitor.position().x,
            y: monitor.position().y,
            w: monitor.size().width as i32,
            h: monitor.size().height as i32,
        },
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
    } else {
        // A sized snap moves the origin; letting the OS re-present the stale
        // client bits translated to the new origin would flash the whole UI
        // displaced for a frame. Discarding them shows (transparent) nothing
        // for that frame instead — invisible on a transparent window.
        flags |= SWP_NOCOPYBITS;
    }
    let (cx, cy) = size.unwrap_or((0, 0));
    unsafe {
        let _ = SetWindowPos(hwnd, None, x, y, cx, cy, flags);
    }
}

/// One instant positioning op: epoch bump (kills any in-flight glide) +
/// animating guard around a single move. For moves the user can't watch
/// (the window is hidden) — visible moves glide via animate_to.
fn jump_to(window: &WebviewWindow, x: i32, y: i32) {
    let dock = window.state::<Dock>();
    dock.epoch.fetch_add(1, Ordering::SeqCst);
    dock.animating.store(true, Ordering::SeqCst);
    apply_pos(window, x, y, None);
    dock.animating.store(false, Ordering::SeqCst);
}

/// Center of the VISIBLE footprint (the current mode's hit rect, anchored at
/// the docked corner of the window rect) in physical px. The oversized
/// WINDOW_MAX window's center misleads the nearest-corner call by up to half
/// the gutter — a pill dropped just past the work-area midline could snap
/// the wrong way when judged by the window center. Falls back to the window
/// center before the first hit-size report (launch).
fn footprint_center(window: &WebviewWindow, pos: (i32, i32), size: (i32, i32)) -> (i32, i32) {
    let dock = window.state::<Dock>();
    let (wx, wy) = pos;
    let (ww, wh) = size;
    let hit = *dock.hit_size.lock().unwrap_or_else(PoisonError::into_inner);
    match hit {
        None => (wx + ww / 2, wy + wh / 2),
        Some((hw, hh)) => {
            let scale = window.scale_factor().unwrap_or(1.0);
            let hw = ((hw * scale).round() as i32).min(ww);
            let hh = ((hh * scale).round() as i32).min(wh);
            let corner = dock
                .corner
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .unwrap_or(Corner::BottomRight);
            let (l, t) = match corner {
                Corner::TopLeft => (wx, wy),
                Corner::TopRight => (wx + ww - hw, wy),
                Corner::BottomLeft => (wx, wy + wh - hh),
                Corner::BottomRight => (wx + ww - hw, wy + wh - hh),
            };
            (l + hw / 2, t + hh / 2)
        }
    }
}

/// Clamp an origin so the w×h window sits inside `rect`, keeping the
/// top-left reachable when the window outgrows it (mirrors corner_origin's
/// rule — the chromeless drag surface must stay on-screen).
fn clamp_origin(pos: (i32, i32), rect: &WorkArea, w: i32, h: i32) -> (i32, i32) {
    (
        pos.0.clamp(rect.x, (rect.x + rect.w - w).max(rect.x)),
        pos.1.clamp(rect.y, (rect.y + rect.h - h).max(rect.y)),
    )
}

/// The settle decision for a released (or launch-restored) position: derive
/// the corner identity from `center`, clamp the window into `rect`, then
/// apply the corner magnet and the per-axis edge rails. Pure — callers apply
/// the returned corner + target.
fn settle_target(
    center: (i32, i32),
    pos: (i32, i32),
    size: (i32, i32),
    rect: &WorkArea,
    scale: f64,
) -> (Corner, (i32, i32)) {
    let (w, h) = size;
    let margin = (MARGIN_LOGICAL * scale).round() as i32;
    let corner = nearest_corner(center.0, center.1, rect);
    let seat = corner_origin(corner, rect, w, h, margin);
    // Clamp first: a half-off-screen drop lands flush, and its now-margin-off
    // distance is the rails' problem below.
    let (x, y) = clamp_origin(pos, rect, w, h);
    // Magnet: near the canonical seat, glide home — the anchor's convenience.
    let (dx, dy) = ((x - seat.0) as i64, (y - seat.1) as i64);
    let magnet = (MAGNET_PX * scale).round() as i64;
    if dx * dx + dy * dy <= magnet * magnet {
        return (corner, seat);
    }
    // Rails: per-axis, the seat coordinate IS the margin rail on the
    // corner's side — a near-edge drop settles flush instead of a few px off.
    let rail = (RAIL_PX * scale).round() as i32;
    let x = if (x - seat.0).abs() <= rail { seat.0 } else { x };
    let y = if (y - seat.1).abs() <= rail { seat.1 } else { y };
    (corner, (x, y))
}

/// Physical state of the primary mouse button (drag may still be in flight).
/// GetAsyncKeyState reports physical buttons — respect SM_SWAPBUTTON so a
/// left-handed mouse (dragging with physical-right) is read correctly.
/// pub(crate): the presence conceal also defers while a press is in flight
/// (hiding the window mid-drag would yank it out from under the hand).
pub(crate) fn primary_button_down() -> bool {
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
/// (The mode resize's EASE.inOut lives in the webview now — the shell's CSS
/// glide — since the window side of a mode change is a single snap.)
fn ease_out(p: f64) -> f64 {
    cubic_bezier(0.16, 1.0, 0.3, 1.0, p)
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
            // Default Windows timer resolution rounds thread::sleep(8ms) up
            // to ~15.6ms, landing ~13 UNEVEN frames across the 200ms window —
            // the mid-curve (fastest) stretch jumps in irregular steps and
            // the motion reads as lunge-then-settle instead of one glide.
            // 1ms resolution for the animation's lifetime makes the 8ms
            // cadence real; wall-clock progress below stays the correctness
            // backstop for any frame the OS still delays.
            unsafe {
                let _ = timeBeginPeriod(1);
            }
            let start = Instant::now();
            loop {
                std::thread::sleep(Duration::from_millis(FRAME_MS));
                if dock.epoch.load(Ordering::SeqCst) != my_epoch {
                    // Superseded by a drag or resize — stop where we are.
                    dock.animating.store(false, Ordering::SeqCst);
                    unsafe {
                        let _ = timeEndPeriod(1);
                    }
                    return;
                }
                // Progress from wall-clock, not frame count: a delayed frame
                // skips ahead instead of slowing the animation down.
                let t = (start.elapsed().as_secs_f64() * 1000.0 / SNAP_MS as f64).min(1.0);
                frame(&window, ease(t));
                if t >= 1.0 {
                    break;
                }
            }
            unsafe {
                let _ = timeEndPeriod(1);
            }
        } else {
            frame(&window, 1.0);
        }
        dock.animating.store(false, Ordering::SeqCst);
    });
}

/// Settle a released drag: derive the corner, run the magnet/rails/clamp
/// decision, glide there. During a fullscreen episode the settle runs
/// against the monitor rect and the landing becomes the remembered
/// fullscreen seat (the desktop position waits in desktop_return).
fn settle_release(window: &WebviewWindow) {
    let dock = window.state::<Dock>();
    let space = if dock.seated_fs.load(Ordering::SeqCst) {
        Space::Fullscreen
    } else {
        Space::Desktop
    };
    let Some(rect) = space_rect(window, space) else { return };
    let (Ok(pos), Ok(size)) = (window.outer_position(), window.outer_size()) else {
        return;
    };
    let (w, h) = (size.width as i32, size.height as i32);
    let center = footprint_center(window, (pos.x, pos.y), (w, h));
    let scale = window.scale_factor().unwrap_or(1.0);
    let (corner, target) = settle_target(center, (pos.x, pos.y), (w, h), &rect, scale);
    *dock.corner.lock().unwrap_or_else(PoisonError::into_inner) = Some(corner);
    emit_corner(window, corner);
    if space == Space::Fullscreen {
        // The landing is the new fullscreen seat: remember it corner-relative
        // (logical) and persist. File IO is fine here — this runs on the
        // drag-release watcher thread, never the main thread.
        let margin = (MARGIN_LOGICAL * scale).round() as i32;
        let seat = corner_origin(corner, &rect, w, h, margin);
        let fs = FsSeat {
            corner,
            dx: (target.0 - seat.0) as f64 / scale,
            dy: (target.1 - seat.1) as f64 / scale,
        };
        *dock.fs_seat.lock().unwrap_or_else(PoisonError::into_inner) = Some(fs);
        crate::settings::set_value(window.app_handle(), "fsSeat", fs.to_json());
    }
    animate_to(window, (pos.x, pos.y), target);
}

/// Load the persisted fullscreen seat, and consume any "desktopReturn"
/// left by a quit mid-episode — window-state persisted the FULLSCREEN
/// position then, and settling that as the launch position would silently
/// replace a free desktop placement. Call once from setup (file IO belongs
/// here, not in the sync set_window_size command — main-thread rule).
pub fn init(app: &AppHandle) {
    let dock = app.state::<Dock>();
    if let Some(seat) = crate::settings::get_value(app, "fsSeat")
        .as_ref()
        .and_then(FsSeat::from_json)
    {
        *dock.fs_seat.lock().unwrap_or_else(PoisonError::into_inner) = Some(seat);
    }
    if let Some(v) = crate::settings::get_value(app, "desktopReturn") {
        if let (Some(x), Some(y)) = (
            v.get("x").and_then(Value::as_f64),
            v.get("y").and_then(Value::as_f64),
        ) {
            *dock.launch_pos.lock().unwrap_or_else(PoisonError::into_inner) = Some((x, y));
        }
        if !v.is_null() {
            crate::settings::set_value(app, "desktopReturn", Value::Null);
        }
    }
}

/// Presence's monitor-scoped fullscreen verdict feeds the seat context.
/// Idempotent — presence calls it every tick, which doubles as the retry
/// for a swap deferred mid-press.
pub fn set_fullscreen_context(app: &AppHandle, on: bool) {
    app.state::<Dock>().want_fs.store(on, Ordering::SeqCst);
    sync_seat(app);
}

/// Reconcile the window to the wanted seat context (the positioning sibling
/// of apply_visibility). Entering a fullscreen episode: remember the exact
/// desktop position, take the remembered fullscreen seat (or the same
/// corner against the monitor rect when none). Leaving: restore the desktop
/// position verbatim, clamped — the resolution may have changed mid-episode.
/// Hidden windows jump instantly (a glide nobody sees just delays the hit
/// rect); visible ones glide. Deferred (not skipped) while a press is in
/// flight — moving the window mid-drag would yank it out from under the
/// hand, the conceal's exact rule.
pub fn sync_seat(app: &AppHandle) {
    let Some(window) = app.get_webview_window("main") else { return };
    let dock = app.state::<Dock>();
    // One reconciler at a time — see the seat_gate field doc.
    let _gate = dock.seat_gate.lock().unwrap_or_else(PoisonError::into_inner);
    let want = dock.want_fs.load(Ordering::SeqCst);
    if want == dock.seated_fs.load(Ordering::SeqCst) {
        return;
    }
    let visible = window.is_visible().unwrap_or(false);
    if visible && primary_button_down() {
        return; // defer: the next presence tick retries
    }
    let (Ok(pos), Ok(size)) = (window.outer_position(), window.outer_size()) else {
        return;
    };
    let (w, h) = (size.width as i32, size.height as i32);
    let scale = window.scale_factor().unwrap_or(1.0);
    let margin = (MARGIN_LOGICAL * scale).round() as i32;

    let (corner, target) = if want {
        let cur_corner = dock
            .corner
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .unwrap_or(Corner::BottomRight);
        *dock
            .desktop_return
            .lock()
            .unwrap_or_else(PoisonError::into_inner) = Some(((pos.x, pos.y), cur_corner));
        // Mirror it to disk (logical px) for the quit-mid-episode case:
        // window-state would persist the FULLSCREEN position as the launch
        // position, silently replacing a free desktop placement — init +
        // set_window_size consume this instead.
        crate::settings::set_value(
            app,
            "desktopReturn",
            json!({ "x": pos.x as f64 / scale, "y": pos.y as f64 / scale }),
        );
        let Some(rect) = space_rect(&window, Space::Fullscreen) else { return };
        match *dock.fs_seat.lock().unwrap_or_else(PoisonError::into_inner) {
            Some(s) => {
                let seat = corner_origin(s.corner, &rect, w, h, margin);
                // saturating: dx/dy come from a hand-editable file — a huge
                // value must clamp on-screen below, not overflow-panic here
                // (the float→int cast saturates, but the ADD would panic in
                // dev builds and kill the presence thread).
                let x = seat.0.saturating_add((s.dx * scale).round() as i32);
                let y = seat.1.saturating_add((s.dy * scale).round() as i32);
                (s.corner, clamp_origin((x, y), &rect, w, h))
            }
            None => (cur_corner, corner_origin(cur_corner, &rect, w, h, margin)),
        }
    } else {
        // Resolve the rect BEFORE taking the return seat: a monitor-info
        // miss must leave it in place for the next tick's retry.
        let Some(rect) = space_rect(&window, Space::Desktop) else { return };
        let Some(((rx, ry), rcorner)) = dock
            .desktop_return
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .take()
        else {
            dock.seated_fs.store(false, Ordering::SeqCst);
            return; // nothing to restore (never actually seated)
        };
        // The episode ended cleanly — the persisted copy has done its job.
        crate::settings::set_value(app, "desktopReturn", Value::Null);
        (rcorner, clamp_origin((rx, ry), &rect, w, h))
    };

    dock.seated_fs.store(want, Ordering::SeqCst);
    *dock.corner.lock().unwrap_or_else(PoisonError::into_inner) = Some(corner);
    emit_corner(&window, corner);
    if visible {
        animate_to(&window, (pos.x, pos.y), target);
    } else {
        jump_to(&window, target.0, target.1);
    }
}

/// Size + settle the window in ONE SetWindowPos. Called once at launch with
/// WINDOW_MAX (the window is born at that size, so this is effectively pure
/// positioning): the window-state-restored position runs through the SAME
/// settle rule as a drag release — near a canonical seat → re-seat (heals
/// margin drift, DPI changes, disconnected monitors, exactly the old
/// always-snap behavior); anywhere else → the free position survives,
/// clamped + railed. Seeds the dock-corner event. Mode changes never call
/// this; the window stays at WINDOW_MAX for its whole life (see the module
/// comment).
#[tauri::command]
pub fn set_window_size(window: WebviewWindow, dock: State<Dock>, width: f64, height: f64) {
    dock.epoch.fetch_add(1, Ordering::SeqCst); // cancel any in-flight glide
    let Some(wa) = space_rect(&window, Space::Desktop) else {
        // No monitor info at all — still honor the size so the native window
        // matches the React layout; position keeps its last value.
        let _ = window.set_size(tauri::LogicalSize::new(width, height));
        return;
    };
    let scale = window.scale_factor().unwrap_or(1.0);
    let w = (width * scale).round() as i32;
    let h = (height * scale).round() as i32;
    let margin = (MARGIN_LOGICAL * scale).round() as i32;
    // A quit mid-fullscreen-episode persisted the FULLSCREEN position as the
    // window-state position; init stashed the true desktop seat — prefer it.
    let launch_pos = dock
        .launch_pos
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .take()
        .map(|(x, y)| ((x * scale).round() as i32, (y * scale).round() as i32));
    let restored = launch_pos.map(Ok).unwrap_or_else(|| {
        window.outer_position().map(|p| (p.x, p.y)).map_err(|_| ())
    });
    let (corner, (x, y)) = match restored {
        Ok(pos) => {
            let center = footprint_center(&window, pos, (w, h));
            settle_target(center, pos, (w, h), &wa, scale)
        }
        Err(_) => (
            Corner::BottomRight,
            corner_origin(Corner::BottomRight, &wa, w, h, margin),
        ),
    };
    *dock.corner.lock().unwrap_or_else(PoisonError::into_inner) = Some(corner);
    emit_corner(&window, corner);
    dock.animating.store(true, Ordering::SeqCst);
    apply_pos(&window, x, y, Some((w, h)));
    dock.animating.store(false, Ordering::SeqCst);
}

/// The frontend reports the current mode's interactive footprint (logical
/// px, anchored at the docked corner) on every mode change — the hit
/// watcher makes everything outside it click-through. The full MODE_SIZES
/// footprint (shell + gutter), not just the shell, so the visible edge ring
/// stays grabbable for drags.
#[tauri::command]
pub fn set_hit_size(dock: State<Dock>, width: f64, height: f64) {
    *dock.hit_size.lock().unwrap_or_else(PoisonError::into_inner) = Some((width, height));
}

/// The fixed-size window's transparent gutter must not eat clicks meant for
/// whatever is beneath: poll the cursor and toggle whole-window
/// click-through (WS_EX_TRANSPARENT via set_ignore_cursor_events) so the
/// window is interactive exactly while the cursor is inside the hit rect —
/// the current mode's footprint, anchored at the docked corner. Toggles are
/// suppressed mid-press so a drag/click can't have the window yanked out
/// from under it, and skipped while hidden.
pub fn spawn_hit_watcher(window: WebviewWindow) {
    std::thread::spawn(move || {
        // Local mirror of the applied state — the window starts interactive.
        let mut ignoring = false;
        loop {
            let mut near = false;
            if window.is_visible().unwrap_or(false) {
                let mut p = windows::Win32::Foundation::POINT::default();
                let got = unsafe { GetCursorPos(&mut p).is_ok() };
                if got {
                    if let (Ok(pos), Ok(size)) = (window.outer_position(), window.outer_size()) {
                        let (wx, wy) = (pos.x, pos.y);
                        let (ww, wh) = (size.width as i32, size.height as i32);
                        near = p.x >= wx - HIT_NEAR_PAD
                            && p.x < wx + ww + HIT_NEAR_PAD
                            && p.y >= wy - HIT_NEAR_PAD
                            && p.y < wy + wh + HIT_NEAR_PAD;
                        let dock = window.state::<Dock>();
                        let hit = *dock.hit_size.lock().unwrap_or_else(PoisonError::into_inner);
                        let inside = match hit {
                            None => p.x >= wx && p.x < wx + ww && p.y >= wy && p.y < wy + wh,
                            Some((hw, hh)) => {
                                let scale = window.scale_factor().unwrap_or(1.0);
                                let hw = ((hw * scale).round() as i32).min(ww);
                                let hh = ((hh * scale).round() as i32).min(wh);
                                let corner = dock
                                    .corner
                                    .lock()
                                    .unwrap_or_else(PoisonError::into_inner)
                                    .unwrap_or(Corner::BottomRight);
                                let (l, t) = match corner {
                                    Corner::TopLeft => (wx, wy),
                                    Corner::TopRight => (wx + ww - hw, wy),
                                    Corner::BottomLeft => (wx, wy + wh - hh),
                                    Corner::BottomRight => (wx + ww - hw, wy + wh - hh),
                                };
                                p.x >= l && p.x < l + hw && p.y >= t && p.y < t + hh
                            }
                        };
                        // inside == ignoring means the state is wrong-way —
                        // flip it, unless a press is in flight. The mirror
                        // only advances when the OS call lands, so a failed
                        // call retries next poll instead of desyncing.
                        if inside == ignoring
                            && !primary_button_down()
                            && window.set_ignore_cursor_events(!inside).is_ok()
                        {
                            ignoring = !inside;
                            if ignoring {
                                // WS_EX_TRANSPARENT stops ALL mouse messages
                                // the instant it lands — the webview never
                                // receives the mouseleave, so Chromium's
                                // :hover freezes true and pins the
                                // hover-revealed chrome open. Tell the
                                // frontend to drop its hover state instead
                                // (quick-review catch, 2026-07-10).
                                let _ = window.emit("cursor-left", ());
                            }
                        }
                    }
                }
            }
            std::thread::sleep(Duration::from_millis(if near { HIT_NEAR_MS } else { HIT_FAR_MS }));
        }
    });
}

/// One-shot corner read for webview mount/reload — the event stream's seed
/// (same pattern as now_playing). None until the first positioning op derives
/// a corner; the frontend keeps its bottom-right default then.
#[tauri::command]
pub fn dock_corner(dock: State<Dock>) -> Option<&'static str> {
    dock.corner
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .map(Corner::as_str)
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
                settle_release(&wv);
            }
        });
    }
}

/// Tray recovery: show and re-dock to the bottom-right of the current
/// monitor. Launch settling already heals disconnected-monitor positions;
/// this is the manual belt-and-braces path. Context-aware: during a
/// fullscreen episode it homes to the MONITOR rect's bottom-right and
/// forgets the remembered fullscreen seat (reset means "back to defaults"
/// for whichever seat is live); the desktop return position is untouched.
pub fn reset_position(app: &AppHandle) {
    let Some(window) = app.get_webview_window("main") else { return };
    // An explicit summons: clear manual hide, snooze any conceal episode,
    // and let apply_visibility (the only show/hide caller) reconcile.
    let vis = app.state::<crate::VisIntent>();
    vis.user_hidden.store(false, Ordering::Relaxed);
    if vis.concealed.load(Ordering::Relaxed) {
        vis.conceal_snoozed.store(true, Ordering::Relaxed);
    }
    crate::apply_visibility(app);
    let dock = app.state::<Dock>();
    let space = if dock.seated_fs.load(Ordering::SeqCst) {
        *dock.fs_seat.lock().unwrap_or_else(PoisonError::into_inner) = None;
        crate::settings::set_value(app, "fsSeat", Value::Null);
        Space::Fullscreen
    } else {
        Space::Desktop
    };
    *dock.corner.lock().unwrap_or_else(PoisonError::into_inner) = Some(Corner::BottomRight);
    emit_corner(&window, Corner::BottomRight);
    let Some(wa) = space_rect(&window, space) else { return };
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
