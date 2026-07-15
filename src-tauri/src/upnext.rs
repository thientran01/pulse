//! Pulse-managed up-next: the queue the 11a UI shows and mutates. Spotify's
//! public API cannot remove or reorder queue items, so Pulse keeps its OWN
//! ordered list and feeds Spotify one track shortly before each track ends —
//! remove/reorder/insert are pure local ops, and Spotify's real queue stays
//! shallow (decided with Thien 2026-07-10; the alternative was read+add-only).
//!
//! Honest limits (docs/smtc-support-matrix.md finding): the chain holds only
//! while Pulse runs and Spotify is connected — otherwise the user's playlist
//! just continues naturally (graceful). Skips made inside the Spotify app
//! pull Spotify's own queue and bypass this list. A fed-but-unplayed front
//! item can't be pulled back out of Spotify's queue — removing it locally
//! accepts that one-track leak.
//!
//! The feeder rides the media loop's observations (visible snapshots AND the
//! hidden ~5s history probe, so concealed listening keeps the chain alive).
//! "Remaining time" is a coarse backend projection off the raw pair — the
//! same documented carve-out as history's ms_listened: it never feeds the
//! UI clock.

use crate::media::{self, NowPlaying};
use crate::spotify::{self, QueueTrack};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager, State};

/// Feed the front item when this little of the current track remains.
/// Position is pushed ~every 5s on Spotify, so the estimate can run ~5s
/// stale — 15s keeps a full push cycle of margin before the transition.
const FEED_REMAINING_MS: i64 = 15_000;
/// Minimum gap between feed attempts (throttles offline retries).
const FEED_RETRY_MS: i64 = 5_000;
/// Same-key replay detection (history.rs's rule): a raw position back under
/// this after passing the bar means the track started over — repeat-one, or
/// a re-queued copy of the currently-playing track beginning to play.
const RESTART_NEAR_START_MS: i64 = 10_000;
const RESTART_MIN_PROGRESS_MS: i64 = 30_000;

#[derive(Serialize, Deserialize, Default)]
struct Persisted {
    v: u32,
    /// The front item already POSTed into Spotify's queue, if any — persisted
    /// so a restart doesn't double-feed the same track.
    fed: Option<String>,
    list: Vec<QueueTrack>,
}

#[derive(Default)]
pub struct UpNext {
    inner: Mutex<Inner>,
    /// One feed HTTP call at a time (fired from the media loop, runs on the
    /// blocking pool — the loop itself must never block on network).
    feed_in_flight: AtomicBool,
    /// One fed-marker reconcile read at a time (see request_reconcile).
    reconcile_in_flight: AtomicBool,
}

#[derive(Default)]
struct Inner {
    dir: Option<PathBuf>,
    list: Vec<QueueTrack>,
    /// uri of the fed-but-not-yet-played front item.
    fed: Option<String>,
    last_feed_attempt_ms: i64,
    /// Identity key of the last observed track — change detection. A session
    /// vanish does NOT clear it (AM-style stop/resume is not a track change).
    last_track: Option<String>,
    /// Last raw position of the observed track — same-key replay detection.
    last_raw_pos_ms: i64,
}

fn unix_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn lock(u: &UpNext) -> std::sync::MutexGuard<'_, Inner> {
    u.inner
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

fn store_path(dir: &Path) -> PathBuf {
    dir.join("upnext.json")
}

fn persist(inner: &Inner) {
    let Some(dir) = &inner.dir else { return };
    let p = Persisted {
        v: 1,
        fed: inner.fed.clone(),
        list: inner.list.clone(),
    };
    if let Ok(json) = serde_json::to_string(&p) {
        // Atomic replace: a crash mid-write must not blank the list to default.
        if let Err(e) = crate::settings::write_atomic(&store_path(dir), json.as_bytes()) {
            log::warn!("upnext: persist failed: {e}");
        }
    }
}

fn emit_list(app: &AppHandle, list: &[QueueTrack]) {
    let _ = app.emit("upnext-changed", list);
}

/// Load the persisted list. Setup-time.
pub fn init(app: &AppHandle) {
    let Ok(dir) = app.path().app_data_dir() else {
        log::warn!("upnext: app data dir unavailable — up-next disabled this run");
        return;
    };
    let loaded = std::fs::read_to_string(store_path(&dir))
        .ok()
        .and_then(|raw| serde_json::from_str::<Persisted>(&raw).ok())
        .unwrap_or_default();
    let upnext = app.state::<UpNext>();
    let mut inner = lock(&upnext);
    inner.dir = Some(dir);
    inner.list = loaded.list;
    inner.fed = loaded.fed;
}

