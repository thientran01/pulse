/*
 * Focus mode — the fullscreen now-playing takeover (design "B1"). A
 * user-invoked, TRANSIENT second window: the expanded view's expand bracket
 * (labeled "Expand to focus") opens it, Esc / its collapse control /
 * Alt-F4 close it, and closing returns the main widget to its EXACT prior
 * intent (VisIntent.focus_open composes into effective_visible; the flag is
 * memory-only, so a relaunch can never boot into focus).
 *
 * Create-on-open, destroy-on-close — unlike the search window's create-once
 * (summon latency matters there; a deliberate takeover can afford the
 * cold-create, masked by the frontend's arrival fade), and destroy keeps
 * the lifecycle state impossible to corrupt. The label-filtered Destroyed
 * handler in lib.rs is the SINGLE cleanup point: it clears focus_open and
 * re-applies visibility, so Esc, the collapse control, and OS teardown all
 * converge on one path.
 *
 * This is the doctrine-legal reincarnation of what the removed P3
 * ambient-grow was groping toward: the same "bigger surface while I'm
 * around but not driving" want, INVOKED deliberately instead of guessed
 * from idle timers. It inherits the search window's multi-window seams
 * (capabilities label, window-state denylist, Moved guard, per-window
 * reactive votes) and adds the two gates that windows born after "main"
 * need: the media loop's `visible` and the audio capture switch both widen
 * to "main OR focus" (lib.rs) — without that, hiding main behind focus
 * froze the player and killed the visualizer (verified in planning).
 *
 * The window is born fullscreen on the main widget's monitor and never
 * resized (house rule; a DIFFERENT window born at size is legal — the
 * never-resize doctrine is about animating a live window's bounds).
 */
use std::sync::atomic::Ordering;

use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

use crate::{apply_visibility, VisIntent};

pub const LABEL: &str = "focus";

/// Open the takeover: build the window fullscreen-at-birth on the main
/// widget's monitor, flag the intent, yield the widget.
#[tauri::command]
pub async fn focus_open(app: AppHandle) {
    if let Some(win) = app.get_webview_window(LABEL) {
        // Already open (double-click on the bracket) — front it. If it's a
        // mid-teardown corpse (Esc→reopen race, the destroy hasn't drained),
        // this no-ops and the click is lost; rare, self-heals, accepted.
        let _ = win.set_focus();
        return;
    }
    let result = WebviewWindowBuilder::new(
        &app,
        LABEL,
        WebviewUrl::App("index.html?window=focus".into()),
    )
    .title("Palette Focus")
    .decorations(false)
    // UNLIKE the widget/search window (chromeless floating surfaces that skip the
    // taskbar), focus mode is a fullscreen view the user actively works in
    // and Alt+Tabs away from — it MUST stay in the taskbar + Alt+Tab
    // switcher. With skip_taskbar it dropped behind whatever you switched to
    // with no way back (not in the switcher, not on the taskbar), leaving
    // only the Pulse hotkey — which closes focus rather than restoring it
    // (Thien, 2026-07-12). It is not always-on-top on purpose: switching to
    // another app should surface that app, and Alt+Tab brings focus back.
    .resizable(false)
    .maximizable(false)
    .minimizable(false)
    // Born hidden so the position → fullscreen → show sequence below is
    // deterministic (fullscreen takes the window's CURRENT monitor).
    .visible(false)
    .build();
    match result {
        Ok(win) => {
            // Same monitor as the widget (derive, don't assume — even on
            // today's single-monitor machine).
            if let Some(pos) = app
                .get_webview_window("main")
                .and_then(|m| m.outer_position().ok())
            {
                let _ = win.set_position(pos);
            }
            let _ = win.set_fullscreen(true);
            // The widget yields only for a takeover that actually appeared:
            // a failed show() with the flag set would leave NOTHING on
            // screen, and only the focus window's Destroyed event clears
            // the flag (quick-review catch; Ctrl+Alt+M carries a recovery
            // path regardless).
            if win.show().is_err() {
                log::error!("focus: show failed — aborting the takeover");
                let _ = win.destroy();
                return;
            }
            let _ = win.set_focus();
            app.state::<VisIntent>().focus_open.store(true, Ordering::Relaxed);
            apply_visibility(&app);
        }
        Err(e) => {
            log::error!("focus: window create failed: {e}");
        }
    }
}

/// Close = destroy; the Destroyed handler (lib.rs) clears focus_open and
/// restores the widget — one cleanup path for Esc, collapse, and Alt-F4.
#[tauri::command]
pub async fn focus_close(app: AppHandle) {
    if let Some(win) = app.get_webview_window(LABEL) {
        let _ = win.destroy();
    }
}

/// The Destroyed-event cleanup (called from lib.rs's window-event handler).
pub fn on_destroyed(app: &AppHandle) {
    app.state::<VisIntent>().focus_open.store(false, Ordering::Relaxed);
    apply_visibility(app);
}
