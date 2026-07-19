//! Play-history: logs every track Pulse displays, fed from the media loop's
//! own GSMTC stream (GSMTC has no history API — this file IS the history).
//! Append-only JSONL at app_data/history.jsonl, no cap; an in-memory
//! (started_at, byte offset) index serves backwards pagination without
//! holding entries in RAM. The index build reads the whole log, so it runs
//! on a background thread spawned from setup (off the launch path —
//! Milestone D); page() waits on it, bounded, via the Tracker condvar.
//!
//! `ms_listened` is accumulated wall-clock time spent in status "playing",
//! measured with `Instant` at status transitions. This is NOT position
//! projection — the "Rust never projects a UI-visible position" rule guards
//! the playback clock the frontend renders; this is a coarse analytics
//! duration that never touches that pipeline.
//!
//! Dedupe rules (the tracker state machine):
//! - pause/resume of the same track = one entry (spans accumulate);
//! - session vanish (Apple Music deregisters on stop — matrix finding #4)
//!   followed by the SAME track within REAPPEAR_GRACE resumes the same
//!   entry; a different track or grace expiry finalizes it;
//! - a repeat/loop of the same track is a NEW entry, detected by the raw
//!   position restarting near 0 after having been well past the restart bar;
//! - sub-second listens are dropped: rapid skip-throughs surface each
//!   intermediate track for a few hundred ms and those are GSMTC churn, not
//!   listening history.

use crate::media::{self, NowPlaying};
use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use serde::{Deserialize, Serialize};
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::{Condvar, Mutex, PoisonError};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager};

/// Same-track reappearance window after a session vanish (AM stop → resume).
const REAPPEAR_GRACE: Duration = Duration::from_secs(600);
/// Entries below this listened floor are dropped as skip-through churn.
const MIN_LISTEN_MS: i64 = 1_000;
/// A raw position back under this after passing the restart bar = a replay.
const RESTART_NEAR_START_MS: i64 = 10_000;
/// The restart bar floor (raised to 60% of duration when duration is known).
const RESTART_MIN_PROGRESS_MS: i64 = 30_000;
const THUMB_MAX_FILES: usize = 300;
/// Thumbs are ~96px JPEGs (3-5 KB); anything bigger is a caller bug.
const THUMB_MAX_BYTES: usize = 200_000;

#[derive(Serialize, Deserialize, Clone)]
pub struct HistoryEntry {
    /// Schema version — the seam for later columns (art variants etc).
    pub v: u32,
    /// Identity hash of (app_id, title, artist) — the SAME hash as the art
    /// cache key (media::ident_key), so the frontend can derive the thumb
    /// file from an art_id's key prefix.
    pub key: String,
    pub app_id: String,
    pub player: String,
    pub title: String,
    pub artist: String,
    pub album: String,
    pub started_at_ms: i64,
    pub ended_at_ms: i64,
    pub ms_listened: i64,
    pub duration_ms: i64,
    /// Stamped by the up-next engine's enrichment while Spotify is connected
    /// (PR 3) — lets history rows replay without a search round-trip.
    pub spotify_uri: Option<String>,
    /// GSMTC MediaPlaybackType bucket ("music" | "video" | "image" |
    /// "unknown"), copied from the snapshot. Read surfaces (page + the
    /// history-appended emit) keep only music via `is_music`. `#[serde(default)]`
    /// → "" on pre-feature rows, which is exactly the legacy sentinel is_music
    /// falls back on; new rows are always non-empty.
    #[serde(default)]
    pub media_kind: String,
}

/// The in-progress listen — becomes a HistoryEntry when it finalizes.
struct Candidate {
    key: String,
    app_id: String,
    player: String,
    title: String,
    artist: String,
    album: String,
    duration_ms: i64,
    started_at_ms: i64,
    listened_ms: i64,
    /// Some while status == "playing" — the open span's start.
    playing_since: Option<Instant>,
    /// Last raw player-reported position — restart (replay) detection only.
    last_raw_pos_ms: i64,
    /// Set when the session deregistered with this track current; cleared if
    /// the same track reappears within REAPPEAR_GRACE.
    vanished_at: Option<Instant>,
    spotify_uri: Option<String>,
    /// GSMTC MediaPlaybackType bucket, carried through to the finalized entry.
    media_kind: String,
}