/// Loose GSMTC↔Web-API track match: same title (case-insensitive) and the
/// artist strings overlap (GSMTC may carry the primary artist where the API
/// joins all of them).
fn matches_track(np: &NowPlaying, t: &QueueTrack) -> bool {
    let title_eq = np.title.trim().to_lowercase() == t.title.trim().to_lowercase();
    if !title_eq {
        return false;
    }
    let a = np.artist.trim().to_lowercase();
    let b = t.artist.trim().to_lowercase();
    !a.is_empty() && !b.is_empty() && (a.contains(&b) || b.contains(&a))
}

/// Pop the fed item (it played) — caller holds the lock via &mut Inner.
/// Returns the list for emitting.
fn pop_fed(inner: &mut Inner, fed_uri: &str) -> Vec<QueueTrack> {
    if let Some(i) = inner.list.iter().position(|t| t.uri == fed_uri) {
        inner.list.remove(i);
    }
    inner.fed = None;
    persist(inner);
    inner.list.clone()
}

/// One media-loop observation. Handles track-change bookkeeping (pop a fed
/// item that just started playing) and fires the feeder when the current
/// track nears its end.
pub fn tick(app: &AppHandle, np: &NowPlaying) {
    let upnext = app.state::<UpNext>();
    let jump_active = spotify::jump_active(app);

    // Track-change bookkeeping. While a play_now jump is skipping through
    // the queue, intermediate tracks flicker as "playing" — the fed item
    // among them must NOT be popped as played (the jump re-queues everything
    // it skipped over); a change that slips through the window self-heals
    // via the reconcile read on the next genuine change.
    if np.player != "none" && np.status != "none" {
        let key = media::ident_key(&np.app_id, &np.title, &np.artist);
        let (popped, want_reconcile, changed) = {
            let mut inner = lock(&upnext);
            let same = inner.last_track.as_deref() == Some(key.as_str());
            // Same-key replay (repeat-one, or a re-queued copy of the
            // currently-playing track starting): raw position back near 0
            // after having passed the bar. Uses history.rs's rule.
            let bar = RESTART_MIN_PROGRESS_MS.max(np.duration_ms * 6 / 10);
            let restarted = same
                && np.position_at_ms > 0
                && np.position_ms < RESTART_NEAR_START_MS
                && inner.last_raw_pos_ms > bar;
            if np.position_at_ms > 0 || !same {
                inner.last_raw_pos_ms = if np.position_at_ms > 0 {
                    np.position_ms
                } else {
                    0
                };
            }
            if same && !restarted {
                (None, false, false)
            } else if jump_active {
                inner.last_track = Some(key);
                (None, false, false)
            } else if restarted {
                // Repeat-one restarting an UNRELATED track keeps the fed
                // item armed (it's still waiting in Spotify's queue — a
                // re-feed would duplicate it). A restart that IS the fed
                // item means its queued copy just started: pop it.
                match inner.fed.clone() {
                    Some(fed_uri)
                        if inner
                            .list
                            .iter()
                            .find(|t| t.uri == fed_uri)
                            .is_some_and(|t| matches_track(np, t)) =>
                    {
                        (Some(pop_fed(&mut inner, &fed_uri)), false, true)
                    }
                    _ => (None, false, true),
                }
            } else {
                inner.last_track = Some(key);
                match inner.fed.clone() {
                    // The fed item started playing — it left Spotify's queue
                    // and leaves Pulse's list.
                    Some(fed_uri)
                        if inner
                            .list
                            .iter()
                            .find(|t| t.uri == fed_uri)
                            .is_some_and(|t| matches_track(np, t)) =>
                    {
                        (Some(pop_fed(&mut inner, &fed_uri)), false, true)
                    }
                    // A change to some OTHER track while a fed item is
                    // pending: it usually just means the user jumped around
                    // and the fed item still waits in Spotify's queue (keep
                    // it armed — unmarking would re-feed a duplicate). But
                    // it can also mean the fed item was CONSUMED where we
                    // couldn't see (in-app skip, app downtime) and will
                    // never pop by playing — ask Spotify which it is.
                    Some(_) => (None, true, true),
                    None => (None, false, true),
                }
            }
        };
        if let Some(list) = popped {
            emit_list(app, &list);
        }
        if want_reconcile {
            request_reconcile(app);
        }
        // Every settled track change on a connected Spotify session stamps
        // the new track's uri onto history's fresh candidate (spotify.rs
        // enrich_now — one in-flight, off-thread). This is what makes
        // history rows actionable without a later search round-trip.
        if changed && np.player == "spotify" {
            spotify::enrich_now(app);
        }
    }

    // Feeder. Never while a jump is rewriting the queue (two writers to one
    // external resource), and never twice for the same front (fed marker).
    if jump_active || np.player != "spotify" || np.status != "playing" {
        return;
    }
    if np.duration_ms <= 0 || np.position_at_ms <= 0 {
        return;
    }
    // Coarse remaining estimate off the raw pair (never reaches the UI).
    let projected = np.position_ms + (unix_ms() - np.position_at_ms).clamp(0, 30_000);
    let remaining = np.duration_ms - projected;
    if remaining > FEED_REMAINING_MS {
        return;
    }
    let front = {
        let mut inner = lock(&upnext);
        if inner.fed.is_some() || inner.list.is_empty() {
            return;
        }
        let now = unix_ms();
        if now - inner.last_feed_attempt_ms < FEED_RETRY_MS {
            return;
        }
        inner.last_feed_attempt_ms = now;
        inner.list[0].clone()
    };
    if !spotify::connected(app) {
        return;
    }
    if upnext
        .feed_in_flight
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return;
    }
    // Blocking HTTP must not run on the media loop thread.
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let ok = spotify::add_to_queue(&app, &front.uri).is_ok();
        let upnext = app.state::<UpNext>();
        if ok {
            let mut inner = lock(&upnext);
            // The list may have mutated during the HTTP round-trip. Only arm
            // the marker if the fed track is still the front — otherwise the
            // POSTed copy is the documented one-track leak and must not
            // block feeding the REAL front.
            if inner.list.first().is_some_and(|t| t.uri == front.uri) {
                inner.fed = Some(front.uri);
                persist(&inner);
            } else {
                log::warn!(
                    "upnext: front changed mid-feed — {} leaked to Spotify's queue",
                    front.uri
                );
            }
        }
        upnext.feed_in_flight.store(false, Ordering::SeqCst);
    });
}

