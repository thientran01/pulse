/*
 * Last.fm track.getSimilar — the brain behind more-like-this. Spotify's own
 * /recommendations is gated for apps registered after Nov 2024, so similarity
 * comes from Last.fm's listening graph instead.
 *
 * The API key is personal and lives in app_data/settings.json under
 * "lastfm_api_key" — the repo is public, so it must NEVER become a const.
 *
 * Spike-verified 2026-07-11 against real history (13 tracks off
 * history.jsonl): 12/13 usable, Korean catalog 9/10 — even deep cuts (XLOV,
 * tripleS) return full lists. The thin spot is RECENCY (a fresh release
 * returns 0 similars), not language, so `no_data` is a designed answer, not
 * an error. Two graph shapes the consumer must handle (similar.rs does):
 * the top of every list is "more by this artist" (match 1.0–0.9), and below
 * ~0.05 the tail degenerates into unrelated filler.
 */
use std::time::Duration;

use crate::settings::{json_capped, JSON_CAP};
use crate::spotify::urlenc;

const TIMEOUT: Duration = Duration::from_secs(15);
const UA: &str = "Palette/0.1 (https://github.com/thientran01/palette)";

pub struct SimilarTrack {
    pub title: String,
    pub artist: String,
    /// Last.fm's 0..1 similarity score.
    pub score: f64,
}

/// Cheap key validation for the prefs "Test key" button: a minimal request
/// (chart.getTopArtists, limit 1) whose only failure mode we care about is a
/// rejected key. Returns "ok" | "invalid" (Last.fm error 10/26) | "offline"
/// (transport/5xx/garbled). An empty key is "invalid" without a round-trip.
pub fn validate_key(key: &str) -> &'static str {
    if key.trim().is_empty() {
        return "invalid";
    }
    let url = format!(
        "https://ws.audioscrobbler.com/2.0/?method=chart.gettopartists&limit=1&api_key={}&format=json",
        urlenc(key),
    );
    let resp = ureq::get(&url)
        .set("User-Agent", UA)
        .timeout(TIMEOUT)
        .call();
    let v: serde_json::Value = match resp {
        Ok(r) => match json_capped(r, JSON_CAP) {
            Ok(v) => v,
            Err(_) => return "offline",
        },
        // Last.fm serves its application errors as 4xx WITH a JSON body — read
        // it so a rejected key reports as invalid, not offline.
        Err(ureq::Error::Status(_, r)) => match json_capped(r, JSON_CAP) {
            Ok(v) => v,
            Err(_) => return "offline",
        },
        Err(_) => return "offline",
    };
    if let Some(code) = v["error"].as_i64() {
        // 10 = invalid key, 26 = suspended key. Anything else (rate limit,
        // temporary service error) is not a verdict on the key itself.
        return match code {
            10 | 26 => "invalid",
            _ => "offline",
        };
    }
    "ok"
}

/// Statuses: "no_key" (key rejected), "no_data" (Last.fm doesn't know the
/// track), "offline" (transport/5xx). An empty Ok list also means no_data —
/// the caller collapses them.
pub fn get_similar(
    api_key: &str,
    title: &str,
    artist: &str,
    limit: u32,
) -> Result<Vec<SimilarTrack>, &'static str> {
    let url = format!(
        "https://ws.audioscrobbler.com/2.0/?method=track.getSimilar&artist={}&track={}&autocorrect=1&limit={limit}&api_key={}&format=json",
        urlenc(artist),
        urlenc(title),
        urlenc(api_key),
    );
    let resp = ureq::get(&url)
        .set("User-Agent", UA)
        .timeout(TIMEOUT)
        .call();
    let v: serde_json::Value = match resp {
        Ok(r) => json_capped(r, JSON_CAP).map_err(|_| "offline")?,
        // Last.fm serves its application errors as 4xx WITH a JSON body —
        // read it so an invalid key reports as no_key, not offline.
        Err(ureq::Error::Status(_, r)) => json_capped(r, JSON_CAP).map_err(|_| "offline")?,
        Err(_) => return Err("offline"),
    };
    if let Some(code) = v["error"].as_i64() {
        // 10 = invalid key, 26 = suspended key; 6 = track not found.
        // bad_key ≠ no_key: "add a key" is the wrong instruction for a key
        // that exists and was rejected.
        return match code {
            10 | 26 => Err("bad_key"),
            6 => Err("no_data"),
            _ => Err("offline"),
        };
    }
    let list = match v["similartracks"]["track"].as_array() {
        Some(a) => a.clone(),
        // A single result serializes as an object, not a 1-array.
        None if v["similartracks"]["track"].is_object() => {
            vec![v["similartracks"]["track"].clone()]
        }
        None => Vec::new(),
    };
    Ok(list
        .iter()
        .filter_map(|t| {
            Some(SimilarTrack {
                title: t["name"].as_str()?.to_string(),
                artist: t["artist"]["name"].as_str()?.to_string(),
                // Number or numeric string, per the API's mood. An absent/
                // unparseable match collapses to 0.0 and dies at the
                // consumer's floor — deliberate: an unscored similar is
                // indistinguishable from mush, and dropping it is the safe
                // read.
                score: t["match"]
                    .as_f64()
                    .or_else(|| t["match"].as_str().and_then(|s| s.parse().ok()))
                    .unwrap_or(0.0),
            })
        })
        .collect())
}
