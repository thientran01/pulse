//! Spotify Web API adapter — the app's first OAuth. PKCE + loopback redirect
//! (the M5 plan's blessed shape), token cache on disk, and the raw endpoints
//! the queue/up-next features ride (PR 3+). HTTP follows lyrics.rs's
//! discipline: blocking ureq, served-vs-transport error split, and every
//! command async so nothing blocks the webview's STA thread (lib.rs rule).
//!
//! Tokens live in their own app-data file (`spotify_tokens.json`) — NOT
//! settings.json (a shared key-value file; settings.rs owns its
//! read-modify-write). Plaintext on disk is the standard desktop-app
//! tradeoff: the file is user-profile-scoped and holds a refresh token
//! limited to this app's scopes.
//!
//! Token-destruction policy (quick-review hardening, 2026-07-10): tokens are
//! cleared ONLY on evidence the session itself is dead — a 400-class answer
//! from the token endpoint (invalid_grant/invalid_client), or a fresh
//! access token still answering 401. Transport failures, 5xx, and 403s
//! (which Spotify also serves for non-scope reasons, e.g. Premium-required)
//! never destroy a session a re-consent couldn't improve.

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
const SPOTIFY_CLIENT_ID: &str = "3f82e7a35eea45ddab8625819a79d1de";

const REDIRECT_PORT: u16 = 43117;
/// read = queue/currently-playing; modify = add-to-queue/skip (play-now and
/// the up-next feeder) — requested up front so later features need no
/// re-consent. The library scopes (the like heart) were REQUESTED AND CUT
/// 2026-07-12: Spotify endpoint-blocks PUT/DELETE /me/tracks and GET
/// .../contains for this app id — 403 with a valid token carrying the
/// scopes (verified live; the dev-mode blocking family). Don't re-add
/// without re-verifying the endpoints answer.
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

type Narrator = Box<dyn Fn(&AppHandle, &str) + Send + Sync + 'static>;

#[derive(Default)]
pub struct SpotifyAuth {
    inner: Mutex<Inner>,
    /// One consent flow at a time (double tray click, launch races).
    connect_in_flight: AtomicBool,
    /// Single-flight for token refreshes: two callers sharing one stale
    /// refresh token would otherwise race the rotation — the loser's
    /// invalid_grant could clear the winner's just-saved valid tokens.
    /// NEVER held at the same time as `inner` (gate first, inner inside).
    refresh_gate: Mutex<()>,
    /// Tray-label narration, registered by lib.rs at setup. Kept here so
    /// EVERY connection-state change narrates — including backend-triggered
    /// clears (invalid_grant, dead session) and frontend disconnects, not
    /// just tray clicks. The label doubles as the connection state.
    narrator: Mutex<Option<Narrator>>,
    /// One play_now jump at a time; also gates upnext's fed-pop bookkeeping
    /// against the intermediate track flicker a jump produces.
    jump_in_flight: AtomicBool,
    /// One currently-playing enrichment read at a time (fired per track
    /// change from the media loop — must never stack).
    enrich_in_flight: AtomicBool,
}

