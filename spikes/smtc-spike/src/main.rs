//! M0 feasibility spike: what do Apple Music / Spotify actually honor over GSMTC?
//! Throwaway CLI — the deliverable is docs/smtc-support-matrix.md in the repo root.
//!
//! Usage:
//!   smtc-spike list
//!   smtc-spike probe <app-match>
//!   smtc-spike playpause <app-match>
//!   smtc-spike next <app-match>
//!   smtc-spike prev <app-match>
//!   smtc-spike seekrel <app-match> <delta-secs>   (negative = rewind)
//!   smtc-spike watch <app-match> <secs>           (does reported position advance?)

use std::thread::sleep;
use std::time::Duration;
use windows::Media::Control::{
    GlobalSystemMediaTransportControlsSession as Session,
    GlobalSystemMediaTransportControlsSessionManager as Manager,
};

const TICKS_PER_SEC: i64 = 10_000_000; // WinRT TimeSpan = 100ns ticks

fn manager() -> windows::core::Result<Manager> {
    Manager::RequestAsync()?.get()
}

fn find_session(m: &Manager, needle: &str) -> Option<Session> {
    let needle = needle.to_lowercase();
    m.GetSessions().ok()?.into_iter().find(|s| {
        s.SourceAppUserModelId()
            .map(|id| id.to_string().to_lowercase().contains(&needle))
            .unwrap_or(false)
    })
}

fn fmt_ticks(ticks: i64) -> String {
    let secs = ticks / TICKS_PER_SEC;
    format!("{}:{:02}.{:03}", secs / 60, secs % 60, (ticks % TICKS_PER_SEC) / 10_000)
}

fn probe(s: &Session) -> windows::core::Result<()> {
    println!("app_id: {}", s.SourceAppUserModelId()?);

    match s.TryGetMediaPropertiesAsync()?.get() {
        Ok(p) => {
            println!("title:  {}", p.Title().unwrap_or_default());
            println!("artist: {}", p.Artist().unwrap_or_default());
            println!("album:  {}", p.AlbumTitle().unwrap_or_default());
            let thumb = p.Thumbnail().is_ok();
            println!("thumbnail_ref_present: {thumb}");
        }
        Err(e) => println!("media_properties: ERROR {e}"),
    }

    let info = s.GetPlaybackInfo()?;
    println!("status: {:?}", info.PlaybackStatus()?);
    let c = info.Controls()?;
    println!("controls:");
    println!("  play/pause_toggle: {}", c.IsPlayPauseToggleEnabled()?);
    println!("  next: {}  prev: {}", c.IsNextEnabled()?, c.IsPreviousEnabled()?);
    println!("  playback_position (seek): {}", c.IsPlaybackPositionEnabled()?);
    println!("  fast_forward: {}  rewind: {}", c.IsFastForwardEnabled()?, c.IsRewindEnabled()?);

    let t = s.GetTimelineProperties()?;
    println!("timeline:");
    println!("  position: {}", fmt_ticks(t.Position()?.Duration));
    println!("  start–end: {} – {}", fmt_ticks(t.StartTime()?.Duration), fmt_ticks(t.EndTime()?.Duration));
    println!("  min–max_seek: {} – {}", fmt_ticks(t.MinSeekTime()?.Duration), fmt_ticks(t.MaxSeekTime()?.Duration));
    Ok(())
}

fn main() -> windows::core::Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let m = manager()?;

    match args.first().map(String::as_str) {
        Some("list") => {
            let current = m
                .GetCurrentSession()
                .ok()
                .and_then(|s| s.SourceAppUserModelId().ok())
                .map(|h| h.to_string())
                .unwrap_or_default();
            for s in m.GetSessions()? {
                let id = s.SourceAppUserModelId()?.to_string();
                let marker = if id == current { "  <- current" } else { "" };
                println!("{id}{marker}");
            }
        }
        Some("probe") => {
            let s = find_session(&m, &args[1]).expect("no session matches");
            probe(&s)?;
        }
        Some("playpause") | Some("next") | Some("prev") => {
            let s = find_session(&m, &args[1]).expect("no session matches");
            let ok = match args[0].as_str() {
                "playpause" => s.TryTogglePlayPauseAsync()?.get()?,
                "next" => s.TrySkipNextAsync()?.get()?,
                _ => s.TrySkipPreviousAsync()?.get()?,
            };
            println!("{} accepted: {ok}", args[0]);
            sleep(Duration::from_millis(700));
            println!("status_after: {:?}", s.GetPlaybackInfo()?.PlaybackStatus()?);
        }
        Some("seekrel") => {
            let s = find_session(&m, &args[1]).expect("no session matches");
            let delta: i64 = args[2].parse().expect("delta secs");
            let before = s.GetTimelineProperties()?.Position()?.Duration;
            let target = before + delta * TICKS_PER_SEC;
            let ok = s.TryChangePlaybackPositionAsync(target)?.get()?;
            println!("seek accepted: {ok}");
            println!("before: {}", fmt_ticks(before));
            println!("target: {}", fmt_ticks(target));
            sleep(Duration::from_millis(900));
            let after = s.GetTimelineProperties()?.Position()?.Duration;
            println!("after:  {}  (moved {:+.1}s)", fmt_ticks(after), (after - before) as f64 / TICKS_PER_SEC as f64);
        }
        Some("watch") => {
            let s = find_session(&m, &args[1]).expect("no session matches");
            let secs: u64 = args[2].parse().expect("secs");
            for _ in 0..secs {
                let t = s.GetTimelineProperties()?;
                println!(
                    "pos={} status={:?} last_updated_ticks={}",
                    fmt_ticks(t.Position()?.Duration),
                    s.GetPlaybackInfo()?.PlaybackStatus()?,
                    t.LastUpdatedTime()?.UniversalTime
                );
                sleep(Duration::from_secs(1));
            }
        }
        _ => println!("usage: smtc-spike list | probe <app> | playpause <app> | next <app> | prev <app> | seekrel <app> <secs> | watch <app> <secs>"),
    }
    Ok(())
}
