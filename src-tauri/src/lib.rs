mod audio;
mod dock;
mod focus;
mod history;
mod lastfm;
mod loopback;
mod lyrics;
mod media;
mod prefs;
mod presence;
mod search;
mod settings;
mod similar;
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
// Keep in sync with SEEK_STEP_MS in src/Transport.tsx (UI buttons) — this one
// drives the global hotkeys.
const SEEK_STEP_MS: i64 = 10_000;

// V1 hotkeys — constants for now, a settings surface later.
// NOTE: ctrl+alt+space is already taken system-wide on Thien's machine.
const HK_PLAY_PAUSE: &str = "ctrl+alt+k";
const HK_SEEK_BACK: &str = "ctrl+alt+left";
const HK_SEEK_FWD: &str = "ctrl+alt+right";
const HK_NEXT: &str = "ctrl+alt+n";
const HK_PREV: &str = "ctrl+alt+p";
const HK_TOGGLE: &str = "ctrl+alt+m";
/// S for search/summon — the search window (Thien's pick, 2026-07-11).
const HK_SEARCH: &str = "ctrl+alt+s";

// ---- Global hotkeys: rebindable, HK_* are the DEFAULTS ----
//
// Overrides persist in settings.json under "hotkeys": { <id>: <accelerator> }
// (e.g. "playpause": "ctrl+alt+k"). resolve_chord reads the override at
// registration; the prefs Hotkeys UI rebinds by unregister-all + register-all
// (register_all), which also captures each shortcut's OS-registration result
// so the UI can surface the silent failure (a reserved chord like
// Ctrl+Alt+Left) as a persistent "not registered" note instead of an eprintln.

/// One rebindable action: identity, human label (UI source of truth), the
/// default accelerator, and what it does. Actions are non-capturing so they
/// coerce to `fn` pointers stored per-registration.
struct HotkeyDef {
    id: &'static str,
    label: &'static str,
    default_chord: &'static str,
    action: fn(&AppHandle),
}

/// The seven actions, in the order the prefs Hotkeys list renders them.
fn hotkey_defs() -> [HotkeyDef; 7] {
    [
        HotkeyDef {
            id: "playpause",
            label: "Play / pause",
            default_chord: HK_PLAY_PAUSE,
            action: |app| {
                media::play_pause();
                emit_now(app);
            },
        },
        // Seek hotkeys: no post-seek emit (it would carry the pre-seek
        // position, snapping the UI back — the seek-command rule).
        // "seek-nudge" carries only the direction — the SeekButton runs the
        // same one-revolution spin a click gets, so the hotkey and the button
        // speak one feedback language (PR #21 follow-up). The buttons gate on
        // can_seek, so a player that ignores the SMTC call (Apple Music)
        // never shows a spin for a seek that didn't happen.
        HotkeyDef {
            id: "seekback",
            label: "Seek backward",
            default_chord: HK_SEEK_BACK,
            action: |app| {
                media::seek_rel_ms(-SEEK_STEP_MS);
                let _ = app.emit("seek-nudge", -1);
            },
        },
        HotkeyDef {
            id: "seekfwd",
            label: "Seek forward",
            default_chord: HK_SEEK_FWD,
            action: |app| {
                media::seek_rel_ms(SEEK_STEP_MS);
                let _ = app.emit("seek-nudge", 1);
            },
        },
        // Queue-aware like the media_next command — lands on the up-next front.
        HotkeyDef {
            id: "next",
            label: "Next track",
            default_chord: HK_NEXT,
            action: |app| {
                if !upnext::try_queue_skip(app) {
                    media::next();
                    emit_now(app);
                }
            },
        },
        HotkeyDef {
            id: "prev",
            label: "Previous track",
            default_chord: HK_PREV,
            action: |app| {
                media::prev();
                emit_now(app);
            },
        },
        HotkeyDef {
            id: "showhide",
            label: "Show / hide Palette",
            default_chord: HK_TOGGLE,
            action: toggle_widget,
        },
        HotkeyDef {
            id: "search",
            label: "Summon search",
            default_chord: HK_SEARCH,
            action: |app| search::toggle(app),
        },
    ]
}

/// One row of the resolved hotkey table — the prefs seed + "hotkeys-changed"
/// payload. `registered` is the OS-registration truth (false = the chord was
/// rejected, usually a system-reserved combo).
#[derive(Serialize, Clone)]
pub(crate) struct HotkeyInfo {
    pub id: String,
    pub label: String,
    pub chord: String,
    pub registered: bool,
}

/// The live resolved table, rebuilt on every register_all.
#[derive(Default)]
struct HotkeyState(Mutex<Vec<HotkeyInfo>>);

/// The effective accelerator for an id: a persisted override, else the default.
fn resolve_chord(app: &AppHandle, id: &str, default: &str) -> String {
    settings::get_value(app, "hotkeys")
        .as_ref()
        .and_then(|v| v.get(id))
        .and_then(|c| c.as_str())
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| default.to_string())
}

/// Serializes every registration mutation — register_all and the capture
/// suspend loop. Unserialized, two in-flight register_alls interleave per
/// main-thread hop (each per-shortcut call is its own hop), and the commit
/// path provably runs two: commitRebind's rebind_hotkey and the capture
/// cleanup's resume are separate un-awaited invokes, each a tokio task. The
/// interleavings are all bad — the loser of a duplicate on_shortcut records
/// a working row as registered=false, and a resume whose resolve_chord reads
/// pre-write settings registers the OLD chord as a ghost the winning table
/// doesn't know, so no future register_all ever unregisters it. Hotkey
/// DISPATCH never takes this lock, so the unregister_all deadlock documented
/// below doesn't apply — but a MAIN-THREAD caller must never wait on it
/// while a worker holds it (the worker's per-shortcut hops need the main
/// thread free): setup's call is safe (the event loop isn't serving
/// commands yet, nothing can hold the lock), and the prefs-Destroyed resume
/// spawns off-main for exactly this reason.
static REG_LOCK: Mutex<()> = Mutex::new(());

