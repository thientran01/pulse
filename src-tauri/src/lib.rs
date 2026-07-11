mod audio;
mod dock;
mod history;
mod lyrics;
mod media;
mod presence;
mod spotify;
mod upnext;

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

/// Visibility INTENT — the single owner of WHY the window is shown or
/// hidden. `is_visible()` stays the OS truth, but every mutation flows
/// through apply_visibility (the ONLY caller of show()/hide() — grep rule),
/// which reconciles the window to:
///   effective = !user_hidden && !(concealed && !conceal_snoozed)
pub struct VisIntent {
    /// Sticky manual hide (hotkey/tray while visible). Survives conceal
    /// episodes: a game ending must not resurrect a widget the user hid.
    pub user_hidden: AtomicBool,
    /// The presence engine's courtesy conceal (settled fullscreen).
    pub concealed: AtomicBool,
    /// Manual show DURING a conceal episode: the user summoned the widget
    /// over fullscreen content — it stays until the episode ends.
    pub conceal_snoozed: AtomicBool,
    /// Master kill switch for presence ACTIONS (tray "Companion mode",
    /// persisted in app-data settings.json): sensing continues, behaviors
    /// stop. Persisted because a setting that silently resets erodes trust.
    pub companion: AtomicBool,
}

impl Default for VisIntent {
    fn default() -> Self {
        Self {
            user_hidden: AtomicBool::new(false),
            concealed: AtomicBool::new(false),
            conceal_snoozed: AtomicBool::new(false),
            companion: AtomicBool::new(true),
        }
    }
}

impl VisIntent {
    pub fn effective_visible(&self) -> bool {
        !self.user_hidden.load(Ordering::Relaxed)
            && !(self.concealed.load(Ordering::Relaxed)
                && !self.conceal_snoozed.load(Ordering::Relaxed))
    }
}

/// Reconcile the OS window to the current intent. Safe from any thread that
/// may touch GSMTC (emit_now runs inline on show — the toggle_widget
/// precedent); from the single-instance WndProc, defer to the async pool.
pub(crate) fn apply_visibility(app: &AppHandle) {
    let Some(win) = app.get_webview_window("main") else { return };
    let want = app.state::<VisIntent>().effective_visible();
    // On an is_visible() error, assume the OPPOSITE of intent so the
    // reconcile always acts (show/hide are idempotent). A fixed default
    // could silently skip the show() that restores a concealed window —
    // the worst failure class here (quick-review catch, 2026-07-09).
    let is = win.is_visible().unwrap_or(!want);
    if want && !is {
        let _ = win.show();
        // The poll loop skips hidden windows — refresh immediately on show.
        emit_now(app);
    } else if !want && is {
        let _ = win.hide();
    }
}

fn toggle_widget(app: &AppHandle) {
    let Some(win) = app.get_webview_window("main") else { return };
    let vis = app.state::<VisIntent>();
    // Decide from what the user actually SEES, not the intent flags — this
    // self-heals any intent/OS desync. Hiding is always a user act; showing
    // during a conceal episode snoozes the conceal for that episode (the
    // widget stays over the fullscreen content until it ends).
    if win.is_visible().unwrap_or(false) {
        vis.user_hidden.store(true, Ordering::Relaxed);
    } else {
        vis.user_hidden.store(false, Ordering::Relaxed);
        if vis.concealed.load(Ordering::Relaxed) {
            vis.conceal_snoozed.store(true, Ordering::Relaxed);
        }
    }
    apply_visibility(app);
}

/// Companion-mode persistence: one tiny JSON next to the lyrics cache.
fn settings_path(app: &AppHandle) -> Option<std::path::PathBuf> {
    app.path().app_data_dir().ok().map(|d| d.join("settings.json"))
}

fn load_companion(app: &AppHandle) -> bool {
    settings_path(app)
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
        .and_then(|v| v.get("companion").and_then(|b| b.as_bool()))
        .unwrap_or(true)
}

fn save_companion(app: &AppHandle, on: bool) {
    let Some(path) = settings_path(app) else { return };
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    // In-session behavior rides the atomic either way; a failed write only
    // surfaces at next launch — say so instead of diverging silently.
    if let Err(e) = std::fs::write(path, serde_json::json!({ "companion": on }).to_string()) {
        eprintln!("companion setting not persisted: {e}");
    }
}