impl Candidate {
    fn new(np: &NowPlaying, key: String) -> Self {
        Self {
            key,
            app_id: np.app_id.clone(),
            player: np.player.clone(),
            title: np.title.clone(),
            artist: np.artist.clone(),
            album: np.album.clone(),
            duration_ms: np.duration_ms,
            started_at_ms: unix_ms(),
            listened_ms: 0,
            playing_since: (np.status == "playing").then(Instant::now),
            // Same trust rule as the update path: an untimestamped payload's
            // position carries no replay signal — don't seed the baseline
            // from it (a stale first read past the bar would make the next
            // real near-zero position look like a replay).
            last_raw_pos_ms: if np.position_at_ms > 0 {
                np.position_ms
            } else {
                0
            },
            vanished_at: None,
            spotify_uri: None,
            media_kind: np.media_kind.clone(),
        }
    }

    /// Close an open playing span into the accumulator.
    fn close_span(&mut self) {
        if let Some(since) = self.playing_since.take() {
            self.listened_ms += since.elapsed().as_millis() as i64;
        }
    }

    fn into_entry(mut self) -> HistoryEntry {
        self.close_span();
        HistoryEntry {
            v: 2, // +media_kind
            key: self.key,
            app_id: self.app_id,
            player: self.player,
            title: self.title,
            artist: self.artist,
            album: self.album,
            started_at_ms: self.started_at_ms,
            ended_at_ms: unix_ms(),
            ms_listened: self.listened_ms,
            duration_ms: self.duration_ms,
            spotify_uri: self.spotify_uri,
            media_kind: self.media_kind,
        }
    }
}

/// One (started_at, byte offset) pair per well-formed line of history.jsonl,
/// in file (≈ chronological) order.
struct IndexEntry {
    started_at_ms: i64,
    offset: u64,
}

#[derive(Default)]
pub struct Tracker {
    inner: Mutex<Inner>,
    /// Signals `index_ready` flipping true (the background build finishing).
    index_built: Condvar,
}

#[derive(Default)]
struct Inner {
    /// app_data dir — None until init() ran (ingests before that no-op).
    dir: Option<PathBuf>,
    index: Vec<IndexEntry>,
    /// False until the background index build finished (or was superseded by
    /// a clear). Appends don't need it (they compute offsets from the file);
    /// only page() waits.
    index_ready: bool,
    /// Bumped by clear_history so an in-flight build result from the
    /// pre-truncation log is discarded instead of resurrecting it.
    epoch: u64,
    candidate: Option<Candidate>,
}

fn unix_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn lock(t: &Tracker) -> std::sync::MutexGuard<'_, Inner> {
    t.inner
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

fn log_path(dir: &Path) -> PathBuf {
    dir.join("history.jsonl")
}

/// Resolve app_data (cheap, synchronous) and kick the line-index build onto
/// a background thread — the build reads the whole log, and launch must not
/// pay for a long listening history. Called once from setup; a failed
/// resolution leaves the tracker inert (ingest no-ops) rather than logging
/// to a surprise location.
pub fn init(app: &AppHandle) {
    let Ok(dir) = app.path().app_data_dir() else {
        log::warn!("history: app data dir unavailable — history disabled this run");
        // No build will ever run — release page()'s bounded wait immediately.
        let tracker = app.state::<Tracker>();
        lock(&tracker).index_ready = true;
        tracker.index_built.notify_all();
        return;
    };
    let path = log_path(&dir);
    let epoch = {
        let tracker = app.state::<Tracker>();
        let mut inner = lock(&tracker);
        inner.dir = Some(dir);
        inner.epoch
    };
    let app = app.clone();
    std::thread::spawn(move || {
        let (built, boundary) = load_index(&path);
        let tracker = app.state::<Tracker>();
        let mut inner = lock(&tracker);
        if inner.epoch == epoch {
            // Entries appended while the build ran sit at offsets >= the
            // snapshot boundary (appends only ever grow the file), so they're
            // exactly the in-memory rows the snapshot missed — keep them, in
            // order, after the built rows. Anything below the boundary is
            // already IN the snapshot and would only duplicate. The boundary
            // is end-of-last-good-line (see load_index), so an append caught
            // torn by the read lands at the boundary and is recovered here
            // rather than falling into the gap between built and late.
            let late: Vec<IndexEntry> = inner
                .index
                .drain(..)
                .filter(|e| e.offset >= boundary)
                .collect();
            inner.index = built;
            inner.index.extend(late);
        }
        // On an epoch mismatch a clear_history truncated the log mid-build:
        // the live index (empty + post-clear appends) is the truth and the
        // snapshot would resurrect erased listens — drop it on the floor.
        inner.index_ready = true;
        drop(inner);
        tracker.index_built.notify_all();
    });
}