/// Unregister everything and register the resolved chords fresh — the ONE
/// registration path (setup, a rebind, a reset, the capture resume, the
/// prefs-Destroyed backstop), serialized under REG_LOCK. Records each
/// shortcut's OS-registration result into HotkeyState and emits
/// "hotkeys-changed" so an open prefs window reflects the new table (and any
/// registration failure).
pub(crate) fn register_all(app: &AppHandle) {
    let _reg = REG_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let gs = app.global_shortcut();
    // Unregister the PREVIOUS set one-by-one — deliberately NOT
    // gs.unregister_all(). In tauri-plugin-global-shortcut 2.3.2,
    // unregister_all() locks its internal `shortcuts` mutex and holds it
    // ACROSS the main-thread hop, and that same mutex is locked on the main
    // thread during hotkey dispatch — so calling it from an async command's
    // worker (rebind/reset) can deadlock against a concurrent key press.
    // Per-shortcut unregister() and on_shortcut() both hop to the main thread
    // BEFORE locking, so they are safe from any thread. On the setup call the
    // snapshot is empty (nothing registered yet), so this loop no-ops.
    for prev in hotkey_snapshot(app) {
        let _ = gs.unregister(prev.chord.as_str());
    }
    let mut infos = Vec::with_capacity(7);
    for def in hotkey_defs() {
        let chord = resolve_chord(app, def.id, def.default_chord);
        let action = def.action;
        let result = gs.on_shortcut(chord.as_str(), move |app, _s, event| {
            if event.state() == ShortcutState::Pressed {
                // Hotkey dispatch runs on the MAIN/STA thread (the plugin's
                // WM_HOTKEY WndProc). The transport actions block on GSMTC
                // `.get()`, and showhide → apply_visibility → emit_now does too;
                // running them inline froze the message pump whenever a media
                // player was slow to answer, which Windows reports as an
                // "Application Hang". Defer off-main.
                defer_main_action(app, action);
            }
        });
        let registered = result.is_ok();
        if let Err(e) = result {
            log::warn!("hotkey {} ({chord}) failed to register: {e}", def.id);
        }
        infos.push(HotkeyInfo {
            id: def.id.to_string(),
            label: def.label.to_string(),
            chord,
            registered,
        });
    }
    {
        let state = app.state::<HotkeyState>();
        *state
            .0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = infos.clone();
    }
    let _ = app.emit("hotkeys-changed", &infos);
}

/// The current resolved table (prefs seed reads it).
pub(crate) fn hotkey_snapshot(app: &AppHandle) -> Vec<HotkeyInfo> {
    app.state::<HotkeyState>()
        .0
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .clone()
}

/// Persist one override and re-register live. Duplicate-chord prevention lives
/// in the UI (it blocks the commit and never calls this); an unknown id is a
/// no-op. Returns the fresh table.
#[tauri::command]
async fn rebind_hotkey(app: AppHandle, id: String, chord: String) -> Vec<HotkeyInfo> {
    if !hotkey_defs().iter().any(|d| d.id == id) {
        return hotkey_snapshot(&app);
    }
    let mut obj = settings::get_value(&app, "hotkeys")
        .and_then(|v| v.as_object().cloned())
        .unwrap_or_default();
    obj.insert(id, serde_json::Value::String(chord));
    settings::set_value(&app, "hotkeys", serde_json::Value::Object(obj));
    register_all(&app);
    hotkey_snapshot(&app)
}

/// Clear all overrides and re-register the defaults. Returns the fresh table.
#[tauri::command]
async fn reset_hotkeys(app: AppHandle) -> Vec<HotkeyInfo> {
    settings::set_value(
        &app,
        "hotkeys",
        serde_json::Value::Object(Default::default()),
    );
    register_all(&app);
    hotkey_snapshot(&app)
}

/// Suspend (true) / resume (false) the global shortcuts around the prefs
/// hotkey capture. While capture listens, a registered chord never reaches
/// the prefs webview — RegisterHotKey swallows it system-wide — so pressing
/// a BOUND Palette chord during capture fired its action instead (Ctrl+Alt+S
/// summoned Search over the prefs window, whose blur then cancelled the
/// capture) and the UI's registered-duplicate conflict branch was
/// unreachable. Suspend uses the same per-shortcut unregister loop
/// register_all opens with — NEVER unregister_all (the cross-thread deadlock
/// documented there) — and never holds HotkeyState across a gs call
/// (hotkey_snapshot clones out of the lock). HotkeyState itself is left
/// intact so resume's register_all resolves the same table. Idempotent both
/// ways: a re-suspend unregisters already-gone chords (errors ignored), and
/// a resume after commit's own register_all just rebuilds the same set —
/// idempotence that holds CONCURRENTLY too, because both the suspend loop
/// and register_all serialize under REG_LOCK (an in-flight resume finishing
/// second would otherwise re-register chords INTO the capture).
#[tauri::command]
async fn set_hotkeys_capture(app: AppHandle, active: bool) {
    if active {
        let _reg = REG_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let gs = app.global_shortcut();
        for prev in hotkey_snapshot(&app) {
            let _ = gs.unregister(prev.chord.as_str());
        }
    } else {
        register_all(&app);
    }
}

// Every command that touches GSMTC (or the network) is `async` — NOT for
// concurrency, but to move it OFF the main thread. Tauri runs sync commands
// on the webview IPC (main/STA) thread, where WinRT's blocking `.get()` can
// never observe its completion (the STA is parked in the wait) — a cold-cache
// snapshot there deadlocks the whole app. Async commands run on the async
// runtime's worker pool — but that pool is the tokio CORE workers, which
// blocking work must ALSO leave; off_core below is the second hop.

/// Run a command body's sync GSMTC/WinRT work on the DEDICATED blocking pool
/// (the defer_main_action discipline), never on the tokio core worker the
/// async command body lands on. Core workers are a small fixed pool that does
/// NOT replenish: one wedged `.get()` eats a worker permanently — invisibly,
/// because the media-loop stage watchdog's telemetry (media set_stage) is
/// loop-thread-gated and never sees command-path calls — and a few repeated
/// presses exhaust the pool, silently killing ALL webview IPC while hotkeys
/// (already on the blocking pool via defer_main_action) keep working.
/// spawn_blocking threads replenish, so a wedge costs one thread, not the
/// runtime. JoinError = the closure panicked; degrade to `default` instead of
/// a dead IPC call — loudly, or a release build swallows the panic invisibly
/// (the media_lyrics rule).
async fn off_core<T: Send + 'static>(default: T, f: impl FnOnce() -> T + Send + 'static) -> T {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .unwrap_or_else(|e| {
            log::error!("command blocking work panicked: {e}");
            default
        })
}

#[tauri::command]
async fn media_play_pause(app: AppHandle) -> bool {
    off_core(false, move || {
        let ok = media::play_pause();
        emit_now(&app);
        ok
    })
    .await
}

#[tauri::command]
async fn media_next(app: AppHandle) -> bool {
    off_core(false, move || {
        // Queue-aware: a next pressed in Pulse lands on the up-next front when
        // there is one (upnext::try_queue_skip) — the mid-song skip is the one
        // transition the feed-late model missed. Falls through to the plain
        // GSMTC skip otherwise.
        if upnext::try_queue_skip(&app) {
            return true;
        }
        let ok = media::next();
        emit_now(&app);
        ok
    })
    .await
}