/// A track change bypassed a pending fed item — find out (off-thread, one at
/// a time) whether it still waits in Spotify's queue or was consumed where
/// Pulse couldn't see (in-app skip, downtime between sessions). Consumed →
/// it will never pop by playing: drop it and unmark so the feeder moves on.
/// This read is the reconciliation for the fed marker (derived state must
/// not float free of the ground truth forever).
fn request_reconcile(app: &AppHandle) {
    let upnext = app.state::<UpNext>();
    if !spotify::connected(app) {
        return;
    }
    if upnext
        .reconcile_in_flight
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        reconcile_fed(&app);
        app.state::<UpNext>()
            .reconcile_in_flight
            .store(false, Ordering::SeqCst);
    });
}

fn reconcile_fed(app: &AppHandle) {
    let upnext = app.state::<UpNext>();
    let Some(fed_uri) = lock(&upnext).fed.clone() else {
        return;
    };
    let q = spotify::queue_fresh(app);
    if q.status != "ok" {
        return; // can't tell right now — keep waiting, a later change retries
    }
    let still_there = q.queue.iter().any(|t| t.uri == fed_uri)
        || q.currently_playing
            .as_ref()
            .is_some_and(|t| t.uri == fed_uri);
    if still_there {
        return;
    }
    let list = {
        let mut inner = lock(&upnext);
        // Re-check under the lock — the marker may have resolved meanwhile.
        if inner.fed.as_deref() != Some(fed_uri.as_str()) {
            return;
        }
        pop_fed(&mut inner, &fed_uri)
    };
    emit_list(app, &list);
}

/// Run a mutation, persist, emit. Everything the UI does routes through here.
fn mutate(app: &AppHandle, f: impl FnOnce(&mut Inner)) {
    let upnext = app.state::<UpNext>();
    let list = {
        let mut inner = lock(&upnext);
        f(&mut inner);
        persist(&inner);
        inner.list.clone()
    };
    emit_list(app, &list);
}

/// Current list uris, in order — similar.rs's dedupe read.
pub fn uris(app: &AppHandle) -> Vec<String> {
    let upnext = app.state::<UpNext>();
    let inner = lock(&upnext);
    inner.list.iter().map(|t| t.uri.clone()).collect()
}

/// Programmatic append (the more-like-this feeder) — the same emit+persist
/// mutate path as the frontend's add, one item per call so rows arrive
/// incrementally.
pub fn append(app: &AppHandle, item: QueueTrack) {
    mutate(app, |inner| inner.list.push(item));
}