/// Byte-wise on purpose: `read_to_string` would reject the WHOLE file over
/// one torn multi-byte character (a crash mid-append on a non-ASCII title),
/// silently emptying the index. Parsing per line bounds that damage to the
/// torn line — every other entry stays reachable. Also returns the merge
/// boundary: the offset just past the LAST SUCCESSFULLY PARSED line — NOT
/// total bytes read. The distinction matters when the background build reads
/// the file mid-append: a torn tail (an in-flight append caught half-written)
/// fails to parse, and counting its bytes toward the boundary would push it
/// past the offset the concurrent finalize() recorded for that same entry —
/// excluding it from BOTH the built snapshot and the "late" merge set, silently
/// dropping it from the in-memory index until the next restart. Boundary =
/// end-of-last-good-line keeps that entry in the late set (its offset == the
/// boundary), so the merge recovers it. A fully-read entry sits below the next
/// good line's end, so it can't double-count either.
fn load_index(path: &Path) -> (Vec<IndexEntry>, u64) {
    let Ok(raw) = std::fs::read(path) else {
        return (Vec::new(), 0);
    };
    let mut offset = 0u64;
    let mut good_end = 0u64;
    let mut out = Vec::new();
    for line in raw.split_inclusive(|b| *b == b'\n') {
        if let Ok(e) = serde_json::from_slice::<HistoryEntry>(line) {
            out.push(IndexEntry {
                started_at_ms: e.started_at_ms,
                offset,
            });
            good_end = offset + line.len() as u64;
        }
        offset += line.len() as u64;
    }
    (out, good_end)
}

/// Feed one observation (a media-loop snapshot or a hidden-window probe)
/// through the tracker; emits "history-appended" for any finalized entry.
pub fn ingest(app: &AppHandle, np: &NowPlaying) {
    let tracker = app.state::<Tracker>();
    let finalized = {
        let mut inner = lock(&tracker);
        inner.ingest(np)
    };
    if let Some(entry) = finalized {
        // Persisted regardless (inside ingest); only music is announced to
        // the queue's live prepend, so non-music never surfaces.
        if is_music(&entry) {
            let _ = app.emit("history-appended", &entry);
        }
    }
}

/// Cheap per-iteration check: finalizes a vanish-pending candidate whose
/// grace expired. Needed because a vanished session stops producing ticks —
/// without this, the pending entry would sit unfinalized until the next
/// session change (or forever).
pub fn tick(app: &AppHandle) {
    let tracker = app.state::<Tracker>();
    let finalized = {
        let mut inner = lock(&tracker);
        let expired = inner
            .candidate
            .as_ref()
            .is_some_and(|c| c.vanished_at.is_some_and(|t| t.elapsed() >= REAPPEAR_GRACE));
        if expired {
            inner.finalize()
        } else {
            None
        }
    };
    if let Some(entry) = finalized {
        if is_music(&entry) {
            let _ = app.emit("history-appended", &entry);
        }
    }
}

/// Finalize whatever is in flight — RunEvent::Exit path, so quitting
/// mid-song still logs the listen. No emit: the webview is going down.
pub fn flush(app: &AppHandle) {
    let tracker = app.state::<Tracker>();
    let mut inner = lock(&tracker);
    inner.finalize();
}

