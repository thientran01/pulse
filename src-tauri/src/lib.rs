mod audio;
mod lyrics;
mod media;

use media::ArtCache;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::sync::Mutex;
use std::time::Duration;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

const POLL_INTERVAL_MS: u64 = 500;
// Keep in sync with SEEK_STEP_MS in src/App.tsx (UI buttons) — this one drives
// the global hotkeys.
const SEEK_STEP_MS: i64 = 10_000;

// V1 hotkeys — constants for now, a settings surface later.
// NOTE: ctrl+alt+space is already taken system-wide on Thien's machine.
const HK_PLAY_PAUSE: &str = "ctrl+alt+k";
const HK_SEEK_BACK: &str = "ctrl+alt+left";
const HK_SEEK_FWD: &str = "ctrl+alt+right";
const HK_NEXT: &str = "ctrl+alt+n";
const HK_PREV: &str = "ctrl+alt+p";
const HK_TOGGLE: &str = "ctrl+alt+m";

#[tauri::command]
fn media_play_pause(app: AppHandle) -> bool {
    let ok = media::play_pause();
    emit_now(&app);
    ok
}

#[tauri::command]
fn media_next(app: AppHandle) -> bool {
    let ok = media::next();
    emit_now(&app);
    ok
}

#[tauri::command]
fn media_prev(app: AppHandle) -> bool {
    let ok = media::prev();
    emit_now(&app);
    ok
}

#[tauri::command]
fn media_seek_rel(app: AppHandle, delta_ms: i64) -> bool {
    let ok = media::seek_rel_ms(delta_ms);
    emit_now(&app);
    ok
}

#[tauri::command]
fn media_seek_abs(app: AppHandle, position_ms: i64) -> bool {
    let ok = media::seek_abs_ms(position_ms);
    emit_now(&app);
    ok
}

/// The frontend's vote on audio reactivity (false under OS reduced-motion) —
/// ANDed into the capture switch so suppressed visuals also stop the capture.
struct UiReactive(Arc<AtomicBool>);

#[tauri::command]
fn set_reactive_enabled(enabled: bool, state: State<UiReactive>) {
    state.0.store(enabled, Ordering::Relaxed);
}

/// Fetch synced/plain lyrics for a track (LRCLIB + disk cache). Blocking
/// network call — Tauri runs sync commands on a worker thread.
#[tauri::command]
fn media_lyrics(
    app: AppHandle,
    artist: String,
    title: String,
    album: String,
    duration_ms: i64,
) -> lyrics::Lyrics {
    let dir = app
        .path()
        .app_data_dir()
        .map(|d| d.join("lyrics"))
        .unwrap_or_else(|_| std::env::temp_dir().join("pulse-lyrics"));
    lyrics::fetch(&dir, &artist, &title, &album, duration_ms)
}

/// Return the cached art data URL if it matches the requested id.
#[tauri::command]
fn media_art(art_id: String, cache: State<ArtCache>) -> Option<String> {
    let cache = cache.0.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    cache
        .as_ref()
        .filter(|e| e.key == art_id)
        .and_then(|e| e.url.clone())
}

fn emit_now(app: &AppHandle) -> media::NowPlaying {
    let cache = app.state::<ArtCache>();
    let payload = media::snapshot(&cache);
    let _ = app.emit("now-playing", payload.clone());
    payload
}

fn toggle_widget(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        match win.is_visible() {
            Ok(true) => {
                let _ = win.hide();
            }
            _ => {
                let _ = win.show();
                // The poll loop skips hidden windows — refresh immediately on show.
                emit_now(app);
            }
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(
            tauri_plugin_window_state::Builder::new()
                .with_state_flags(tauri_plugin_window_state::StateFlags::POSITION)
                .build(),
        )
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .manage(ArtCache(Mutex::new(None)))
        .manage(UiReactive(Arc::new(AtomicBool::new(true))))
        .invoke_handler(tauri::generate_handler![
            media_play_pause,
            media_next,
            media_prev,
            media_seek_rel,
            media_seek_abs,
            media_art,
            media_lyrics,
            set_reactive_enabled
        ])
        .setup(|app| {
            // Tray: Show/Hide + Quit.
            let show_hide = MenuItem::with_id(app, "toggle", "Show / Hide", true, None::<&str>)?;
            // Recovery for a position persisted on a now-disconnected monitor —
            // the window is chromeless and skips the taskbar, so this is the
            // only way to pull it back on-screen.
            let center = MenuItem::with_id(app, "center", "Center on screen", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit Pulse", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_hide, &center, &quit])?;
            TrayIconBuilder::with_id("pulse-tray")
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("Pulse")
                .menu(&menu)
                .show_menu_on_left_click(true)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "toggle" => toggle_widget(app),
                    "center" => {
                        if let Some(win) = app.get_webview_window("main") {
                            let _ = win.show();
                            let _ = win.center();
                        }
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .build(app)?;

            // Global hotkeys, each with its own action.
            type Action = fn(&AppHandle);
            let hotkeys: [(&str, Action); 6] = [
                (HK_PLAY_PAUSE, |app| {
                    media::play_pause();
                    emit_now(app);
                }),
                (HK_SEEK_BACK, |app| {
                    media::seek_rel_ms(-SEEK_STEP_MS);
                    emit_now(app);
                }),
                (HK_SEEK_FWD, |app| {
                    media::seek_rel_ms(SEEK_STEP_MS);
                    emit_now(app);
                }),
                (HK_NEXT, |app| {
                    media::next();
                    emit_now(app);
                }),
                (HK_PREV, |app| {
                    media::prev();
                    emit_now(app);
                }),
                (HK_TOGGLE, toggle_widget),
            ];
            for (hk, action) in hotkeys {
                let result = app.global_shortcut().on_shortcut(hk, move |app, _s, event| {
                    if event.state() == ShortcutState::Pressed {
                        action(app);
                    }
                });
                if let Err(e) = result {
                    eprintln!("hotkey {hk} failed to register: {e}");
                }
            }

            // Audio-reactive capture switch: on ONLY while visible AND playing
            // (plan M4 — a hidden or paused widget does zero audio work).
            let audio_switch = Arc::new(AtomicBool::new(false));
            audio::spawn(app.handle().clone(), audio_switch.clone());
            let ui_reactive = app.state::<UiReactive>().0.clone();

            // Media poll loop → "now-playing" events. Skips all work while the
            // widget is hidden (toggle_widget emits fresh state on show).
            // NOTE: is_visible() is "not hidden/minimized", not "unoccluded" —
            // a fully covered widget still captures. Occlusion detection isn't
            // exposed through Tauri; accepted for v1.
            let handle = app.handle().clone();
            std::thread::spawn(move || loop {
                let visible = handle
                    .get_webview_window("main")
                    .and_then(|w| w.is_visible().ok())
                    .unwrap_or(true);
                let playing = if visible {
                    emit_now(&handle).status == "playing"
                } else {
                    false
                };
                let reactive = ui_reactive.load(Ordering::Relaxed);
                audio_switch.store(visible && playing && reactive, Ordering::Relaxed);
                std::thread::sleep(Duration::from_millis(POLL_INTERVAL_MS));
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
