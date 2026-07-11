//! Spotify Web API adapter — the app's first OAuth. PKCE + loopback redirect
//! (the M5 plan's blessed shape), token cache on disk, and the raw endpoints
//! the queue/up-next features ride (PR 3+). HTTP follows lyrics.rs's
//! discipline: blocking ureq, served-vs-transport error split, and every
//! command async so nothing blocks the webview's STA thread (lib.rs rule).
//!
//! Tokens live in their own app-data file (`spotify_tokens.json`) — NOT
//! settings.json, which is a whole-file clobber write. Plaintext on disk is
//! the standard desktop-app tradeoff: the file is user-profile-scoped and
//! holds a refresh token limited to this app's scopes.

use base64::engine::general_purpose::URL_SAFE_NO_PAD as B64URL;
use base64::Engine;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::io::{Read, Write};
use std::net::TcpListener;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_opener::OpenerExt;

/// Public by design under PKCE (no secret exists for this app type).
/// Prerequisite: create the app at developer.spotify.com/dashboard with
/// Redirect URI EXACTLY `http://127.0.0.1:43117/callback` (literal 127.0.0.1,
/// not localhost — Spotify's loopback rules), Web API enabled, then paste the
/// Client ID here. Empty = the tray narrates "Spotify setup needed".
const SPOTIFY_CLIENT_ID: &str = "";

const REDIRECT_PORT: u16 = 43117;
/// read = queue/currently-playing; modify = add-to-queue/skip (play-now and
/// the up-next feeder, PR 3+) — requested up front so PR 3 needs no
/// re-consent. A 403 insufficient-scope (tokens from an older consent) is
/// treated as disconnected so the tray prompts a reconnect.
const SCOPES: &str = "user-read-playback-state user-modify-playback-state";
const UA: &str = "Pulse/0.1 (https://github.com/thientran01/pulse)";
const TIMEOUT: Duration = Duration::from_secs(15);
/// How long the loopback listener waits for the browser consent round-trip.
const AUTH_DEADLINE: Duration = Duration::from_secs(300);
/// Refresh when the access token is within this of expiry.
const REFRESH_MARGIN_MS: i64 = 60_000;
/// Serve the cached queue read when younger than this — absorbs trigger
/// races (view mount + track change) without hammering the API.
const QUEUE_CACHE_MS: i64 = 5_000;

// ---- state ----

#[derive(Serialize, Deserialize, Clone)]
struct Tokens {
    v: u32,
    access_token: String,
    refresh_token: String,
    expires_at_ms: i64,
    scope: String,
}

#[derive(Default)]
pub struct SpotifyAuth {
    inner: Mutex<Inner>,
    /// One consent flow at a time (double tray click, launch races).
    connect_in_flight: AtomicBool,
}

#[derive(Default)]
struct Inner {
    /// app-data dir — None until init() ran.
    dir: Option<PathBuf>,
    tokens: Option<Tokens>,
    /// (fetched_at unix ms, result) — the QUEUE_CACHE_MS response cache.
    queue_cache: Option<(i64, QueueResult)>,
}