/// Opportunistic Spotify-uri stamping (called from spotify.rs whenever a
/// successful API read reveals the current track's uri): if the in-flight
/// candidate is that track, remember the uri so its history row can replay
/// without a search round-trip. Loose match — GSMTC may carry the primary
/// artist where the API joins all of them.
pub fn enrich_uri(app: &AppHandle, title: &str, artist: &str, uri: &str) {
    let tracker = app.state::<Tracker>();
    let mut inner = lock(&tracker);
    let Some(c) = inner.candidate.as_mut() else {
        return;
    };
    if c.spotify_uri.is_some() || c.player != "spotify" {
        return;
    }
    let title_eq = c.title.trim().to_lowercase() == title.trim().to_lowercase();
    let (a, b) = (c.artist.trim().to_lowercase(), artist.trim().to_lowercase());
    if title_eq && !a.is_empty() && !b.is_empty() && (a.contains(&b) || b.contains(&a)) {
        c.spotify_uri = Some(uri.to_string());
    }
}

impl Inner {
    fn ingest(&mut self, np: &NowPlaying) -> Option<HistoryEntry> {
        if np.player == "none" || np.status == "none" {
            // Session gone. AM does this on every stop (matrix finding #4) —
            // a normal state, not a track change. Mark pending and wait out
            // the grace; tick() handles expiry when no further payloads come.
            let expired = match self.candidate.as_mut() {
                Some(c) => {
                    c.close_span();
                    match c.vanished_at {
                        None => {
                            c.vanished_at = Some(Instant::now());
                            false
                        }
                        Some(t) => t.elapsed() >= REAPPEAR_GRACE,
                    }
                }
                None => false,
            };
            return if expired { self.finalize() } else { None };
        }

        let key = media::ident_key(&np.app_id, &np.title, &np.artist);
        let same = self.candidate.as_ref().is_some_and(|c| c.key == key);
        if !same {
            // Track change (or first track) — finalize whatever was current.
            let entry = self.finalize();
            self.candidate = Some(Candidate::new(np, key));
            return entry;
        }

        // Replay detection: raw position restarted near 0 after having been
        // well past the bar → the SAME track is a NEW listen. Works at AM's
        // 1s floor and Spotify's ~5s push cadence. A manual seek-to-start
        // after listening past the bar logs the first pass — consistent with
        // what was actually listened to.
        let restarted = {
            let c = self.candidate.as_ref().expect("same-track candidate");
            let bar = RESTART_MIN_PROGRESS_MS.max(c.duration_ms * 6 / 10);
            np.position_at_ms > 0
                && np.position_ms < RESTART_NEAR_START_MS
                && c.last_raw_pos_ms > bar
        };
        if restarted {
            let entry = self.finalize();
            self.candidate = Some(Candidate::new(np, key));
            return entry;
        }

        // Same track continuing — possibly back from a vanish (one entry).
        let c = self.candidate.as_mut().expect("same-track candidate");
        c.vanished_at = None;
        if np.duration_ms > 0 {
            c.duration_ms = np.duration_ms;
        }
        match (np.status == "playing", c.playing_since) {
            (true, None) => c.playing_since = Some(Instant::now()),
            (false, Some(_)) => c.close_span(),
            _ => {}
        }
        // Only track real positions — a payload that never stamped a
        // timeline (position_at_ms == 0) carries no replay signal.
        if np.position_at_ms > 0 {
            c.last_raw_pos_ms = np.position_ms;
        }
        None
    }

    /// Close out the candidate: below the listen floor it's dropped as
    /// skip-through churn; otherwise appended to the log + index.
    fn finalize(&mut self) -> Option<HistoryEntry> {
        let entry = self.candidate.take()?.into_entry();
        if entry.ms_listened < MIN_LISTEN_MS {
            return None;
        }
        let dir = self.dir.clone()?;
        match append(&dir, &entry) {
            Ok(offset) => {
                self.index.push(IndexEntry {
                    started_at_ms: entry.started_at_ms,
                    offset,
                });
                Some(entry)
            }
            Err(e) => {
                log::warn!("history: append failed ({e}) — entry dropped");
                None
            }
        }
    }

