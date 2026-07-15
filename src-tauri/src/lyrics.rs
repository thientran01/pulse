//! Synced lyrics via LRCLIB (lrclib.net — free, no auth, please send a UA).
//! Strategy: an exact /api/get (artist+title+album+duration) and a raw-title
//! /api/search run CONCURRENTLY — Apple Music's exact call almost always 404s
//! on its album suffix, so the search is on the common path; overlapping them
//! turns a miss-then-hit from a SUM of two slow calls into a MAX. A
//! normalized-title search follows only when both miss. Search hits are
//! filtered by duration ±4s and prefer ORIGINAL-SCRIPT entries (hangul/CJK/
//! kana) over romanized uploads — LRCLIB's K-pop catalog is full of both, and
//! which one sorts first is luck (measured 2026-07-10: NMIXX "KNOW ABOUT ME"
//! led with 3 romanized entries ahead of 4 hangul ones). Successful lookups
//! cache to disk; misses cache in-memory per session so a track without
//! lyrics isn't re-fetched every poll but gets another chance next launch.

use serde::{Deserialize, Serialize};
use std::collections::hash_map::DefaultHasher;
use std::collections::HashSet;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

const UA: &str = "Palette/0.1.0 (https://github.com/thientran01/palette)";
// LRCLIB normally answers in <1s but degrades to 7-9s first-byte under load
// (measured 2026-07-07) — a 5s timeout lost every race on a cold cache. The
// fetch runs off the main thread and the UI shows the big-art fallback while
// waiting, so a generous timeout costs nothing visible.
const TIMEOUT: Duration = Duration::from_secs(15);
/// How long a Latin-only exact hit waits for the racing search to offer an
/// original-script upgrade before serving what it has. The search launched
/// alongside the exact call, so it has had the exact call's whole latency as
/// a head start — under LRCLIB's normal <1s answers this window never
/// actually elapses; under degraded 7-9s first-bytes we'd rather show
/// romanized lyrics than stall the happy path toward the full timeout.
const UPGRADE_GRACE: Duration = Duration::from_secs(3);
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
    /// True only when the fetch bailed on a transport failure (offline, DNS,
    /// timeout) rather than a served "no lyrics" answer — lets the caption
    /// distinguish "unavailable — offline" from "No synced lyrics". Defaults
    /// false (served miss / cache hit / success); cache files predating this
    /// field deserialize to false, which is correct — a cached record is
    /// never an offline result.
    #[serde(default)]
    pub offline: bool,
}

impl Lyrics {
    fn is_empty(&self) -> bool {
        self.synced.is_none() && self.plain.is_none()
    }

    /// The transport-failure sentinel returned to the frontend (never cached).
    fn offline() -> Self {
        Self {
            offline: true,
            ..Self::default()
        }
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
            offline: false,
        }
    }

    /// True when the record carries no usable lyric text.
    fn is_empty_record(&self) -> bool {
        self.synced_lyrics
            .as_deref()
            .map(|s| s.trim().is_empty())
            .unwrap_or(true)
            && self
                .plain_lyrics
                .as_deref()
                .map(|s| s.trim().is_empty())
                .unwrap_or(true)
    }

    fn has_synced(&self) -> bool {
        self.synced_lyrics
            .as_deref()
            .map(|s| !s.trim().is_empty())
            .unwrap_or(false)
    }

    /// True when the synced text carries the song's original script rather
    /// than a romanization. Only scripts that romanized uploads actually
    /// transliterate away count (hangul, CJK ideographs, kana) — NOT all of
    /// non-ASCII, so accented Latin lyrics don't false-positive.
    fn has_original_script(&self) -> bool {
        const MIN_CHARS: usize = 10; // above stray-glyph noise; real entries have hundreds
        self.synced_lyrics
            .as_deref()
            .map(|s| {
                s.chars()
                    .filter(|&c| {
                        matches!(u32::from(c),
                            0xAC00..=0xD7A3 | 0x1100..=0x11FF | 0x3130..=0x318F // hangul
                            | 0x4E00..=0x9FFF | 0x3400..=0x4DBF // CJK ideographs
                            | 0x3040..=0x30FF // kana
                        )
                    })
                    .take(MIN_CHARS)
                    .count()
                    >= MIN_CHARS
            })
            .unwrap_or(false)
    }
}

fn session_misses() -> &'static Mutex<HashSet<String>> {
    static MISSES: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    MISSES.get_or_init(|| Mutex::new(HashSet::new()))
}