#[derive(Serialize, Clone)]
pub struct SpotifyStatus {
    pub connected: bool,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct QueueTrack {
    /// Spotify track URI — play-now/re-queue anchor by uri, never by index.
    pub uri: String,
    pub title: String,
    /// Joined artist names.
    pub artist: String,
    pub album: String,
    pub duration_ms: i64,
    /// Smallest suitable remote cover URL — the webview loads it directly
    /// (null CSP), no data-URL bloat, no ArtCache involvement.
    pub art_url: Option<String>,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct QueueResult {
    /// "ok" | "disconnected" | "no_playback" | "offline"
    pub status: String,
    pub currently_playing: Option<QueueTrack>,
    pub queue: Vec<QueueTrack>,
}

impl QueueResult {
    fn bare(status: &str) -> Self {
        Self { status: status.into(), currently_playing: None, queue: Vec::new() }
    }
}

fn unix_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn lock(auth: &SpotifyAuth) -> std::sync::MutexGuard<'_, Inner> {
    auth.inner.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

fn tokens_path(dir: &std::path::Path) -> PathBuf {
    dir.join("spotify_tokens.json")
}

/// Load the token file (if any) and remember the app-data dir. Setup-time.
pub fn init(app: &AppHandle) {
    let Ok(dir) = app.path().app_data_dir() else {
        eprintln!("spotify: app data dir unavailable — adapter disabled this run");
        return;
    };
    let tokens = std::fs::read_to_string(tokens_path(&dir))
        .ok()
        .and_then(|raw| serde_json::from_str::<Tokens>(&raw).ok());
    let auth = app.state::<SpotifyAuth>();
    let mut inner = lock(&auth);
    inner.dir = Some(dir);
    inner.tokens = tokens;
}

pub fn connected(app: &AppHandle) -> bool {
    let auth = app.state::<SpotifyAuth>();
    let inner = lock(&auth);
    inner.tokens.is_some()
}

fn emit_status(app: &AppHandle) {
    let _ = app.emit("spotify-status", SpotifyStatus { connected: connected(app) });
}

fn save_tokens(inner: &Inner) {
    let (Some(dir), Some(tokens)) = (&inner.dir, &inner.tokens) else { return };
    if let Ok(json) = serde_json::to_string(tokens) {
        let _ = std::fs::create_dir_all(dir);
        if let Err(e) = std::fs::write(tokens_path(dir), json) {
            eprintln!("spotify: token save failed: {e}");
        }
    }
}

/// Drop tokens + file; the caller emits status / narrates the tray.
fn clear_tokens(app: &AppHandle) {
    let auth = app.state::<SpotifyAuth>();
    let mut inner = lock(&auth);
    if let Some(dir) = &inner.dir {
        let _ = std::fs::remove_file(tokens_path(dir));
    }
    inner.tokens = None;
    inner.queue_cache = None;
}

// ---- PKCE consent flow ----

fn b64url_random(len: usize) -> String {
    let mut buf = vec![0u8; len];
    rand::thread_rng().fill_bytes(&mut buf);
    B64URL.encode(buf)
}

/// Percent-encode for query components (RFC 3986 unreserved kept).
fn urlenc(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// Start the consent flow on its own thread; narration lands on the tray
/// item via the provided callback. No-op when a flow is already running.
pub fn start_connect(app: &AppHandle, narrate: impl Fn(&AppHandle, &str) + Send + 'static) {
    if SPOTIFY_CLIENT_ID.is_empty() {
        narrate(app, "Spotify setup needed (no client id)");
        return;
    }
    let auth = app.state::<SpotifyAuth>();
    if auth
        .connect_in_flight
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        let outcome = run_consent(&app, &narrate);
        app.state::<SpotifyAuth>().connect_in_flight.store(false, Ordering::SeqCst);
        match outcome {
            Ok(()) => {
                emit_status(&app);
                narrate(&app, "Disconnect Spotify");
            }
            Err(msg) => {
                eprintln!("spotify connect failed: {msg}");
                narrate(&app, "Spotify connect failed — retry");
            }
        }
    });
}

fn run_consent(app: &AppHandle, narrate: &impl Fn(&AppHandle, &str)) -> Result<(), String> {
    let verifier = b64url_random(64);
    let challenge = B64URL.encode(Sha256::digest(verifier.as_bytes()));
    let state = b64url_random(16);
    let redirect = format!("http://127.0.0.1:{REDIRECT_PORT}/callback");

    // Bind BEFORE opening the browser — a busy port fails fast and clean.
    let listener = TcpListener::bind(("127.0.0.1", REDIRECT_PORT))
        .map_err(|e| format!("port {REDIRECT_PORT} unavailable: {e}"))?;
    listener.set_nonblocking(true).map_err(|e| e.to_string())?;

    let url = format!(
        "https://accounts.spotify.com/authorize?response_type=code&client_id={}&scope={}&redirect_uri={}&state={}&code_challenge_method=S256&code_challenge={}",
        urlenc(SPOTIFY_CLIENT_ID),
        urlenc(SCOPES),
        urlenc(&redirect),
        urlenc(&state),
        urlenc(&challenge),
    );
    app.opener()
        .open_url(&url, None::<&str>)
        .map_err(|e| format!("browser open failed: {e}"))?;
    narrate(app, "Connecting… approve in the browser");

    let code = wait_for_callback(&listener, &state)?;
    narrate(app, "Connecting… exchanging tokens");
    let tokens = exchange_code(&code, &redirect, &verifier)?;

    let auth = app.state::<SpotifyAuth>();
    let mut inner = lock(&auth);
    inner.tokens = Some(tokens);
    save_tokens(&inner);
    Ok(())
}

/// One-shot loopback accept: poll until the redirect lands or the deadline
/// passes. Returns the authorization code after verifying `state`.
fn wait_for_callback(listener: &TcpListener, want_state: &str) -> Result<String, String> {
    let deadline = Instant::now() + AUTH_DEADLINE;
    loop {
        match listener.accept() {
            Ok((mut stream, _)) => {
                let mut buf = [0u8; 4096];
                let n = {
                    let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
                    stream.read(&mut buf).unwrap_or(0)
                };
                let req = String::from_utf8_lossy(&buf[..n]);
                let Some(query) = req
                    .lines()
                    .next()
                    .and_then(|l| l.split_whitespace().nth(1))
                    .and_then(|path| path.strip_prefix("/callback?"))
                else {
                    // Favicons and strays — answer politely, keep waiting.
                    let _ = stream.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n");
                    continue;
                };
                let mut code = None;
                let mut got_state = None;
                let mut error = None;
                for pair in query.split('&') {
                    let (k, v) = pair.split_once('=').unwrap_or((pair, ""));
                    match k {
                        "code" => code = Some(v.to_string()),
                        "state" => got_state = Some(v.to_string()),
                        "error" => error = Some(v.to_string()),
                        _ => {}
                    }
                }
                let body = "<html><body style=\"font-family:sans-serif;background:#141210;color:#f5efe6;display:grid;place-items:center;height:100vh;margin:0\"><p>Pulse is connected — you can close this tab.</p></body></html>";
                let _ = stream.write_all(
                    format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                        body.len()
                    )
                    .as_bytes(),
                );
                if let Some(e) = error {
                    return Err(format!("consent denied: {e}"));
                }
                if got_state.as_deref() != Some(want_state) {
                    return Err("state mismatch (stale or forged callback)".into());
                }
                return code.ok_or_else(|| "callback carried no code".into());
            }
            Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                if Instant::now() >= deadline {
                    return Err("consent timed out (5 min)".into());
                }
                std::thread::sleep(Duration::from_millis(100));
            }
            Err(e) => return Err(format!("listener error: {e}")),
        }
    }
}

