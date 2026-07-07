//! GSMTC media core: polls the current Windows media session and exposes
//! transport commands. Capability quirks per player are documented in
//! docs/smtc-support-matrix.md — notably Apple Music ignores seek and packs
//! "artist — album" into the artist field.

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use serde::Serialize;
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use windows::Media::Control::{
    GlobalSystemMediaTransportControlsSession as Session,
    GlobalSystemMediaTransportControlsSessionManager as Manager,
    GlobalSystemMediaTransportControlsSessionPlaybackStatus as PlaybackStatus,
};
use windows::Storage::Streams::{Buffer, DataReader, InputStreamOptions};

const TICKS_PER_MS: i64 = 10_000; // WinRT TimeSpan tick = 100ns
/// Offset between the Windows FILETIME epoch (1601) and the unix epoch, in ms.
const FILETIME_EPOCH_OFFSET_MS: i64 = 11_644_473_600_000;

#[derive(Serialize, Clone, Default)]
pub struct NowPlaying {
    pub app_id: String,
    /// "apple_music" | "spotify" | "other" | "none"
    pub player: String,
    pub title: String,
    pub artist: String,
    pub album: String,
    /// "playing" | "paused" | "stopped" | "none"
    pub status: String,
    pub position_ms: i64,
    pub duration_ms: i64,
    /// Unix ms at which position_ms was true — the frontend interpolates from here.
    pub emitted_at_ms: i64,
    pub can_seek: bool,
    pub art_id: Option<String>,
}

/// Cached album art for the currently playing media. Failed reads are cached
/// too (url: None) so a bad thumbnail isn't re-fetched every poll cycle.
pub struct ArtCache(pub Mutex<Option<ArtEntry>>);

pub struct ArtEntry {
    pub key: String,
    pub url: Option<String>,
}

fn lock_art(cache: &ArtCache) -> std::sync::MutexGuard<'_, Option<ArtEntry>> {
    cache.0.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn manager() -> windows::core::Result<Manager> {
    Manager::RequestAsync()?.get()
}

pub fn current_session() -> Option<Session> {
    manager().ok()?.GetCurrentSession().ok()
}

fn player_kind(app_id: &str) -> &'static str {
    let id = app_id.to_lowercase();
    if id.contains("applemusic") {
        "apple_music"
    } else if id.contains("spotify") {
        "spotify"
    } else {
        "other"
    }
}

fn art_key(app_id: &str, title: &str, artist: &str) -> String {
    let mut h = DefaultHasher::new();
    (app_id, title, artist).hash(&mut h);
    format!("{:x}", h.finish())
}

/// Read the session thumbnail into a data URL. Best-effort: any failure → None.
/// ReadAsync may return FEWER bytes than requested (that was shipping truncated
/// images that failed to decode) — loop until the stream is drained.
fn read_art(session: &Session) -> Option<String> {
    const CHUNK: u32 = 262_144;
    let props = session.TryGetMediaPropertiesAsync().ok()?.get().ok()?;
    let thumb = props.Thumbnail().ok()?;
    let stream = thumb.OpenReadAsync().ok()?.get().ok()?;
    let size = stream.Size().ok()?;
    if size == 0 || size > 8_000_000 {
        return None;
    }
    // Apple Music reports a comma-separated LIST ("image/jpeg,image/jpe,image/jpg");
    // commas are invalid inside a data: URL mime — take the first entry only.
    let mime = stream
        .ContentType()
        .map(|h| h.to_string())
        .ok()
        .and_then(|m| m.split(',').next().map(|s| s.trim().to_string()))
        .filter(|m| m.starts_with("image/"))
        .unwrap_or_else(|| "image/jpeg".into());
    let mut bytes: Vec<u8> = Vec::with_capacity(size as usize);
    while (bytes.len() as u64) < size {
        // Cap the final request to the declared remainder — some streams are
        // views into a larger backing store and would return trailing garbage.
        let want = CHUNK.min((size - bytes.len() as u64) as u32);
        let chunk = Buffer::Create(want).ok()?;
        let chunk = stream
            .ReadAsync(&chunk, want, InputStreamOptions::ReadAhead)
            .ok()?
            .get()
            .ok()?;
        let len = chunk.Length().ok()? as usize;
        if len == 0 {
            break; // stream ended early — bail below if incomplete
        }
        let reader = DataReader::FromBuffer(&chunk).ok()?;
        let mut part = vec![0u8; len];
        reader.ReadBytes(&mut part).ok()?;
        bytes.extend_from_slice(&part);
    }
    if (bytes.len() as u64) < size {
        return None;
    }
    bytes.truncate(size as usize);
    Some(format!("data:{};base64,{}", mime, B64.encode(bytes)))
}

