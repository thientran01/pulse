/*
 * Presence engine: senses the user's device context — fullscreen foreground
 * content and input idleness — emits derived, hysteresis-settled states to
 * the frontend, and acts on them in the licensed ways only (CLAUDE.md
 * "Presence" doctrine). P1: courtesy conceal — settled fullscreen hides the
 * native window via lib.rs's VisIntent/apply_visibility (manual intent
 * always wins; the tray "Companion mode" switch stops all actions).
 * docs/presence-signal-matrix.md is the source of truth for what Windows
 * reports — no behavior ships on an unmeasured signal.
 *
 * Derivation deliberately lives HERE, not in the webview (diverging from
 * media.rs's raw-relay philosophy): webview timers throttle/freeze exactly
 * when presence matters most (hidden/occluded), and P1's conceal is a native
 * hide() that must work with no webview in the loop. Raw signals still reach
 * the frontend on a separate "presence-debug" stream, gated behind a flag,
 * so observability never pollutes the settled stream's diff suppression.
 *
 * Own thread at a 1s cadence (house pattern: one watcher thread per concern).
 * NOT the dock hit watcher: that loop is cursor-cadenced (8-40ms) and skips
 * hidden windows — exactly when presence must keep sensing.
 */
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, PoisonError};
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};
use windows::core::PWSTR;
use windows::Win32::Foundation::{CloseHandle, HWND, RECT};
use windows::Win32::Graphics::Gdi::{
    GetMonitorInfoW, MonitorFromWindow, MONITORINFO, MONITOR_DEFAULTTONEAREST,
};
use windows::Win32::System::SystemInformation::GetTickCount;
use windows::Win32::System::Threading::{
    OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
    PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows::Win32::UI::Input::KeyboardAndMouse::{GetLastInputInfo, LASTINPUTINFO};
use windows::Win32::UI::Shell::SHQueryUserNotificationState;
use windows::Win32::UI::WindowsAndMessaging::{
    GetClassNameW, GetForegroundWindow, GetWindowRect, GetWindowThreadProcessId,
};

const PRESENCE_POLL_MS: u64 = 1000;
/// Fullscreen hysteresis: slow to assert (alt-tabbing THROUGH a fullscreen
/// app must never read as entering one), quicker to release (the return is
/// the user-serving direction). Applied to the emitted state from P0 on, so
/// the soak validates the constants before any behavior rides them.
const FS_ENTER_MS: u64 = 2000;
const FS_EXIT_MS: u64 = 1000;
/// Away after this much input silence (Thien's number, 2026-07-09). Debug
/// builds compile a short threshold so the transition is feel-checkable in
/// one sitting.
const AWAY_AFTER_S: u64 = if cfg!(debug_assertions) { 15 } else { 180 };
/// Working = sustained input duty: at least WORK_DUTY of the last
/// WORK_WINDOW_S one-second windows saw fresh input (idle_s == 0 exactly —
/// `<= 1` would let one physical event mark TWO slots, dropping the real
/// bar to "an event every ~3.3s", light fidgeting instead of sustained
/// work; quick-review catch, 2026-07-09). Entry is inherently hysteretic
/// (release: ≥72 input-seconds of the last 120; debug: ≥12 of 20), and
/// exit is the duty decaying below the bar (release ~50-60s of quiet,
/// debug ~8s) — the arc plan's enter-slow/exit-slow shape without a second
/// state machine. Coarse GetLastInputInfo deltas only — no hooks.
const WORK_WINDOW_S: usize = if cfg!(debug_assertions) { 20 } else { 120 };
const WORK_DUTY: f32 = 0.6;

/// The settled, behavior-grade state. Emitted diff-suppressed on "presence";
/// P1+ behaviors key off exactly these fields.
#[derive(Serialize, Clone, Copy, PartialEq)]
pub struct PresenceState {
    /// Hysteresis-settled: fullscreen content owns the WIDGET's monitor
    /// (or a global presentation/D3D state is active).
    pub fullscreen: bool,
    /// "active" | "working" | "away" — input idleness/intensity. Away wins
    /// over working (they can't physically co-occur: away needs 180s of
    /// silence, working needs dense recent input).
    pub user: &'static str,
    /// What the engine did about it: the window is currently hidden by the
    /// courtesy conceal (false while a manual show snoozes the episode).
    pub concealed: bool,
}

impl Default for PresenceState {
    fn default() -> Self {
        Self { fullscreen: false, user: "active", concealed: false }
    }
}

/// Raw per-tick signals for the debug stream and the matrix work. Not
/// diff-suppressed (idle ticks every second by nature); only emitted while
/// the debug flag is on.
#[derive(Serialize, Clone)]
struct PresenceDebug {
    fg_exe: String,
    fg_class: String,
    fg_pid: u32,
    /// "fullscreen" | "maximized" | "windowed" | "none" | "shell" | "self"
    rect_verdict: &'static str,
    on_widget_monitor: bool,
    quns: i32,
    quns_name: &'static str,
    idle_s: u64,
    /// Instantaneous fullscreen verdict, before hysteresis.
    fs_raw: bool,
    fs_settled: bool,
    user: &'static str,
    /// Input duty over the working window, 0..1 (filled by the loop).
    work_duty: f32,
}

pub struct Presence {
    /// Last emitted settled state — the seed command reads this, so a fresh
    /// webview always gets what the last event said (or the default before
    /// the first tick).
    last: Mutex<Option<PresenceState>>,
    /// Frontend's vote: emit the raw "presence-debug" stream (the dev
    /// overlay flips this on while mounted).
    debug: AtomicBool,
    /// Dev tray "Simulate fullscreen": the loop treats fs_raw as true until
    /// this instant (hysteresis still applies, so the conceal/restore cycle
    /// exercises the real path).
    sim_fs_until: Mutex<Option<std::time::Instant>>,
}

impl Default for Presence {
    fn default() -> Self {
        Self {
            last: Mutex::new(None),
            debug: AtomicBool::new(false),
            sim_fs_until: Mutex::new(None),
        }
    }
}

impl Presence {
    /// Dev-only conceal test affordance (tray item, debug builds).
    #[cfg(debug_assertions)]
    pub fn simulate_fullscreen(&self, for_dur: Duration) {
        *self.sim_fs_until.lock().unwrap_or_else(PoisonError::into_inner) =
            Some(std::time::Instant::now() + for_dur);
    }

    fn sim_fs_active(&self) -> bool {
        let mut until = self.sim_fs_until.lock().unwrap_or_else(PoisonError::into_inner);
        match *until {
            Some(t) if std::time::Instant::now() < t => true,
            Some(_) => {
                *until = None;
                false
            }
            None => false,
        }
    }
}

/// One-shot settled-state read for webview mount/reload — the event stream's
/// seed (same pattern as dock_corner / now_playing).
#[tauri::command]
pub fn presence_state(presence: State<Presence>) -> PresenceState {
    presence
        .last
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .unwrap_or_default()
}

/// The dev overlay's subscription vote for the raw stream.
#[tauri::command]
pub fn set_presence_debug(enabled: bool, presence: State<Presence>) {
    presence.debug.store(enabled, Ordering::Relaxed);
}

fn quns_name(v: i32) -> &'static str {
    match v {
        1 => "NOT_PRESENT",
        2 => "BUSY",
        3 => "RUNNING_D3D_FULL_SCREEN",
        4 => "PRESENTATION_MODE",
        5 => "ACCEPTS_NOTIFICATIONS",
        6 => "QUIET_TIME",
        7 => "APP",
        _ => "UNKNOWN",
    }
}