fn token_request(form: &[(&str, &str)]) -> Result<Tokens, String> {
    let resp = ureq::post("https://accounts.spotify.com/api/token")
        .set("User-Agent", UA)
        .timeout(TIMEOUT)
        .send_form(form);
    let resp = match resp {
        Ok(r) => r,
        Err(ureq::Error::Status(code, r)) => {
            let body = r.into_string().unwrap_or_default();
            return Err(format!("token endpoint {code}: {body}"));
        }
        Err(e) => return Err(format!("offline: {e}")),
    };
    let v: serde_json::Value = resp.into_json().map_err(|e| e.to_string())?;
    let access = v["access_token"].as_str().ok_or("no access_token")?.to_string();
    let expires_in = v["expires_in"].as_i64().unwrap_or(3600);
    // Rotation: a refresh response may omit refresh_token (keep the old one —
    // the caller merges); an authorization response always carries it.
    let refresh = v["refresh_token"].as_str().unwrap_or_default().to_string();
    Ok(Tokens {
        v: 1,
        access_token: access,
        refresh_token: refresh,
        expires_at_ms: unix_ms() + expires_in * 1000 - 5_000,
        scope: v["scope"].as_str().unwrap_or(SCOPES).to_string(),
    })
}

fn exchange_code(code: &str, redirect: &str, verifier: &str) -> Result<Tokens, String> {
    token_request(&[
        ("grant_type", "authorization_code"),
        ("code", code),
        ("redirect_uri", redirect),
        ("client_id", SPOTIFY_CLIENT_ID),
        ("code_verifier", verifier),
    ])
}

