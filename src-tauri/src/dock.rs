/*
 * Free placement with edge snapping: the widget goes ANYWHERE on screen and
 * stays where it was dropped. On release each axis settles independently —
 * within RAIL_PX of an edge line it snaps to that line, otherwise it keeps
 * exactly the coordinate it was dropped at; the visible widget is clamped
 * on-screen and nothing else moves it. There is no corner magnet (removed
 * 2026-07-21 on Thien's live verdict: a drop NEAR a corner was pulled INTO
 * it, "I just want it to align with the nearest edge... and stay at that Y
 * level"), and no fullscreen special case — Palette never repositions
 * itself in response to another app.
 *
 * Edge lines, per axis: the MARGIN_LOGICAL inset of BOTH the work area and
 * the full monitor rect, on both sides; the nearest within RAIL_PX wins.
 * Left/right/top the two rects coincide, so there is one line. The bottom
 * has two ~a-taskbar apart — above the taskbar (the familiar seat) and
 * flush with the true screen bottom. That second line is what retires the
 * old fullscreen seat: it already exists on the desktop, so a near-bottom
 * drop over a fullscreen game lands flush without anyone sensing anything.
 *
 * The settle runs in FOOTPRINT coordinates — the visible widget, not the
 * window. The shell seats at the docked corner INSIDE the fixed
 * WINDOW_MAX window (App.tsx SHELL_SEAT), so placing the window instead let
 * a corner flip re-seat the visible widget by WINDOW_MAX - MODE_SIZE across
 * a stationary window: 80×392px in pill mode, i.e. crossing the screen
 * midline threw the widget most of a screen height. Deriving the window
 * origin from the settled footprint (window = footprint - corner_offset)
 * absorbs the flip, which is the precondition for "place it anywhere"
 * meaning anything in pill and card. The window may hang off-screen as a
 * result — it is transparent and click-through out there, and only the
 * footprint is clamped.
 *
 * The corner is still DERIVED on every settle (from the footprint's center)
 * and is still the anchor IDENTITY — shell-seat glide direction, hit-rect
 * anchor, queue popover direction, mode-glide growth all key on it, and all
 * anchor to the corner of the WINDOW rect, so they work at any position. It
 * just no longer pulls.
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
 * now-disconnected monitor (the clamp does that work; with the magnet gone
 * there is no re-seat, so a free placement always survives a relaunch).
 */
use std::sync::atomic::{AtomicBool, AtomicI32, AtomicU64, Ordering};
use std::sync::{Condvar, Mutex, PoisonError};
use std::time::{Duration, Instant};

use serde_json::Value;
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

/// Gap between the widget and the screen edges when an axis snaps, in
/// logical px.
const MARGIN_LOGICAL: f64 = 12.0;
/// The ONLY snap: a drop within this of an edge line settles that axis onto
/// the margin rail. Per-axis and independent, so a drop near the left edge
/// tidies X and leaves Y exactly where it landed. Mid-screen drops stand
/// untouched — this is the whole placement rule, there is no corner magnet.
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
/// While hidden the watcher PARKS on Dock::show_signal instead of polling — a
/// hidden window takes no clicks. apply_visibility wakes it on show, so the
/// click-through state is correct before the first click can land (no
/// post-show staleness). This is just the park's safety-timeout: if a wake
/// signal were ever missed the watcher re-checks visibility this often, so a
/// bug degrades to a slow correction, never a wedge or a stuck click-through.
const HIT_PARK_SAFETY_MS: u64 = 250;
/// "Near" halo around the window rect that switches the fast cadence on.
const HIT_NEAR_PAD: i32 = 64;
/// Post-corner-change grace: the webview shell glides to its new seat for
/// SNAP_MS (App.tsx FLIP), so until it lands the corner-anchored hit rect
/// is wrong on both ends — the traveling shell sits outside it while the
/// still-empty destination reads as interactive. The whole window stays
/// interactive for the glide instead — the same never-smaller-than-what's-
/// on-screen rule as the frontend's deferred hit shrinks (hitCommanded).
const HIT_GRACE_MS: u64 = SNAP_MS + 80;

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

    /// Inverse of as_str, for the persisted corner (settings.json
    /// "dockCorner").
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
    /// Nesting COUNT of in-flight self-inflicted moves so on_moved ignores
    /// them (>0 = animating). A plain bool let a SUPERSEDED animation thread's
    /// tail `store(false)` clear the flag out from under the NEWER animation
    /// that replaced it — a self-inflicted Moved during that newer glide then
    /// read as a user drag and mis-fired the corner snap. A counter can't: each
    /// op adds exactly one on entry and subs one on every exit, so a superseded
    /// thread only removes its own contribution.
    animating: AtomicI32,
    last_moved: Mutex<Instant>,
    /// One debounce watcher at a time.
    watcher_armed: AtomicBool,
    /// The interactive footprint (logical px, anchored at the docked
    /// corner) the frontend reports per mode — everything outside it is
    /// click-through. None (pre-report) = the whole window is interactive.
    /// This is a UNION: it swells to cover the queue popover and goes
    /// whole-window under a transient overlay, so it is the right rect for
    /// clicks and the WRONG one for placement (see mode_size).
    hit_size: Mutex<Option<(f64, f64)>>,
    /// The mode's own box (MODE_SIZES, logical px) — what PLACEMENT uses.
    /// It must track App.tsx's SHELL_SEAT exactly, because the corner-flip
    /// compensation only cancels the frontend's FLIP if both sides measure
    /// the same rect; hit_size's popover union would compensate for a box
    /// the shell never moves by, re-opening the teleport it fixes.
    mode_size: Mutex<Option<(f64, f64)>>,
    /// When the docked corner last CHANGED (not launch-derived) — hit_rect
    /// widens to the whole window for HIT_GRACE_MS after it while the shell
    /// glides to its new seat.
    corner_changed: Mutex<Option<Instant>>,
    /// The hit watcher parks here while the window is hidden (a hidden window
    /// takes no clicks, so there's nothing to poll for). apply_visibility's
    /// show path calls notify_shown, waking it within a frame so the
    /// click-through state is correct before the first click can land — no
    /// post-show staleness window. The bool is the wake flag guarding against
    /// a lost wakeup (a show landing between the watcher's visibility check
    /// and its park); the Condvar's timeout is a safety net so a missed
    /// signal degrades to a slow re-check, never a wedge.
    show_signal: (Mutex<bool>, Condvar),
}

