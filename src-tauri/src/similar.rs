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

/// One run at a time (the enrich_in_flight shape) — a double click must not
/// race two fills into the same list.
static IN_FLIGHT: AtomicBool = AtomicBool::new(false);

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

    // Discovery-first ordering: different-artist above the floor, then
    // same-artist backfill. Below-floor different-artist entries are the
    // mush tail — dropped entirely.
    let seed_artist = artist.trim().to_lowercase();
    let same_artist = |s: &lastfm::SimilarTrack| s.artist.trim().to_lowercase() == seed_artist;
    let candidates: Vec<&lastfm::SimilarTrack> = similars
        .iter()
        .filter(|s| s.score >= MATCH_FLOOR && !same_artist(s))
        .chain(
            similars
                .iter()
                .filter(|s| s.score >= MATCH_FLOOR && same_artist(s)),
        )
        .collect();
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