/// Remove by uri (first occurrence). Public for play_now's queue-row path.
pub fn remove(app: &AppHandle, uri: &str) {
    mutate(app, |inner| {
        if let Some(i) = inner.list.iter().position(|t| t.uri == uri) {
            inner.list.remove(i);
        }
        // Removing the fed front: the item is already in Spotify's queue and
        // can't be pulled back — the documented one-track leak. Unmark so
        // the feeder moves on to the new front.
        if inner.fed.as_deref() == Some(uri) {
            inner.fed = None;
        }
    });
}

/// The frontend arms its own suppression when IT starts a jump; this event
/// covers backend-initiated jumps (the queue-aware skip) so the pill's
/// announcement still holds for intermediates and fires once on the target.
#[derive(serde::Serialize, Clone)]
struct JumpTarget {
    title: String,
    artist: String,
}

/// Queue-aware skip: a "next" pressed IN PULSE (transport button, the
/// Ctrl+Alt+N hotkey) lands on the up-next front instead of falling through
/// to the playlist — the mid-song skip was the one transition the feed-late
/// model missed (feeding waits for the last ~15s precisely so remove/reorder
/// keep working; a skip before that window meant Spotify had never been
/// handed anything). Skips made inside the Spotify app still bypass the
/// list — nothing can intercept those (matrix finding 11).
///
/// Returns true when the press was consumed (jump spawned, or one is
/// already in flight — never stack skips); false = caller does a plain
/// next. Cheap sync gates only; all HTTP on the blocking pool.
pub fn try_queue_skip(app: &AppHandle) -> bool {
    let upnext = app.state::<UpNext>();
    let front = {
        let inner = lock(&upnext);
        match inner.list.first() {
            Some(t) => t.clone(),
            None => return false,
        }
    };
    if !spotify::connected(app) || media::current_player() != "spotify" {
        return false;
    }
    if spotify::jump_active(app) {
        return true; // a jump is mid-flight — swallow the press
    }
    let _ = app.emit(
        "spotify-jump",
        JumpTarget {
            title: front.title.clone(),
            artist: front.artist.clone(),
        },
    );
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let upnext = app.state::<UpNext>();
        // A feed POST may be mid-flight for this exact uri (the press often
        // lands inside the feeder's <15s window): wait it out (bounded) so
        // the jump's queue read sees the fed copy instead of appending a
        // DUPLICATE that would play twice (quick-review catch, 2026-07-11).
        let wait_until = std::time::Instant::now() + std::time::Duration::from_secs(3);
        while upnext.feed_in_flight.load(Ordering::SeqCst) && std::time::Instant::now() < wait_until
        {
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        // Read the fed marker AFTER the wait — the feed just resolved it.
        let was_fed = lock(&upnext).fed.as_deref() == Some(front.uri.as_str());
        match spotify::play_now(&app, &front.uri) {
            // Landed (verified): pop the front from Pulse's list. A FED
            // front pops via tick's fed-match instead (racing it here could
            // eat a duplicate entry) — this handles the unfed mid-song case.
            "ok" | "partial" => {
                if !was_fed {
                    remove(&app, &front.uri);
                }
            }
            // Skips happened but the landing is unconfirmed / another jump
            // won the guard — do NOT add a plain skip on top. Suppression
            // rides out its window (the outcome is genuinely uncertain).
            "diverged" | "busy" => {}
            // Nothing was skipped (unreachable, no playback, target gone):
            // the user still asked for NEXT — deliver the plain one so the
            // press never dead-ends, and CANCEL the armed suppression so
            // that legitimate skip still announces (the frontend clears its
            // own arming the same way on a failed play-now).
            _ => {
                let _ = app.emit("spotify-jump-cancel", ());
                media::next();
                crate::emit_now(&app);
            }
        }
    });
    true
}

// ---- commands ----

/// Seed for the queue UI ("upnext-changed" is the event half).
#[tauri::command]
pub async fn upnext_list(upnext: State<'_, UpNext>) -> Result<Vec<QueueTrack>, ()> {
    Ok(lock(&upnext).list.clone())
}

#[tauri::command]
pub async fn upnext_add(app: AppHandle, item: QueueTrack, at: Option<usize>) {
    mutate(&app, |inner| {
        let at = at.unwrap_or(inner.list.len()).min(inner.list.len());
        inner.list.insert(at, item);
    });
}

#[tauri::command]
pub async fn upnext_remove(app: AppHandle, uri: String) {
    remove(&app, &uri);
}

#[tauri::command]
pub async fn upnext_move(app: AppHandle, from: usize, to: usize) {
    mutate(&app, |inner| {
        if from < inner.list.len() && to < inner.list.len() && from != to {
            let item = inner.list.remove(from);
            inner.list.insert(to, item);
        }
    });
}
