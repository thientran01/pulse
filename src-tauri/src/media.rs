//! GSMTC media core: watches the current Windows media session (change events
//! plus a heartbeat poll) and exposes transport commands. Capability quirks
//! per player are documented in docs/smtc-support-matrix.md — notably Apple
//! Music ignores seek and packs "artist — album" into the artist field.

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use serde::Serialize;
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::sync::mpsc::Sender;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use windows::Foundation::TypedEventHandler;
use windows::Media::Control::{
    GlobalSystemMediaTransportControlsSession as Session,
    GlobalSystemMediaTransportControlsSessionManager as Manager,
    GlobalSystemMediaTransportControlsSessionPlaybackStatus as PlaybackStatus,
};
use windows::Storage::Streams::{Buffer, DataReader, InputStreamOptions};

const TICKS_PER_MS: i64 = 10_000; // WinRT TimeSpan tick = 100ns
/// Offset between the Windows FILETIME epoch (1601) and the unix epoch, in ms.
const FILETIME_EPOCH_OFFSET_MS: i64 = 11_644_473_600_000;

#[derive(Serialize, Clone, Default, PartialEq)]
pub struct NowPlaying {
    pub app_id: String,
    /// "apple_music" | "spotify" | "other" | "none"
    pub player: String,
    pub title: String,
    pub artist: String,
    pub album: String,
    /// "playing" | "paused" | "stopped" | "none"
    pub status: String,
    /// RAW player-reported position — no staleness projection applied. The
    /// frontend owns the one clock that turns (position, reported-at) pairs
    /// into a display position; Rust never projects a UI-visible position.
    pub position_ms: i64,
    pub duration_ms: i64,
    /// Unix ms when the player last stamped its timeline (GSMTC
    /// LastUpdatedTime). 0 = the player never stamped it.
    pub position_at_ms: i64,
    pub can_seek: bool,
    pub art_id: Option<String>,
}

/// Cached album art for the currently playing media. Failed reads are cached
/// too (url: None) so a bad thumbnail isn't re-fetched every poll cycle.
pub struct ArtCache(pub Mutex<Option<ArtEntry>>);

/// How long after a key change we keep distrusting the cached thumbnail.
/// GSMTC updates title/artist before the player attaches the new thumbnail
/// (worst on Apple Music), so the first read after a track change can capture
/// the PREVIOUS track's image. Within this window every poll re-reads and
/// fingerprints the stream; a byte change bumps `rev` so the emitted art_id
/// changes and the frontend re-fetches.
const ART_PROBE_WINDOW_MS: i64 = 10_000;

pub struct ArtEntry {
    pub key: String,
    /// Bumped when probing catches the thumbnail bytes changing under the same
    /// key. Part of the emitted art_id (`"{key}:{rev}"`).
    pub rev: u32,
    pub url: Option<String>,
    /// Cheap content fingerprint (len + first/last 1KB). None = read failed.
    pub fingerprint: Option<u64>,
    /// When this key first appeared — anchors the probe window.
    pub first_seen_ms: i64,
    /// True once a rev bump was confirmed unchanged by the next probe —
    /// probing stops early instead of running out the window.
    pub settled: bool,
}

impl ArtEntry {
    /// The id emitted as NowPlaying.art_id and matched by the media_art IPC.
    pub fn id(&self) -> String {
        format!("{}:{}", self.key, self.rev)
    }
}