fn key_for(artist: &str, title: &str, album: &str, duration_s: i64) -> String {
    let mut h = DefaultHasher::new();
    // "v2" = the 2026-07-10 original-script preference: resalted so tracks
    // cached under the old picker (possibly romanized) refetch once; the
    // orphaned v1 files age out via the CACHE_MAX_FILES eviction.
    ("v2", artist, title, album, duration_s).hash(&mut h);
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

fn classify(
    result: Result<ureq::Response, ureq::Error>,
) -> Result<Option<ureq::Response>, Offline> {
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
    Ok(pick(records, duration_s))
}

/// Choose the best record at matching duration: original-script synced, then
/// any synced, then anything. Script preference stays BELOW synced-ness — a
/// hangul plain-only record must never beat a romanized synced one, karaoke
/// is the point of the view.
fn pick(records: Vec<LrclibRecord>, duration_s: i64) -> Option<LrclibRecord> {
    let close = |r: &LrclibRecord| {
        r.duration
            .map(|d| (d - duration_s as f64).abs() <= DURATION_TOLERANCE_S)
            .unwrap_or(false)
    };
    let idx = records
        .iter()
        .position(|r| close(r) && r.has_synced() && r.has_original_script())
        .or_else(|| records.iter().position(|r| close(r) && r.has_synced()))
        .or_else(|| records.iter().position(close));
    idx.and_then(|i| records.into_iter().nth(i))
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
        let misses = session_misses()
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
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
        // keeps precedence; its result decides how long the search matters:
        // an original-script exact hit returns immediately (never blocks on
        // the heavier search), a Latin-only exact hit gives the search
        // UPGRADE_GRACE to offer an original-script candidate (it can't be
        // told apart from a romanized upload of a non-Latin song without the
        // comparison), and an exact miss waits for the search in full — the
        // search IS the answer then. The result travels over a channel so
        // the grace wait can time out; a panicked worker drops its sender
        // and reads as Offline, never a false miss.
        let (tx, rx) = std::sync::mpsc::channel();
        let (artist_owned, title_owned) = (artist.to_string(), title.to_string());
        std::thread::spawn(move || {
            let _ = tx.send(search(&artist_owned, &title_owned, duration_s));
        });

        // Hit precedence unchanged: exact (non-empty) > raw search > norm
        // search — the script upgrade is the one carve-out, and a search
        // failure or grace timeout can never lose a served exact result.
        let exact = get_exact(artist, title, album, duration_s);
        let exact_offline = exact.is_err();
        let exact_hit = match exact {
            Ok(Some(r)) if !r.is_empty_record() => Some(r),
            _ => None,
        };
        if let Some(r) = exact_hit {
            if r.has_original_script() {
                return Ok(Some(r)); // the search worker detaches, its result unused
            }
            if let Ok(Ok(Some(s))) = rx.recv_timeout(UPGRADE_GRACE) {
                if s.has_original_script() {
                    return Ok(Some(s));
                }
            }
            return Ok(Some(r));
        }

        // Exact missed; the search result now matters. Wait for it in full
        // (it has been running alongside the exact call the whole time).
        let raw = rx.recv().unwrap_or(Err(Offline));
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
        // A transport failure is NOT a "no lyrics" verdict — flag it so the
        // caption can say "unavailable — offline" instead of "No synced
        // lyrics", and (as before) don't record a session miss.
        Err(Offline) => return Lyrics::offline(),
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
            Err(e) => log::warn!("lyrics cache dir unavailable ({e}) — running uncached"),
        }
    }
    lyrics
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rec(synced: Option<&str>, plain: Option<&str>, duration: f64) -> LrclibRecord {
        LrclibRecord {
            synced_lyrics: synced.map(str::to_string),
            plain_lyrics: plain.map(str::to_string),
            duration: Some(duration),
        }
    }

    const HANGUL: &str = "[00:12.00] 제대로 건드린 호기심의 끈\n[00:15.00] 깟다킨";
    const ROMAJI: &str = "[00:12.00] jedaero geondeun hogisimui kkeun\n[00:15.00] kkattakin";

    #[test]
    fn original_script_detection() {
        assert!(rec(Some(HANGUL), None, 166.0).has_original_script());
        assert!(!rec(Some(ROMAJI), None, 166.0).has_original_script());
        // Accented Latin is NOT "original script" — no false positive.
        assert!(
            !rec(Some("[00:01.00] Soñar más allá, corazón"), None, 166.0).has_original_script()
        );
        // Plain-only hangul doesn't count: the preference rides synced text.
        assert!(!rec(None, Some(HANGUL), 166.0).has_original_script());
    }

    #[test]
    fn pick_prefers_original_script_within_duration() {
        // The measured KNOW ABOUT ME shape: romanized entries sort first,
        // hangul entries exist further down at close-enough durations.
        let records = vec![
            rec(Some(ROMAJI), None, 166.0),
            rec(Some(ROMAJI), None, 166.0),
            rec(Some(HANGUL), None, 174.0), // hangul but outside ±4s — must NOT win
            rec(Some(HANGUL), None, 165.76),
        ];
        let got = pick(records, 165).unwrap();
        assert_eq!(got.duration, Some(165.76));
        assert!(got.has_original_script());
    }

    #[test]
    fn pick_falls_back_to_synced_then_any() {
        // No original-script candidate: first duration-close synced wins,
        // exactly the old behavior.
        let records = vec![
            rec(None, Some("plain only"), 166.0),
            rec(Some(ROMAJI), None, 166.0),
        ];
        assert!(pick(records, 166).unwrap().has_synced());
        // No synced at all: any duration-close record.
        let records = vec![rec(None, Some("plain only"), 166.0)];
        assert!(pick(records, 166).is_some());
        // Nothing within tolerance: miss.
        let records = vec![rec(Some(HANGUL), None, 200.0)];
        assert!(pick(records, 166).is_none());
    }

    #[test]
    fn norm_title_strips_trailing_parenthetical_only() {
        assert_eq!(norm_title("Dive (feat. someone)"), "Dive");
        assert_eq!(norm_title("(G)I-DLE song"), "(G)I-DLE song");
    }

    /// Live-network check against the track that motivated the script
    /// preference (LRCLIB leads with romanized entries for it). Run with
    /// `cargo test lyrics -- --ignored`.
    #[test]
    #[ignore]
    fn live_know_about_me_returns_hangul() {
        let dir = std::env::temp_dir().join("pulse-lyrics-test");
        let _ = std::fs::remove_dir_all(&dir);
        let got = fetch(&dir, "NMIXX", "KNOW ABOUT ME", "", 165_000);
        let synced = got.synced.expect("expected synced lyrics");
        let hangul = synced
            .chars()
            .filter(|&c| matches!(u32::from(c), 0xAC00..=0xD7A3))
            .count();
        assert!(
            hangul > 100,
            "expected hangul lyrics, got: {}",
            &synced[..synced.len().min(200)]
        );
    }
}