fn exe_name(pid: u32) -> String {
    unsafe {
        let Ok(handle) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) else {
            return String::new();
        };
        let mut buf = [0u16; 512];
        let mut len = buf.len() as u32;
        let name = if QueryFullProcessImageNameW(
            handle,
            PROCESS_NAME_WIN32,
            PWSTR(buf.as_mut_ptr()),
            &mut len,
        )
        .is_ok()
        {
            let full = String::from_utf16_lossy(&buf[..len as usize]);
            full.rsplit('\\').next().unwrap_or(&full).to_string()
        } else {
            String::new()
        };
        let _ = CloseHandle(handle);
        name
    }
}

/// `inner` covers `outer` entirely (borderless fullscreen may overhang by a
/// border pixel, so >= not ==).
fn covers(inner: &RECT, outer: &RECT) -> bool {
    inner.left <= outer.left
        && inner.top <= outer.top
        && inner.right >= outer.right
        && inner.bottom >= outer.bottom
}

fn idle_seconds() -> u64 {
    unsafe {
        let mut lii = LASTINPUTINFO {
            cbSize: std::mem::size_of::<LASTINPUTINFO>() as u32,
            dwTime: 0,
        };
        if !GetLastInputInfo(&mut lii).as_bool() {
            return 0; // fail open to "active" — never strand "away" on an API error
        }
        // Wrapping subtraction survives GetTickCount's ~49.7-day rollover.
        (GetTickCount().wrapping_sub(lii.dwTime) / 1000) as u64
    }
}