    /// Newest-first page of entries strictly older than `before` (None = from
    /// the newest). The index is in append order, ≈ ascending started_at — a
    /// wall-clock jump can locally disorder it, in which case partition_point
    /// lands on a valid nearby boundary (accepted; entries are never lost,
    /// only page boundaries shift).
    fn page(&self, before_started_at_ms: Option<i64>, limit: usize) -> Vec<HistoryEntry> {
        let Some(dir) = &self.dir else {
            return Vec::new();
        };
        let end = match before_started_at_ms {
            Some(ts) => self.index.partition_point(|e| e.started_at_ms < ts),
            None => self.index.len(),
        };
        if end == 0 || limit == 0 {
            return Vec::new();
        }
        let Ok(file) = std::fs::File::open(log_path(dir)) else {
            return Vec::new();
        };
        let mut reader = BufReader::new(file);
        let mut out = Vec::with_capacity(limit);
        // Fill-to-limit, newest→oldest: skip non-music rows and keep scanning
        // rather than taking a fixed window, so a page short of `limit` means
        // "reached the start" — the exhausted signal both consumers rely on
        // (Search RESURFACE scan, Queue loadMore). Deliberately uncapped: the
        // cursor advances past the oldest RETURNED row each loadMore, so rows
        // above it are never re-read — total work is O(index) across a full
        // scroll, not per-call. A scan cap would be wrong here: returning
        // < limit while music remains below would falsely mark the feed
        // exhausted and silently truncate it.
        for i in (0..end).rev() {
            if out.len() >= limit {
                break;
            }
            if reader.seek(SeekFrom::Start(self.index[i].offset)).is_err() {
                continue;
            }
            let mut line = String::new();
            if reader.read_line(&mut line).is_err() {
                continue;
            }
            if let Ok(e) = serde_json::from_str::<HistoryEntry>(line.trim_end()) {
                if is_music(&e) {
                    out.push(e);
                }
            }
        }
        out
    }
}

/// Music gate for the READ surfaces (search + queue). Conservative: only a
/// POSITIVE video/image kind is dropped, so a music app that mislabels its
/// PlaybackType as Unknown is never lost. "" is the pre-feature legacy row
/// (no media_kind persisted) — those fall back to the player bucket, which
/// keeps old Apple Music/Spotify listens and hides old browser/video ones.
/// Persistence is untouched; this only governs what surfaces.
fn is_music(e: &HistoryEntry) -> bool {
    match e.media_kind.as_str() {
        "video" | "image" => false,
        "" => matches!(e.player.as_str(), "apple_music" | "spotify"),
        _ => true, // "music", "unknown", any future kind
    }
}

/// Append one entry line; returns its byte offset in the log. Heals a
/// crash-torn tail first: if the file doesn't already end in a newline, the
/// previous process died mid-append and this line would GLUE onto that partial
/// one — serde_json then rejects the fused line and BOTH entries vanish from
/// every later load_index/page. Prepend a newline so the append lands clean;
/// the cost is one blank line, which both readers tolerate (from_slice/from_str
/// skip it, offsets stay correct).
fn append(dir: &Path, entry: &HistoryEntry) -> std::io::Result<u64> {
    std::fs::create_dir_all(dir)?;
    let path = log_path(dir);
    let mut offset = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
    let needs_heal = if offset > 0 {
        // Read the last byte only; append writes still go to EOF regardless.
        let mut f = std::fs::File::open(&path)?;
        f.seek(SeekFrom::End(-1))?;
        let mut tail = [0u8; 1];
        f.read_exact(&mut tail)?;
        tail[0] != b'\n'
    } else {
        false
    };
    let mut line = String::new();
    if needs_heal {
        line.push('\n'); // separate the torn partial from this entry
        offset += 1; // the entry begins after the heal newline
    }
    line.push_str(&serde_json::to_string(entry).map_err(std::io::Error::other)?);
    line.push('\n');
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)?;
    // One write_all so the heal newline + entry land together (no new tear
    // introduced between them).
    file.write_all(line.as_bytes())?;
    Ok(offset)
}

/// Newest-first history page. `before_started_at_ms` = the oldest loaded
/// entry's started_at for infinite scroll; None seeds from the newest.
/// Waits (bounded) for the background index build on the blocking pool —
/// usually a no-op, the build finishes long before the first queue open; on
/// timeout it fails open with whatever rows exist rather than hanging the
/// feed.
#[tauri::command]
pub async fn history_page(
    app: AppHandle,
    before_started_at_ms: Option<i64>,
    limit: u32,
) -> Result<Vec<HistoryEntry>, ()> {
    tauri::async_runtime::spawn_blocking(move || {
        let tracker = app.state::<Tracker>();
        let mut inner = lock(&tracker);
        let deadline = Instant::now() + Duration::from_secs(5);
        while !inner.index_ready {
            let now = Instant::now();
            if now >= deadline {
                break;
            }
            let (guard, _) = tracker
                .index_built
                .wait_timeout(inner, deadline - now)
                .unwrap_or_else(PoisonError::into_inner);
            inner = guard;
        }
        inner.page(before_started_at_ms, (limit as usize).min(200))
    })
    .await
    .map_err(|_| ())
}

