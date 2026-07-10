//! Play-history: logs every track Pulse displays, fed from the media loop's
//! own GSMTC stream (GSMTC has no history API — this file IS the history).
//! Append-only JSONL at app_data/history.jsonl, no cap; an in-memory
//! (started_at, byte offset) index built at startup serves backwards
//! pagination without holding entries in RAM.
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
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager, State};

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
            last_raw_pos_ms: if np.position_at_ms > 0 { np.position_ms } else { 0 },
            vanished_at: None,
            spotify_uri: None,
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
            v: 1,
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
pub struct Tracker(Mutex<Inner>);

#[derive(Default)]
struct Inner {
    /// app_data dir — None until init() ran (ingests before that no-op).
    dir: Option<PathBuf>,
    index: Vec<IndexEntry>,
    candidate: Option<Candidate>,
}

fn unix_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn lock(t: &Tracker) -> std::sync::MutexGuard<'_, Inner> {
    t.0.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

fn log_path(dir: &Path) -> PathBuf {
    dir.join("history.jsonl")
}

/// Resolve app_data and build the line index. Called once from setup; a
/// failed resolution leaves the tracker inert (ingest no-ops) rather than
/// logging to a surprise location.
pub fn init(app: &AppHandle) {
    let Ok(dir) = app.path().app_data_dir() else {
        eprintln!("history: app data dir unavailable — history disabled this run");
        return;
    };
    let index = load_index(&log_path(&dir));
    let tracker = app.state::<Tracker>();
    let mut inner = lock(&tracker);
    inner.dir = Some(dir);
    inner.index = index;
}

/// Byte-wise on purpose: `read_to_string` would reject the WHOLE file over
/// one torn multi-byte character (a crash mid-append on a non-ASCII title),
/// silently emptying the index. Parsing per line bounds that damage to the
/// torn line — every other entry stays reachable.
fn load_index(path: &Path) -> Vec<IndexEntry> {
    let Ok(raw) = std::fs::read(path) else {
        return Vec::new();
    };
    let mut offset = 0u64;
    let mut out = Vec::new();
    for line in raw.split_inclusive(|b| *b == b'\n') {
        if let Ok(e) = serde_json::from_slice::<HistoryEntry>(line) {
            out.push(IndexEntry { started_at_ms: e.started_at_ms, offset });
        }
        offset += line.len() as u64;
    }
    out
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
        let _ = app.emit("history-appended", &entry);
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
        let _ = app.emit("history-appended", &entry);
    }
}

/// Finalize whatever is in flight — RunEvent::Exit path, so quitting
/// mid-song still logs the listen. No emit: the webview is going down.
pub fn flush(app: &AppHandle) {
    let tracker = app.state::<Tracker>();
    let mut inner = lock(&tracker);
    inner.finalize();
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
                self.index.push(IndexEntry { started_at_ms: entry.started_at_ms, offset });
                Some(entry)
            }
            Err(e) => {
                eprintln!("history: append failed ({e}) — entry dropped");
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
        let start = end.saturating_sub(limit);
        if start >= end {
            return Vec::new();
        }
        let Ok(file) = std::fs::File::open(log_path(dir)) else {
            return Vec::new();
        };
        let mut reader = BufReader::new(file);
        let mut out = Vec::with_capacity(end - start);
        for i in (start..end).rev() {
            if reader.seek(SeekFrom::Start(self.index[i].offset)).is_err() {
                continue;
            }
            let mut line = String::new();
            if reader.read_line(&mut line).is_err() {
                continue;
            }
            if let Ok(e) = serde_json::from_str::<HistoryEntry>(line.trim_end()) {
                out.push(e);
            }
        }
        out
    }
}

/// Append one entry line; returns its byte offset in the log.
fn append(dir: &Path, entry: &HistoryEntry) -> std::io::Result<u64> {
    std::fs::create_dir_all(dir)?;
    let path = log_path(dir);
    let offset = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
    let mut line = serde_json::to_string(entry).map_err(std::io::Error::other)?;
    line.push('\n');
    let mut file = std::fs::OpenOptions::new().create(true).append(true).open(&path)?;
    file.write_all(line.as_bytes())?;
    Ok(offset)
}

/// Newest-first history page. `before_started_at_ms` = the oldest loaded
/// entry's started_at for infinite scroll; None seeds from the newest.
#[tauri::command]
pub async fn history_page(
    tracker: State<'_, Tracker>,
    before_started_at_ms: Option<i64>,
    limit: u32,
) -> Result<Vec<HistoryEntry>, ()> {
    Ok(lock(&tracker).page(before_started_at_ms, (limit as usize).min(200)))
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
    std::fs::File::open(path).ok()?.read_to_end(&mut bytes).ok()?;
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