/// One instantaneous sample of every raw signal. `widget_hwnd` scopes the
/// rect verdict to the widget's monitor. Returns None when there is no
/// foreground window at all (lock screen / UAC secure desktop) — the caller
/// must HOLD its current fullscreen state then, never reset it: the secure
/// desktop says nothing about what's behind it.
fn sample(widget_hwnd: Option<HWND>, own_pid: u32) -> Option<PresenceDebug> {
    unsafe {
        let quns = SHQueryUserNotificationState().map(|s| s.0).unwrap_or(-1);
        let idle_s = idle_seconds();

        let fg = GetForegroundWindow();
        if fg == HWND::default() {
            return None;
        }

        let mut pid = 0u32;
        GetWindowThreadProcessId(fg, Some(&mut pid));

        let mut class_buf = [0u16; 128];
        let n = GetClassNameW(fg, &mut class_buf);
        let class = String::from_utf16_lossy(&class_buf[..n.max(0) as usize]);

        // Self/shell exclusion: our own transparent window and the desktop
        // shell both legitimately cover the whole monitor — treating either
        // as fullscreen content would conceal the widget over an empty
        // desktop (Progman/WorkerW span the monitor rect; matrix row
        // confirms on this machine).
        let is_self = pid == own_pid;
        let is_shell = matches!(class.as_str(), "Progman" | "WorkerW" | "Shell_TrayWnd");

        let mut rect = RECT::default();
        let rect_ok = GetWindowRect(fg, &mut rect).is_ok();

        let fg_mon = MonitorFromWindow(fg, MONITOR_DEFAULTTONEAREST);
        let widget_mon = widget_hwnd.map(|h| MonitorFromWindow(h, MONITOR_DEFAULTTONEAREST));
        // Unknown widget monitor → assume shared: better a false conceal
        // candidate (hysteresis + matrix will tell) than a fullscreen game
        // ignored because the widget handle wasn't resolvable for a tick.
        let on_widget_monitor = widget_mon.map_or(true, |wm| wm.0 == fg_mon.0);

        let mut mi = MONITORINFO {
            cbSize: std::mem::size_of::<MONITORINFO>() as u32,
            ..Default::default()
        };
        let mi_ok = GetMonitorInfoW(fg_mon, &mut mi).as_bool();

        let rect_verdict = if is_self {
            "self"
        } else if is_shell {
            "shell"
        } else if !(rect_ok && mi_ok) {
            "none"
        } else if covers(&rect, &mi.rcMonitor) {
            "fullscreen"
        } else if covers(&rect, &mi.rcWork) {
            // Maximized covers the WORK AREA but not the monitor (taskbar
            // height difference). Caveat: an auto-hidden taskbar makes the
            // two rects equal — measured in the matrix.
            "maximized"
        } else {
            "windowed"
        };

        // Instantaneous fullscreen verdict:
        //   - rect fullscreen on the widget's monitor (borderless/games), or
        //   - a global QUNS fullscreen/presentation state (exclusive D3D,
        //     PowerPoint-style presenting).
        // QUNS_BUSY is deliberately NOT here: the alt-tab task switcher
        // reports BUSY (measured in the P0 spike), so BUSY alone would flap
        // on every alt-tab. The matrix decides if it earns a place in P1.
        let fs_raw = (rect_verdict == "fullscreen" && on_widget_monitor)
            || quns == 3  // RUNNING_D3D_FULL_SCREEN
            || quns == 4; // PRESENTATION_MODE

        Some(PresenceDebug {
            fg_exe: exe_name(pid),
            fg_class: class,
            fg_pid: pid,
            rect_verdict,
            on_widget_monitor,
            quns,
            quns_name: quns_name(quns),
            idle_s,
            fs_raw,
            fs_settled: false, // filled by the loop after hysteresis
            user: "",          // filled by the loop
            work_duty: 0.0,    // filled by the loop
        })
    }
}

