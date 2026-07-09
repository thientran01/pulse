//! Synced lyrics via LRCLIB (lrclib.net — free, no auth, please send a UA).
//! Strategy: an exact /api/get (artist+title+album+duration) and a raw-title
//! /api/search run CONCURRENTLY — Apple Music's exact call almost always 404s
//! on its album suffix, so the search is on the common path; overlapping them
//! turns a miss-then-hit from a SUM of two slow calls into a MAX. A
//! normalized-title search follows only when both miss. Search hits are
//! filtered by duration ±4s. Successful lookups cache to disk; misses cache
//! in-memory per session so a track without lyrics isn't re-fetched every poll
//! but gets another chance next launch.

use serde::{Deserialize, Serialize};
use std::collections::hash_map::DefaultHasher;
use std::collections::HashSet;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

const UA: &str = "Pulse/0.1.0 (https://github.com/thientran01/pulse)";
// LRCLIB normally answers in <1s but degrades to 7-9s first-byte under load
// (measured 2026-07-07) — a 5s timeout lost every race on a cold cache. The
// fetch runs off the main thread and the UI shows the big-art fallback while
// waiting, so a generous timeout costs nothing visible.
const TIMEOUT: Duration = Duration::from_secs(15);
const DURATION_TOLERANCE_S: f64 = 4.0;
const CACHE_MAX_FILES: usize = 500;

/// Transport-level failure (offline, DNS, timeout) — distinct from a served
/// 404. Callers bail early and must NOT record a miss: a Wi-Fi blip would
/// otherwise suppress lyrics for the track until relaunch.
struct Offline;

#[derive(Serialize, Deserialize, Clone, Default)]
pub struct Lyrics {
    pub synced: Option<String>,
    pub plain: Option<String>,
}

impl Lyrics {
    fn is_empty(&self) -> bool {
        self.synced.is_none() && self.plain.is_none()
    }
}

#[derive(Deserialize)]
struct LrclibRecord {
    #[serde(rename = "syncedLyrics")]
    synced_lyrics: Option<String>,
    #[serde(rename = "plainLyrics")]
    plain_lyrics: Option<String>,
    duration: Option<f64>,
}

impl LrclibRecord {
    fn into_lyrics(self) -> Lyrics {
        Lyrics {
            synced: self.synced_lyrics.filter(|s| !s.trim().is_empty()),
            plain: self.plain_lyrics.filter(|s| !s.trim().is_empty()),
        }
    }

    /// True when the record carries no usable lyric text.
    fn is_empty_record(&self) -> bool {
        self.synced_lyrics.as_deref().map(|s| s.trim().is_empty()).unwrap_or(true)
            && self.plain_lyrics.as_deref().map(|s| s.trim().is_empty()).unwrap_or(true)
    }
}

fn session_misses() -> &'static Mutex<HashSet<String>> {
    static MISSES: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    MISSES.get_or_init(|| Mutex::new(HashSet::new()))
}

fn key_for(artist: &str, title: &str, album: &str, duration_s: i64) -> String {
    let mut h = DefaultHasher::new();
    (artist, title, album, duration_s).hash(&mut h);
    format!("{:x}", h.finish())
}

/// Strip parentheticals and "feat." tails for the fallback search — Apple
/// Music styles titles differently from LRCLIB's catalog (support matrix).
/// A leading parenthetical is part of the name ("(G)I-DLE" tracks etc.) —
/// only trailing ones are stripped.
fn norm_title(title: &str) -> String {
    let mut s = title.to_string();
    if let Some(i) = s.find('(') {
        if i > 0 {
            s.truncate(i);
        }
    }
    if let Some(i) = s.to_lowercase().find("feat.") {
        if i > 0 {
            s.truncate(i);
        }
    }
    s.trim().to_string()
}

fn classify(result: Result<ureq::Response, ureq::Error>) -> Result<Option<ureq::Response>, Offline> {
    match result {
        Ok(resp) => Ok(Some(resp)),
        Err(ureq::Error::Status(_, _)) => Ok(None), // served error (404 etc) — try fallbacks
        Err(_) => Err(Offline),
    }
}

fn get_exact(
    artist: &str,
    title: &str,
    album: &str,
    duration_s: i64,
) -> Result<Option<LrclibRecord>, Offline> {
    let mut req = ureq::get("https://lrclib.net/api/get")
        .set("User-Agent", UA)
        .timeout(TIMEOUT)
        .query("artist_name", artist)
        .query("track_name", title)
        .query("duration", &duration_s.to_string());
    if !album.is_empty() {
        req = req.query("album_name", album);
    }
    Ok(classify(req.call())?.and_then(|r| r.into_json().ok()))
}

fn search(artist: &str, title: &str, duration_s: i64) -> Result<Option<LrclibRecord>, Offline> {
    let resp = match classify(
        ureq::get("https://lrclib.net/api/search")
            .set("User-Agent", UA)
            .timeout(TIMEOUT)
            .query("artist_name", artist)
            .query("track_name", title)
            .call(),
    )? {
        Some(r) => r,
        None => return Ok(None),
    };
    let Ok(records) = resp.into_json::<Vec<LrclibRecord>>() else {
        return Ok(None);
    };
    let close = |r: &&LrclibRecord| {
        r.duration
            .map(|d| (d - duration_s as f64).abs() <= DURATION_TOLERANCE_S)
            .unwrap_or(false)
    };
    // Prefer a synced hit at matching duration, then any hit at matching duration.
    let idx = records
        .iter()
        .position(|r| close(&r) && r.synced_lyrics.as_deref().map(|s| !s.trim().is_empty()).unwrap_or(false))
        .or_else(|| records.iter().position(|r| close(&r)));
    Ok(idx.and_then(|i| records.into_iter().nth(i)))
}