/// A valid bearer token, refreshing on demand. Never holds the state lock
/// across HTTP. Err = the caller's QueueResult status ("disconnected" when
/// tokens are gone/invalid, "offline" on transport failure).
fn ensure_access(app: &AppHandle) -> Result<String, &'static str> {
    let auth = app.state::<SpotifyAuth>();
    let (access, refresh_token) = {
        let inner = lock(&auth);
        let Some(t) = &inner.tokens else { return Err("disconnected") };
        if t.expires_at_ms - unix_ms() > REFRESH_MARGIN_MS {
            return Ok(t.access_token.clone());
        }
        (t.access_token.clone(), t.refresh_token.clone())
    };
    if refresh_token.is_empty() {
        // Shouldn't happen (authorization always grants one) — treat as a
        // dead session rather than silently riding an expiring token.
        clear_tokens(app);
        emit_status(app);
        return Err("disconnected");
    }
    match token_request(&[
        ("grant_type", "refresh_token"),
        ("refresh_token", &refresh_token),
        ("client_id", SPOTIFY_CLIENT_ID),
    ]) {
        Ok(mut fresh) => {
            if fresh.refresh_token.is_empty() {
                fresh.refresh_token = refresh_token;
            }
            let access = fresh.access_token.clone();
            let mut inner = lock(&auth);
            inner.tokens = Some(fresh);
            save_tokens(&inner);
            Ok(access)
        }
        Err(e) if e.contains("invalid_grant") => {
            // Revoked / rotated away underneath us — a re-consent is the only
            // fix; surface it as disconnected.
            clear_tokens(app);
            emit_status(app);
            Err("disconnected")
        }
        Err(e) if e.starts_with("offline") => {
            // Transport failure: the old token may still be fine — try it.
            Ok(access)
        }
        Err(_) => Err("disconnected"),
    }
}

// ---- Web API ----

/// GET a player endpoint with one 401-refresh retry and one 429 Retry-After
/// honor. Ok(None) = 204 (no active playback).
fn api_get(app: &AppHandle, url: &str) -> Result<Option<serde_json::Value>, &'static str> {
    let mut token = ensure_access(app)?;
    let mut refreshed = false;
    let mut waited_429 = false;
    loop {
        let resp = ureq::get(url)
            .set("User-Agent", UA)
            .set("Authorization", &format!("Bearer {token}"))
            .timeout(TIMEOUT)
            .call();
        match resp {
            Ok(r) => {
                if r.status() == 204 {
                    return Ok(None);
                }
                return r.into_json().map(Some).map_err(|_| "offline");
            }
            Err(ureq::Error::Status(401, _)) if !refreshed => {
                refreshed = true;
                // Force a refresh by expiring the cached token first.
                {
                    let auth = app.state::<SpotifyAuth>();
                    let mut inner = lock(&auth);
                    if let Some(t) = inner.tokens.as_mut() {
                        t.expires_at_ms = 0;
                    }
                }
                token = ensure_access(app)?;
            }
            Err(ureq::Error::Status(401, _)) => {
                clear_tokens(app);
                emit_status(app);
                return Err("disconnected");
            }
            Err(ureq::Error::Status(403, _)) => {
                // Insufficient scope (tokens predate the current SCOPES) —
                // only a re-consent fixes it.
                clear_tokens(app);
                emit_status(app);
                return Err("disconnected");
            }
            Err(ureq::Error::Status(429, r)) if !waited_429 => {
                waited_429 = true;
                let wait = r
                    .header("Retry-After")
                    .and_then(|s| s.parse::<u64>().ok())
                    .unwrap_or(1)
                    .min(10);
                std::thread::sleep(Duration::from_secs(wait));
            }
            Err(ureq::Error::Status(_, _)) => return Err("offline"),
            Err(_) => return Err("offline"),
        }
    }
}

