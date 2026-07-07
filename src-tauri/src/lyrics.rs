//! Synced lyrics via LRCLIB (lrclib.net — free, no auth, please send a UA).
//! Strategy: exact /api/get (artist+title+album+duration) → /api/search
//! fallback (raw title, then normalized title) filtered by duration ±4s.
//! Successful lookups cache to disk; misses cache in-memory per session so a
//! track without lyrics isn't re-fetched every poll but gets another chance
//! next launch.

use serde::{Deserialize, Serialize};
use std::collections::hash_map::DefaultHasher;
use std::collections::HashSet;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

const UA: &str = "Pulse/0.1.0 (https://github.com/thientran01/pulse)";
const TIMEOUT: Duration = Duration::from_secs(8);
const DURATION_TOLERANCE_S: f64 = 4.0;

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
fn norm_title(title: &str) -> String {
    let mut s = title.to_string();
    if let Some(i) = s.find('(') {
        s.truncate(i);
    }
    if let Some(i) = s.to_lowercase().find("feat.") {
        s.truncate(i);
    }
    s.trim().to_string()
}

fn get_exact(artist: &str, title: &str, album: &str, duration_s: i64) -> Option<LrclibRecord> {
    let mut req = ureq::get("https://lrclib.net/api/get")
        .set("User-Agent", UA)
        .timeout(TIMEOUT)
        .query("artist_name", artist)
        .query("track_name", title)
        .query("duration", &duration_s.to_string());
    if !album.is_empty() {
        req = req.query("album_name", album);
    }
    req.call().ok()?.into_json().ok()
}

fn search(artist: &str, title: &str, duration_s: i64) -> Option<LrclibRecord> {
    let records: Vec<LrclibRecord> = ureq::get("https://lrclib.net/api/search")
        .set("User-Agent", UA)
        .timeout(TIMEOUT)
        .query("artist_name", artist)
        .query("track_name", title)
        .call()
        .ok()?
        .into_json()
        .ok()?;
    let close = |r: &&LrclibRecord| {
        r.duration
            .map(|d| (d - duration_s as f64).abs() <= DURATION_TOLERANCE_S)
            .unwrap_or(false)
    };
    // Prefer a synced hit at matching duration, then any hit at matching duration.
    let idx = records
        .iter()
        .position(|r| close(&r) && r.synced_lyrics.as_deref().map(|s| !s.trim().is_empty()).unwrap_or(false))
        .or_else(|| records.iter().position(|r| close(&r)))?;
    records.into_iter().nth(idx)
}

pub fn fetch(cache_dir: &Path, artist: &str, title: &str, album: &str, duration_ms: i64) -> Lyrics {
    if artist.is_empty() && title.is_empty() {
        return Lyrics::default();
    }
    let duration_s = duration_ms / 1000;
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

    let record = get_exact(artist, title, album, duration_s)
        .filter(|r| !r.is_empty_record())
        .or_else(|| search(artist, title, duration_s))
        .or_else(|| {
            let norm = norm_title(title);
            if norm.is_empty() || norm == title {
                None
            } else {
                search(artist, &norm, duration_s)
            }
        });

    let lyrics = record.map(LrclibRecord::into_lyrics).unwrap_or_default();
    if lyrics.is_empty() {
        session_misses()
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .insert(key);
    } else if std::fs::create_dir_all(cache_dir).is_ok() {
        if let Ok(json) = serde_json::to_string(&lyrics) {
            let _ = std::fs::write(&cache_file, json);
        }
    }
    lyrics
}