/// Spawn the presence watcher thread. Senses every second, settles the
/// fullscreen signal through enter/exit hysteresis, derives the user state,
/// and emits "presence" diff-suppressed (plus "presence-debug" raw while the
/// debug flag is on). P0: no actions.
pub fn spawn(app: AppHandle) {
    std::thread::spawn(move || {
        let own_pid = std::process::id();
        let mut fs_settled = false;
        // Consecutive milliseconds the raw verdict has disagreed with the
        // settled one; flips the settled state once past the threshold.
        let mut disagree_ms: u64 = 0;
        // Working-detection ring: one bool per second — did that second see
        // fresh input? Holds (doesn't advance) across secure-desktop gaps,
        // like every other derived state.
        let mut work_ring = [false; WORK_WINDOW_S];
        let mut work_i: usize = 0;
        let mut work_filled: usize = 0;
        loop {
            let widget_hwnd = app
                .get_webview_window("main")
                .and_then(|w| w.hwnd().ok())
                .map(|h| HWND(h.0));

            let sampled = sample(widget_hwnd, own_pid);
            // No foreground window (secure desktop): hold every derived
            // state exactly where it was — emit nothing, decide nothing.
            let Some(mut dbg) = sampled else {
                // Also drop any accumulated hysteresis credit: pre-gap
                // disagreement must not let one post-unlock tick flip the
                // settled state early — the full window restarts (conservative
                // in both directions; quick-review catch, 2026-07-09).
                disagree_ms = 0;
                std::thread::sleep(Duration::from_millis(PRESENCE_POLL_MS));
                continue;
            };

            let presence_st = app.state::<Presence>();
            if presence_st.sim_fs_active() {
                dbg.fs_raw = true;
            }

            if dbg.fs_raw != fs_settled {
                disagree_ms += PRESENCE_POLL_MS;
                let needed = if fs_settled { FS_EXIT_MS } else { FS_ENTER_MS };
                if disagree_ms >= needed {
                    fs_settled = dbg.fs_raw;
                    disagree_ms = 0;
                }
            } else {
                disagree_ms = 0;
            }

            work_ring[work_i] = dbg.idle_s == 0;
            work_i = (work_i + 1) % WORK_WINDOW_S;
            work_filled = (work_filled + 1).min(WORK_WINDOW_S);
            let duty =
                work_ring.iter().filter(|b| **b).count() as f32 / WORK_WINDOW_S as f32;
            let working = work_filled == WORK_WINDOW_S && duty >= WORK_DUTY;

            let user = if dbg.idle_s >= AWAY_AFTER_S {
                "away"
            } else if working {
                "working"
            } else {
                "active"
            };

            // P1 — courtesy conceal, the engine's only action: settled
            // fullscreen (companion on) hides the native window; episode end
            // restores it and clears any manual-show snooze. All show/hide
            // flows through apply_visibility, so a manual hide stays sticky
            // and a snoozed episode stays visible without special cases here.
            let vis = app.state::<crate::VisIntent>();
            let companion = vis.companion.load(Ordering::Relaxed);
            let mut restore_pending = false;
            if fs_settled && companion {
                // Defer (not skip) while a press is in flight: hiding the
                // window mid-drag would yank it out from under the hand —
                // the next 1s tick conceals once the button is up.
                if !vis.concealed.load(Ordering::Relaxed) && !crate::dock::primary_button_down() {
                    vis.concealed.store(true, Ordering::Relaxed);
                    crate::apply_visibility(&app);
                }
            } else if vis.concealed.load(Ordering::Relaxed) {
                vis.concealed.store(false, Ordering::Relaxed);
                vis.conceal_snoozed.store(false, Ordering::Relaxed);
                // Restore AFTER the emit below: the still-hidden webview
                // gets the new state first (override layout applies while
                // nothing is visible), so the show can't flash the loud
                // mode for a beat before re-quieting under the user's eye
                // (quick-review catch, 2026-07-09). Hides stay immediate —
                // there's nothing to mis-show on the way out.
                restore_pending = true;
            }

            let state = PresenceState {
                fullscreen: fs_settled,
                user,
                // "The engine is currently hiding the window": a snoozed
                // episode is fullscreen but NOT concealed.
                concealed: vis.concealed.load(Ordering::Relaxed)
                    && !vis.conceal_snoozed.load(Ordering::Relaxed),
            };

            let presence = app.state::<Presence>();
            {
                let mut last = presence.last.lock().unwrap_or_else(PoisonError::into_inner);
                if *last != Some(state) {
                    eprintln!(
                        "presence: fullscreen={} user={} (fg={} rect={} quns={} idle={}s)",
                        state.fullscreen,
                        state.user,
                        dbg.fg_exe,
                        dbg.rect_verdict,
                        dbg.quns_name,
                        dbg.idle_s
                    );
                    let _ = app.emit("presence", &state);
                    *last = Some(state);
                }
            }

            if restore_pending {
                crate::apply_visibility(&app);
            }

            if presence.debug.load(Ordering::Relaxed) {
                dbg.fs_settled = fs_settled;
                dbg.user = user;
                dbg.work_duty = duty;
                let _ = app.emit("presence-debug", &dbg);
            }

            std::thread::sleep(Duration::from_millis(PRESENCE_POLL_MS));
        }
    });
}