/// Parse one queue/currently-playing item. Non-track items (episodes) map
/// with best-effort fields; anything without a uri is dropped by the caller.
fn parse_track(v: &serde_json::Value) -> Option<QueueTrack> {
    let uri = v["uri"].as_str()?.to_string();
    let artist = v["artists"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|x| x["name"].as_str())
                .collect::<Vec<_>>()
                .join(", ")
        })
        .unwrap_or_default();
    // Smallest image ≥64px wins; Spotify orders images largest-first.
    let art_url = v["album"]["images"]
        .as_array()
        .and_then(|imgs| {
            imgs.iter()
                .filter(|i| i["width"].as_i64().unwrap_or(0) >= 64)
                .last()
                .or_else(|| imgs.first())
        })
        .and_then(|i| i["url"].as_str())
        .map(String::from);
    Some(QueueTrack {
        uri,
        title: v["name"].as_str().unwrap_or_default().to_string(),
        artist,
        album: v["album"]["name"].as_str().unwrap_or_default().to_string(),
        duration_ms: v["duration_ms"].as_i64().unwrap_or(0),
        art_url,
    })
}

/// The user's queue (currently playing + up next). Served from a 5s cache;
/// note Spotify mixes user-queued and autoplay items with no distinction and
/// caps at ~20 items.
pub fn queue(app: &AppHandle) -> QueueResult {
    {
        let auth = app.state::<SpotifyAuth>();
        let inner = lock(&auth);
        if let Some((at, cached)) = &inner.queue_cache {
            if unix_ms() - at < QUEUE_CACHE_MS {
                return cached.clone();
            }
        }
    }
    let result = match api_get(app, "https://api.spotify.com/v1/me/player/queue") {
        Err(status) => QueueResult::bare(status),
        Ok(None) => QueueResult::bare("no_playback"),
        Ok(Some(v)) => {
            let currently_playing = parse_track(&v["currently_playing"]);
            let queue = v["queue"]
                .as_array()
                .map(|items| items.iter().filter_map(parse_track).collect())
                .unwrap_or_default();
            if currently_playing.is_none() && v["queue"].as_array().is_none() {
                QueueResult::bare("no_playback")
            } else {
                QueueResult { status: "ok".into(), currently_playing, queue }
            }
        }
    };
    // Cache ok/no_playback (real answers); transient failures retry freely.
    if result.status == "ok" || result.status == "no_playback" {
        let auth = app.state::<SpotifyAuth>();
        let mut inner = lock(&auth);
        inner.queue_cache = Some((unix_ms(), result.clone()));
    }
    result
}

// ---- commands ----

#[tauri::command]
pub async fn spotify_status(app: AppHandle) -> SpotifyStatus {
    SpotifyStatus { connected: connected(&app) }
}

/// Shared by the command and the tray click.
pub fn disconnect(app: &AppHandle) {
    clear_tokens(app);
    emit_status(app);
}

#[tauri::command]
pub async fn spotify_disconnect(app: AppHandle) {
    disconnect(&app);
}

/// Queue read for the frontend — blocking HTTP on the dedicated pool (the
/// media_lyrics shape).
#[tauri::command]
pub async fn spotify_queue(app: AppHandle) -> QueueResult {
    tauri::async_runtime::spawn_blocking(move || queue(&app))
        .await
        .unwrap_or_else(|e| {
            eprintln!("spotify queue task panicked: {e}");
            QueueResult::bare("offline")
        })
}