/// Frontend-initiated connect (the queue UI's gate state, PR 4) — same flow
/// and tray narration as the tray click (spotify.rs holds the narrator).
#[tauri::command]
async fn spotify_connect(app: AppHandle) {
    spotify::start_connect(&app);
}

/// Push a label/enabled change to a tray menu item from any thread — menu
/// items are UI objects, so writes hop to the main thread.
fn set_menu_label(
    app: &AppHandle,
    item: &tauri::menu::MenuItem<tauri::Wry>,
    text: &'static str,
    enabled: bool,
) {
    let item = item.clone();
    let _ = app.run_on_main_thread(move || {
        let _ = item.set_text(text);
        let _ = item.set_enabled(enabled);
    });
}

/// Check the latest GitHub release and install it if newer. Shared by the
/// silent launch check (feedback: None) and the tray "Check for updates"
/// entry (feedback: Some — the item's label narrates install/outcome).
/// Success normally never returns on Windows: the passive NSIS installer
/// kills this process and relaunches; restart() is the documented pattern
/// and the relaunch guarantee if the installer doesn't do it.
/// One update flow at a time — the silent launch check and a tray click can
/// otherwise race two concurrent NSIS installs. Never cleared on the install
/// path (the process dies there).
static UPDATE_IN_FLIGHT: AtomicBool = AtomicBool::new(false);

enum UpdateOutcome {
    Installed,
    UpToDate,
    /// Dev builds check but never install: the release would land in
    /// %LOCALAPPDATA%\Pulse while restart() relaunches the DEV exe.
    DevAvailable,
}

