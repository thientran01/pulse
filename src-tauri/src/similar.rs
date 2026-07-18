/*
 * more_like_this: current track → Last.fm similars → Spotify uris → the
 * Pulse-managed up-next list (upnext.rs's feeder does the rest).
 *
 * Candidate ordering encodes the spike findings (2026-07-11, real history):
 * seed-artist entries are SKIPPED first — the top of every Last.fm list is
 * "more by this artist" (match 1.0–0.9), and Thien's ask is genre discovery,
 * not a artist radio — and a match floor guards the mush tail (below ~0.05
 * the graph returns unrelated filler: tripleS's list ends in Jazmine
 * Sullivan at 0.016). Same-artist entries backfill only when the
 * different-artist pool runs dry.
 *
 * Adds go through upnext::append one at a time (each persists + emits), so
 * rows arrive incrementally in the open queue panel — earned arrival for
 * content the user explicitly asked for.
 */
use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use tauri::AppHandle;

use crate::{lastfm, settings, spotify, upnext};

const ADD_CAP: usize = 5;
const FETCH_LIMIT: u32 = 15;
const MATCH_FLOOR: f64 = 0.05;
/// Gap between Spotify search calls — the requeue cadence; api_call already
/// honors one Retry-After on top.
const RESOLVE_GAP: Duration = Duration::from_millis(120);

/// discovery_picks fan: at most 2 seed tracks, ≤2 resolved picks each, and —
/// because a candidate that MISSES on Spotify still costs a search + gap —
/// at most TRIES_PER_SEED resolve attempts per seed. Worst case is a bounded
/// 2×5 = 10 gapped Spotify calls (quick-review catch: the earlier "≤4"
/// claim only counted successes; a miss-heavy seed walked all FETCH_LIMIT
/// candidates). A hard Last.fm error on any seed breaks the whole walk.
const SEED_CAP: usize = 2;
const PER_SEED: usize = 2;
const TRIES_PER_SEED: usize = 5;

/// One run at a time (the enrich_in_flight shape) — a double click must not
/// race two fills into the same list.
static IN_FLIGHT: AtomicBool = AtomicBool::new(false);

/// discovery_picks has its OWN gate: the search window's empty-state fetch and
/// the queue's more-like-this button must never block each other.
static DISCOVERY_IN_FLIGHT: AtomicBool = AtomicBool::new(false);

/// Discovery-first candidate ordering, the shared spike-verified rule (see the
/// module header): different-artist entries above the match floor first (real
/// genre discovery, not artist radio), then same-artist backfill only when the
/// different-artist pool runs dry. Below-floor different-artist entries are the
/// mush tail — dropped entirely.
fn ordered<'a>(
    seed_artist: &str,
    similars: &'a [lastfm::SimilarTrack],
) -> Vec<&'a lastfm::SimilarTrack> {
    let seed = seed_artist.trim().to_lowercase();
    let same = |s: &lastfm::SimilarTrack| s.artist.trim().to_lowercase() == seed;
    similars
        .iter()
        .filter(|s| s.score >= MATCH_FLOOR && !same(s))
        .chain(
            similars
                .iter()
                .filter(|s| s.score >= MATCH_FLOOR && same(s)),
        )
        .collect()
}

/// The exclude-key contract shared with the frontend (Search.tsx): a track's
/// identity for dedupe is its lowercased, trimmed `artist\u{1}title`. Kept in
/// lockstep on both sides — a drift silently stops excluding.
fn norm_key(artist: &str, title: &str) -> String {
    format!(
        "{}\u{1}{}",
        artist.trim().to_lowercase(),
        title.trim().to_lowercase()
    )
}

/// Statuses: "ok:<n>" | "no_matches" | "no_data" | "no_key" (absent) |
/// "bad_key" (rejected) | "busy" | "disconnected" | "offline". Blocking
/// (two HTTP hops) — dedicated pool.
#[tauri::command]
pub async fn more_like_this(app: AppHandle, title: String, artist: String) -> String {
    tauri::async_runtime::spawn_blocking(move || run(&app, &title, &artist))
        .await
        .unwrap_or_else(|e| {
            log::error!("more_like_this task panicked: {e}");
            IN_FLIGHT.store(false, Ordering::SeqCst);
            "offline".into()
        })
}

fn run(app: &AppHandle, title: &str, artist: &str) -> String {
    if IN_FLIGHT
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return "busy".into();
    }
    let out = fill(app, title, artist);
    IN_FLIGHT.store(false, Ordering::SeqCst);
    out
}

fn fill(app: &AppHandle, title: &str, artist: &str) -> String {
    if !spotify::connected(app) {
        return "disconnected".into();
    }
    let Some(key) = settings::get_string(app, "lastfm_api_key").filter(|k| !k.is_empty()) else {
        return "no_key".into();
    };
    let similars = match lastfm::get_similar(&key, title, artist, FETCH_LIMIT) {
        Ok(v) => v,
        Err(e) => return e.into(),
    };
    if similars.is_empty() {
        return "no_data".into();
    }

    let candidates = ordered(artist, &similars);
    if candidates.is_empty() {
        return "no_data".into();
    }

    let mut added = 0usize;
    let mut resolved_any = false;
    for c in candidates {
        if added >= ADD_CAP {
            break;
        }
        if resolved_any {
            std::thread::sleep(RESOLVE_GAP);
        }
        resolved_any = true;
        let Some(track) = spotify::search_best(app, &c.title, &c.artist) else {
            continue; // no Spotify match / transient — skip, keep walking
        };
        // Never queue what's playing, never double-queue — BOTH re-read per
        // add: the walk takes seconds, and a track change or a user drag/add
        // can interleave with it (quick-review catch on the once-up-front
        // now_uri snapshot).
        if spotify::now_uri(app).as_deref() == Some(track.uri.as_str())
            || upnext::uris(app).contains(&track.uri)
        {
            continue;
        }
        upnext::append(app, track);
        added += 1;
    }
    if added == 0 {
        "no_matches".into()
    } else {
        format!("ok:{added}")
    }
}