#[tauri::command]
async fn media_prev(app: AppHandle) -> bool {
    off_core(false, move || {
        let ok = media::prev();
        emit_now(&app);
        ok
    })
    .await
}

// The seek commands deliberately do NOT snapshot afterwards: the player hasn't
// applied the seek yet, so an immediate emit carries the PRE-seek position and
// visibly snaps the UI back to the old spot (worst on lyrics click-to-seek).
// The next heartbeat/event delivers the post-seek timeline within ~500ms.

#[tauri::command]
async fn media_seek_rel(delta_ms: i64) -> bool {
    off_core(false, move || media::seek_rel_ms(delta_ms)).await
}

#[tauri::command]
async fn media_seek_abs(position_ms: i64) -> bool {
    off_core(false, move || media::seek_abs_ms(position_ms)).await
}

/// Per-window frontend votes on audio reactivity (false under OS
/// reduced-motion) — the effective value is the OR of live windows' votes,
/// ANDed into the capture switch. A single shared atomic worked while
/// "main" was the only webview; with the search window (and focus mode next) each
/// realm's initReactive would clobber the others'. Empty map (pre-vote
/// startup) defaults true, matching the old atomic's default. The label
/// comes from the invoking window's IPC context, never a parameter — a
/// webview can only vote for itself. Votes drop on Destroyed (the window
/// event handler) so a dead window can't wedge the gate.
struct UiReactive(Arc<Mutex<std::collections::HashMap<String, bool>>>);

fn reactive_effective(votes: &Mutex<std::collections::HashMap<String, bool>>) -> bool {
    let m = votes
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    m.is_empty() || m.values().any(|v| *v)
}

#[tauri::command]
fn set_reactive_enabled(enabled: bool, window: tauri::WebviewWindow, state: State<UiReactive>) {
    let mut votes = state
        .0
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    votes.insert(window.label().to_string(), enabled);
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
        log::error!("lyrics fetch panicked: {e}");
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
/// seeds from this instead. Ordering rides the same claim-then-publish gate
/// as emit_now; NO lock is held across the snapshot — the 2026-07-15 wedge
/// held LastEmit inside a hung snapshot and this seed blocked forever behind
/// it (a freshly opened focus window sat on the resting dot while music
/// played). The winning branch bumps published_seq but must NOT write
/// st.payload: the diff-suppression baseline stays "last payload actually
/// emitted to all windows" — a single-window seed writing it would suppress
/// the next real emit.
#[tauri::command]
async fn now_playing(app: AppHandle) -> Stamped {
    // The whole claim→snapshot→publish sequence rides off_core as ONE
    // closure: seq is still claimed immediately before the snapshot with no
    // lock held across it (the #103 ordering — seq order == snapshot-START
    // order), just on a blocking-pool thread instead of a core worker. The
    // JoinError default (seq 0, empty payload) is below every live seq, so
    // posClock discards it and the seed degrades to "no data", not bad data.
    off_core(
        Stamped {
            seq: 0,
            now: media::NowPlaying::default(),
        },
        move || {
            let my_seq = SEQ.fetch_add(1, Ordering::Relaxed);
            let np = media::snapshot(&app.state::<ArtCache>());
            let last = app.state::<LastEmit>();
            let mut st = last
                .0
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if my_seq >= st.published_seq {
                st.published_seq = my_seq;
                return Stamped {
                    seq: my_seq,
                    now: np,
                };
            }
            // Outrun: a snapshot that STARTED after ours already published.
            // Hand back the freshest published payload instead; fall back to
            // our own read when nothing has ever been emitted (only reachable
            // seed-vs-seed, where the winner's data went to a different
            // webview's clock).
            Stamped {
                seq: st.published_seq,
                now: st.payload.clone().unwrap_or(np),
            }
        },
    )
    .await
}

/// Monotonic stamp on every now-playing payload — the frontend position
/// clock (posClock.ingest) drops any payload whose seq is <= the last one it
/// accepted, instead of trusting IPC delivery order. Ordering invariant:
/// seq is claimed BEFORE the snapshot starts, so seq order == snapshot-START
/// order, and the publish gate in emit_now/now_playing discards any snapshot
/// a later-started one has already outrun — higher seq never carries older
/// data.
static SEQ: AtomicU64 = AtomicU64::new(1);

#[derive(Serialize, Clone)]
struct Stamped {
    seq: u64,
    #[serde(flatten)]
    now: media::NowPlaying,
}

/// Last payload emitted + the seq high-water mark of the newest published
/// snapshot. Raw pairs make unchanged GSMTC data byte-identical, so
/// suppressing equal payloads costs nothing and zeroes idle/paused IPC —
/// and every suppressed emit is also one less regression lottery ticket for
/// the position pipeline (ad-hoc emit_now callers included).
#[derive(Default)]
struct LastEmitState {
    payload: Option<media::NowPlaying>,
    published_seq: u64,
}
struct LastEmit(Mutex<LastEmitState>);

pub(crate) fn emit_now(app: &AppHandle) -> media::NowPlaying {
    // Claim seq BEFORE the snapshot, snapshot with NO lock held: a wedged
    // WinRT read (the 2026-07-15 freeze — a player that never answered hung
    // the media loop INSIDE this lock, freezing the display and deadlocking
    // the now_playing seed) must only ever stall its own caller. Concurrent
    // callers (media loop, commands, hotkeys, tray) order at the publish
    // gate below instead: seq order == snapshot-START order, and a snapshot
    // that a later-started one has outrun is discarded, never emitted.
    let my_seq = SEQ.fetch_add(1, Ordering::Relaxed);
    let np = media::snapshot(&app.state::<ArtCache>());
    let last = app.state::<LastEmit>();
    let mut st = last
        .0
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if my_seq < st.published_seq {
        return np;
    }
    st.published_seq = my_seq;
    if st.payload.as_ref() != Some(&np) {
        let stamped = Stamped {
            seq: my_seq,
            now: np.clone(),
        };
        let _ = app.emit("now-playing", &stamped);
        st.payload = Some(stamped.now);
    }
    np
}

// ── Main-thread liveness ─────────────────────────────────────────────────
// Every historical "Application Hang" in this app was a blocking call landing
// on the main/STA thread and freezing the Win32 message pump — GSMTC `.get()`
// reached from a hotkey/tray action (which dispatch ON the main thread), or a
// lock / cross-thread window op. Two guards live here:
//   1. defer_main_action — runs those actions OFF the main thread on the
//      dedicated blocking pool — the discipline the async transport commands
//      reach via off_core and the single-instance summons routes through
//      directly.
//   2. spawn_main_thread_watchdog — logs a UI-pump stall BEFORE Windows
//      force-closes, so any future regression names itself in pulse.log instead
//      of vanishing silently (a hang bypasses the panic hook — nothing is
//      logged otherwise).

static MAIN_TICK_MS: AtomicU64 = AtomicU64::new(0);

/// Media-loop liveness threshold (see media::beat_age_ms). The 2026-07-15
/// freeze was that thread blocked forever in a WinRT call — no panic, no
/// log, display frozen while everything else ran. The watchdog names the
/// stall AND its stage (media::stage_name). The beat refreshes on EVERY
/// stage transition (plus once per iteration), so what goes stale is one
/// blocking call that never returns — a slow-but-progressing art fetch
/// (dozens of succeeding 3s-bounded chunk reads) keeps beating and never
/// false-positives. No single healthy call takes 1s, wait_op bounds the
/// async ones at 2-3s — 10s of NO transitions is unambiguous.
/// Recovery is deliberately log-only: after the lock narrowing (emit_now)
/// and wait_op timeouts, a wedge stalls nothing but the loop itself and
/// self-heals when the op times out. Add generation-respawn machinery ONLY
/// if pulse.log ever shows a stall stuck on a sync-call stage (get_session /
/// session_id / timeline / playback_info — the un-timeout-able surface).
const MEDIA_STALL_WARN_MS: i64 = 10_000;

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64)
}