fn spawn_update_check(app: &AppHandle, feedback: Option<tauri::menu::MenuItem<tauri::Wry>>) {
    use tauri_plugin_updater::UpdaterExt;
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        if UPDATE_IN_FLIGHT
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_err()
        {
            // Another flow is mid-check/install (launch check racing a tray
            // click) — put the entry back rather than leaving "Checking…".
            if let Some(item) = &feedback {
                set_menu_label(&app, item, "Check for updates", true);
            }
            return;
        }
        let result: Result<UpdateOutcome, String> = async {
            let updater = app.updater().map_err(|e| e.to_string())?;
            match updater.check().await.map_err(|e| e.to_string())? {
                Some(update) => {
                    if cfg!(debug_assertions) {
                        return Ok(UpdateOutcome::DevAvailable);
                    }
                    if let Some(item) = &feedback {
                        set_menu_label(&app, item, "Installing update…", false);
                    }
                    update
                        .download_and_install(|_, _| {}, || {})
                        .await
                        .map_err(|e| e.to_string())?;
                    Ok(UpdateOutcome::Installed)
                }
                None => Ok(UpdateOutcome::UpToDate),
            }
        }
        .await;
        UPDATE_IN_FLIGHT.store(false, Ordering::SeqCst);
        match result {
            Ok(UpdateOutcome::Installed) => app.restart(),
            Ok(UpdateOutcome::UpToDate) => {
                if let Some(item) = &feedback {
                    set_menu_label(&app, item, "Up to date", false);
                }
            }
            Ok(UpdateOutcome::DevAvailable) => {
                if let Some(item) = &feedback {
                    set_menu_label(&app, item, "Update available (dev — not installing)", false);
                }
            }
            Err(e) => {
                eprintln!("update check failed: {e}");
                if let Some(item) = &feedback {
                    set_menu_label(&app, item, "Update failed", false);
                }
            }
        }
        // Leave the outcome readable for a beat, then restore the entry.
        if let Some(item) = feedback {
            let app = app.clone();
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_secs(4));
                set_menu_label(&app, &item, "Check for updates", true);
            });
        }
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Registered first so a second launch (Start menu, installer's "run
        // app" checkbox) hands off before any other plugin does work: the new
        // process exits and the running widget surfaces instead.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // An explicit summons: clear any manual hide and snooze an
            // active conceal episode. This callback runs in a WndProc on
            // the main/STA thread (SendMessageW from the second process) —
            // apply_visibility's emit_now touches GSMTC, which must never
            // block there (see the async-command note above), so the whole
            // reconcile defers to the async pool.
            let vis = app.state::<VisIntent>();
            vis.user_hidden.store(false, Ordering::Relaxed);
            if vis.concealed.load(Ordering::Relaxed) {
                vis.conceal_snoozed.store(true, Ordering::Relaxed);
            }
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                apply_visibility(&app);
                // Unconditional refresh, preserving the old handler's
                // behavior for an ALREADY-visible widget (apply_visibility
                // only emits on an actual show). Diff-suppressed — a
                // redundant call costs nothing.
                emit_now(&app);
                if let Some(win) = app.get_webview_window("main") {
                    let _ = win.set_focus();
                }
            });
        }))
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
        .plugin(
            tauri_plugin_window_state::Builder::new()
                .with_state_flags(tauri_plugin_window_state::StateFlags::POSITION)
                .build(),
        )
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .manage(ArtCache(Mutex::new(None)))
        .manage(LastEmit(Mutex::new(None)))
        .manage(history::Tracker::default())
        .manage(spotify::SpotifyAuth::default())
        .manage(upnext::UpNext::default())
        .manage(UiReactive(Arc::new(AtomicBool::new(true))))
        .manage(dock::Dock::default())
        .manage(presence::Presence::default())
        .manage(VisIntent::default())
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
            history::history_page,
            history::history_thumb,
            history::history_thumb_url,
            spotify_connect,
            spotify::spotify_status,
            spotify::spotify_disconnect,
            spotify::spotify_queue,
            spotify::spotify_play_now,
            upnext::upnext_list,
            upnext::upnext_add,
            upnext::upnext_remove,
            upnext::upnext_move,
            dock::set_window_size,
            dock::set_hit_size,
            dock::start_drag,
            dock::dock_corner,
            presence::presence_state,
            presence::set_presence_debug
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
            // The fullscreen-conceal switch (sensing keeps running for the
            // debug stream; the ACTION stops). Loaded from settings.json so
            // turning it off sticks across launches. Label renamed from
            // "Companion mode" when the idle-driven behaviors were removed
            // (2026-07-11) — the id and settings key stay "companion" so the
            // persisted choice survives the rename.
            let companion_on = load_companion(app.handle());
            app.state::<VisIntent>()
                .companion
                .store(companion_on, Ordering::Relaxed);
            let companion = CheckMenuItem::with_id(
                app,
                "companion",
                "Hide on fullscreen",
                true,
                companion_on,
                None::<&str>,
            )?;
            // Spotify Web API connection (spotify.rs) — the label doubles as
            // the state; loaded tokens flip it to Disconnect at launch. The
            // narrator lives in spotify.rs so EVERY state change re-syncs
            // the label (background invalid_grant included), not just clicks.
            spotify::init(app.handle());
            let spotify_label = if spotify::connected(app.handle()) {
                "Disconnect Spotify"
            } else {
                "Connect Spotify"
            };
            let spotify_item =
                MenuItem::with_id(app, "spotify", spotify_label, true, None::<&str>)?;
            {
                let item = spotify_item.clone();
                spotify::set_narrator(app.handle(), move |app, text| {
                    let item = item.clone();
                    let text = text.to_string();
                    let _ = app.run_on_main_thread(move || {
                        let _ = item.set_text(text);
                    });
                });
            }
            let update_check =
                MenuItem::with_id(app, "update", "Check for updates", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit Pulse", true, None::<&str>)?;
            // Dev-only conceal test affordance: fullscreen apps are awkward
            // to summon on demand; this feeds the presence loop a synthetic
            // fullscreen verdict for 10s (hysteresis still applies).
            #[cfg(debug_assertions)]
            let sim_fs =
                MenuItem::with_id(app, "simfs", "Simulate fullscreen (10s)", true, None::<&str>)?;
            #[cfg(debug_assertions)]
            let menu = Menu::with_items(
                app,
                &[
                    &show_hide,
                    &reset,
                    &autostart,
                    &companion,
                    &spotify_item,
                    &sim_fs,
                    &update_check,
                    &quit,
                ],
            )?;
            #[cfg(not(debug_assertions))]
            let menu = Menu::with_items(
                app,
                &[&show_hide, &reset, &autostart, &companion, &spotify_item, &update_check, &quit],
            )?;
            let autostart_item = autostart.clone();
            let companion_item = companion.clone();
            let update_item = update_check.clone();
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
                    "companion" => {
                        let vis = app.state::<VisIntent>();
                        let on = !vis.companion.load(Ordering::Relaxed);
                        vis.companion.store(on, Ordering::Relaxed);
                        save_companion(app, on);
                        // Re-sync like autostart: the item flips itself on
                        // click; assert the state we actually hold.
                        let _ = companion_item.set_checked(on);
                        // Turning it off releases an active conceal NOW, not
                        // on the next presence tick — the user is asking the
                        // widget to stop acting.
                        if !on && vis.concealed.swap(false, Ordering::Relaxed) {
                            vis.conceal_snoozed.store(false, Ordering::Relaxed);
                            apply_visibility(app);
                        }
                    }
                    "spotify" => {
                        if spotify::connected(app) {
                            spotify::disconnect(app);
                        } else {
                            spotify::start_connect(app);
                        }
                    }
                    #[cfg(debug_assertions)]
                    "simfs" => {
                        app.state::<presence::Presence>()
                            .simulate_fullscreen(Duration::from_secs(10));
                    }
                    "update" => {
                        // Disable before spawning — we're on the main thread
                        // here, so a double-click can't race two checks.
                        let _ = update_item.set_text("Checking…");
                        let _ = update_item.set_enabled(false);
                        spawn_update_check(app, Some(update_item.clone()));
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .build(app)?;

            // Click-through gate for the fixed-size window's unused gutter —
            // see dock::spawn_hit_watcher.
            if let Some(win) = app.get_webview_window("main") {
                dock::spawn_hit_watcher(win);
            }

            // Play-history: resolve the log dir + build the line index once.
            history::init(app.handle());
            // Managed up-next: restore the persisted list + fed marker.
            upnext::init(app.handle());

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

            // Self-update: one silent check at launch against the latest
            // GitHub release, release builds only (a dev build "updating"
            // itself to the published version would be chaos). The tray's
            // "Check for updates" re-runs the same flow on demand — in any
            // build, since a click is deliberate. Every failure path is a
            // shrug: no network / rate-limited / repo gone just means this
            // launch runs the current version.
            #[cfg(not(debug_assertions))]
            spawn_update_check(app.handle(), None);

            // Presence engine (P0: sense-only) → "presence" events. Keeps
            // sensing while the widget is hidden — that's the point.
            presence::spawn(app.handle().clone());

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
                // Hidden-window history cadence: probe every Nth heartbeat
                // (~5s) so listens keep logging under P1 conceal — the ONE
                // narrow exception to "no work while hidden" (no art
                // marshal, no emit; media::history_probe).
                const HISTORY_PROBE_BEATS: u32 = 10;
                let mut hidden_beats = 0u32;
                loop {
                    if let Some(w) = watch.as_mut() {
                        w.resubscribe(std::mem::take(&mut resubscribe));
                    }
                    let visible = handle
                        .get_webview_window("main")
                        .and_then(|w| w.is_visible().ok())
                        .unwrap_or(true);
                    let playing = if visible {
                        hidden_beats = 0;
                        let tick = media::tick_key();
                        let probing = media::art_probing(&handle.state::<ArtCache>());
                        let p = if std::mem::take(&mut force_snapshot) || probing || tick != last_tick {
                            let np = emit_now(&handle);
                            // A play_now jump flickers intermediate tracks as
                            // "playing" (and a slow skip can hold one past the
                            // 1s history floor) — those are navigation, not
                            // listening. upnext::tick still runs: it owns the
                            // jump-aware bookkeeping.
                            if !spotify::jump_active(&handle) {
                                history::ingest(&handle, &np);
                            }
                            upnext::tick(&handle, &np);
                            np.status == "playing"
                        } else {
                            tick.as_ref().is_some_and(|k| k.3 == "playing")
                        };
                        last_tick = tick;
                        p
                    } else {
                        hidden_beats += 1;
                        if hidden_beats >= HISTORY_PROBE_BEATS {
                            hidden_beats = 0;
                            let np = media::history_probe();
                            if !spotify::jump_active(&handle) {
                                history::ingest(&handle, &np);
                            }
                            upnext::tick(&handle, &np);
                        }
                        false
                    };
                    // Grace-expiry sweep for a vanish-pending entry (a gone
                    // session produces no ticks to ride).
                    history::tick(&handle);
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
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|app, event| {
            // Quit mid-song still logs the listen — the tracker's in-flight
            // candidate finalizes on the way out.
            if let tauri::RunEvent::Exit = event {
                history::flush(app);
            }
        });
}