/*
 * discovery_picks: the search window's "Something different" section. Same
 * Last.fm→Spotify similarity engine as more_like_this, but it RETURNS resolved
 * tracks instead of appending to up-next — the empty state renders them as
 * playable rows, seeded from what the user actually listens to.
 *
 * The frontend passes 1–2 seeds (rotated by its day-block) and the normalized
 * keys of everything already in the history pool, so "different" means
 * genuinely un-played. Excluding BEFORE resolving means a dead candidate never
 * costs a Spotify search.
 */
#[derive(serde::Deserialize)]
pub struct Seed {
    pub title: String,
    pub artist: String,
}

#[derive(serde::Serialize)]
pub struct DiscoveryPick {
    /// The played track this suggestion came from — the row's "Because you
    /// played X" label.
    pub seed_title: String,
    pub track: spotify::QueueTrack,
}

#[derive(serde::Serialize)]
pub struct DiscoveryResult {
    pub status: String,
    pub picks: Vec<DiscoveryPick>,
}

/// Statuses: "ok" | "no_key" (absent) | "bad_key" (rejected) | "disconnected"
/// | "offline" (transport/5xx) | "no_data" (every seed dry) | "busy". Blocking
/// (Last.fm + Spotify hops) on the dedicated pool.
#[tauri::command]
pub async fn discovery_picks(
    app: AppHandle,
    seeds: Vec<Seed>,
    exclude: Vec<String>,
) -> DiscoveryResult {
    tauri::async_runtime::spawn_blocking(move || run_discovery(&app, seeds, exclude))
        .await
        .unwrap_or_else(|e| {
            log::error!("discovery_picks task panicked: {e}");
            DISCOVERY_IN_FLIGHT.store(false, Ordering::SeqCst);
            DiscoveryResult {
                status: "offline".into(),
                picks: Vec::new(),
            }
        })
}

fn run_discovery(app: &AppHandle, seeds: Vec<Seed>, exclude: Vec<String>) -> DiscoveryResult {
    if DISCOVERY_IN_FLIGHT
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return DiscoveryResult {
            status: "busy".into(),
            picks: Vec::new(),
        };
    }
    let out = discover(app, seeds, exclude);
    DISCOVERY_IN_FLIGHT.store(false, Ordering::SeqCst);
    out
}

fn discover(app: &AppHandle, seeds: Vec<Seed>, exclude: Vec<String>) -> DiscoveryResult {
    let empty = |status: &str| DiscoveryResult {
        status: status.into(),
        picks: Vec::new(),
    };
    if !spotify::connected(app) {
        return empty("disconnected");
    }
    let Some(key) = settings::get_string(app, "lastfm_api_key").filter(|k| !k.is_empty()) else {
        return empty("no_key");
    };

    let excl: HashSet<String> = exclude.into_iter().collect();
    let mut picks: Vec<DiscoveryPick> = Vec::new();
    // Cross-set artist diversity (the "no artist radio" doctrine) + uri dedupe,
    // both spanning all seeds so two seeds can't surface the same artist twice.
    let mut picked_artists: HashSet<String> = HashSet::new();
    let mut picked_uris: HashSet<String> = HashSet::new();
    let mut resolved_any = false;
    // A hard verdict (rejected key / unreachable) is worth reporting only when
    // nothing resolved; a merely dry seed is not an error.
    let mut hard_err: Option<&'static str> = None;

    for seed in seeds.iter().take(SEED_CAP) {
        let similars = match lastfm::get_similar(&key, &seed.title, &seed.artist, FETCH_LIMIT) {
            Ok(v) => v,
            Err(e) => {
                // bad_key is terminal for every seed (same key); offline breaks
                // too, so a second seed can't spend another 15s timeout.
                if e == "bad_key" || e == "offline" {
                    hard_err = Some(e);
                    break;
                }
                continue; // "no_data" for this seed — try the next
            }
        };
        let mut from_seed = 0usize;
        let mut tried = 0usize;
        for c in ordered(&seed.artist, &similars) {
            if from_seed >= PER_SEED || tried >= TRIES_PER_SEED {
                break;
            }
            // Exclusion/dedupe checks are free — only a real resolve attempt
            // (a Spotify search + gap) counts against TRIES_PER_SEED.
            if excl.contains(&norm_key(&c.artist, &c.title)) {
                continue;
            }
            let ca = c.artist.trim().to_lowercase();
            if picked_artists.contains(&ca) {
                continue;
            }
            tried += 1;
            if resolved_any {
                std::thread::sleep(RESOLVE_GAP);
            }
            resolved_any = true;
            let Some(track) = spotify::search_best(app, &c.title, &c.artist) else {
                continue; // no Spotify match / transient — keep walking
            };
            // Belt-and-suspenders: the resolved uri could still collide with an
            // already-picked one (two Last.fm titles resolving to one track).
            if picked_uris.contains(&track.uri) {
                continue;
            }
            picked_uris.insert(track.uri.clone());
            picked_artists.insert(ca);
            picks.push(DiscoveryPick {
                seed_title: seed.title.clone(),
                track,
            });
            from_seed += 1;
        }
    }

    let status = if !picks.is_empty() {
        "ok"
    } else {
        hard_err.unwrap_or("no_data")
    };
    DiscoveryResult {
        status: status.into(),
        picks,
    }
}