/// Run a main-window / GSMTC action OFF the main/STA thread. Hotkey dispatch
/// (the plugin's WM_HOTKEY WndProc) and tray menu events run on the main
/// thread; the actions they trigger do blocking WinRT `.get()` (transport) and
/// apply_visibility → emit_now, which froze the message pump and produced an
/// "Application Hang" whenever a media player was slow to answer. spawn_blocking
/// (the dedicated blocking pool) because the work is synchronous blocking WinRT
/// — a spammed hotkey must not starve the cooperative async workers.
pub(crate) fn defer_main_action(app: &AppHandle, f: impl FnOnce(&AppHandle) + Send + 'static) {
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || f(&app));
}

/// Watch the main/UI thread's liveness. Queues a heartbeat onto the event loop
/// each second (a non-blocking UserEvent); a stalled pump can't run it, so the
/// tick goes stale and we log the stall + its duration before Windows reports
/// the hang. The `.run()` closure also bumps the tick, so real events keep it
/// fresh when idle.
fn spawn_main_thread_watchdog(app: AppHandle) {
    MAIN_TICK_MS.store(now_ms(), Ordering::Relaxed);
    std::thread::Builder::new()
        .name("main-watchdog".into())
        .spawn(move || {
        let mut warned = false;
        let mut media_stall_peak: i64 = 0;
        loop {
            std::thread::sleep(Duration::from_secs(1));
            let _ = app.run_on_main_thread(|| {
                MAIN_TICK_MS.store(now_ms(), Ordering::Relaxed);
            });
            let stalled = now_ms().saturating_sub(MAIN_TICK_MS.load(Ordering::Relaxed));
            if stalled >= 4000 {
                if !warned {
                    log::error!(
                        "main-thread watchdog: UI pump stalled {stalled}ms — a blocking call is on the main/STA thread (GSMTC .get, a lock, or a cross-thread window op); Windows reports this as an Application Hang."
                    );
                    warned = true;
                }
            } else {
                warned = false;
            }
            // Media-loop liveness (see MEDIA_STALL_WARN_MS). Same warn-once
            // latch; the recovery line distinguishes "wedged until restart"
            // (the 2026-07-15 incident) from "one slow player episode".
            // beat_age_ms is 0 until the loop thread starts.
            let media_stall = media::beat_age_ms();
            if media_stall >= MEDIA_STALL_WARN_MS {
                if media_stall_peak == 0 {
                    log::error!(
                        "media-loop watchdog: no progress for {media_stall}ms — stuck at stage '{}' (a WinRT call into the player is blocking)",
                        media::stage_name()
                    );
                }
                media_stall_peak = media_stall;
            } else if media_stall_peak > 0 {
                log::info!("media-loop watchdog: loop resumed after ~{media_stall_peak}ms stall");
                media_stall_peak = 0;
            }
        }
        })
        .expect("spawn main-watchdog thread");
}

/// Visibility INTENT — the single owner of WHY the MAIN window is shown or
/// hidden. `is_visible()` stays the OS truth, but every mutation flows
/// through apply_visibility (the ONLY caller of the main window's
/// show()/hide() — grep rule; search.rs is the one other, window-scoped
/// visibility ledger, for its own label only),
/// which reconciles the window to:
///   effective = !user_hidden && !(concealed && !conceal_snoozed) && !focus_open
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
    /// The fullscreen focus window is open (focus.rs) — the widget yields
    /// unconditionally and returns to its EXACT prior intent on close (a
    /// sticky manual hide stays hidden; a live conceal episode still holds).
    /// Memory-only, never persisted: a relaunch can never boot into focus.
    pub focus_open: AtomicBool,
}

impl Default for VisIntent {
    fn default() -> Self {
        Self {
            user_hidden: AtomicBool::new(false),
            concealed: AtomicBool::new(false),
            conceal_snoozed: AtomicBool::new(false),
            companion: AtomicBool::new(true),
            focus_open: AtomicBool::new(false),
        }
    }
}

impl VisIntent {
    pub fn effective_visible(&self) -> bool {
        // ≡ !user_hidden && !(concealed && !snoozed) && !focus_open — the
        // intent formula as documented; the middle term is written OR-style
        // ("not concealed, or the conceal is snoozed") for clippy's
        // nonminimal_bool hard gate.
        !self.user_hidden.load(Ordering::Relaxed)
            && (!self.concealed.load(Ordering::Relaxed)
                || self.conceal_snoozed.load(Ordering::Relaxed))
            && !self.focus_open.load(Ordering::Relaxed)
    }
}

