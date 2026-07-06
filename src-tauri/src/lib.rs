mod media;

use media::ArtCache;
use std::sync::Mutex;
use std::time::Duration;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

const POLL_INTERVAL_MS: u64 = 500;
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

/// Return the cached art data URL if it matches the requested id.
#[tauri::command]
fn media_art(art_id: String, cache: State<ArtCache>) -> Option<String> {
    let cache = cache.0.lock().unwrap();
    cache
        .as_ref()
        .filter(|(id, _)| *id == art_id)
        .map(|(_, url)| url.clone())
}

fn emit_now(app: &AppHandle) {
    let cache = app.state::<ArtCache>();
    let payload = media::snapshot(&cache);
    let _ = app.emit("now-playing", payload);
}

fn toggle_widget(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        match win.is_visible() {
            Ok(true) => {
                let _ = win.hide();
            }
            _ => {
                let _ = win.show();
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
        .invoke_handler(tauri::generate_handler![
            media_play_pause,
            media_next,
            media_prev,
            media_seek_rel,
            media_seek_abs,
            media_art
        ])
        .setup(|app| {
            // Tray: Show/Hide + Quit.
            let show_hide = MenuItem::with_id(app, "toggle", "Show / Hide", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit Pulse", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_hide, &quit])?;
            TrayIconBuilder::with_id("pulse-tray")
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("Pulse")
                .menu(&menu)
                .show_menu_on_left_click(true)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "toggle" => toggle_widget(app),
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

            // Media poll loop → "now-playing" events.
            let handle = app.handle().clone();
            std::thread::spawn(move || loop {
                emit_now(&handle);
                std::thread::sleep(Duration::from_millis(POLL_INTERVAL_MS));
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
