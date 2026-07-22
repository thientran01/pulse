/*
 * The preferences window (Milestone C) — Pulse's third webview, on the proven
 * multi-window pattern (search.rs pioneered it, focus.rs reuses it). UNLIKE
 * the widget/search window (chromeless, transparent, always-on-top, click-through)
 * this is a NORMAL desktop window: opaque, frameless, 720×560, non-resizable,
 * NOT always-on-top, in the taskbar/Alt-Tab. It opens rarely, so it is
 * CREATE-ON-OPEN + DESTROY-ON-CLOSE (focus.rs's lifecycle, not the search window's
 * create-once-hidden — no reason to hold a third resident webview).
 *
 * Multi-window invariants this window inherits (grep anchors, see search.rs):
 * capabilities/default.json lists "prefs" (a missing label = ZERO IPC,
 * silently); window-state's denylist excludes it (it recenters on the cursor
 * monitor per open, never restores a stale position); dock's Moved forwarding
 * and the presence conceal are label-guarded to "main", so this window never
 * joins the dock/corner/hit-watcher machinery.
 *
 * This module owns the window lifecycle plus the settings-read seam the UI
 * mounts from (prefs_seed) and the small data/connector commands. The hotkey
 * rebinding machinery lives in lib.rs, co-located with the HK_* defaults and
 * the global-shortcut registration it re-runs.
 */
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_autostart::ManagerExt as _;
use tauri_plugin_opener::OpenerExt;

pub const LABEL: &str = "prefs";
/// Born at this logical size, never resized (house rule; a window born at size
/// is never-resize-legal, unlike animating a live window's bounds).
const W: f64 = 720.0;
const H: f64 = 560.0;

const SECTIONS: [&str; 6] = [
    "connectors",
    "hotkeys",
    "playback",
    "general",
    "about",
    "data",
];

fn valid_section(s: &str) -> bool {
    SECTIONS.contains(&s)
}

/// Open (or focus, if already open) the prefs window at an optional section.
/// The initial section rides the builder URL so the mount reads it without an
/// event race; an already-open window is nudged over a "prefs-section" event
/// (its listener is live by then).
pub fn open(app: &AppHandle, section: Option<String>) {
    let section = section.filter(|s| valid_section(s));
    if let Some(win) = app.get_webview_window(LABEL) {
        let _ = win.unminimize();
        let _ = win.set_focus();
        if let Some(s) = section {
            let _ = app.emit_to(LABEL, "prefs-section", s);
        }
        return;
    }
    let url = match &section {
        Some(s) => format!("index.html?window=prefs&section={s}"),
        None => "index.html?window=prefs".to_string(),
    };
    let result = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App(url.into()))
        .title("Palette — Preferences")
        .inner_size(W, H)
        // Frameless + opaque + a normal window (NOT the widget's transparent,
        // click-through, always-on-top model): it belongs in the taskbar and
        // Alt-Tab so a user can find it like any settings window.
        .decorations(false)
        .resizable(false)
        .maximizable(false)
        // Born hidden so the recenter lands before the first paint shows.
        .visible(false)
        .build();
    match result {
        Ok(win) => {
            // Kill the Win11 accent-colored window border DWM draws around a
            // frameless opaque window (a stray blue hairline). Mirrors
            // search.rs's DWMWA_TRANSITIONS_FORCEDISABLED call: get the HWND,
            // set the attribute, ignore the HRESULT.
            #[cfg(windows)]
            if let Ok(hwnd) = win.hwnd() {
                use windows::Win32::Graphics::Dwm::{DwmSetWindowAttribute, DWMWA_BORDER_COLOR};
                // DWMWA_COLOR_NONE — "no border color" (removes the accent line).
                const COLOR_NONE: u32 = 0xFFFF_FFFE;
                let _ = unsafe {
                    DwmSetWindowAttribute(
                        windows::Win32::Foundation::HWND(hwnd.0),
                        DWMWA_BORDER_COLOR,
                        std::ptr::from_ref(&COLOR_NONE).cast(),
                        std::mem::size_of::<u32>() as u32,
                    )
                };
            }
            center_on_cursor(app, &win);
            if win.show().is_err() {
                log::error!("prefs: show failed — aborting open");
                let _ = win.destroy();
                return;
            }
            let _ = win.set_focus();
        }
        Err(e) => log::error!("prefs: window create failed: {e}"),
    }
}

/// Center on the monitor under the cursor (the window doesn't remember its
/// position in v1). Physical pixels throughout; any failure falls back to a
/// plain center().
fn center_on_cursor(app: &AppHandle, win: &tauri::WebviewWindow) {
    let placed = (|| {
        let pos = win.cursor_position().ok()?;
        let mon = app.monitor_from_point(pos.x, pos.y).ok()??;
        let scale = mon.scale_factor();
        let (w, h) = ((W * scale) as i32, (H * scale) as i32);
        let x = mon.position().x + (mon.size().width as i32 - w) / 2;
        let y = mon.position().y + (mon.size().height as i32 - h) / 2;
        win.set_position(tauri::PhysicalPosition::new(x, y)).ok()
    })();
    if placed.is_none() {
        let _ = win.center();
    }
}

#[tauri::command]
pub async fn open_prefs(app: AppHandle, section: Option<String>) {
    open(&app, section);
}

/// The window's own floating × (and any programmatic close). Destroy so a
/// reopen recreates from scratch — the create-on-open/destroy-on-close
/// lifecycle keeps the window state impossible to corrupt.
#[tauri::command]
pub async fn close_prefs(app: AppHandle) {
    if let Some(win) = app.get_webview_window(LABEL) {
        let _ = win.destroy();
    }
}