/// Snapshot the current session into a NowPlaying payload, refreshing the art
/// cache when the (app, title, artist) key changes.
pub fn snapshot(art_cache: &ArtCache) -> NowPlaying {
    let Some(session) = current_session() else {
        return NowPlaying {
            player: "none".into(),
            status: "none".into(),
            ..Default::default()
        };
    };
    let app_id = session
        .SourceAppUserModelId()
        .map(|h| h.to_string())
        .unwrap_or_default();
    let player = player_kind(&app_id).to_string();

    let (mut title, mut artist, mut album, has_thumb) =
        match session.TryGetMediaPropertiesAsync().and_then(|op| op.get()) {
            Ok(p) => (
                p.Title().map(|h| h.to_string()).unwrap_or_default(),
                p.Artist().map(|h| h.to_string()).unwrap_or_default(),
                p.AlbumTitle().map(|h| h.to_string()).unwrap_or_default(),
                p.Thumbnail().is_ok(),
            ),
            Err(_) => (String::new(), String::new(), String::new(), false),
        };
    // Apple Music packs "artist — album" into the artist field (matrix quirk #5).
    if player == "apple_music" && album.is_empty() {
        if let Some((a, b)) = artist.split_once(" — ") {
            album = b.trim().to_string();
            artist = a.trim().to_string();
        }
    }
    if title.is_empty() && artist.is_empty() {
        title = "Unknown".into();
    }

    let status = playback_status(&session).to_string();
    let can_seek = session
        .GetPlaybackInfo()
        .and_then(|i| i.Controls())
        .and_then(|c| c.IsPlaybackPositionEnabled())
        .unwrap_or(false);

    let (mut position_ms, duration_ms) = corrected_position(&session, &status);
    if duration_ms > 0 {
        position_ms = position_ms.clamp(0, duration_ms);
    }
    // Stamp BEFORE the (potentially slow) art read below — the frontend treats
    // position_ms as true at emitted_at_ms and interpolates from there.
    let emitted_at_ms = now_ms();

    let art_id = if has_thumb {
        let key = art_key(&app_id, &title, &artist);
        // Never hold the lock across the WinRT stream read — media_art (IPC)
        // shares this mutex.
        let cached_url_present: Option<bool> = {
            let cache = lock_art(art_cache);
            cache.as_ref().filter(|e| e.key == key).map(|e| e.url.is_some())
        };
        let url_present = match cached_url_present {
            Some(present) => present,
            None => {
                let url = read_art(&session);
                let present = url.is_some();
                *lock_art(art_cache) = Some(ArtEntry { key: key.clone(), url });
                present
            }
        };
        url_present.then_some(key)
    } else {
        None
    };

    NowPlaying {
        app_id,
        player,
        title,
        artist,
        album,
        status,
        position_ms,
        duration_ms,
        emitted_at_ms,
        can_seek,
        art_id,
    }
}

/// (position_ms, duration_ms) with staleness correction for ANY player:
/// position + elapsed-since-LastUpdatedTime is the best estimate of the true
/// position while playing. It matters for Spotify (pushes its timeline only
/// ~every 5s) and is a ≤1s refinement for Apple Music (reports fresh every
/// second). Correction is skipped for insane staleness values (clock skew,
/// first emit after a session appears).
fn corrected_position(session: &Session, status: &str) -> (i64, i64) {
    let Ok(t) = session.GetTimelineProperties() else {
        return (0, 0);
    };
    let pos = t.Position().map(|d| d.Duration / TICKS_PER_MS).unwrap_or(0);
    let end = t.EndTime().map(|d| d.Duration / TICKS_PER_MS).unwrap_or(0);
    let corrected = if status == "playing" {
        let updated_unix_ms = t
            .LastUpdatedTime()
            .map(|d| d.UniversalTime / TICKS_PER_MS - FILETIME_EPOCH_OFFSET_MS)
            .unwrap_or(0);
        let staleness = now_ms() - updated_unix_ms;
        if (0..30_000).contains(&staleness) {
            pos + staleness
        } else {
            pos
        }
    } else {
        pos
    };
    (corrected, end)
}

fn playback_status(session: &Session) -> &'static str {
    match session.GetPlaybackInfo().and_then(|i| i.PlaybackStatus()) {
        Ok(PlaybackStatus(4)) => "playing",
        Ok(PlaybackStatus(5)) => "paused",
        _ => "stopped",
    }
}

pub fn play_pause() -> bool {
    current_session()
        .and_then(|s| s.TryTogglePlayPauseAsync().ok()?.get().ok())
        .unwrap_or(false)
}

pub fn next() -> bool {
    current_session()
        .and_then(|s| s.TrySkipNextAsync().ok()?.get().ok())
        .unwrap_or(false)
}

pub fn prev() -> bool {
    current_session()
        .and_then(|s| s.TrySkipPreviousAsync().ok()?.get().ok())
        .unwrap_or(false)
}

/// Absolute seek. Returns false when the session is gone or refuses the call.
/// NOTE: Apple Music returns true and does nothing — callers should treat the
/// bool as "command delivered", not "seek happened" (matrix finding #3).
pub fn seek_abs_ms(target_ms: i64) -> bool {
    let Some(session) = current_session() else {
        return false;
    };
    let target = target_ms.max(0) * TICKS_PER_MS;
    session
        .TryChangePlaybackPositionAsync(target)
        .and_then(|op| op.get())
        .unwrap_or(false)
}

/// Relative seek anchored on the staleness-corrected position (Spotify's raw
/// reported position can be ~5s behind what the user hears), clamped to the
/// track bounds.
pub fn seek_rel_ms(delta_ms: i64) -> bool {
    let Some(session) = current_session() else {
        return false;
    };
    let status = playback_status(&session);
    let (pos, end) = corrected_position(&session, status);
    let end = if end > 0 { end } else { i64::MAX };
    seek_abs_ms((pos + delta_ms).clamp(0, end))
}