impl Default for Dock {
    fn default() -> Self {
        Self {
            corner: Mutex::new(None),
            epoch: AtomicU64::new(0),
            animating: AtomicI32::new(0),
            last_moved: Mutex::new(Instant::now()),
            watcher_armed: AtomicBool::new(false),
            hit_size: Mutex::new(None),
            mode_size: Mutex::new(None),
            corner_changed: Mutex::new(None),
            show_signal: (Mutex::new(false), Condvar::new()),
        }
    }
}

/// Wake the hit watcher from its hidden-window park (apply_visibility's show
/// path). Sets the wake flag under the lock so a park that hasn't started yet
/// still sees it, then signals. No-op cost when the watcher isn't parked.
pub(crate) fn notify_shown(app: &AppHandle) {
    let dock = app.state::<Dock>();
    let (lock, cv) = &dock.show_signal;
    *lock.lock().unwrap_or_else(PoisonError::into_inner) = true;
    cv.notify_all();
}

/// Work area (monitor minus taskbar) in physical px: (x, y, w, h).
struct WorkArea {
    x: i32,
    y: i32,
    w: i32,
    h: i32,
}

/// Both rects placement math cares about. `work` (monitor minus taskbar) is
/// the familiar seat and the one `reset_position` homes to; `mon` (the full
/// monitor) is what the widget is CLAMPED to — it may sit over the taskbar if
/// that's where it was put. Each contributes its own pair of edge lines per
/// axis, which is what lets a near-bottom drop choose between "above the
/// taskbar" and "flush with the screen" without any fullscreen sensing.
struct Rects {
    work: WorkArea,
    mon: WorkArea,
}