#[derive(Default)]
struct Inner {
    /// app-data dir — None until init() ran.
    dir: Option<PathBuf>,
    tokens: Option<Tokens>,
    /// (fetched_at unix ms, result) — the QUEUE_CACHE_MS response cache.
    queue_cache: Option<(i64, QueueResult)>,
    /// The current track's uri, remembered by update_now (settled enrichment
    /// reads, verified jump landings) — similar.rs excludes what's playing
    /// from a more-like-this fill by it. Cleared with the tokens. (This slot
    /// once carried a liked flag for the like heart — CUT 2026-07-12:
    /// Spotify endpoint-blocks library writes for this app id.)
    now_uri: Option<String>,
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

/// Register the tray-label narrator (lib.rs setup, capturing the menu item).
pub fn set_narrator(app: &AppHandle, f: impl Fn(&AppHandle, &str) + Send + Sync + 'static) {
    let auth = app.state::<SpotifyAuth>();
    *auth.narrator.lock().unwrap_or_else(std::sync::PoisonError::into_inner) = Some(Box::new(f));
}

fn narrate(app: &AppHandle, text: &str) {
    let auth = app.state::<SpotifyAuth>();
    let narrator = auth.narrator.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    if let Some(f) = narrator.as_ref() {
        f(app, text);
    }
}

pub fn connected(app: &AppHandle) -> bool {
    let auth = app.state::<SpotifyAuth>();
    let inner = lock(&auth);
    inner.tokens.is_some()
}

/// True while a play_now jump is skipping through the queue — upnext::tick
/// suspends its fed-pop bookkeeping for the duration.
pub fn jump_active(app: &AppHandle) -> bool {
    app.state::<SpotifyAuth>().jump_in_flight.load(Ordering::SeqCst)
}

/// Emit the connection state AND re-sync the tray label to it — the label is
/// derived state and every transition flows through here (tray, frontend
/// command, background invalid_grant), so it can never go stale.
fn emit_status(app: &AppHandle) {
    let connected = connected(app);
    let _ = app.emit("spotify-status", SpotifyStatus { connected });
    narrate(app, if connected { "Disconnect Spotify" } else { "Connect Spotify" });
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

/// Drop tokens + file; callers follow with emit_status.
fn clear_tokens(app: &AppHandle) {
    let auth = app.state::<SpotifyAuth>();
    {
        let mut inner = lock(&auth);
        if let Some(dir) = &inner.dir {
            let _ = std::fs::remove_file(tokens_path(dir));
        }
        inner.tokens = None;
        inner.queue_cache = None;
        inner.now_uri = None;
    }
}

/// Shared by the command and the tray click.
pub fn disconnect(app: &AppHandle) {
    clear_tokens(app);
    emit_status(app);
}

// ---- PKCE consent flow ----

fn b64url_random(len: usize) -> String {
    let mut buf = vec![0u8; len];
    rand::thread_rng().fill_bytes(&mut buf);
    B64URL.encode(buf)
}

/// Percent-encode for query components (RFC 3986 unreserved kept).
pub(crate) fn urlenc(s: &str) -> String {
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

/// Percent-decode a query component (the authorization code is opaque server
/// data with no charset guarantee — using it raw would double-encode any
/// escaped byte in the token exchange).
fn urldec(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'%' if i + 2 < bytes.len() => {
                let hex = std::str::from_utf8(&bytes[i + 1..i + 3])
                    .ok()
                    .and_then(|h| u8::from_str_radix(h, 16).ok());
                match hex {
                    Some(b) => {
                        out.push(b);
                        i += 3;
                    }
                    None => {
                        out.push(bytes[i]);
                        i += 1;
                    }
                }
            }
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            b => {
                out.push(b);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Start the consent flow on its own thread; progress narrates on the tray
/// label via the registered narrator. No-op when a flow is already running.
pub fn start_connect(app: &AppHandle) {
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
        let outcome = run_consent(&app);
        app.state::<SpotifyAuth>().connect_in_flight.store(false, Ordering::SeqCst);
        match outcome {
            Ok(()) => emit_status(&app),
            Err(msg) => {
                eprintln!("spotify connect failed: {msg}");
                narrate(&app, "Spotify connect failed — retry");
            }
        }
    });
}

fn run_consent(app: &AppHandle) -> Result<(), String> {
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

/// Read the request head (through the blank line) with a bounded loop — a
/// single read() is not guaranteed to deliver the whole request line.
fn read_request_head(stream: &mut std::net::TcpStream) -> String {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
    let mut buf = Vec::with_capacity(2048);
    let mut chunk = [0u8; 2048];
    while buf.len() < 16_384 {
        match stream.read(&mut chunk) {
            Ok(0) => break,
            Ok(n) => {
                buf.extend_from_slice(&chunk[..n]);
                if buf.windows(4).any(|w| w == b"\r\n\r\n") {
                    break;
                }
            }
            Err(_) => break,
        }
    }
    String::from_utf8_lossy(&buf).into_owned()
}

fn respond(stream: &mut std::net::TcpStream, status: &str, body: &str) {
    let _ = stream.write_all(
        format!(
            "HTTP/1.1 {status}\r\nContent-Type: text/html\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        )
        .as_bytes(),
    );
}

fn consent_page(msg: &str) -> String {
    format!(
        "<html><body style=\"font-family:sans-serif;background:#141210;color:#f5efe6;display:grid;place-items:center;height:100vh;margin:0\"><p>{msg}</p></body></html>"
    )
}

/// One-shot loopback accept: poll until OUR redirect lands (state verified)
/// or the deadline passes. Callbacks whose state doesn't match are answered
/// and ignored — any local process can hit this port, and a stray or forged
/// request must not abort the real consent still pending in the browser.
fn wait_for_callback(listener: &TcpListener, want_state: &str) -> Result<String, String> {
    let deadline = Instant::now() + AUTH_DEADLINE;
    loop {
        match listener.accept() {
            Ok((mut stream, _)) => {
                let req = read_request_head(&mut stream);
                let Some(query) = req
                    .lines()
                    .next()
                    .and_then(|l| l.split_whitespace().nth(1))
                    .and_then(|path| path.strip_prefix("/callback?"))
                else {
                    // Favicons and strays — answer politely, keep waiting.
                    let _ = stream.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
                    continue;
                };
                let mut code = None;
                let mut got_state = None;
                let mut error = None;
                for pair in query.split('&') {
                    let (k, v) = pair.split_once('=').unwrap_or((pair, ""));
                    match k {
                        "code" => code = Some(urldec(v)),
                        "state" => got_state = Some(urldec(v)),
                        "error" => error = Some(urldec(v)),
                        _ => {}
                    }
                }
                // State FIRST: a callback that isn't ours (wrong/absent
                // state) gets ignored — even an error= one. Only Spotify's
                // own redirect carries our state.
                if got_state.as_deref() != Some(want_state) {
                    respond(&mut stream, "404 Not Found", &consent_page("Not this session."));
                    continue;
                }
                if let Some(e) = error {
                    respond(
                        &mut stream,
                        "200 OK",
                        &consent_page("Connection canceled — you can close this tab."),
                    );
                    return Err(format!("consent denied: {e}"));
                }
                respond(
                    &mut stream,
                    "200 OK",
                    &consent_page("Pulse is connected — you can close this tab."),
                );
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

/// Errors: "offline: …" = transport; "token endpoint <code>: …" = served.
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
    // Rotation: a refresh response may omit refresh_token AND scope (keep the
    // old ones — the caller merges); an authorization response carries both.
    // The scope fallback must NOT be the SCOPES const: has_library_scope
    // gates the heart on this string, and stamping today's requested scopes
    // onto a pre-library-consent token would re-open the click-time-403 path
    // the gate exists to avoid (quick-review catch, 2026-07-11).
    let refresh = v["refresh_token"].as_str().unwrap_or_default().to_string();
    Ok(Tokens {
        v: 1,
        access_token: access,
        refresh_token: refresh,
        expires_at_ms: unix_ms() + expires_in * 1000 - 5_000,
        scope: v["scope"].as_str().unwrap_or_default().to_string(),
    })
}

fn exchange_code(code: &str, redirect: &str, verifier: &str) -> Result<Tokens, String> {
    let mut tokens = token_request(&[
        ("grant_type", "authorization_code"),
        ("code", code),
        ("redirect_uri", redirect),
        ("client_id", SPOTIFY_CLIENT_ID),
        ("code_verifier", verifier),
    ])?;
    if tokens.scope.is_empty() {
        // A fresh authorization grants exactly what was asked (Spotify
        // consent is all-or-nothing) — only here is the const the truth.
        tokens.scope = SCOPES.to_string();
    }
    Ok(tokens)
}

/// A valid bearer token, refreshing on demand. Refreshes are single-flighted
/// through `refresh_gate`; the state lock is never held across HTTP. On a
/// refresh that CAN'T run (offline, 5xx) the old token is returned — callers
/// distinguish "refresh actually happened" by the token changing.
/// Err = "disconnected" (no/dead session) — 400-class token-endpoint answers
/// (invalid_grant, invalid_client) clear the session, transient failures
/// never do.
fn ensure_access(app: &AppHandle) -> Result<String, &'static str> {
    let auth = app.state::<SpotifyAuth>();
    {
        let inner = lock(&auth);
        let Some(t) = &inner.tokens else { return Err("disconnected") };
        if t.expires_at_ms - unix_ms() > REFRESH_MARGIN_MS {
            return Ok(t.access_token.clone());
        }
    }
    // Slow path: serialize refreshes; a waiter re-checks and usually finds
    // the winner's fresh token.
    let _gate = auth.refresh_gate.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    let (old_access, refresh_token, old_scope) = {
        let inner = lock(&auth);
        let Some(t) = &inner.tokens else { return Err("disconnected") };
        if t.expires_at_ms - unix_ms() > REFRESH_MARGIN_MS {
            return Ok(t.access_token.clone());
        }
        (t.access_token.clone(), t.refresh_token.clone(), t.scope.clone())
    };
    if refresh_token.is_empty() {
        // Shouldn't happen (authorization always grants one) — a dead
        // session, not a transient.
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
            if fresh.scope.is_empty() {
                // A refresh can't widen a grant — carry the old truth.
                fresh.scope = old_scope;
            }
            let access = fresh.access_token.clone();
            let mut inner = lock(&auth);
            inner.tokens = Some(fresh);
            save_tokens(&inner);
            Ok(access)
        }
        // 400-class served answer: the grant itself is dead (revoked,
        // rotated away, bad client) — only a re-consent heals it. Clearing
        // here also heals the "stale tokens presented as connected forever"
        // restart state.
        Err(e) if e.starts_with("token endpoint 4") => {
            eprintln!("spotify refresh rejected: {e}");
            clear_tokens(app);
            emit_status(app);
            Err("disconnected")
        }
        // Transport failure or 5xx: the session may be fine — hand back the
        // old token and let the caller treat a repeat 401 as offline.
        Err(e) => {
            eprintln!("spotify refresh unavailable: {e}");
            Ok(old_access)
        }
    }
}

// ---- Web API ----

/// Call a player endpoint with one 401-refresh retry and one 429 Retry-After
/// honor. Ok(None) = 204 (no active playback) or an empty body.
fn api_call(
    app: &AppHandle,
    method: &str,
    url: &str,
) -> Result<Option<serde_json::Value>, &'static str> {
    api_call_impl(app, method, url, None, "disconnected")
}

/// api_call with a JSON body (start_playback's PUT play needs `uris`).
fn api_call_body(
    app: &AppHandle,
    method: &str,
    url: &str,
    body: &serde_json::Value,
) -> Result<Option<serde_json::Value>, &'static str> {
    api_call_impl(app, method, url, Some(body), "disconnected")
}

fn api_call_impl(
    app: &AppHandle,
    method: &str,
    url: &str,
    body: Option<&serde_json::Value>,
    on_403: &'static str,
) -> Result<Option<serde_json::Value>, &'static str> {
    let mut token = ensure_access(app)?;
    let mut refreshed = false;
    let mut waited_429 = false;
    loop {
        let req = ureq::request(method, url)
            .set("User-Agent", UA)
            .set("Authorization", &format!("Bearer {token}"))
            .timeout(TIMEOUT);
        // Non-GETs must carry an explicit body even when empty: ureq's
        // bodyless call() sends no Content-Length and Spotify's edge answers
        // 411 "Length Required" — which read as "Spotify unreachable" on
        // every play_now and silently starved the feeder (first live soak,
        // 2026-07-11; GETs were never affected, which is why search/enrich
        // worked).
        let resp = match (method, body) {
            ("GET", _) => req.call(),
            (_, Some(b)) => req
                .set("Content-Type", "application/json")
                .send_string(&b.to_string()),
            (_, None) => req.send_bytes(&[]),
        };
        match resp {
            Ok(r) => {
                if r.status() == 204 {
                    return Ok(None);
                }
                // A GET's body is the answer — a garbled one is a failure.
                // POST answers (200/202) may carry no body; that's success.
                if method == "GET" {
                    return r.into_json().map(Some).map_err(|_| "offline");
                }
                return Ok(r.into_json().ok());
            }
            Err(ureq::Error::Status(401, _)) if !refreshed => {
                refreshed = true;
                // Force a real refresh by expiring the cached token.
                {
                    let auth = app.state::<SpotifyAuth>();
                    let mut inner = lock(&auth);
                    if let Some(t) = inner.tokens.as_mut() {
                        t.expires_at_ms = 0;
                    }
                }
                let fresh = ensure_access(app)?;
                if fresh == token {
                    // The refresh couldn't run (offline/5xx) — retrying the
                    // same token would 401 into the destroy path below. The
                    // session may be fine; report transient.
                    return Err("offline");
                }
                token = fresh;
            }
            Err(ureq::Error::Status(401, _)) => {
                // A genuinely fresh token still 401s — the session is dead.
                clear_tokens(app);
                emit_status(app);
                return Err("disconnected");
            }
            Err(ureq::Error::Status(403, _)) => {
                // 403 is ambiguous on player endpoints (insufficient scope,
                // but ALSO Spotify's Premium-required answer) and definitive
                // on library endpoints (the dev-mode endpoint block). The
                // caller picks the mapping; nothing here destroys tokens —
                // a re-consent is available from the tray any time.
                return Err(on_403);
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
            // Served 5xx and transport failures both mean "can't read the
            // queue right now" — deliberately one bucket for the UI (unlike
            // lyrics.rs, nothing here must avoid caching a miss).
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
    // Smallest image ≥64px wins; Spotify orders images largest-first, so
    // the fallback (no usable widths) is also the LAST entry.
    let art_url = v["album"]["images"]
        .as_array()
        .and_then(|imgs| {
            imgs.iter()
                .filter(|i| i["width"].as_i64().unwrap_or(0) >= 64)
                .last()
                .or_else(|| imgs.last())
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

/// One "queue" POST: append a track to the END of Spotify's real queue —
/// the up-next feeder's rung and the jump's re-queue primitive.
pub fn add_to_queue(app: &AppHandle, uri: &str) -> Result<(), &'static str> {
    api_call(
        app,
        "POST",
        &format!("https://api.spotify.com/v1/me/player/queue?uri={}", urlenc(uri)),
    )
    .map(|_| ())
}

fn next_track(app: &AppHandle) -> Result<(), &'static str> {
    api_call(app, "POST", "https://api.spotify.com/v1/me/player/next").map(|_| ())
}

/// The user's queue (currently playing + up next). Served from a 5s cache;
/// note Spotify mixes user-queued and autoplay items with no distinction and
/// caps at ~20 items.
pub fn queue(app: &AppHandle) -> QueueResult {
    queue_impl(app, true)
}

/// Cache-bypassing read — play_now's positioning must never act on a stale
/// snapshot (it skips by position).
pub(crate) fn queue_fresh(app: &AppHandle) -> QueueResult {
    queue_impl(app, false)
}

/// `use_cache: false` (the jump's reads) neither reads NOR writes the shared
/// cache and skips enrichment: mid-jump snapshots reflect transient
/// skipped-through tracks — caching one would poison what the UI shows for
/// up to 5s, and enriching from one could stamp a wrong uri.
fn queue_impl(app: &AppHandle, use_cache: bool) -> QueueResult {
    if use_cache {
        let auth = app.state::<SpotifyAuth>();
        let inner = lock(&auth);
        if let Some((at, cached)) = &inner.queue_cache {
            if unix_ms() - at < QUEUE_CACHE_MS {
                return cached.clone();
            }
        }
    }
    let result = match api_call(app, "GET", "https://api.spotify.com/v1/me/player/queue") {
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
    // Guarded on tokens still existing so a concurrent disconnect's cache
    // clear can't be repopulated by this in-flight read.
    if use_cache {
        if result.status == "ok" || result.status == "no_playback" {
            let auth = app.state::<SpotifyAuth>();
            let mut inner = lock(&auth);
            if inner.tokens.is_some() {
                inner.queue_cache = Some((unix_ms(), result.clone()));
            }
        }
        // Opportunistic history enrichment: a settled read tells us the
        // current track's uri — stamp it onto history's in-flight candidate
        // so history rows can replay without a search round-trip.
        if let Some(cp) = &result.currently_playing {
            crate::history::enrich_uri(app, &cp.title, &cp.artist, &cp.uri);
        }
    }
    result
}

// ---- play_now: the context-preserving jump ----

/// Play `uri` NOW without losing the playlist context or the rest of the
/// queue. Never `PUT /me/player/play` with bare uris (that kills the
/// context — Thien's explicit constraint): the target is positioned in the
/// real queue (added if absent), skipped to, the landing verified, and every
/// skipped-over item re-queued in order. Under the managed up-next model
/// Spotify's queue stays shallow, so the normal case is 0–2 skips.
///
/// Returns: "ok" | "busy" | "gone" | "diverged" | "partial" | "no_device"
/// (nothing playing AND Spotify open nowhere it can play) | "disconnected" |
/// "offline". From silence it starts playback outright (start_playback).
pub fn play_now(app: &AppHandle, uri: &str) -> &'static str {
    let auth = app.state::<SpotifyAuth>();
    if auth
        .jump_in_flight
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return "busy";
    }
    let outcome = jump(app, uri);
    app.state::<SpotifyAuth>().jump_in_flight.store(false, Ordering::SeqCst);
    // NO jump-cancel on "diverged" — upnext::try_queue_skip deliberately
    // lets suppression ride out its window there (the outcome is genuinely
    // uncertain; skips DID happen), and a blanket cancel here would undo
    // that call (quick-review catch). Pre-arm failures (gone/no_device/...)
    // never emitted the arm, and the 6s expiry covers the rest.
    outcome
}

/// Start playback of `uri` from SILENCE. play_now's never-PUT-play-uris rule
/// exists to protect a live playlist context — from no_playback there is no
/// context to kill, and the bare-uris PUT on the best available device is
/// exactly right (the palette's headline case: summon, type, play, with
/// nothing running). "ok" | "no_device" | "disconnected" | "offline".
fn start_playback(app: &AppHandle, uri: &str) -> &'static str {
    let devices = match api_call(app, "GET", "https://api.spotify.com/v1/me/player/devices") {
        Ok(Some(v)) => v,
        Ok(None) => return "no_device",
        Err(e) => return e,
    };
    let list = devices["devices"].as_array().cloned().unwrap_or_default();
    // Prefer the active device — but never a restricted one (Connect
    // hardware that rejects Web API commands with a 403); fall back to the
    // first commandable device.
    let commandable = |d: &&serde_json::Value| d["is_restricted"].as_bool() != Some(true);
    let dev = list
        .iter()
        .filter(commandable)
        .find(|d| d["is_active"].as_bool() == Some(true))
        .or_else(|| list.iter().find(commandable));
    let Some(id) = dev.and_then(|d| d["id"].as_str()) else {
        return "no_device"; // Spotify isn't open anywhere it can play
    };
    if let Err(e) = api_call_body(
        app,
        "PUT",
        &format!("https://api.spotify.com/v1/me/player/play?device_id={}", urlenc(id)),
        &serde_json::json!({ "uris": [uri] }),
    ) {
        return e;
    }
    // Verify the landing — never trust command answers (matrix finding 3;
    // jump() re-reads the same way). A device that accepted the PUT and
    // then went dead reports "diverged": honest uncertainty, retryable.
    for _ in 0..3 {
        std::thread::sleep(Duration::from_millis(400));
        if let Ok(Some(v)) =
            api_call(app, "GET", "https://api.spotify.com/v1/me/player/currently-playing")
        {
            if v["item"]["uri"].as_str() == Some(uri) {
                if let Some(t) = parse_track(&v["item"]) {
                    update_now(app, &t);
                }
                return "ok";
            }
        }
    }
    "diverged"
}

fn jump(app: &AppHandle, target: &str) -> &'static str {
    // 1. Where is the target? (Fresh read — positions go stale in seconds.)
    let q = queue_fresh(app);
    match q.status.as_str() {
        "ok" => {}
        // Nothing playing = nothing to jump within — start from silence
        // instead (see start_playback; this is the palette's core promise).
        "no_playback" => return start_playback(app, target),
        "disconnected" => return "disconnected",
        _ => return "offline",
    }
    if q.currently_playing.as_ref().is_some_and(|t| t.uri == target) {
        return "ok"; // already playing
    }
    let (skips, skipped, target_track): (usize, Vec<QueueTrack>, QueueTrack) =
        match q.queue.iter().position(|t| t.uri == target) {
            Some(k) => (k + 1, q.queue[..k].to_vec(), q.queue[k].clone()),
            None => {
                // Not in the queue (a history replay / Pulse up-next row):
                // append it, then find where it landed — user-queued items
                // sit before autoplay continuation, so the position after a
                // fresh read is the real skip count.
                if let Err(status) = add_to_queue(app, target) {
                    return status;
                }
                let q2 = queue_fresh(app);
                if q2.status != "ok" {
                    // Nothing has been skipped yet — "gone" keeps this in
                    // the pre-skip class (callers may safely fall back to a
                    // plain next; "diverged" is reserved for skips-happened-
                    // landing-unverified).
                    return "gone";
                }
                let Some(k) = q2.queue.iter().position(|t| t.uri == target) else {
                    return "gone";
                };
                (k + 1, q2.queue[..k].to_vec(), q2.queue[k].clone())
            }
        };

    // Arm the pill's announcement suppression in EVERY realm before skipping.
    // The queue UI arms its own realm frontend-side, but a palette-initiated
    // play runs in a different webview — the pill's realm only hears about
    // it through this event (same payload as upnext's queue-aware skip).
    let _ = app.emit(
        "spotify-jump",
        serde_json::json!({ "title": target_track.title, "artist": target_track.artist }),
    );

    // 2. Skip to it. A failure midway leaves playback partway — re-queue
    // what was already consumed (best effort) and report "diverged": skips
    // happened but the target's arrival is unconfirmed. ("partial" is
    // reserved for a VERIFIED landing whose re-queue was incomplete —
    // callers pop the queue front on it, so it must imply the target
    // actually played; quick-review catch, 2026-07-11.)
    for i in 0..skips {
        if next_track(app).is_err() {
            requeue(app, &skipped[..i.min(skipped.len())]);
            return "diverged";
        }
        std::thread::sleep(Duration::from_millis(150));
    }

    // 3. Verify the landing — never keep acting on an unconfirmed state
    // (matrix finding 3: never trust command bools; re-read).
    let mut landing: Option<QueueTrack> = None;
    for _ in 0..4 {
        std::thread::sleep(Duration::from_millis(300));
        let v = queue_fresh(app);
        if v.currently_playing.as_ref().is_some_and(|t| t.uri == target) {
            landing = v.currently_playing;
            break;
        }
    }

    // 4. Re-queue the skipped-over items in their original order. They were
    // consumed unplayed — this includes a fed up-next front item, which then
    // plays right after the target (upnext's fed marker stays armed; its
    // tick suspends fed-pop bookkeeping while jump_in_flight is set).
    let requeued_ok = requeue(app, &skipped);
    let Some(t) = landing else {
        return "diverged"; // concurrent user action — stopped, not forced
    };
    // The verified landing is trustworthy — enrich + publish here (mid-jump
    // reads deliberately don't), so the heart follows a jump without waiting
    // for the next settled enrich.
    update_now(app, &t);
    if !requeued_ok {
        return "partial";
    }
    "ok"
}

fn requeue(app: &AppHandle, items: &[QueueTrack]) -> bool {
    let mut ok = true;
    for t in items {
        if add_to_queue(app, &t.uri).is_err() {
            ok = false;
        }
        std::thread::sleep(Duration::from_millis(120));
    }
    ok
}

// ---- the current-track memory (history enrichment + similar.rs's seed) ----

/// The single writer of the current-track memory: stamp history's candidate
/// and remember the uri. Callers hand it a track they TRUST: a settled
/// currently-playing read (enrich_now) or a verified jump landing — never a
/// mid-jump snapshot.
fn update_now(app: &AppHandle, t: &QueueTrack) {
    crate::history::enrich_uri(app, &t.title, &t.artist, &t.uri);
    let auth = app.state::<SpotifyAuth>();
    let mut inner = lock(&auth);
    // A disconnect can race this in-flight read — its clear must win.
    if inner.tokens.is_some() {
        inner.now_uri = Some(t.uri.clone());
    }
}

// ---- history enrichment + uri resolution ----

/// Stamp the CURRENT track's uri onto history's in-flight candidate. Fired
/// once per track change from the media loop (via upnext::tick) while
/// connected and Spotify is active — this is the path that makes history
/// rows actionable (play-now/+ anchor by uri). The v0.6.0 wiring only
/// enriched from queue reads the shipped UI never performs, so no entry
/// ever earned a uri and the up-next list was unbootstrappable (Thien's
/// live find, 2026-07-11).
pub fn enrich_now(app: &AppHandle) {
    let auth = app.state::<SpotifyAuth>();
    if !connected(app)
        || auth
            .enrich_in_flight
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_err()
    {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        if let Ok(Some(v)) = api_call(&app, "GET", "https://api.spotify.com/v1/me/player/currently-playing")
        {
            if let Some(t) = parse_track(&v["item"]) {
                update_now(&app, &t);
            }
        }
        app.state::<SpotifyAuth>().enrich_in_flight.store(false, Ordering::SeqCst);
    });
}

/// Raw ranked track search — the palette's list and the fielded resolvers'
/// substrate. Ok(empty) = the API answered with no hits.
pub fn search_tracks(
    app: &AppHandle,
    query: &str,
    limit: u32,
) -> Result<Vec<QueueTrack>, &'static str> {
    let url = format!(
        "https://api.spotify.com/v1/search?type=track&limit={limit}&q={}",
        urlenc(query)
    );
    let v = api_call(app, "GET", &url)?;
    Ok(v
        .and_then(|v| {
            v["tracks"]["items"]
                .as_array()
                .map(|items| items.iter().filter_map(parse_track).collect())
        })
        .unwrap_or_default())
}

/// Resolve the best-matching track by search — the path for history entries
/// logged before enrichment existed (or from Apple Music sessions), and the
/// track builder for more-like-this. Best match = same title (ci) + artist
/// overlap, first 5 results.
pub fn search_best(app: &AppHandle, title: &str, artist: &str) -> Option<QueueTrack> {
    let items = search_tracks(app, &format!("track:{title} artist:{artist}"), 5).ok()?;
    let title_lc = title.trim().to_lowercase();
    let artist_lc = artist.trim().to_lowercase();
    items
        .iter()
        .find(|t| {
            let a = t.artist.trim().to_lowercase();
            t.title.trim().to_lowercase() == title_lc
                && (artist_lc.is_empty() || a.contains(&artist_lc) || artist_lc.contains(&a))
        })
        // Fall back to Spotify's own top hit — search relevance is usually
        // right even when metadata strings differ (remaster suffixes etc).
        .or_else(|| items.first())
        .cloned()
}

pub fn search_track(app: &AppHandle, title: &str, artist: &str) -> Option<String> {
    search_best(app, title, artist).map(|t| t.uri)
}

/// The current track's uri, if the enrichment has seen one.
pub fn now_uri(app: &AppHandle) -> Option<String> {
    let auth = app.state::<SpotifyAuth>();
    let inner = lock(&auth);
    inner.now_uri.clone()
}

// ---- commands ----

/// Search-resolve a uri for a history row that never got enriched. Returns
/// null on no match / disconnected / offline — the UI toasts.
#[tauri::command]
pub async fn spotify_resolve_uri(
    app: AppHandle,
    title: String,
    artist: String,
) -> Option<String> {
    tauri::async_runtime::spawn_blocking(move || search_track(&app, &title, &artist))
        .await
        .unwrap_or_else(|e| {
            eprintln!("spotify resolve task panicked: {e}");
            None
        })
}

#[tauri::command]
pub async fn spotify_status(app: AppHandle) -> SpotifyStatus {
    SpotifyStatus { connected: connected(&app) }
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

/// The context-preserving jump (from silence: an outright start). Statuses:
/// ok | busy (a jump is already running — ignore) | no_device (nothing
/// playing and Spotify open nowhere) | gone | diverged (concurrent user
/// action; stopped) | partial (re-queue incomplete) | disconnected |
/// offline. Up to ~several seconds of blocking work — dedicated pool.
#[tauri::command]
pub async fn spotify_play_now(app: AppHandle, uri: String) -> String {
    tauri::async_runtime::spawn_blocking(move || play_now(&app, &uri).to_string())
        .await
        .unwrap_or_else(|e| {
            eprintln!("spotify play_now task panicked: {e}");
            "offline".into()
        })
}

#[derive(Serialize, Clone)]
pub struct SearchResult {
    /// "ok" | "disconnected" | "offline"
    pub status: String,
    pub tracks: Vec<QueueTrack>,
}

/// Free-text track search for the palette. Ok + empty list = a real "no
/// hits" answer.
#[tauri::command]
pub async fn spotify_search(app: AppHandle, query: String, limit: Option<u32>) -> SearchResult {
    tauri::async_runtime::spawn_blocking(move || {
        let limit = limit.unwrap_or(8).clamp(1, 20);
        match search_tracks(&app, &query, limit) {
            Ok(tracks) => SearchResult { status: "ok".into(), tracks },
            Err(e) => SearchResult { status: e.into(), tracks: Vec::new() },
        }
    })
    .await
    .unwrap_or_else(|e| {
        eprintln!("spotify search task panicked: {e}");
        SearchResult { status: "offline".into(), tracks: Vec::new() }
    })
}