/// Wipe all play history: the JSONL log, the thumbnail cache, and the
/// in-memory index — and drop any in-flight candidate so it can't re-append
/// the track the user just erased. Non-destructive to anything else in
/// app-data (settings, tokens, up-next). Emits "history-cleared" so live feed
/// surfaces (queue/search) can reset. Returns false only if app-data was
/// never resolved (history disabled this run).
#[tauri::command]
pub async fn clear_history(app: AppHandle) -> bool {
    let tracker = app.state::<Tracker>();
    let dir = {
        let mut inner = lock(&tracker);
        inner.candidate = None;
        inner.index.clear();
        // Invalidate any in-flight background index build — its snapshot
        // predates the truncation and merging it would resurrect erased
        // listens.
        inner.epoch = inner.epoch.wrapping_add(1);
        inner.dir.clone()
    };
    let Some(dir) = dir else {
        return false;
    };
    let _ = std::fs::remove_file(log_path(&dir));
    if let Some(td) = thumbs_dir(&app) {
        let _ = std::fs::remove_dir_all(&td);
    }
    let _ = app.emit("history-cleared", ());
    true
}

// ---- thumbs: a bounded disk cache of ~96px covers keyed by the identity
// hash. The FRONTEND downscales (it already holds the art data URL for
// display; no Rust image deps) and pushes one per art REVISION — a rev bump
// means the first capture had the previous track's image (media.rs stale-art
// probe), so writes always overwrite. Rows re-read via history_thumb_url.
// Hidden-window listens get no thumb until the track next plays visibly —
// the glyph fallback covers the gap.

fn thumbs_dir(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_data_dir().ok().map(|d| d.join("thumbs"))
}

/// Keys are DefaultHasher hex — anything else is a path-traversal attempt.
fn valid_key(key: &str) -> bool {
    !key.is_empty() && key.len() <= 32 && key.chars().all(|c| c.is_ascii_hexdigit())
}

#[tauri::command]
pub async fn history_thumb(app: AppHandle, key: String, data_url: String) -> bool {
    if !valid_key(&key) {
        return false;
    }
    let Some(dir) = thumbs_dir(&app) else {
        return false;
    };
    let path = dir.join(format!("{key}.jpg"));
    let Some(b64) = data_url.strip_prefix("data:image/jpeg;base64,") else {
        return false;
    };
    let Ok(bytes) = B64.decode(b64) else {
        return false;
    };
    if bytes.is_empty() || bytes.len() > THUMB_MAX_BYTES {
        return false;
    }
    if std::fs::create_dir_all(&dir).is_err() || std::fs::write(&path, &bytes).is_err() {
        return false;
    }
    evict_old(&dir, THUMB_MAX_FILES);
    true
}

#[tauri::command]
pub async fn history_thumb_url(app: AppHandle, key: String) -> Option<String> {
    if !valid_key(&key) {
        return None;
    }
    let path = thumbs_dir(&app)?.join(format!("{key}.jpg"));
    let mut bytes = Vec::new();
    std::fs::File::open(path)
        .ok()?
        .read_to_end(&mut bytes)
        .ok()?;
    Some(format!("data:image/jpeg;base64,{}", B64.encode(&bytes)))
}

/// Keep a dir bounded: evict oldest files past `max` (the lyrics-cache
/// eviction pattern).
fn evict_old(dir: &Path, max: usize) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let mut files: Vec<(std::time::SystemTime, PathBuf)> = entries
        .filter_map(|e| {
            let e = e.ok()?;
            let meta = e.metadata().ok()?;
            Some((meta.modified().ok()?, e.path()))
        })
        .collect();
    if files.len() <= max {
        return;
    }
    files.sort_by_key(|(t, _)| *t);
    let excess = files.len().saturating_sub(max);
    for (_, path) in files.into_iter().take(excess) {
        let _ = std::fs::remove_file(path);
    }
}