/// Resolve an emitted art_id (`"{key}:{rev}"`) to the cached data URL.
pub fn art_url(cache: &ArtCache, art_id: &str) -> Option<String> {
    let cache = lock_art(cache);
    cache
        .as_ref()
        .filter(|e| e.id() == art_id)
        .and_then(|e| e.url.clone())
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

/// GSMTC manager, cached for the app lifetime: RequestAsync is a blocking
/// cross-process round-trip and was being paid on every snapshot and every
/// transport command. The manager is a stable singleton connection — sessions
/// come and go underneath it. A failed request retries on the next call.
static MANAGER: Mutex<Option<Manager>> = Mutex::new(None);

fn manager() -> Option<Manager> {
    let mut cached = MANAGER.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    if cached.is_none() {
        *cached = Manager::RequestAsync().ok().and_then(|op| op.get().ok());
    }
    cached.clone()
}

pub fn current_session() -> Option<Session> {
    match manager()?.GetCurrentSession() {
        Ok(s) => Some(s),
        // windows-rs maps a null return ("no current session" — a normal
        // state, e.g. Apple Music stopped) to an Err carrying S_OK. Any real
        // failure code means the cached manager's connection died (service
        // restart, sleep/resume) — drop it so the next call re-requests,
        // otherwise the app would stay dark until restart.
        Err(e) => {
            if !e.code().is_ok() {
                *MANAGER.lock().unwrap_or_else(std::sync::PoisonError::into_inner) = None;
            }
            None
        }
    }
}

/// Wake signals sent from WinRT event handlers to the media loop.
pub enum Wake {
    /// Session content changed (metadata/thumbnail/playback) — snapshot now.
    Event,
    /// The OS swapped the current session — re-subscribe, then snapshot.
    SessionChanged,
}

/// Subscribes to GSMTC change events and forwards them to the media loop as
/// [`Wake`]s. The loop stays the only place that snapshots and emits — the
/// WinRT handlers (which fire on the OS threadpool) only ever poke the
/// channel, so going event-driven adds no new concurrency into snapshot().
pub struct SessionWatch {
    manager: Manager,
    tx: Sender<Wake>,
    /// (session, app_id, [media_props_token, playback_info_token])
    watched: Option<(Session, String, [i64; 2])>,
}

impl SessionWatch {
    /// None when GSMTC is unavailable — the caller falls back to pure polling.
    pub fn new(tx: Sender<Wake>) -> Option<Self> {
        let manager = manager()?;
        let session_tx = tx.clone();
        manager
            .CurrentSessionChanged(&TypedEventHandler::new(move |_, _| {
                let _ = session_tx.send(Wake::SessionChanged);
                Ok(())
            }))
            .ok()?;
        Some(Self { manager, tx, watched: None })
    }

    /// Attach change handlers to the CURRENT session if it isn't the watched
    /// one. `force` re-attaches even when the app id matches — a player can
    /// re-register a fresh session under the same id (Apple Music does, on
    /// every stop/start), leaving handlers on the dead one. Missed events are
    /// never fatal: the heartbeat poll still covers everything within 500ms.
    pub fn resubscribe(&mut self, force: bool) {
        let current = self.manager.GetCurrentSession().ok();
        let current_id = current
            .as_ref()
            .and_then(|s| s.SourceAppUserModelId().ok())
            .map(|h| h.to_string());
        let watched_id = self.watched.as_ref().map(|(_, id, _)| id.as_str());
        if !force && current_id.as_deref() == watched_id {
            return;
        }
        if let Some((old, _, [t_props, t_play])) = self.watched.take() {
            // The old session may already be deregistered — best effort.
            let _ = old.RemoveMediaPropertiesChanged(t_props);
            let _ = old.RemovePlaybackInfoChanged(t_play);
        }
        let (Some(session), Some(id)) = (current, current_id) else {
            return;
        };
        let props_tx = self.tx.clone();
        let t_props = session.MediaPropertiesChanged(&TypedEventHandler::new(move |_, _| {
            let _ = props_tx.send(Wake::Event);
            Ok(())
        }));
        let play_tx = self.tx.clone();
        let t_play = session.PlaybackInfoChanged(&TypedEventHandler::new(move |_, _| {
            let _ = play_tx.send(Wake::Event);
            Ok(())
        }));
        // Timeline events are deliberately NOT subscribed: Apple Music fires
        // one per second for position, and the heartbeat already bounds
        // position staleness at the same interval the frontend interpolates
        // over. Events buy latency only where polling is visibly slow —
        // track/art/status changes.
        match (t_props, t_play) {
            (Ok(t_props), Ok(t_play)) => {
                self.watched = Some((session, id, [t_props, t_play]));
            }
            // Partial registration: remove the half that landed, or the next
            // iteration (watched stayed None) re-registers on this same
            // session and the orphaned handler compounds every heartbeat.
            (Ok(t_props), Err(_)) => {
                let _ = session.RemoveMediaPropertiesChanged(t_props);
            }
            (Err(_), Ok(t_play)) => {
                let _ = session.RemovePlaybackInfoChanged(t_play);
            }
            (Err(_), Err(_)) => {}
        }
    }
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

/// The track identity hash — shared vocabulary across the app: the art cache
/// key, the emitted art_id's key prefix, AND history.rs's entry/thumb key
/// (posClock keys on the same raw tuple frontend-side). Album and duration
/// are deliberately NOT included (that's the lyrics key).
///
/// DefaultHasher's algorithm is not guaranteed stable across Rust releases,
/// and history.rs persists these keys (entry `key`, thumb filenames). A
/// toolchain bump that changes it costs only cosmetics — old thumbs stop
/// resolving (glyph fallback, eviction cleans them up) while entry data stays
/// intact — so we accept it; switch to a fixed hasher if keys ever gain a
/// load-bearing cross-version meaning.
pub(crate) fn ident_key(app_id: &str, title: &str, artist: &str) -> String {
    let mut h = DefaultHasher::new();
    (app_id, title, artist).hash(&mut h);
    format!("{:x}", h.finish())
}

/// Cheap content fingerprint for probe comparisons: length + first/last ~1KB.
/// Deliberately NOT a full-image hash — probing runs every poll for a few
/// seconds and must not re-encode or re-hash whole covers.
fn art_fingerprint(bytes: &[u8]) -> u64 {
    let mut h = DefaultHasher::new();
    bytes.len().hash(&mut h);
    let k = bytes.len().min(1024);
    bytes[..k].hash(&mut h);
    bytes[bytes.len() - k..].hash(&mut h);
    h.finish()
}

/// Read the session thumbnail into raw bytes + mime. Best-effort: any failure
/// → None. ReadAsync may return FEWER bytes than requested (that was shipping
/// truncated images that failed to decode) — loop until the stream is drained.
fn read_art_bytes(session: &Session) -> Option<(Vec<u8>, String)> {
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
    Some((bytes, mime))
}

fn art_data_url(bytes: &[u8], mime: &str) -> String {
    format!("data:{};base64,{}", mime, B64.encode(bytes))
}

fn none_now() -> NowPlaying {
    NowPlaying {
        player: "none".into(),
        status: "none".into(),
        ..Default::default()
    }
}

/// Metadata + status + raw timeline for a session — everything but art.
/// Shared by snapshot() (which adds the art pipeline) and history_probe()
/// (the hidden-window history feed, which must do zero art work). Returns
/// the payload (art_id None) plus whether a thumbnail stream exists.
fn base_snapshot(session: &Session) -> (NowPlaying, bool) {
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

    let (status, can_seek) = playback_info(session);
    let (mut position_ms, duration_ms, position_at_ms) = raw_timeline(session);
    if duration_ms > 0 {
        position_ms = position_ms.clamp(0, duration_ms);
    }

    (
        NowPlaying {
            app_id,
            player,
            title,
            artist,
            album,
            status: status.to_string(),
            position_ms,
            duration_ms,
            position_at_ms,
            can_seek,
            art_id: None,
        },
        has_thumb,
    )
}

/// Art-free observation for the history tracker while the window is hidden —
/// the ONE narrow exception to "the media loop does no work while hidden"
/// (~5s cadence, no art marshal, no emit; see lib.rs's media loop).
pub fn history_probe() -> NowPlaying {
    match current_session() {
        Some(session) => base_snapshot(&session).0,
        None => none_now(),
    }
}

/// Snapshot the current session into a NowPlaying payload, refreshing the art
/// cache when the (app, title, artist) key changes.
pub fn snapshot(art_cache: &ArtCache) -> NowPlaying {
    let Some(session) = current_session() else {
        return none_now();
    };
    let (mut np, has_thumb) = base_snapshot(&session);

    np.art_id = if has_thumb {
        let key = ident_key(&np.app_id, &np.title, &np.artist);
        // Never hold the lock across the WinRT stream read — media_art (IPC)
        // shares this mutex. Sample the cached state, drop the lock, then read.
        let cached: Option<(u32, bool, Option<u64>, i64, bool)> = {
            let cache = lock_art(art_cache);
            cache
                .as_ref()
                .filter(|e| e.key == key)
                .map(|e| (e.rev, e.url.is_some(), e.fingerprint, e.first_seen_ms, e.settled))
        };
        match cached {
            // Stable hit: past the probe window or confirmed settled.
            Some((rev, present, _, first_seen, settled))
                if settled || now_ms() - first_seen >= ART_PROBE_WINDOW_MS =>
            {
                present.then(|| format!("{key}:{rev}"))
            }
            // Probe window: the first read after a key change may have captured
            // the PREVIOUS track's thumbnail — re-read and compare fingerprints.
            Some((rev, present, fingerprint, _, _)) => {
                match read_art_bytes(&session) {
                    // Failed probe read = no information — keep the cached
                    // entry (don't drop a good image on a transient failure)
                    // and keep probing.
                    None => present.then(|| format!("{key}:{rev}")),
                    Some((bytes, mime)) => {
                        let new_fp = art_fingerprint(&bytes);
                        if fingerprint == Some(new_fp) {
                            // Unchanged. A confirmed post-bump read means the
                            // real art landed — settle so the remaining window
                            // isn't re-read.
                            if rev > 0 {
                                let mut cache = lock_art(art_cache);
                                if let Some(e) =
                                    cache.as_mut().filter(|e| e.key == key && e.rev == rev)
                                {
                                    e.settled = true;
                                }
                            }
                            present.then(|| format!("{key}:{rev}"))
                        } else {
                            // Bytes changed under the same key — the pinned
                            // image was stale. Bump rev so the emitted art_id
                            // changes and the frontend re-fetches. snapshot()
                            // runs concurrently (poll thread + hotkey/command
                            // emit_now), and an id must never be re-associated
                            // with different bytes — the frontend latches an id
                            // on first successful fetch. So only advance from
                            // the exact state we sampled; if another snapshot
                            // got there first, its entry wins and we emit that.
                            let mut cache = lock_art(art_cache);
                            match cache.as_mut() {
                                Some(e) if e.key == key && e.rev == rev => {
                                    e.rev = rev + 1;
                                    e.url = Some(art_data_url(&bytes, &mime));
                                    e.fingerprint = Some(new_fp);
                                    e.settled = false;
                                    Some(e.id())
                                }
                                Some(e) if e.key == key => e.url.is_some().then(|| e.id()),
                                // Key moved on (track changed mid-read) — our
                                // metadata is stale too; emit the sampled id
                                // and let the next poll rebuild.
                                _ => present.then(|| format!("{key}:{rev}")),
                            }
                        }
                    }
                }
            }
            // New key: first read, distrusted — the probe window starts now.
            None => {
                let bytes = read_art_bytes(&session);
                let fingerprint = bytes.as_ref().map(|(b, _)| art_fingerprint(b));
                let url = bytes.map(|(b, mime)| art_data_url(&b, &mime));
                let present = url.is_some();
                let mut cache = lock_art(art_cache);
                match cache.as_ref() {
                    // A concurrent snapshot raced us to this key — keep its
                    // entry (overwriting could re-associate its already-emitted
                    // id with our bytes) and emit what it stored.
                    Some(e) if e.key == key => e.url.is_some().then(|| e.id()),
                    _ => {
                        *cache = Some(ArtEntry {
                            key: key.clone(),
                            rev: 0,
                            url,
                            fingerprint,
                            first_seen_ms: now_ms(),
                            settled: false,
                        });
                        present.then(|| format!("{key}:0"))
                    }
                }
            }
        }
    } else {
        None
    };
    np
}

/// Raw GSMTC timeline triple: (position_ms, duration_ms, last_updated_unix_ms).
/// Deliberately NO staleness projection — re-projecting each snapshot is what
/// let Apple Music's 1s-quantized pushes land behind the previous projection
/// (the lyric flash-back), and the old out-of-range fallback to the raw
/// position was a second regression source. last_updated is 0 when the player
/// never stamped the timeline.
fn raw_timeline(session: &Session) -> (i64, i64, i64) {
    let Ok(t) = session.GetTimelineProperties() else {
        return (0, 0, 0);
    };
    let pos = t.Position().map(|d| d.Duration / TICKS_PER_MS).unwrap_or(0);
    let end = t.EndTime().map(|d| d.Duration / TICKS_PER_MS).unwrap_or(0);
    let updated = t
        .LastUpdatedTime()
        .map(|d| d.UniversalTime / TICKS_PER_MS - FILETIME_EPOCH_OFFSET_MS)
        .unwrap_or(0);
    (pos, end, updated)
}

/// (status, can_seek) from ONE GetPlaybackInfo read — snapshot used to fetch
/// it twice (status, then capability).
fn playback_info(session: &Session) -> (&'static str, bool) {
    let Ok(info) = session.GetPlaybackInfo() else {
        return ("stopped", false);
    };
    let status = match info.PlaybackStatus() {
        Ok(PlaybackStatus(4)) => "playing",
        Ok(PlaybackStatus(5)) => "paused",
        _ => "stopped",
    };
    let can_seek = info
        .Controls()
        .and_then(|c| c.IsPlaybackPositionEnabled())
        .unwrap_or(false);
    (status, can_seek)
}

fn playback_status(session: &Session) -> &'static str {
    playback_info(session).0
}

/// Cheap heartbeat probe: (app_id, timeline Position + LastUpdatedTime ticks,
/// status). The media loop skips the full snapshot (metadata marshal + art
/// work + emit) when this hasn't moved since the previous tick. Position is
/// included on its own because a player may move it without re-stamping
/// LastUpdatedTime (unverified for programmatic Spotify seeks) — the post-seek
/// UI bound must stay one heartbeat, not one push cadence. Metadata-only
/// changes still snapshot: MediaPropertiesChanged wakes force one.
pub type TickKey = (String, i64, i64, &'static str);

pub fn tick_key() -> Option<TickKey> {
    let session = current_session()?;
    let app_id = session
        .SourceAppUserModelId()
        .map(|h| h.to_string())
        .unwrap_or_default();
    let (position, updated) = session
        .GetTimelineProperties()
        .map(|t| {
            (
                t.Position().map(|d| d.Duration).unwrap_or(0),
                t.LastUpdatedTime().map(|d| d.UniversalTime).unwrap_or(0),
            )
        })
        .unwrap_or((0, 0));
    Some((app_id, position, updated, playback_status(&session)))
}

/// True while the art cache is inside its distrust window for the current key.
/// The stale-art probe re-reads thumbnail bytes every tick then (#11), so the
/// media loop must not skip snapshots on an unchanged tick_key.
pub fn art_probing(cache: &ArtCache) -> bool {
    lock_art(cache)
        .as_ref()
        .is_some_and(|e| !e.settled && now_ms() - e.first_seen_ms < ART_PROBE_WINDOW_MS)
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

/// Relative seek anchored on a locally projected position (Spotify's raw
/// reported position can be ~5s behind what the user hears), clamped to the
/// track bounds. This projection is the ONE left in Rust and it never reaches
/// the UI — global hotkeys land here without passing through the frontend, so
/// the ±10s anchor must be computed on this side.
pub fn seek_rel_ms(delta_ms: i64) -> bool {
    let Some(session) = current_session() else {
        return false;
    };
    let (pos, end, updated) = raw_timeline(&session);
    let staleness = now_ms() - updated;
    let pos = if playback_status(&session) == "playing" && (0..30_000).contains(&staleness) {
        pos + staleness
    } else {
        pos
    };
    let end = if end > 0 { end } else { i64::MAX };
    seek_abs_ms((pos + delta_ms).clamp(0, end))
}