/// The snapshot the prefs UI mounts from — every persisted setting the window
/// renders, plus derived state (app version, autostart registry truth, Spotify
/// connection, the resolved hotkey table). Emits are diff-suppressed elsewhere,
/// but prefs opens fresh each time and simply reads this once on mount.
#[derive(Serialize)]
pub struct PrefsSeed {
    version: String,
    reactive_separator: bool,
    launch_mode: String,
    start_at_login: bool,
    hide_on_fullscreen: bool,
    spotify_connected: bool,
    lastfm_api_key: String,
    seen_intro: bool,
    hotkeys: Vec<crate::HotkeyInfo>,
}

#[tauri::command]
pub async fn prefs_seed(app: AppHandle) -> PrefsSeed {
    use crate::settings;
    PrefsSeed {
        version: app.package_info().version.to_string(),
        reactive_separator: settings::get_bool(&app, "reactive_separator", true),
        launch_mode: settings::get_string(&app, "launch_mode")
            .unwrap_or_else(|| "card".to_string()),
        start_at_login: app.autolaunch().is_enabled().unwrap_or(false),
        // Persisted under the legacy "companion" key (the fullscreen-conceal
        // switch; the tray label reads "Hide on fullscreen").
        hide_on_fullscreen: settings::get_bool(&app, "companion", true),
        spotify_connected: crate::spotify::connected(&app),
        lastfm_api_key: settings::get_string(&app, "lastfm_api_key").unwrap_or_default(),
        seen_intro: settings::get_bool(&app, "seenIntro", false),
        hotkeys: crate::hotkey_snapshot(&app),
    }
}

/// Keys the generic persist seam (`set_setting`) is allowed to write — the
/// inert settings the prefs UI legitimately touches. DELIBERATELY excludes the
/// security-relevant / side-effecting keys ("companion" fullscreen conceal,
/// "hotkeys", autostart): those have their own typed setters that keep the
/// tray mirror and geometry in sync, and the generic seam must never be a
/// back door around them.
const SETTABLE_KEYS: [&str; 4] = [
    "reactive_separator",
    "launch_mode",
    "lastfm_api_key",
    "seenIntro",
];
/// Generous per-write ceiling on the serialized value — a real setting here is
/// a bool, a short mode string, or a ~32-char API key; anything past this is a
/// bloat attempt (settings.json is re-parsed on every read).
const MAX_SETTING_BYTES: usize = 4096;

/// The generic persist seam for the frontend's INERT settings (settings.rs is
/// already atomic). Hardened as defense-in-depth — the frontend is first-party
/// behind CSP, but a future renderer compromise must not clobber a
/// security-relevant key or bloat the file: the key is ALLOW-LISTED against
/// SETTABLE_KEYS and the serialized value length is capped, anything else is
/// rejected with an Err. Settings with a live side effect (autostart, the
/// fullscreen conceal) still go through their own commands so the tray mirror
/// stays in sync. The "settings-changed" event lets any other open surface
/// reflect the write.
#[tauri::command]
pub async fn set_setting(
    app: AppHandle,
    key: String,
    value: serde_json::Value,
) -> Result<(), String> {
    if !SETTABLE_KEYS.contains(&key.as_str()) {
        log::warn!("set_setting: rejected non-allow-listed key {key:?}");
        return Err(format!("key not settable: {key}"));
    }
    if value.to_string().len() > MAX_SETTING_BYTES {
        log::warn!("set_setting: rejected oversized value for key {key:?}");
        return Err("value too large".to_string());
    }
    crate::settings::set_value(&app, &key, value.clone());
    let _ = app.emit(
        "settings-changed",
        serde_json::json!({ "key": key, "value": value }),
    );
    Ok(())
}

/// Validate a Last.fm API key against the live service (lastfm.rs). "ok" |
/// "invalid" (key rejected) | "offline" (transport/5xx). Blocking HTTP on the
/// dedicated pool, per the lyrics.rs/spotify.rs discipline.
#[tauri::command]
pub async fn test_lastfm_key(key: String) -> String {
    tauri::async_runtime::spawn_blocking(move || crate::lastfm::validate_key(&key).to_string())
        .await
        .unwrap_or_else(|e| {
            log::error!("lastfm validate task panicked: {e}");
            "offline".to_string()
        })
}

/// Key-presence signal — the reusable read the Connectors UI and a later
/// phase's more-like-this gate share (having a key un-dead-ends
/// recommendations).
#[tauri::command]
pub async fn lastfm_has_key(app: AppHandle) -> bool {
    crate::settings::get_string(&app, "lastfm_api_key")
        .map(|s| !s.trim().is_empty())
        .unwrap_or(false)
}

/// Open the rotating log dir in the OS file manager (the log plugin writes
/// pulse.log there). Direct Rust opener call — no webview capability needed.
#[tauri::command]
pub async fn open_logs(app: AppHandle) {
    if let Ok(dir) = app.path().app_log_dir() {
        let _ = app.opener().open_path(dir.to_string_lossy(), None::<&str>);
    }
}

/// Reveal the app-data dir (history, thumbnails, settings, tokens).
#[tauri::command]
pub async fn open_data_folder(app: AppHandle) {
    if let Ok(dir) = app.path().app_data_dir() {
        let _ = app.opener().open_path(dir.to_string_lossy(), None::<&str>);
    }
}

/// Open the source repo in the default browser (About → Source).
#[tauri::command]
pub async fn open_repo(app: AppHandle) {
    let _ = app
        .opener()
        .open_url("https://github.com/thientran01/palette", None::<&str>);
}