/// Reconcile the OS window to the current intent. Safe from any thread that
/// may touch GSMTC (emit_now runs inline on show — the toggle_widget
/// precedent); from the single-instance WndProc, defer to the async pool.
pub(crate) fn apply_visibility(app: &AppHandle) {
    let Some(win) = app.get_webview_window("main") else {
        return;
    };
    let want = app.state::<VisIntent>().effective_visible();
    // On an is_visible() error, assume the OPPOSITE of intent so the
    // reconcile always acts (show/hide are idempotent). A fixed default
    // could silently skip the show() that restores a concealed window —
    // the worst failure class here (quick-review catch, 2026-07-09).
    let is = win.is_visible().unwrap_or(!want);
    if want && !is {
        // Reconcile the seat context first: a show landing between presence
        // ticks (hotkey snooze, tray) must never flash at the wrong seat.
        // The hidden-window swap is an instant jump, and sync_seat never
        // calls back into apply_visibility.
        dock::sync_seat(app);
        let _ = win.show();
        // The hit watcher parks while hidden — wake it so click-through is
        // reconciled to the cursor before the first click, not up to a poll
        // interval later.
        dock::notify_shown(app);
        // The poll loop skips hidden windows — refresh immediately on show.
        emit_now(app);
    } else if !want && is {
        let _ = win.hide();
    }
}