/// Keep the cache bounded: evict oldest files past CACHE_MAX_FILES.
fn evict_old(cache_dir: &Path) {
    let Ok(entries) = std::fs::read_dir(cache_dir) else {
        return;
    };
    let mut files: Vec<(std::time::SystemTime, PathBuf)> = entries
        .filter_map(|e| {
            let e = e.ok()?;
            let meta = e.metadata().ok()?;
            Some((meta.modified().ok()?, e.path()))
        })
        .collect();
    if files.len() <= CACHE_MAX_FILES {
        return;
    }
    files.sort_by_key(|(t, _)| *t);
    let excess = files.len().saturating_sub(CACHE_MAX_FILES);
    for (_, path) in files.into_iter().take(excess) {
        let _ = std::fs::remove_file(path);
    }
}

pub fn fetch(cache_dir: &Path, artist: &str, title: &str, album: &str, duration_ms: i64) -> Lyrics {
    if artist.is_empty() && title.is_empty() {
        return Lyrics::default();
    }
    // Round (not truncate) — players report ms jitter around second boundaries.
    let duration_s = (duration_ms + 500) / 1000;
    let key = key_for(artist, title, album, duration_s);

    let cache_file: PathBuf = cache_dir.join(format!("{key}.json"));
    if let Ok(raw) = std::fs::read_to_string(&cache_file) {
        if let Ok(cached) = serde_json::from_str::<Lyrics>(&raw) {
            return cached;
        }
    }
    {
        let misses = session_misses().lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        if misses.contains(&key) {
            return Lyrics::default();
        }
    }

    // Any transport failure → bail WITHOUT recording a miss (offline ≠ no lyrics).
    let lookup = || -> Result<Option<LrclibRecord>, Offline> {
        // Start the raw-title /api/search CONCURRENTLY with the exact lookup.
        // Apple Music's exact /api/get almost always 404s (its album carries a
        // "- Single"/"- EP" suffix), so the search is on the common path and
        // used to run only AFTER the exact call's full latency — overlapping
        // them turns that miss-then-hit from a SUM into a MAX. The exact call
        // keeps precedence, so we ALWAYS wait for it; the search runs on a
        // detached worker and is joined only when exact misses. An exact hit
        // therefore returns immediately and never blocks on the (heavier)
        // search — the happy path is never slower than the old sequential form.
        let (artist_owned, title_owned) = (artist.to_string(), title.to_string());
        let raw_worker =
            std::thread::spawn(move || search(&artist_owned, &title_owned, duration_s));

        // Hit precedence unchanged: exact (non-empty) > raw search > norm search.
        let exact = get_exact(artist, title, album, duration_s);
        let exact_offline = exact.is_err();
        if let Ok(Some(r)) = exact {
            if !r.is_empty_record() {
                return Ok(Some(r)); // exact hit — raw_worker detaches, its result unused
            }
        }

        // Exact missed; the search result now matters. Join it (usually already
        // done, having run alongside the exact call). A panicked worker degrades
        // to Offline — never a false miss.
        let raw = raw_worker.join().unwrap_or(Err(Offline));
        let raw_offline = raw.is_err();
        if let Ok(Some(r)) = raw {
            return Ok(Some(r));
        }

        // The normalized-title search is a last resort, reached only when both
        // prior attempts SERVED a negative. Skipping it when either was Offline
        // matches the old `?`-propagation (which bailed on the first transport
        // error) AND caps the degraded-network bail at one timeout window
        // instead of chaining a third sequential 15s attempt.
        let norm = norm_title(title);
        let norm_res = if !exact_offline && !raw_offline && !norm.is_empty() && norm != title {
            search(artist, &norm, duration_s)
        } else {
            Ok(None)
        };
        let norm_offline = norm_res.is_err();
        if let Ok(Some(r)) = norm_res {
            return Ok(Some(r));
        }

        // No hit anywhere. A transport failure on ANY attempt means we can't
        // conclude the track has no lyrics — bail without recording a miss
        // (offline ≠ miss). Only an all-served-negative result is a real miss,
        // which matches the old sequential `?`-propagation exactly.
        if exact_offline || raw_offline || norm_offline {
            Err(Offline)
        } else {
            Ok(None)
        }
    };
    let record = match lookup() {
        Ok(r) => r,
        Err(Offline) => return Lyrics::default(),
    };

    let lyrics = record.map(LrclibRecord::into_lyrics).unwrap_or_default();
    if lyrics.is_empty() {
        session_misses()
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .insert(key);
    } else {
        match std::fs::create_dir_all(cache_dir) {
            Ok(()) => {
                if let Ok(json) = serde_json::to_string(&lyrics) {
                    let _ = std::fs::write(&cache_file, json);
                }
                evict_old(cache_dir);
            }
            Err(e) => eprintln!("lyrics cache dir unavailable ({e}) — running uncached"),
        }
    }
    lyrics
}
