mod audio;
mod dock;
mod lyrics;
mod media;

use media::ArtCache;
use serde::Serialize;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::sync::Mutex;
use std::time::Duration;
use tauri::menu::{CheckMenuItem, Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_autostart::ManagerExt as _;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

const POLL_INTERVAL_MS: u64 = 500;
// After a GSMTC event wakes the media loop, wait this long and drain the
// channel before snapshotting — players fire several events per track change
// (title, then artist, then thumbnail) and one emit should cover the burst.
const EVENT_SETTLE_MS: u64 = 30;
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

// Every command that touches GSMTC (or the network) is `async` — NOT for
// concurrency, but to move it OFF the main thread. Tauri runs sync commands
// on the webview IPC (main/STA) thread, where WinRT's blocking `.get()` can
// never observe its completion (the STA is parked in the wait) — a cold-cache
// snapshot there deadlocks the whole app. Async commands run on the async
// runtime's worker pool, where blocking waits complete normally.

#[tauri::command]
async fn media_play_pause(app: AppHandle) -> bool {
    let ok = media::play_pause();
    emit_now(&app);
    ok
}

#[tauri::command]
async fn media_next(app: AppHandle) -> bool {
    let ok = media::next();
    emit_now(&app);
    ok
}

#[tauri::command]
async fn media_prev(app: AppHandle) -> bool {
    let ok = media::prev();
    emit_now(&app);
    ok
}

// The seek commands deliberately do NOT snapshot afterwards: the player hasn't
// applied the seek yet, so an immediate emit carries the PRE-seek position and
// visibly snaps the UI back to the old spot (worst on lyrics click-to-seek).
// The next heartbeat/event delivers the post-seek timeline within ~500ms.

#[tauri::command]
async fn media_seek_rel(delta_ms: i64) -> bool {
    media::seek_rel_ms(delta_ms)
}

#[tauri::command]
async fn media_seek_abs(position_ms: i64) -> bool {
    media::seek_abs_ms(position_ms)
}

/// The frontend's vote on audio reactivity (false under OS reduced-motion) —
/// ANDed into the capture switch so suppressed visuals also stop the capture.
struct UiReactive(Arc<AtomicBool>);

#[tauri::command]
fn set_reactive_enabled(enabled: bool, state: State<UiReactive>) {
    state.0.store(enabled, Ordering::Relaxed);
}

/// Fetch synced/plain lyrics for a track (LRCLIB + disk cache). Worst case
/// ~45s of blocking network I/O (three sequential 15s-timeout calls), so the
/// fetch runs on tokio's dedicated blocking pool — an async worker occupied
/// that long would contend with every other command on the small shared pool.
#[tauri::command]
async fn media_lyrics(
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
    tauri::async_runtime::spawn_blocking(move || {
        lyrics::fetch(&dir, &artist, &title, &album, duration_ms)
    })
    .await
    // Join error = the fetch panicked; degrade to a miss, not a dead IPC
    // call — but say so, or a release build swallows the panic invisibly.
    .unwrap_or_else(|e| {
        eprintln!("lyrics fetch panicked: {e}");
        lyrics::Lyrics::default()
    })
}

/// Return the cached art data URL if it matches the requested id
/// (`"{key}:{rev}"` — rev bumps when probing catches a stale first read).
#[tauri::command]
async fn media_art(app: AppHandle, art_id: String) -> Option<String> {
    media::art_url(&app.state::<ArtCache>(), &art_id)
}

/// One-shot state read for webview mount/reload. Emits are diff-suppressed,
/// so a freshly loaded webview cannot count on an event ever arriving — it
/// seeds from this instead. Snapshot + seq happen under the same LastEmit
/// lock as emits, so seed seq order is linearized with emit seq order and the
/// frontend clock's seq guard can trust either source.
#[tauri::command]
async fn now_playing(app: AppHandle) -> Stamped {
    let cache = app.state::<ArtCache>();
    let last = app.state::<LastEmit>();
    let _guard = last.0.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    Stamped {
        seq: SEQ.fetch_add(1, Ordering::Relaxed),
        now: media::snapshot(&cache),
    }
}

/// Monotonic stamp on every now-playing payload. No consumer yet — the
/// position clock kernel (next PR) uses it to drop stale/out-of-order
/// payloads instead of trusting IPC delivery order. Ordering invariant
/// established here: seq is assigned in the same critical section as the
/// snapshot AND the emit, so higher seq == later snapshot == later emit.
static SEQ: AtomicU64 = AtomicU64::new(1);

#[derive(Serialize, Clone)]
struct Stamped {
    seq: u64,
    #[serde(flatten)]
    now: media::NowPlaying,
}

/// Last payload emitted. Raw pairs make unchanged GSMTC data byte-identical,
/// so suppressing equal payloads costs nothing and zeroes idle/paused IPC —
/// and every suppressed emit is also one less regression lottery ticket for
/// the position pipeline (ad-hoc emit_now callers included).
struct LastEmit(Mutex<Option<media::NowPlaying>>);

fn emit_now(app: &AppHandle) -> media::NowPlaying {
    let cache = app.state::<ArtCache>();
    let last = app.state::<LastEmit>();
    // Snapshot INSIDE the lock: concurrent callers (media loop, commands,
    // hotkeys, tray) serialize here, so an older snapshot can never be
    // emitted after — or seq-stamped above — a newer one.
    let mut last = last.0.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    let np = media::snapshot(&cache);
    if last.as_ref() != Some(&np) {
        let stamped = Stamped {
            seq: SEQ.fetch_add(1, Ordering::Relaxed),
            now: np.clone(),
        };
        let _ = app.emit("now-playing", &stamped);
        *last = Some(stamped.now);
    }
    np
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
        // Registered first so a second launch (Start menu, installer's "run
        // app" checkbox) hands off before any other plugin does work: the new
        // process exits and the running widget surfaces instead.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.show();
                let _ = win.set_focus();
                // This callback runs in a WndProc on the main/STA thread
                // (SendMessageW from the second process) — emit_now touches
                // GSMTC, which must never block there (see the async-command
                // note above). Defer it to the async pool like the commands.
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    emit_now(&app);
                });
            }
        }))
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(tauri_plugin_opener::init())
        .plugin(
            tauri_plugin_window_state::Builder::new()
                .with_state_flags(tauri_plugin_window_state::StateFlags::POSITION)
                .build(),
        )
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .manage(ArtCache(Mutex::new(None)))
        .manage(LastEmit(Mutex::new(None)))
        .manage(UiReactive(Arc::new(AtomicBool::new(true))))
        .manage(dock::Dock::default())
        .invoke_handler(tauri::generate_handler![
            media_play_pause,
            media_next,
            media_prev,
            media_seek_rel,
            media_seek_abs,
            media_art,
            media_lyrics,
            now_playing,
            set_reactive_enabled,
            dock::set_window_size,
            dock::start_drag
        ])
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Moved(_) = event {
                dock::on_moved(window);
            }
        })
        .setup(|app| {
            // Tray: Show/Hide + Quit.
            let show_hide = MenuItem::with_id(app, "toggle", "Show / Hide", true, None::<&str>)?;
            // Manual re-dock (bottom-right). Launch snapping already heals
            // positions persisted on a now-disconnected monitor; this is the
            // belt-and-braces path for a chromeless, taskbar-less window.
            let reset = MenuItem::with_id(app, "reset", "Reset position", true, None::<&str>)?;
            // Opt-in launch-at-login, default off. The plugin writes the HKCU
            // Run key with the CURRENT exe's path — enabling from a dev build
            // registers the dev exe until re-toggled from the installed app.
            let autostart_on = app.autolaunch().is_enabled().unwrap_or(false);
            let autostart = CheckMenuItem::with_id(
                app,
                "autostart",
                "Start at login",
                true,
                autostart_on,
                None::<&str>,
            )?;
            let quit = MenuItem::with_id(app, "quit", "Quit Pulse", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_hide, &reset, &autostart, &quit])?;
            let autostart_item = autostart.clone();
            TrayIconBuilder::with_id("pulse-tray")
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("Pulse")
                .menu(&menu)
                .show_menu_on_left_click(true)
                .on_menu_event(move |app, event| match event.id.as_ref() {
                    "toggle" => toggle_widget(app),
                    "reset" => dock::reset_position(app),
                    "autostart" => {
                        let al = app.autolaunch();
                        let result = if al.is_enabled().unwrap_or(false) {
                            al.disable()
                        } else {
                            al.enable()
                        };
                        if let Err(e) = result {
                            eprintln!("autostart toggle failed: {e}");
                        }
                        // The menu item flips itself on click; re-sync it to
                        // the registry's actual state so a failed toggle
                        // doesn't leave the checkmark lying.
                        let _ = autostart_item.set_checked(al.is_enabled().unwrap_or(false));
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
                // Seek hotkeys: no post-seek emit for the same reason as the
                // seek commands — it would carry the pre-seek position.
                (HK_SEEK_BACK, |_app| {
                    media::seek_rel_ms(-SEEK_STEP_MS);
                }),
                (HK_SEEK_FWD, |_app| {
                    media::seek_rel_ms(SEEK_STEP_MS);
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

            // Media loop → "now-playing" events: a heartbeat poll plus GSMTC
            // change events that cut the wait short, so track changes,
            // play/pause, and thumbnail attaches reach the UI within ~50ms
            // instead of up to a full interval later. Skips all work while the
            // widget is hidden (toggle_widget emits fresh state on show).
            // NOTE: is_visible() is "not hidden/minimized", not "unoccluded" —
            // a fully covered widget still captures. Occlusion detection isn't
            // exposed through Tauri; accepted for v1.
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                let (wake_tx, wake_rx) = std::sync::mpsc::channel::<media::Wake>();
                // None → GSMTC unavailable; the loop degrades to pure polling.
                let mut watch = media::SessionWatch::new(wake_tx);
                let mut resubscribe = true;
                // Event wakes force a full snapshot; heartbeat ticks first
                // probe tick_key and skip the snapshot (metadata marshal, art
                // work, emit) when nothing moved — except while the art probe
                // window is open, which needs every tick.
                let mut force_snapshot = true;
                let mut last_tick: Option<media::TickKey> = None;
                loop {
                    if let Some(w) = watch.as_mut() {
                        w.resubscribe(std::mem::take(&mut resubscribe));
                    }
                    let visible = handle
                        .get_webview_window("main")
                        .and_then(|w| w.is_visible().ok())
                        .unwrap_or(true);
                    let playing = if visible {
                        let tick = media::tick_key();
                        let probing = media::art_probing(&handle.state::<ArtCache>());
                        let p = if std::mem::take(&mut force_snapshot) || probing || tick != last_tick {
                            emit_now(&handle).status == "playing"
                        } else {
                            tick.as_ref().is_some_and(|k| k.3 == "playing")
                        };
                        last_tick = tick;
                        p
                    } else {
                        false
                    };
                    let reactive = ui_reactive.load(Ordering::Relaxed);
                    audio_switch.store(visible && playing && reactive, Ordering::Relaxed);
                    use std::sync::mpsc::RecvTimeoutError;
                    match wake_rx.recv_timeout(Duration::from_millis(POLL_INTERVAL_MS)) {
                        Ok(first) => {
                            let mut changed = matches!(first, media::Wake::SessionChanged);
                            std::thread::sleep(Duration::from_millis(EVENT_SETTLE_MS));
                            while let Ok(w) = wake_rx.try_recv() {
                                changed |= matches!(w, media::Wake::SessionChanged);
                            }
                            resubscribe = changed;
                            force_snapshot = true;
                        }
                        Err(RecvTimeoutError::Timeout) => {}
                        // Only reachable when SessionWatch never constructed
                        // (it owns the last sender) — plain sleep poll.
                        Err(RecvTimeoutError::Disconnected) => {
                            std::thread::sleep(Duration::from_millis(POLL_INTERVAL_MS));
                        }
                    }
                }
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