fn toggle_widget(app: &AppHandle) {
    let Some(win) = app.get_webview_window("main") else {
        return;
    };
    let vis = app.state::<VisIntent>();
    // During the focus takeover the hotkey means "give me the widget back":
    // LEAVE FOCUS (the Destroyed handler restores the exact prior intent).
    // Reasoning from raw visibility here would see main hidden and silently
    // wipe a sticky manual hide / snooze a live conceal with zero visible
    // effect — corrupting the prior intent focus promises to restore
    // (quick-review catch, 2026-07-11).
    if vis.focus_open.load(Ordering::Relaxed) {
        if let Some(focus_win) = app.get_webview_window(focus::LABEL) {
            let _ = focus_win.destroy();
        } else {
            // Window gone but the flag stuck (a failed create/show) — the
            // hotkey is the recovery path: clear and reconcile.
            vis.focus_open.store(false, Ordering::Relaxed);
            apply_visibility(app);
        }
        return;
    }
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

/// Companion-mode persistence — thin wrappers over the shared settings.rs
/// read-modify-write (the old wholesale `{"companion": on}` write clobbered
/// every other key the moment a second one existed).
fn load_companion(app: &AppHandle) -> bool {
    settings::get_bool(app, "companion", true)
}

fn save_companion(app: &AppHandle, on: bool) {
    settings::set_value(app, "companion", serde_json::Value::Bool(on));
}

/// Clones of the tray's two check items, so the prefs window and the tray stay
/// mirrored: a toggle from either surface re-checks the tray item and emits
/// "settings-changed" for the other. Populated at setup.
#[derive(Default)]
struct TrayHandles {
    autostart: Mutex<Option<CheckMenuItem<tauri::Wry>>>,
    companion: Mutex<Option<CheckMenuItem<tauri::Wry>>>,
}

/// Set the tray autostart check item (menu writes hop to the main thread).
fn sync_tray_autostart(app: &AppHandle, on: bool) {
    let item = app
        .state::<TrayHandles>()
        .autostart
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .clone();
    if let Some(item) = item {
        let _ = app.run_on_main_thread(move || {
            let _ = item.set_checked(on);
        });
    }
}

fn sync_tray_companion(app: &AppHandle, on: bool) {
    let item = app
        .state::<TrayHandles>()
        .companion
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .clone();
    if let Some(item) = item {
        let _ = app.run_on_main_thread(move || {
            let _ = item.set_checked(on);
        });
    }
}

/// Apply the fullscreen-conceal switch from ANY surface (tray click, prefs
/// toggle): store intent, persist, mirror the tray, notify listeners, and
/// release a live conceal immediately when turned off (the user is asking the
/// widget to stop acting — don't wait for the next presence tick).
fn set_companion(app: &AppHandle, on: bool) {
    let vis = app.state::<VisIntent>();
    vis.companion.store(on, Ordering::Relaxed);
    save_companion(app, on);
    sync_tray_companion(app, on);
    let _ = app.emit(
        "settings-changed",
        serde_json::json!({ "key": "companion", "value": on }),
    );
    if !on && vis.concealed.swap(false, Ordering::Relaxed) {
        vis.conceal_snoozed.store(false, Ordering::Relaxed);
        apply_visibility(app);
    }
}

/// Apply start-at-login from any surface. The plugin writes the HKCU Run key;
/// we re-read the registry truth so a failed toggle never leaves a lying
/// checkmark. Returns nothing here — the command wrapper reports the truth.
fn set_autostart(app: &AppHandle, on: bool) {
    let al = app.autolaunch();
    let result = if on { al.enable() } else { al.disable() };
    if let Err(e) = result {
        log::warn!("autostart toggle failed: {e}");
    }
    let actual = al.is_enabled().unwrap_or(on);
    sync_tray_autostart(app, actual);
    let _ = app.emit(
        "settings-changed",
        serde_json::json!({ "key": "start_at_login", "value": actual }),
    );
}

/// Prefs "Start at login" toggle — mirrors the tray. Returns the registry's
/// actual state so the UI reflects a failed toggle honestly.
#[tauri::command]
async fn set_start_at_login(app: AppHandle, enabled: bool) -> bool {
    set_autostart(&app, enabled);
    app.autolaunch().is_enabled().unwrap_or(enabled)
}

/// Prefs "Hide on fullscreen" toggle — mirrors the tray. Rides off_core:
/// switching OFF during a live conceal releases it through apply_visibility,
/// whose show path runs emit_now — a sync GSMTC snapshot.
#[tauri::command]
async fn set_hide_on_fullscreen(app: AppHandle, enabled: bool) {
    off_core((), move || set_companion(&app, enabled)).await
}

/// Frontend-initiated connect (the queue UI's gate state, PR 4) — same flow
/// and tray narration as the tray click (spotify.rs holds the narrator).
#[tauri::command]
async fn spotify_connect(app: AppHandle) {
    spotify::start_connect(&app);
}

/// Hide the widget from a frontend surface (the right-click menu's "Hide
/// Palette"). A DEDICATED hide: sets the sticky manual-hide intent and
/// reconciles — NOT toggle_widget, whose focus/visibility inference is meant
/// for the hotkey/tray and could destroy the focus window instead. Every
/// show/hide flows through apply_visibility (grep rule).
#[tauri::command]
async fn hide_widget(app: AppHandle) {
    app.state::<VisIntent>()
        .user_hidden
        .store(true, Ordering::Relaxed);
    apply_visibility(&app);
}

/// Quit from a frontend surface (the right-click menu's "Quit Palette"),
/// mirroring the tray "quit" handler.
#[tauri::command]
async fn quit_app(app: AppHandle) {
    app.exit(0);
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
                log::warn!("update check failed: {e}");
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

/// Prefs "Check for updates" — the same flow as the tray entry, but reporting
/// to the UI via a returned status string instead of a tray label. Shares the
/// UPDATE_IN_FLIGHT guard so a tray check and a prefs check can't race two
/// installs. On an installed update the process is replaced and this never
/// returns; otherwise: "uptodate" | "dev" | "busy" | "failed".
#[tauri::command]
async fn check_for_updates(app: AppHandle) -> String {
    use tauri_plugin_updater::UpdaterExt;
    if UPDATE_IN_FLIGHT
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return "busy".to_string();
    }
    let result: Result<UpdateOutcome, String> = async {
        let updater = app.updater().map_err(|e| e.to_string())?;
        match updater.check().await.map_err(|e| e.to_string())? {
            Some(update) => {
                if cfg!(debug_assertions) {
                    return Ok(UpdateOutcome::DevAvailable);
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
        // Windows: the passive NSIS installer replaces this process; restart()
        // is the documented relaunch guarantee. Never returns.
        Ok(UpdateOutcome::Installed) => app.restart(),
        Ok(UpdateOutcome::UpToDate) => "uptodate".to_string(),
        Ok(UpdateOutcome::DevAvailable) => "dev".to_string(),
        Err(e) => {
            log::warn!("prefs update check failed: {e}");
            "failed".to_string()
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
            // An explicit summons: clear any manual hide and snooze an
            // active conceal episode. This callback runs in a WndProc on
            // the main/STA thread (SendMessageW from the second process) —
            // apply_visibility's emit_now touches GSMTC, which must never
            // block there (see the async-command note above). The reconcile
            // defers via defer_main_action (blocking pool), NOT a plain
            // async spawn: the sync snapshot on a core worker is the
            // off_core wedge class, and a summons lands exactly when the
            // widget looks dead — relaunch-spam during a wedge episode
            // would eat a non-replenishing core worker per press.
            let vis = app.state::<VisIntent>();
            // During the focus takeover, Pulse IS surfaced — the summons is
            // already satisfied, and the flag-clears below would silently
            // corrupt the prior intent focus restores on close.
            if vis.focus_open.load(Ordering::Relaxed) {
                return;
            }
            vis.user_hidden.store(false, Ordering::Relaxed);
            if vis.concealed.load(Ordering::Relaxed) {
                vis.conceal_snoozed.store(true, Ordering::Relaxed);
            }
            defer_main_action(app, |app| {
                apply_visibility(app);
                // Unconditional refresh, preserving the old handler's
                // behavior for an ALREADY-visible widget (apply_visibility
                // only emits on an actual show). Diff-suppressed — a
                // redundant call costs nothing.
                emit_now(app);
                if let Some(win) = app.get_webview_window("main") {
                    let _ = win.set_focus();
                }
            });
        }))
        // Release logging (registered early so later plugins/setup can log):
        // main.rs sets windows_subsystem="windows", so stderr is discarded and
        // panics + eprintln! diagnostics vanish. Route them to a rotating file
        // in the app log dir (%LOCALAPPDATA%\<id>\logs\pulse.log) instead. Dev
        // builds also keep a Stdout target so `tauri dev` still prints inline.
        .plugin(
            tauri_plugin_log::Builder::new()
                // Level is a hard cap: Info in release keeps identifying
                // detail (presence's foreground exe) out of pulse.log — the
                // support bundle — while dev builds lower to Debug so the
                // crate's log::debug! diagnostics (audio reopen-backoff
                // cadence, presence detail) actually print; without the dev
                // branch every debug! line is dead in ALL builds.
                .level(if cfg!(debug_assertions) {
                    log::LevelFilter::Debug
                } else {
                    log::LevelFilter::Info
                })
                // Bound disk use: rotate at 5 MB, keep one old file.
                .max_file_size(5_000_000)
                .rotation_strategy(tauri_plugin_log::RotationStrategy::KeepOne)
                .targets([
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::LogDir {
                        file_name: Some("pulse".into()),
                    }),
                    #[cfg(debug_assertions)]
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Stdout),
                ])
                .build(),
        )
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
        .plugin(
            tauri_plugin_window_state::Builder::new()
                .with_state_flags(tauri_plugin_window_state::StateFlags::POSITION)
                // Only "main" persists position. The search window recenters
                // per summon, focus mode is born fullscreen, and prefs
                // recenters on the cursor monitor per open — a restored stale
                // position would be wrong for all three.
                .with_denylist(&[search::LABEL, focus::LABEL, prefs::LABEL])
                .build(),
        )
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .manage(ArtCache(Mutex::new(None)))
        .manage(LastEmit(Mutex::new(LastEmitState::default())))
        .manage(history::Tracker::default())
        .manage(spotify::SpotifyAuth::default())
        .manage(upnext::UpNext::default())
        .manage(UiReactive(Arc::new(Mutex::new(
            std::collections::HashMap::new(),
        ))))
        .manage(dock::Dock::default())
        .manage(presence::Presence::default())
        .manage(VisIntent::default())
        .manage(HotkeyState::default())
        .manage(TrayHandles::default())
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
            hide_widget,
            quit_app,
            spotify::spotify_status,
            spotify::spotify_device,
            spotify::spotify_disconnect,
            spotify::spotify_play_now,
            spotify::spotify_resolve_uri,
            spotify::spotify_search,
            search::search_hide,
            focus::focus_open,
            focus::focus_close,
            prefs::open_prefs,
            prefs::close_prefs,
            prefs::prefs_seed,
            prefs::set_setting,
            prefs::test_lastfm_key,
            prefs::lastfm_has_key,
            prefs::open_logs,
            prefs::open_data_folder,
            prefs::open_repo,
            rebind_hotkey,
            reset_hotkeys,
            set_hotkeys_capture,
            set_start_at_login,
            set_hide_on_fullscreen,
            check_for_updates,
            spotify::spotify_display_name,
            history::clear_history,
            upnext::upnext_list,
            upnext::upnext_add,
            upnext::upnext_remove,
            upnext::upnext_move,
            similar::more_like_this,
            similar::discovery_picks,
            dock::set_window_size,
            dock::set_hit_size,
            dock::start_drag,
            dock::dock_corner,
            presence::presence_state,
            presence::set_presence_debug
        ])
        .on_window_event(|window, event| {
            match event {
                // Corner-snap is the MAIN window's behavior only — the
                // handler fires for every window's moves, and an unguarded
                // forward would arm the snap on the search window (live-verified
                // trap from the multi-window planning pass).
                tauri::WindowEvent::Moved(_) if window.label() == "main" => {
                    dock::on_moved(window);
                }
                // Blur dismisses the search window — the OS focus event is the
                // trustworthy signal (webview-side blur can lie during
                // devtools/IME churn).
                tauri::WindowEvent::Focused(false) if window.label() == search::LABEL => {
                    search::hide(window.app_handle());
                }
                // A dead window's reactive vote must not wedge the capture
                // gate (the search window is create-once so this mostly serves
                // focus mode's create/destroy lifecycle). Focus mode's
                // destroy is ALSO its close path — Esc, the collapse
                // control, and Alt-F4 all converge here, where the widget
                // returns to its exact prior intent.
                tauri::WindowEvent::Destroyed => {
                    let votes = window.app_handle().state::<UiReactive>();
                    {
                        let mut m = votes
                            .0
                            .lock()
                            .unwrap_or_else(std::sync::PoisonError::into_inner);
                        m.remove(window.label());
                    }
                    if window.label() == focus::LABEL {
                        focus::on_destroyed(window.app_handle());
                    }
                    // Prefs can die NATIVELY mid-capture — Alt+F4, the
                    // taskbar Close, a webview crash — teardown paths where
                    // the capture cleanup's resume invoke never runs (React
                    // cleanups don't fire on webview destruction), which
                    // would leave every global shortcut suspended
                    // system-wide until the next rebind or relaunch. Resume
                    // unconditionally: register_all is idempotent (a
                    // no-capture close rebuilds the same table) and
                    // REG_LOCK-serialized against closePrefs' awaited
                    // resume. Spawned OFF this main-thread handler —
                    // register_all blocks on per-shortcut main-thread hops
                    // and can wait on REG_LOCK, either of which would
                    // deadlock if run inline here (see REG_LOCK).
                    if window.label() == prefs::LABEL {
                        let app = window.app_handle().clone();
                        tauri::async_runtime::spawn_blocking(move || register_all(&app));
                    }
                }
                _ => {}
            }
        })
        .setup(|app| {
            // Panic hook: in a release build stderr is discarded, so an
            // uncaught panic (any thread — the media loop, presence watcher,
            // blocking-pool tasks) otherwise vanishes with no trace. Log the
            // payload + location + a captured backtrace through the file logger
            // (initialized above), then chain to the default hook so dev builds
            // still print to the console. Installed here in setup, after the
            // log plugin has registered the global logger.
            let default_panic_hook = std::panic::take_hook();
            std::panic::set_hook(Box::new(move |info| {
                let location = info
                    .location()
                    .map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column()))
                    .unwrap_or_else(|| "unknown location".to_string());
                let payload = info
                    .payload()
                    .downcast_ref::<&str>()
                    .copied()
                    .or_else(|| info.payload().downcast_ref::<String>().map(String::as_str))
                    .unwrap_or("<non-string panic payload>");
                let backtrace = std::backtrace::Backtrace::force_capture();
                log::error!("panic at {location}: {payload}\n{backtrace}");
                default_panic_hook(info);
            }));

            // Tray: Show/Hide + Quit.
            let show_hide = MenuItem::with_id(app, "toggle", "Show / Hide", true, None::<&str>)?;
            // Manual re-dock (bottom-right). Launch snapping already heals
            // positions persisted on a now-disconnected monitor; this is the
            // belt-and-braces path for a chromeless, taskbar-less window.
            let reset = MenuItem::with_id(app, "reset", "Reset position", true, None::<&str>)?;
            // Preferences window (prefs.rs) — the reliable entry for returning
            // users (the right-click context menu is the other, in a later
            // phase). "Shortcuts / Help" jumps straight to the Hotkeys section.
            let prefs_item = MenuItem::with_id(app, "prefs", "Preferences…", true, None::<&str>)?;
            let shortcuts_item =
                MenuItem::with_id(app, "shortcuts", "Shortcuts / Help", true, None::<&str>)?;
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
            // Reveal the log dir so a user hitting a crash / failed refresh can
            // grab pulse.log to send (see the log plugin above). Seated next to
            // "Check for updates" — both are supportability affordances.
            let open_logs = MenuItem::with_id(app, "logs", "Open logs", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit Palette", true, None::<&str>)?;
            // Dev-only conceal test affordance: fullscreen apps are awkward
            // to summon on demand; this feeds the presence loop a synthetic
            // fullscreen verdict for 10s (hysteresis still applies).
            #[cfg(debug_assertions)]
            let sim_fs = MenuItem::with_id(
                app,
                "simfs",
                "Simulate fullscreen (10s)",
                true,
                None::<&str>,
            )?;
            // Dev-only wedge test: fakes the un-reproducible hung-WinRT-call
            // state on the media loop (2026-07-15 freeze) — verifies the
            // watchdog line, that seed/transport stay live (lock narrowing),
            // and the frontend staleness re-seed. 15s > the 10s watchdog
            // threshold so the stall demonstrably logs mid-wedge.
            #[cfg(debug_assertions)]
            let sim_wedge = MenuItem::with_id(
                app,
                "simwedge",
                "Simulate media wedge (15s)",
                true,
                None::<&str>,
            )?;
            #[cfg(debug_assertions)]
            let menu = Menu::with_items(
                app,
                &[
                    &show_hide,
                    &reset,
                    &prefs_item,
                    &shortcuts_item,
                    &autostart,
                    &companion,
                    &spotify_item,
                    &sim_fs,
                    &sim_wedge,
                    &update_check,
                    &open_logs,
                    &quit,
                ],
            )?;
            #[cfg(not(debug_assertions))]
            let menu = Menu::with_items(
                app,
                &[
                    &show_hide,
                    &reset,
                    &prefs_item,
                    &shortcuts_item,
                    &autostart,
                    &companion,
                    &spotify_item,
                    &update_check,
                    &open_logs,
                    &quit,
                ],
            )?;
            // Store the two check items so prefs toggles can mirror the tray.
            {
                let th = app.state::<TrayHandles>();
                *th.autostart
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(autostart.clone());
                *th.companion
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(companion.clone());
            }
            let update_item = update_check.clone();
            TrayIconBuilder::with_id("pulse-tray")
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("Palette")
                .menu(&menu)
                .show_menu_on_left_click(true)
                .on_menu_event(move |app, event| match event.id.as_ref() {
                    // toggle/reset/companion reach apply_visibility → emit_now
                    // (GSMTC) and sync_seat; on_menu_event runs on the main
                    // thread, so run them OFF it (see defer_main_action) — this
                    // is what kept the tray from freezing the pump.
                    "toggle" => defer_main_action(app, toggle_widget),
                    "reset" => defer_main_action(app, dock::reset_position),
                    "prefs" => prefs::open(app, None),
                    "shortcuts" => prefs::open(app, Some("hotkeys".to_string())),
                    // Toggle from the registry's actual state, through the
                    // shared helper so the tray checkmark + prefs mirror stay
                    // in sync (the check item does NOT auto-toggle itself).
                    "autostart" => {
                        let on = !app.autolaunch().is_enabled().unwrap_or(false);
                        set_autostart(app, on);
                    }
                    "companion" => defer_main_action(app, |app| {
                        let on = !app.state::<VisIntent>().companion.load(Ordering::Relaxed);
                        set_companion(app, on);
                    }),
                    // Off the pump like "toggle"/"companion": disconnect does
                    // token-file I/O (and connected() takes the state lock), so
                    // it must not run on the message pump.
                    "spotify" => defer_main_action(app, |app| {
                        if spotify::connected(app) {
                            spotify::disconnect(app);
                        } else {
                            spotify::start_connect(app);
                        }
                    }),
                    #[cfg(debug_assertions)]
                    "simfs" => {
                        app.state::<presence::Presence>()
                            .simulate_fullscreen(Duration::from_secs(10));
                    }
                    #[cfg(debug_assertions)]
                    "simwedge" => media::simulate_wedge(15_000),
                    "update" => {
                        // Disable before spawning — we're on the main thread
                        // here, so a double-click can't race two checks.
                        let _ = update_item.set_text("Checking…");
                        let _ = update_item.set_enabled(false);
                        spawn_update_check(app, Some(update_item.clone()));
                    }
                    "logs" => {
                        // Open the log dir in the file manager (the log plugin
                        // writes pulse.log here). Direct Rust call — bypasses
                        // the webview capability layer, so no capability
                        // change is needed. Best-effort: nothing to recover if
                        // the folder can't be opened.
                        use tauri_plugin_opener::OpenerExt;
                        if let Ok(dir) = app.path().app_log_dir() {
                            let _ = app.opener().open_path(dir.to_string_lossy(), None::<&str>);
                        }
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

            // Play-history: resolve the log dir now, build the line index on a
            // background thread (off the launch path — history_page waits on it).
            history::init(app.handle());
            // Managed up-next: restore the persisted list + fed marker.
            upnext::init(app.handle());
            // Docking: restore the persisted fullscreen seat.
            dock::init(app.handle());

            // Global hotkeys — resolve persisted overrides and register the
            // seven actions (hotkey_defs). register_all records each
            // shortcut's OS-registration result so the prefs Hotkeys UI can
            // surface a reserved-combo failure instead of a silent eprintln,
            // and the prefs rebind/reset commands re-run this exact path.
            register_all(app.handle());

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

            // Main-thread liveness watchdog: logs a UI-pump stall before Windows
            // force-closes it (the "Application Hang" class), so any future
            // regression is diagnosable from pulse.log instead of vanishing.
            spawn_main_thread_watchdog(app.handle().clone());

            // Audio-reactive capture switch: on ONLY while visible AND playing
            // (plan M4 — a hidden or paused widget does zero audio work).
            let audio_switch = Arc::new(AtomicBool::new(false));
            audio::spawn(app.handle().clone(), audio_switch.clone());
            let ui_reactive = app.state::<UiReactive>().0.clone();
            // The search window: create-once-hidden so Ctrl+Alt+S is
            // instant (WebView2 cold-create costs hundreds of ms).
            search::init(app.handle());

            // Media loop → "now-playing" events: a heartbeat poll plus GSMTC
            // change events that cut the wait short, so track changes,
            // play/pause, and thumbnail attaches reach the UI within ~50ms
            // instead of up to a full interval later. Skips all work while the
            // widget is hidden (toggle_widget emits fresh state on show).
            // NOTE: is_visible() is "not hidden/minimized", not "unoccluded" —
            // a fully covered widget still captures. Occlusion detection isn't
            // exposed through Tauri; accepted for v1.
            let handle = app.handle().clone();
            std::thread::Builder::new()
                .name("media-loop".into())
                .spawn(move || {
                    // Explicit MTA: media.rs's wait_op timeouts rely on WinRT
                    // completions arriving on the COM threadpool — make the
                    // implicit-MTA assumption explicit (S_FALSE double-init is
                    // fine; same idiom as audio.rs).
                    let _ = unsafe {
                        windows::Win32::System::Com::CoInitializeEx(
                            None,
                            windows::Win32::System::Com::COINIT_MULTITHREADED,
                        )
                    };
                    // Stage telemetry + dev sim-wedge key off this mark; the
                    // watchdog reads media::beat_age_ms (stage transitions +
                    // the per-iteration beat below).
                    media::mark_media_loop_thread();
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
                        media::beat();
                        if let Some(w) = watch.as_mut() {
                            w.resubscribe(std::mem::take(&mut resubscribe));
                        }
                        // Widened for focus mode: main hides behind the takeover
                        // (VisIntent.focus_open), and a loop gated on main alone
                        // would stop emitting — a frozen player in the focus
                        // window (verified in planning). The audio capture
                        // switch below inherits this for free.
                        let visible = handle
                            .get_webview_window("main")
                            .and_then(|w| w.is_visible().ok())
                            .unwrap_or(true)
                            || handle
                                .get_webview_window(focus::LABEL)
                                .and_then(|w| w.is_visible().ok())
                                .unwrap_or(false);
                        let playing = if visible {
                            hidden_beats = 0;
                            let tick = media::tick_key();
                            let probing = media::art_probing(&handle.state::<ArtCache>());
                            let p = if std::mem::take(&mut force_snapshot)
                                || probing
                                || tick != last_tick
                            {
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
                        let reactive = reactive_effective(&ui_reactive);
                        // The capture's process-scoping target rides the same
                        // beat as the switch: whichever app GSMTC says is
                        // playing is the app whose audio the waveform should
                        // hear (loopback.rs — never the whole device mix).
                        audio::set_target(last_tick.as_ref().map(|k| k.0.as_str()).unwrap_or(""));
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
                })
                .expect("spawn media-loop thread");
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|app, event| {
            // Main-thread heartbeat (see spawn_main_thread_watchdog): every
            // RunEvent proves the pump is alive, so an idle app never trips the
            // stall watchdog.
            MAIN_TICK_MS.store(now_ms(), Ordering::Relaxed);
            // Quit mid-song still logs the listen — the tracker's in-flight
            // candidate finalizes on the way out.
            if let tauri::RunEvent::Exit = event {
                history::flush(app);
            }
        });
}