/// The monitor the VISIBLE widget is on — the one containing (cx, cy), which
/// callers pass as the footprint's center. Asking the WINDOW instead
/// (current_monitor = largest intersection) can answer with a neighbouring
/// display now that the window sits up to WINDOW_MAX − MODE_SIZE away from
/// the widget, and the drop would be clamped onto the wrong screen. Falls
/// back to the window's monitor, then the primary — a position persisted on a
/// now-disconnected monitor must still resolve somewhere visible so the clamp
/// can pull the widget back on-screen.
fn monitor_rects(window: &WebviewWindow, cx: i32, cy: i32) -> Option<Rects> {
    let monitor = window
        .available_monitors()
        .unwrap_or_default()
        .into_iter()
        .find(|m| {
            let (p, s) = (m.position(), m.size());
            cx >= p.x && cx < p.x + s.width as i32 && cy >= p.y && cy < p.y + s.height as i32
        })
        .or_else(|| window.current_monitor().ok().flatten())
        .or_else(|| window.primary_monitor().ok().flatten())?;
    let wa = monitor.work_area();
    Some(Rects {
        work: WorkArea {
            x: wa.position.x,
            y: wa.position.y,
            w: wa.size.width as i32,
            h: wa.size.height as i32,
        },
        mon: WorkArea {
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

/// Clamp an origin so the w×h footprint sits inside `rect`, keeping the
/// top-left reachable when it outgrows it (mirrors corner_origin's rule —
/// the chromeless drag surface must stay on-screen).
fn clamp_origin(pos: (i32, i32), rect: &WorkArea, w: i32, h: i32) -> (i32, i32) {
    (
        pos.0.clamp(rect.x, (rect.x + rect.w - w).max(rect.x)),
        pos.1.clamp(rect.y, (rect.y + rect.h - h).max(rect.y)),
    )
}

/// Snap one axis to the nearest of `lines` within `rail`, else leave it
/// exactly where it is. Ties are impossible in practice — the two rects'
/// lines on a side either coincide (deduped by "nearest", which then picks
/// either identical value) or differ by a taskbar thickness.
fn snap_axis(v: i32, lines: [i32; 4], rail: i32) -> i32 {
    let mut best: Option<(i32, i32)> = None; // (distance, line)
    for line in lines {
        let d = (v - line).abs();
        if d <= rail && best.is_none_or(|(bd, _)| d < bd) {
            best = Some((d, line));
        }
    }
    best.map_or(v, |(_, line)| line)
}

/// The settle decision for a released (or launch-restored) FOOTPRINT — the
/// visible widget, not the window (see the module comment: the window origin
/// is derived from this, so a corner change can't re-seat the shell across a
/// stationary window). Pure: clamp on-screen, snap each axis to the nearest
/// edge line, then read the corner identity off where it actually landed.
///
/// `rails` is false only before the frontend has reported a footprint size,
/// where the "footprint" is really the whole window: railing the window's FAR
/// edges would move the visible widget onto a line it isn't at, so the launch
/// settle clamps and nothing more.
fn settle_target(
    fpos: (i32, i32),
    fsize: (i32, i32),
    rects: &Rects,
    scale: f64,
    rails: bool,
) -> (Corner, (i32, i32)) {
    let (fw, fh) = fsize;
    let margin = (MARGIN_LOGICAL * scale).round() as i32;
    // Clamp first: a half-off-screen drop lands flush, and its now-margin-off
    // distance is the rails' problem below.
    let (x, y) = clamp_origin(fpos, &rects.mon, fw, fh);
    let (x, y) = if rails {
        let rail = (RAIL_PX * scale).round() as i32;
        (
            snap_axis(
                x,
                [
                    rects.work.x + margin,
                    rects.work.x + rects.work.w - fw - margin,
                    rects.mon.x + margin,
                    rects.mon.x + rects.mon.w - fw - margin,
                ],
                rail,
            ),
            snap_axis(
                y,
                [
                    rects.work.y + margin,
                    rects.work.y + rects.work.h - fh - margin,
                    rects.mon.y + margin,
                    rects.mon.y + rects.mon.h - fh - margin,
                ],
                rail,
            ),
        )
    } else {
        (x, y)
    };
    // Corner from where it LANDED — every consumer of the corner (shell seat,
    // popover direction, mode-glide growth) is asking "which screen edge is
    // this thing against", so the settled position is the honest input.
    let corner = nearest_corner(x + fw / 2, y + fh / 2, &rects.mon);
    (corner, (x, y))
}

/// Where the footprint sits INSIDE the window: the shell seats at the docked
/// corner (App.tsx SHELL_SEAT), so `window_origin = footprint_origin - this`.
/// Saturating at 0 keeps a footprint reported larger than the window (never
/// happens — footprint_rect min()s it — but the arithmetic must not go
/// negative and drag the window off by the difference) harmless.
fn corner_offset(corner: Corner, win: (i32, i32), fp: (i32, i32)) -> (i32, i32) {
    let dx = (win.0 - fp.0).max(0);
    let dy = (win.1 - fp.1).max(0);
    match corner {
        Corner::TopLeft => (0, 0),
        Corner::TopRight => (dx, 0),
        Corner::BottomLeft => (0, dy),
        Corner::BottomRight => (dx, dy),
    }
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
            dock.animating.fetch_add(1, Ordering::SeqCst);
            apply_pos(window, target.0, target.1, None);
            dock.animating.fetch_sub(1, Ordering::SeqCst);
        }
        return;
    }
    spawn_animation(window, ease_out, move |win, e| {
        let x = from.0 + (dx as f64 * e).round() as i32;
        let y = from.1 + (dy as f64 * e).round() as i32;
        apply_pos(win, x, y, None);
    });
}

/// Decrements the `animating` counter on drop, so EVERY exit of a
/// spawn_animation thread — normal landing, superseded-return, AND a panic in
/// the `frame` closure — resets the count. A panic that leaked the count ≥1
/// would make on_moved read every real user drag as self-inflicted and refuse
/// to re-dock until a restart. The matching fetch_add stays in spawn_animation
/// BEFORE the epoch bump (so the count never dips to 0 between add and a
/// superseded thread's sub); this guard owns only the decrement. Mirrors
/// spotify.rs's FlagGuard / loopback.rs's CaptureExit.
struct AnimGuard<'a>(&'a AtomicI32);

impl Drop for AnimGuard<'_> {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}

/// RAII 1ms system timer resolution (timeBeginPeriod/timeEndPeriod). Restores
/// it on drop, so a panic in the animation frame can't leak the elevated
/// resolution process-wide — and the two exit paths (superseded-return, normal
/// end) no longer each need a manual timeEndPeriod.
struct TimerPeriod;

impl TimerPeriod {
    fn new() -> Self {
        unsafe {
            let _ = timeBeginPeriod(1);
        }
        TimerPeriod
    }
}

impl Drop for TimerPeriod {
    fn drop(&mut self) {
        unsafe {
            let _ = timeEndPeriod(1);
        }
    }
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
    // Increment BEFORE bumping the epoch: the superseded thread subs when it
    // sees the new epoch, and adding first keeps the count from momentarily
    // dipping to 0 between the two.
    dock.animating.fetch_add(1, Ordering::SeqCst);
    let my_epoch = dock.epoch.fetch_add(1, Ordering::SeqCst) + 1;
    let window = window.clone();
    std::thread::Builder::new()
        .name("dock-anim".into())
        .spawn(move || {
            let dock = window.state::<Dock>();
            // RAII: the fetch_add ran in spawn_animation (before the epoch
            // bump); this guard owns the matching sub for EVERY exit — normal
            // landing, superseded-return, and a panic in `frame`.
            let _anim = AnimGuard(&dock.animating);
            if snap_animation_enabled() {
                // Default Windows timer resolution rounds thread::sleep(8ms) up
                // to ~15.6ms, landing ~13 UNEVEN frames across the 200ms window —
                // the mid-curve (fastest) stretch jumps in irregular steps and
                // the motion reads as lunge-then-settle instead of one glide.
                // 1ms resolution for the animation's lifetime makes the 8ms
                // cadence real; wall-clock progress below stays the correctness
                // backstop for any frame the OS still delays. RAII so a frame
                // panic can't leak the elevated resolution.
                let _timer = TimerPeriod::new();
                let start = Instant::now();
                loop {
                    std::thread::sleep(Duration::from_millis(FRAME_MS));
                    if dock.epoch.load(Ordering::SeqCst) != my_epoch {
                        // Superseded by a drag or resize — stop where we are.
                        // The guards sub only OUR contribution + restore the
                        // timer on drop; the newer op's increment keeps the
                        // count >0 so its glide stays flagged self-inflicted.
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
            } else {
                frame(&window, 1.0);
            }
        })
        .expect("spawn dock-anim thread");
}

/// A logical-px box anchored at the docked corner of the window rect
/// (physical px, screen coords), or the whole window when `size` is None.
/// The raw geometry — NO corner-glide grace.
fn anchored_rect(
    window: &WebviewWindow,
    size: Option<(f64, f64)>,
    wx: i32,
    wy: i32,
    ww: i32,
    wh: i32,
) -> (i32, i32, i32, i32) {
    let Some((sw, sh)) = size else {
        return (wx, wy, ww, wh);
    };
    let scale = window.scale_factor().unwrap_or(1.0);
    let hw = ((sw * scale).round() as i32).min(ww);
    let hh = ((sh * scale).round() as i32).min(wh);
    let corner = window
        .state::<Dock>()
        .corner
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .unwrap_or(Corner::BottomRight);
    let (ox, oy) = corner_offset(corner, (ww, wh), (hw, hh));
    (wx + ox, wy + oy, hw, hh)
}

/// The interactive footprint — hit_size's popover/overlay UNION. Feeds the
/// click-through gate only.
fn footprint_rect(
    window: &WebviewWindow,
    wx: i32,
    wy: i32,
    ww: i32,
    wh: i32,
) -> (i32, i32, i32, i32) {
    let size = *window
        .state::<Dock>()
        .hit_size
        .lock()
        .unwrap_or_else(PoisonError::into_inner);
    anchored_rect(window, size, wx, wy, ww, wh)
}

/// The VISIBLE widget's box — the mode's own MODE_SIZES rect, never the
/// popover union. Every placement decision keys on this: the snap wants the
/// widget at the committed corner (where the shell is headed), and the
/// corner-flip compensation must measure exactly the rect App.tsx's FLIP
/// moves. Falls back to hit_size, then the whole window, so a settle before
/// the frontend has reported anything still behaves.
fn placement_rect(
    window: &WebviewWindow,
    wx: i32,
    wy: i32,
    ww: i32,
    wh: i32,
) -> (i32, i32, i32, i32) {
    let dock = window.state::<Dock>();
    let size = (*dock
        .mode_size
        .lock()
        .unwrap_or_else(PoisonError::into_inner))
    .or(*dock.hit_size.lock().unwrap_or_else(PoisonError::into_inner));
    anchored_rect(window, size, wx, wy, ww, wh)
}

/// The window origin that puts a settled footprint at `landing`, plus a
/// safety clamp keeping the WINDOW itself on-screen. The clamp is inert on
/// any display taller than ~832 logical px — the corner tracks the widget's
/// screen quadrant, so the window always fits — and exists only so that on a
/// short display, stepping UP the mode ladder (which grows the shell to fill
/// the window) can't paint the widget off the edge.
fn window_origin(
    corner: Corner,
    landing: (i32, i32),
    win: (i32, i32),
    fp: (i32, i32),
    rect: &WorkArea,
) -> (i32, i32) {
    let (ox, oy) = corner_offset(corner, win, fp);
    clamp_origin((landing.0 - ox, landing.1 - oy), rect, win.0, win.1)
}

/// The interactive rect for the click-through gate: footprint_rect, but the
/// whole window during the corner-glide grace — while the shell travels
/// between seats, no corner-anchored rect is honest, so the whole window
/// stays interactive until it lands (see corner_changed / HIT_GRACE_MS).
fn hit_rect(window: &WebviewWindow, wx: i32, wy: i32, ww: i32, wh: i32) -> (i32, i32, i32, i32) {
    let dock = window.state::<Dock>();
    let changed = *dock
        .corner_changed
        .lock()
        .unwrap_or_else(PoisonError::into_inner);
    if changed.is_some_and(|t| t.elapsed() < Duration::from_millis(HIT_GRACE_MS)) {
        return (wx, wy, ww, wh);
    }
    footprint_rect(window, wx, wy, ww, wh)
}

/// Persist the docked corner (settings.json "dockCorner"). window-state
/// restores the window RECT, but the widget sits at one of four corners
/// INSIDE it — and which one is not recoverable from the rect. Re-deriving it
/// from the window's center puts it in the wrong screen quadrant across a
/// ~200px band around each midline (the window center sits ~196px off the
/// footprint center in pill mode), and the shell then seats at the opposite
/// end of the window: a 392px teleport on relaunch. One string is the decoder
/// ring. Written off-thread — set_corner is reachable from the main thread
/// (set_window_size is a sync command) and a settings write is a
/// read-modify-write; a lost write costs one stale launch, nothing more.
fn persist_corner(app: &AppHandle, corner: Corner) {
    let app = app.clone();
    let _ = std::thread::Builder::new()
        .name("dock-persist".into())
        .spawn(move || {
            crate::settings::set_value(&app, "dockCorner", Value::from(corner.as_str()));
        });
}

/// Store the docked corner. If it CHANGED from an existing corner AND the
/// shell will visibly glide to the new seat (`gliding`), open the hit-rect
/// grace window so the click-through gate stays whole-window until the
/// shell lands (see corner_changed / HIT_GRACE_MS). Launch derivation and
/// hidden jumps pass false — neither animates a visible shell across the
/// fixed window.
fn set_corner(app: &AppHandle, dock: &Dock, corner: Corner, gliding: bool) {
    let mut c = dock.corner.lock().unwrap_or_else(PoisonError::into_inner);
    let changed = *c != Some(corner);
    if gliding && c.is_some() && changed {
        *dock
            .corner_changed
            .lock()
            .unwrap_or_else(PoisonError::into_inner) = Some(Instant::now());
    }
    *c = Some(corner);
    drop(c);
    if changed {
        persist_corner(app, corner);
    }
}

/// Settle a released drag. Everything is expressed in the VISIBLE widget's
/// coordinates (footprint_rect) — the shell sits corner-anchored inside the
/// WINDOW_MAX window, so the window rect is up to 80×392px away from what the
/// user actually dragged — and the window origin is derived from the landing
/// LAST, using the settled corner. That derivation is what absorbs a corner
/// change: without it the flip re-seats the shell across a stationary window
/// and the widget jumps most of a screen height (see the module comment).
fn settle_release(window: &WebviewWindow) {
    let dock = window.state::<Dock>();
    let (Ok(pos), Ok(size)) = (window.outer_position(), window.outer_size()) else {
        return;
    };
    let (w, h) = (size.width as i32, size.height as i32);
    let (fx, fy, fw, fh) = placement_rect(window, pos.x, pos.y, w, h);
    let Some(rects) = monitor_rects(window, fx + fw / 2, fy + fh / 2) else {
        return;
    };
    let scale = window.scale_factor().unwrap_or(1.0);
    let (corner, landing) = settle_target((fx, fy), (fw, fh), &rects, scale, true);
    let target = window_origin(corner, landing, (w, h), (fw, fh), &rects.mon);
    // A real corner CHANGE glides the shell to its new seat (App.tsx FLIP) —
    // open the hit-rect grace window for that visible glide. The native glide
    // below runs the compensating distance in the OPPOSITE direction over the
    // same SNAP_MS/EASE.out, so the two cancel and the widget holds still.
    set_corner(window.app_handle(), &dock, corner, true);
    emit_corner(window, corner);
    animate_to(window, (pos.x, pos.y), target);
}

/// Seed the docked corner from settings.json — the decoder ring the launch
/// settle needs to find the visible widget inside the restored window rect
/// (see persist_corner). Absent (fresh install, or the first launch after the
/// 2026-07-21 change) leaves it None, which the launch settle reads as "treat
/// the whole window as the widget", exactly the pre-2026-07-21 behavior, so an
/// upgrade lands where the last version would have put it and the first drag
/// makes it exact.
///
/// Also nulls the two keys the removed fullscreen seat used to own ("fsSeat",
/// "desktopReturn") — dead weight in a dogfooded settings.json. Call once from
/// setup; file IO belongs here, not in the sync set_window_size command
/// (main-thread rule).
pub fn init(app: &AppHandle) {
    if let Some(corner) = crate::settings::get_value(app, "dockCorner")
        .as_ref()
        .and_then(Value::as_str)
        .and_then(Corner::from_str)
    {
        *app.state::<Dock>()
            .corner
            .lock()
            .unwrap_or_else(PoisonError::into_inner) = Some(corner);
    }
    for key in ["fsSeat", "desktopReturn"] {
        if crate::settings::get_value(app, key).is_some_and(|v| !v.is_null()) {
            crate::settings::set_value(app, key, Value::Null);
        }
    }
}

/// Size + settle the window in ONE SetWindowPos. Called once at launch with
/// WINDOW_MAX (the window is born at that size, so this is effectively pure
/// positioning) plus the launch mode's own box: the window-state-restored
/// position runs through the SAME footprint-space settle rule as a drag
/// release, so a free placement survives a relaunch verbatim and a position
/// persisted on a now-disconnected monitor is pulled back on-screen by the
/// clamp. Seeds the dock-corner event. Mode changes never call this; the
/// window stays at WINDOW_MAX for its whole life (see the module comment).
///
/// `mode_width`/`mode_height` are MODE_SIZES[launch mode]. They matter because
/// the restored rect is the WINDOW's and the widget sits at a corner inside
/// it: with the corner seeded from settings.json (dock::init) the two together
/// locate the visible widget exactly. Without a seeded corner (fresh install /
/// first launch after 2026-07-21) the whole window is treated as the widget,
/// reproducing the old behavior rather than guessing a corner and teleporting.
#[tauri::command]
pub fn set_window_size(
    window: WebviewWindow,
    dock: State<Dock>,
    width: f64,
    height: f64,
    mode_width: f64,
    mode_height: f64,
) {
    dock.epoch.fetch_add(1, Ordering::SeqCst); // cancel any in-flight glide

    // Seed the placement box so the launch settle — and any Moved that beats
    // the frontend's first set_hit_size — measures the widget, not the window.
    let mode_box = (mode_width, mode_height);
    *dock
        .mode_size
        .lock()
        .unwrap_or_else(PoisonError::into_inner) = Some(mode_box);
    let scale = window.scale_factor().unwrap_or(1.0);
    let w = (width * scale).round() as i32;
    let h = (height * scale).round() as i32;
    let margin = (MARGIN_LOGICAL * scale).round() as i32;
    // The corner dock::init seeded IS the quit-time corner; placement_rect
    // reads it to find the widget inside the restored window rect. None →
    // anchored_rect's whole-window fallback, and no rails (railing the
    // window's far edges would move the widget onto a line it isn't at).
    let seeded = dock
        .corner
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .is_some();
    let (mw, mh) = (
        ((mode_width * scale).round() as i32).min(w),
        ((mode_height * scale).round() as i32).min(h),
    );
    // Where the VISIBLE widget is right now: inside the restored rect at the
    // seeded corner, or — with no corner to decode it — the whole window.
    let (fx, fy, fw, fh) = match (window.outer_position(), seeded) {
        (Ok(p), true) => placement_rect(&window, p.x, p.y, w, h),
        (Ok(p), false) => (p.x, p.y, w, h),
        // No position at all: aim the widget at the default seat, resolved
        // below against whatever monitor answers.
        (Err(_), _) => (0, 0, mw, mh),
    };
    let Some(rects) = monitor_rects(&window, fx + fw / 2, fy + fh / 2) else {
        // No monitor info at all — still honor the size so the native window
        // matches the React layout; position keeps its last value.
        let _ = window.set_size(tauri::LogicalSize::new(width, height));
        return;
    };
    let (corner, (x, y)) = match window.outer_position() {
        Ok(_) => {
            let (corner, landing) = settle_target((fx, fy), (fw, fh), &rects, scale, seeded);
            (
                corner,
                window_origin(corner, landing, (w, h), (fw, fh), &rects.mon),
            )
        }
        Err(_) => {
            let corner = Corner::BottomRight;
            let seat = corner_origin(corner, &rects.work, mw, mh, margin);
            (
                corner,
                window_origin(corner, seat, (w, h), (mw, mh), &rects.mon),
            )
        }
    };
    // Launch derivation glides nothing (a single sized apply_pos) — no grace.
    set_corner(window.app_handle(), &dock, corner, false);
    emit_corner(&window, corner);
    dock.animating.fetch_add(1, Ordering::SeqCst);
    apply_pos(&window, x, y, Some((w, h)));
    dock.animating.fetch_sub(1, Ordering::SeqCst);
}

/// The frontend reports two boxes (logical px, both anchored at the docked
/// corner) whenever either changes:
///
/// - `width`/`height`: the INTERACTIVE footprint — the hit watcher makes
///   everything outside it click-through. It is a union, swelling to cover the
///   queue popover and going whole-window under a transient overlay.
/// - `mode_width`/`mode_height`: the mode's own MODE_SIZES box, which every
///   PLACEMENT decision uses. Splitting them matters: compensating a corner
///   flip with the popover union would move the window by a distance the
///   shell's FLIP never travels, so a drag released with the queue open would
///   teleport by the difference.
///
/// Both are the full MODE_SIZES footprint (shell + gutter), not just the
/// shell, so the visible edge ring stays grabbable for drags.
#[tauri::command]
pub fn set_hit_size(dock: State<Dock>, width: f64, height: f64, mode_width: f64, mode_height: f64) {
    *dock.hit_size.lock().unwrap_or_else(PoisonError::into_inner) = Some((width, height));
    *dock
        .mode_size
        .lock()
        .unwrap_or_else(PoisonError::into_inner) = Some((mode_width, mode_height));
}

/// The fixed-size window's transparent gutter must not eat clicks meant for
/// whatever is beneath: poll the cursor and toggle whole-window
/// click-through (WS_EX_TRANSPARENT via set_ignore_cursor_events) so the
/// window is interactive exactly while the cursor is inside the hit rect —
/// the current mode's footprint, anchored at the docked corner. Toggles are
/// suppressed mid-press so a drag/click can't have the window yanked out
/// from under it. While hidden the loop parks on Dock::show_signal (woken by
/// apply_visibility's show path) instead of polling.
pub fn spawn_hit_watcher(window: WebviewWindow) {
    std::thread::Builder::new()
        .name("hit-watch".into())
        .spawn(move || {
            // Local mirror of the applied state — the window starts interactive.
            let mut ignoring = false;
            loop {
                let mut near = false;
                let visible = window.is_visible().unwrap_or(false);
                if !visible {
                    // Park until a show wakes us (or the safety timeout). Re-check
                    // visibility under the lock so a show that landed between the
                    // check above and here isn't waited past (lost-wakeup guard);
                    // the wake flag covers a notify_shown that ran before we
                    // parked. On wake the top-of-loop is_visible() runs the hit
                    // block immediately, so the state is right before any click.
                    let dock = window.state::<Dock>();
                    let (lock, cv) = &dock.show_signal;
                    let mut shown = lock.lock().unwrap_or_else(PoisonError::into_inner);
                    if !*shown && !window.is_visible().unwrap_or(false) {
                        let (g, _) = cv
                            .wait_timeout(shown, Duration::from_millis(HIT_PARK_SAFETY_MS))
                            .unwrap_or_else(PoisonError::into_inner);
                        shown = g;
                    }
                    *shown = false; // consume
                    continue;
                }
                {
                    let mut p = windows::Win32::Foundation::POINT::default();
                    let got = unsafe { GetCursorPos(&mut p).is_ok() };
                    if got {
                        if let (Ok(pos), Ok(size)) = (window.outer_position(), window.outer_size())
                        {
                            let (wx, wy) = (pos.x, pos.y);
                            let (ww, wh) = (size.width as i32, size.height as i32);
                            near = p.x >= wx - HIT_NEAR_PAD
                                && p.x < wx + ww + HIT_NEAR_PAD
                                && p.y >= wy - HIT_NEAR_PAD
                                && p.y < wy + wh + HIT_NEAR_PAD;
                            let (l, t, hw, hh) = hit_rect(&window, wx, wy, ww, wh);
                            let inside = p.x >= l && p.x < l + hw && p.y >= t && p.y < t + hh;
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
                // Only reached while visible (the hidden branch parks + continues).
                std::thread::sleep(Duration::from_millis(if near {
                    HIT_NEAR_MS
                } else {
                    HIT_FAR_MS
                }));
            }
        })
        .expect("spawn hit-watch thread");
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

#[cfg(test)]
mod tests {
    use super::*;

    /// 1920×1080 primary with a 48px bottom taskbar, and a pill-sized
    /// footprint — the shape every placement question here is really about.
    fn screen() -> Rects {
        Rects {
            work: WorkArea {
                x: 0,
                y: 0,
                w: 1920,
                h: 1032,
            },
            mon: WorkArea {
                x: 0,
                y: 0,
                w: 1920,
                h: 1080,
            },
        }
    }
    const PILL: (i32, i32) = (300, 48);

    fn settle(pos: (i32, i32)) -> (Corner, (i32, i32)) {
        settle_target(pos, PILL, &screen(), 1.0, true)
    }

    #[test]
    fn free_drop_stands_on_both_axes() {
        // Thien's screenshot 2: dead center, nothing near an edge.
        assert_eq!(settle((760, 500)).1, (760, 500));
    }

    #[test]
    fn near_left_edge_snaps_x_and_holds_y() {
        // Thien's screenshot 1 + the sentence that defines this whole change:
        // "align with the nearest edge... and stay at that Y level."
        assert_eq!(settle((20, 137)).1, (12, 137));
    }

    #[test]
    fn no_corner_magnet() {
        // 60px off BOTH of the bottom-right seat's lines — inside the old
        // MAGNET_PX (80), so this used to be yanked into the corner seat.
        // Now each axis is beyond RAIL_PX, so it stands exactly as dropped.
        let seat = (1920 - 300 - 12, 1032 - 48 - 12);
        assert_eq!(
            settle((seat.0 - 60, seat.1 - 60)).1,
            (seat.0 - 60, seat.1 - 60)
        );
    }

    #[test]
    fn one_axis_snapping_never_drags_the_other() {
        // Near the right edge, mid-height: X rails, Y is untouched.
        assert_eq!(settle((1920 - 300 - 20, 500)).1, (1920 - 300 - 12, 500));
    }

    #[test]
    fn bottom_axis_picks_the_nearer_of_two_lines() {
        let above_taskbar = 1032 - 48 - 12; // 972
        let flush_bottom = 1080 - 48 - 12; // 1020
        let y_of = |y: i32| settle((400, y)).1 .1;
        // A few px under the work-area line: still nearest THAT line, pulled
        // back up rather than dropped onto the taskbar.
        assert_eq!(y_of(above_taskbar + 8), above_taskbar);
        // Dragged genuinely to the bottom: the flush line wins. This is what
        // replaces the deleted fullscreen seat — no sensing, same rule.
        assert_eq!(y_of(flush_bottom - 8), flush_bottom);
        // Exactly between the two (24px each way, both at the rail boundary):
        // deterministic, and never left hanging between them.
        assert_eq!(y_of((above_taskbar + flush_bottom) / 2), above_taskbar);
        // Comfortably between them is NOT reachable at RAIL_PX 24 — the two
        // lines are 48 apart, so the whole taskbar band is magnetic. If
        // RAIL_PX ever shrinks, this is the assertion that notices.
        assert_ne!(y_of(996), 996);
    }

    #[test]
    fn clamps_the_footprint_on_screen() {
        // Flung off the top-left: the VISIBLE widget comes back, and lands on
        // the rails it now sits within.
        assert_eq!(settle((-500, -500)).1, (12, 12));
        // Off the bottom-right: clamped flush to the monitor rect, which is
        // inside RAIL_PX of the flush lines, so it tidies onto them.
        assert_eq!(settle((5000, 5000)).1, (1920 - 300 - 12, 1080 - 48 - 12));
    }

    #[test]
    fn corner_follows_the_footprint_center() {
        assert_eq!(settle((12, 12)).0, Corner::TopLeft);
        assert_eq!(settle((1600, 12)).0, Corner::TopRight);
        assert_eq!(settle((12, 1000)).0, Corner::BottomLeft);
        assert_eq!(settle((1600, 1000)).0, Corner::BottomRight);
        // Just above/below the horizontal midline: the FOOTPRINT's own center
        // decides (x 900 + 300/2 = 1050 is right of 960; y + 48/2 straddles
        // 540) — judged by the 380×440 window's center instead, a pill
        // dropped here would pick the opposite corner.
        assert_eq!(settle((900, 540 - 24 - 1)).0, Corner::TopRight);
        assert_eq!(settle((900, 540 - 24 + 1)).0, Corner::BottomRight);
    }

    #[test]
    fn launch_settle_clamps_without_railing() {
        // rails=false (no footprint reported yet): a free position survives
        // verbatim, and an off-screen one is only pulled back in.
        let win = (380, 440);
        assert_eq!(
            settle_target((900, 300), win, &screen(), 1.0, false).1,
            (900, 300)
        );
        assert_eq!(
            settle_target((-999, 3000), win, &screen(), 1.0, false).1,
            (0, 1080 - 440)
        );
    }

    #[test]
    fn relaunch_reproduces_the_placement_it_quit_at() {
        // window-state restores the WINDOW's rect; the widget sits at a corner
        // inside it. With the corner seeded from settings.json the pair
        // round-trips exactly. Re-deriving the corner from the WINDOW's center
        // instead — what the code did before "dockCorner" was persisted —
        // lands in the wrong quadrant across a ~200px band around each midline
        // (the two centers sit 196px apart in pill mode) and re-seats the
        // shell at the far end of the window: a 392px teleport per launch.
        let win = (380, 440);
        let rects = screen();
        for drop in [
            (760, 500),
            (900, 516),
            (900, 560),
            (12, 137),
            (1608, 1020),
            (400, 700),
        ] {
            let (corner, landing) = settle(drop);
            let origin = window_origin(corner, landing, win, PILL, &rects.mon);
            let (ox, oy) = corner_offset(corner, win, PILL);
            assert_eq!(
                (origin.0 + ox, origin.1 + oy),
                landing,
                "{corner:?} from {drop:?} did not round-trip"
            );
            // Idempotent, so nothing creeps across repeated relaunches.
            let again = settle_target((origin.0 + ox, origin.1 + oy), PILL, &rects, 1.0, true);
            assert_eq!(again, (corner, landing), "second launch drifted");
        }
    }

    #[test]
    fn window_clamp_saves_a_short_display_from_off_screen_growth() {
        let win = (380, 440);
        let short = Rects {
            work: WorkArea {
                x: 0,
                y: 0,
                w: 1366,
                h: 728,
            },
            mon: WorkArea {
                x: 0,
                y: 0,
                w: 1366,
                h: 768,
            },
        };
        // Just below the midline of a 768-tall display: the corner is Bottom*,
        // so the window starts 392px above the widget — off the top, and the
        // expanded mode that FILLS the window would paint there.
        let (corner, landing) = settle_target((600, 360), PILL, &short, 1.0, true);
        assert_eq!(corner, Corner::BottomRight);
        let origin = window_origin(corner, landing, win, PILL, &short.mon);
        assert!(origin.1 >= 0, "window hangs off the top: {origin:?}");
        // Inert on anything taller than ~832px — the offset applies untouched.
        let (c, l) = settle((600, 560));
        assert_eq!(
            window_origin(c, l, win, PILL, &screen().mon),
            (l.0, l.1 - 392)
        );
    }

    #[test]
    fn corner_offset_is_the_shell_seat_inside_the_window() {
        // These numbers ARE App.tsx's SHELL_SEAT geometry (WINDOW_MAX 380×440
        // minus MODE_SIZES.pill 300×48). The compensation only cancels the
        // frontend's FLIP if the two agree — if sizes.ts changes, this fails.
        let win = (380, 440);
        assert_eq!(corner_offset(Corner::TopLeft, win, PILL), (0, 0));
        assert_eq!(corner_offset(Corner::TopRight, win, PILL), (80, 0));
        assert_eq!(corner_offset(Corner::BottomLeft, win, PILL), (0, 392));
        assert_eq!(corner_offset(Corner::BottomRight, win, PILL), (80, 392));
        // Expanded fills the window — no offset, which is why the teleport
        // never showed in the mode Thien screenshotted.
        assert_eq!(corner_offset(Corner::BottomRight, win, win), (0, 0));
        // A footprint bigger than the window can't push the origin negative.
        assert_eq!(corner_offset(Corner::BottomRight, win, (500, 600)), (0, 0));
    }
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
    if dock.animating.load(Ordering::SeqCst) > 0 {
        return; // self-inflicted move (one or more positioning ops in flight)
    }
    *dock
        .last_moved
        .lock()
        .unwrap_or_else(PoisonError::into_inner) = Instant::now();
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
                let last = *dock
                    .last_moved
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner);
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

/// Tray recovery: show and re-dock the widget to the bottom-right of the
/// current monitor's WORK AREA — the familiar seat, above the taskbar. The
/// launch clamp already heals disconnected-monitor positions; this is the
/// manual belt-and-braces path, and with the corner magnet gone it is the
/// ONLY way a position becomes a canonical corner seat without being dragged
/// there.
pub fn reset_position(app: &AppHandle) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    // An explicit summons: clear manual hide, snooze any conceal episode,
    // and let apply_visibility (the only show/hide caller) reconcile.
    let vis = app.state::<crate::VisIntent>();
    vis.user_hidden.store(false, Ordering::Relaxed);
    if vis.concealed.load(Ordering::Relaxed) {
        vis.conceal_snoozed.store(true, Ordering::Relaxed);
    }
    crate::apply_visibility(app);
    let dock = app.state::<Dock>();
    let (Ok(pos), Ok(size)) = (window.outer_position(), window.outer_size()) else {
        return;
    };
    let (w, h) = (size.width as i32, size.height as i32);
    // Read the widget's box BEFORE re-cornering — the SIZE is corner-blind but
    // the position it reports is not, and the center is what picks the monitor
    // to home on (the one the widget is on, not the one the window overlaps).
    let (fx, fy, fw, fh) = placement_rect(&window, pos.x, pos.y, w, h);
    let Some(rects) = monitor_rects(&window, fx + fw / 2, fy + fh / 2) else {
        return;
    };
    // A visible re-dock glides to bottom-right (animate_to below) — if that
    // flips the corner, the shell FLIPs with it, so open the grace window.
    set_corner(app, &dock, Corner::BottomRight, true);
    emit_corner(&window, Corner::BottomRight);
    let scale = window.scale_factor().unwrap_or(1.0);
    let margin = (MARGIN_LOGICAL * scale).round() as i32;
    // Seat the VISIBLE widget, then derive the window origin from it — the
    // same footprint-space rule as a drag release.
    let seat = corner_origin(Corner::BottomRight, &rects.work, fw, fh, margin);
    let target = window_origin(Corner::BottomRight, seat, (w, h), (fw, fh), &rects.mon);
    animate_to(&window, (pos.x, pos.y), target);
}
