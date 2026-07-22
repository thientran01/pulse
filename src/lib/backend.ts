/*
 * Thin backend seam: real Tauri IPC inside the app, a self-advancing mock in a
 * plain browser so the UI can be developed and verified with preview tooling.
 */
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  IN_TAURI,
  type HistoryEntry,
  type NowPlaying,
  type PresenceDebug,
  type PresenceState,
  type QueueTrack,
  type SearchResult,
  type SpotifyDevice,
  type SpotifyStatus,
} from "../types";
import * as posClock from "./posClock";

const MOCK_DURATION = 204_000;

/** `?am` flips the browser mock from its ms-precise Spotify-like profile to
 * Apple Music's pathological one (docs/smtc-support-matrix.md): positions
 * floored to whole seconds on an irregular ~1s push cadence — a fresh pair
 * can project up to ~1s BEHIND the running clock, the flash-back ingredient —
 * plus a resume payload that re-sends the pause-era stamp, and can_seek=false.
 * posClock filter regressions reproduce in preview without a live player. */
const AM_PROFILE = !IN_TAURI && new URLSearchParams(window.location.search).has("am");

/** `?lyrics=<ms>` delays the mock lyric fetch (LRCLIB takes seconds live) and
 * `?lyrics=none` forces a served miss, `?lyrics=offline` a transport failure
 * (the honest "unavailable — offline" caption) — both for exercising the
 * expanded view's art ↔ lyrics arrival transition + caption states in
 * preview. */
const LYRICS_PARAM = IN_TAURI ? null : new URLSearchParams(window.location.search).get("lyrics");

/** `?nothing` forces the no-session state (player "none") so the resting
 * pulse is preview-iterable — live it appears whenever Apple Music stops
 * and deregisters its session. */
const NOTHING_PARAM = !IN_TAURI && new URLSearchParams(window.location.search).has("nothing");

/** The AM profile's hidden ms-precise timeline. Payloads only ever carry its
 * floor — the lost fraction is what makes pushes project backwards, so the
 * truth must live outside the payload (re-deriving it from a floored
 * position, like the Spotify-ish tick does, would advance in clean 1s steps
 * and never jitter). */
let amTruth = { pos: 63_400, at: Date.now() };
/** Irregular so floored positions carry varying fractions, fixed so a repro
 * replays the same way every run. */
const AM_PUSH_MS = [1000, 700, 1300, 900, 1100];

/** Small ring the mock's next/prev walk, so preview can exercise track-change
 * flows (lyrics refetch, the expanded view's reverse transition). */
const MOCK_TRACKS = [
  { title: "Savior", artist: "THE BOYZ", album: "THE BOYZ" },
  { title: "Instagram", artist: "DEAN", album: "Instagram - Single" },
  { title: "WHERE YOU AT?", artist: "STAYC", album: "2:LOVE - EP" },
];
let mockTrack = 0;

let mock: NowPlaying = {
  seq: 1,
  app_id: AM_PROFILE ? "Mock.AppleMusic" : "Mock.Player",
  player: AM_PROFILE ? "apple_music" : "spotify",
  ...MOCK_TRACKS[0],
  status: "playing",
  position_ms: 63_000,
  duration_ms: MOCK_DURATION,
  position_at_ms: Date.now(),
  can_seek: !AM_PROFILE,
  art_id: "mock-art",
};

function mockSkip(dir: 1 | -1): void {
  mockJumpTo((mockTrack + dir + MOCK_TRACKS.length) % MOCK_TRACKS.length);
}

/** Land on ring index `i`: history-finalize the outgoing track (like the
 * backend tracker), switch, and pop a matching up-next front (like the
 * backend feeder confirming its fed item played). */
function mockJumpTo(i: number): void {
  mockHistoryAppend(mockHistoryEntry(MOCK_TRACKS[mockTrack], Date.now() - 190_000, 190_000));
  mockTrack = i;
  const now = Date.now();
  amTruth = { pos: 0, at: now };
  pushMock({ ...MOCK_TRACKS[mockTrack], status: "playing", position_ms: 0, position_at_ms: now });
  const front = mockUpNext[0];
  if (front && front.title === MOCK_TRACKS[mockTrack].title) {
    mockUpNext.shift();
    mockUpNextListeners.forEach((cb) => cb([...mockUpNext]));
  }
}

// ---- play history (history.rs seam) ----

/** Chronological (append order, oldest first) — pages slice from the end,
 * mirroring the backend's JSONL + line index. */
const mockHistory: HistoryEntry[] = [];
const mockHistoryListeners = new Set<(e: HistoryEntry) => void>();

function mockHistoryEntry(
  t: { title: string; artist: string; album: string },
  startedAtMs: number,
  listenedMs: number,
): HistoryEntry {
  return {
    v: 1,
    key: `mock-${t.title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
    app_id: mock.app_id,
    player: mock.player,
    ...t,
    started_at_ms: startedAtMs,
    ended_at_ms: startedAtMs + listenedMs,
    ms_listened: listenedMs,
    duration_ms: MOCK_DURATION,
    // Same scheme as mockQueueTrack — history rows' play-now/+/drag are
    // uri-gated, and the mock's enrichment always "succeeded".
    spotify_uri: `spotify:track:mock-${t.title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
  };
}

function mockHistoryAppend(e: HistoryEntry): void {
  mockHistory.push(e);
  mockHistoryListeners.forEach((cb) => cb(e));
}

// Seed a scrollable backlog so the history UI is preview-iterable: ~40
// entries walking the ring backwards at a plausible listening cadence.
if (!IN_TAURI) {
  const now = Date.now();
  for (let i = 40; i >= 1; i--) {
    mockHistory.push(
      mockHistoryEntry(MOCK_TRACKS[i % MOCK_TRACKS.length], now - i * 4.2 * 60_000, 190_000),
    );
  }
  // A 4th distinct artist so the search empty state fills all FOUR history
  // picks (the 3-track ring alone yields 3) — the preview exercises the true
  // 7-row layout the window height is sized to.
  const fourth = { title: "Blue Hour", artist: "TXT", album: "minisode1 : Blue Hour" };
  for (let i = 8; i >= 1; i--) {
    mockHistory.push(mockHistoryEntry(fourth, now - (300 + i * 37) * 60_000, 190_000));
  }
  mockHistory.sort((a, b) => a.started_at_ms - b.started_at_ms);
}

// ---- Spotify Web API (spotify.rs seam) ----

/** `?spotify=off` forces the disconnected gate state in preview; the mock is
 * otherwise connected so the queue surface is iterable at plain `/`. */
const SPOTIFY_OFF =
  !IN_TAURI && new URLSearchParams(window.location.search).get("spotify") === "off";
/** `?similar=<status>` forces moreLikeThis to answer that status (no_data /
 * no_key / offline …) so every toast is preview-reachable. */
const SIMILAR_FORCE = IN_TAURI
  ? null
  : new URLSearchParams(window.location.search).get("similar");
/** `?discovery=<status>` forces discoveryPicks to answer that status
 * (no_key / no_data / offline / disconnected) so the search window's
 * "Something different" fallbacks are preview-reachable. */
const DISCOVERY_FORCE = IN_TAURI
  ? null
  : new URLSearchParams(window.location.search).get("discovery");

let mockSpotifyConnected = !SPOTIFY_OFF;
const mockSpotifyListeners = new Set<(s: SpotifyStatus) => void>();

function mockStatus(): SpotifyStatus {
  return { connected: mockSpotifyConnected };
}

function pushMockSpotify(connected: boolean): void {
  mockSpotifyConnected = connected;
  mockSpotifyListeners.forEach((cb) => cb(mockStatus()));
}

/** The search window was just summoned (search.rs show) — the webview
 * refocuses its input and recomputes the resurfacing rows. Mock: never fires
 * (a plain-browser search window is always "shown"). */
export function onSearchShown(cb: () => void): () => void {
  if (!IN_TAURI) return () => {};
  const un = listen("search-shown", () => cb());
  return () => {
    un.then((f) => f());
  };
}

/** Extra searchable fixtures beyond the ring so the mock search window has more
 * than three answers; their uris aren't in the ring, so playing one
 * exercises the "gone" failure path deliberately. */
const MOCK_SEARCH_EXTRAS = [
  { title: "Happy Ending", artist: "Kep1er", album: "LOVESTRUCK!" },
  { title: "About Love", artist: "Red Velvet", album: "Perfect Velvet" },
  { title: "Euphoria", artist: "keshi", album: "Requiem" },
  // Enough distinct fixtures that a pull-to-refresh surfaces NEW discovery
  // rows (the session-exclude filters the already-shown ones) instead of
  // dry-ing out after one pull.
  { title: "Drowning", artist: "WOODZ", album: "OO-LI" },
  { title: "Polaroid", artist: "LUCY", album: "Childhood" },
  { title: "Ditto", artist: "NewJeans", album: "OMG" },
  { title: "Antifragile", artist: "LE SSERAFIM", album: "ANTIFRAGILE" },
  { title: "Love Lee", artist: "AKMU", album: "Love Lee" },
];

function mockQueueTrack(t: { title: string; artist: string; album: string }) {
  return {
    uri: `spotify:track:mock-${t.title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
    ...t,
    duration_ms: MOCK_DURATION,
    art_url: mockArt(),
  };
}

const mockSpotifyJumpListeners = new Set<(t: { title: string; artist: string }) => void>();

/** A backend-initiated jump's target (the queue-aware skip) — App arms the
 * pill's announcement suppression with it, exactly like a frontend play-now. */
export function onSpotifyJump(cb: (t: { title: string; artist: string }) => void): () => void {
  if (IN_TAURI) {
    const un = listen<{ title: string; artist: string }>("spotify-jump", (e) => cb(e.payload));
    return () => {
      un.then((f) => f());
    };
  }
  mockSpotifyJumpListeners.add(cb);
  return () => {
    mockSpotifyJumpListeners.delete(cb);
  };
}

/** The backend jump fell back to a plain skip — the armed suppression must
 * clear so that legitimate track change announces. */
export function onSpotifyJumpCancel(cb: () => void): () => void {
  if (!IN_TAURI) return () => {}; // mock next never takes the fallback path
  const un = listen("spotify-jump-cancel", () => cb());
  return () => {
    un.then((f) => f());
  };
}

/** Connection state (OAuth tokens present) — seed + event pairing. */
export function onSpotifyStatus(cb: (s: SpotifyStatus) => void): () => void {
  if (IN_TAURI) {
    let gotEvent = false;
    const un = listen<SpotifyStatus>("spotify-status", (e) => {
      gotEvent = true;
      cb(e.payload);
    });
    void invoke<SpotifyStatus>("spotify_status").then((s) => {
      if (!gotEvent) cb(s);
    });
    return () => {
      un.then((f) => f());
    };
  }
  cb(mockStatus());
  mockSpotifyListeners.add(cb);
  return () => {
    mockSpotifyListeners.delete(cb);
  };
}

/** `?device=phone|speaker|tv|car|other` previews the "Playing on <device>" tag
 *  without a live phone; absent (or `?spotify=off`) → no tag (local). */
const DEVICE_MOCK: SpotifyDevice | null = (() => {
  if (IN_TAURI || SPOTIFY_OFF) return null;
  const raw = new URLSearchParams(window.location.search).get("device");
  if (!raw) return null;
  const names: Record<SpotifyDevice["kind"], string> = {
    phone: "Thien's iPhone",
    speaker: "Living Room",
    tv: "Living Room TV",
    car: "Thien's Car",
    other: "Spotify Connect",
  };
  const kind = (raw in names ? raw : "other") as SpotifyDevice["kind"];
  return { name: names[kind], kind };
})();

/** Which non-PC device Spotify is playing on (null = local / none / not
 *  connected) — seed + event pairing, same shape as onSpotifyStatus. The
 *  substrate for the "Playing on <device>" tag. */
export function onSpotifyDevice(cb: (d: SpotifyDevice | null) => void): () => void {
  if (IN_TAURI) {
    let gotEvent = false;
    const un = listen<SpotifyDevice | null>("spotify-device", (e) => {
      gotEvent = true;
      cb(e.payload);
    });
    void invoke<SpotifyDevice | null>("spotify_device").then((d) => {
      if (!gotEvent) cb(d);
    });
    return () => {
      un.then((f) => f());
    };
  }
  cb(DEVICE_MOCK);
  return () => {};
}

// ---- Pulse-managed up-next (upnext.rs seam) ----

/** `?jump=partial` forces playNow to report a failed re-queue in preview. */
const JUMP_PARTIAL =
  !IN_TAURI && new URLSearchParams(window.location.search).get("jump") === "partial";

/** The mock's Pulse-managed list — seeded with two upcoming ring tracks so
 * the queue surface has rows at plain `/`. */
const mockUpNext: QueueTrack[] = !IN_TAURI
  ? [mockQueueTrack(MOCK_TRACKS[1]), mockQueueTrack(MOCK_TRACKS[2])]
  : [];
const mockUpNextListeners = new Set<(list: QueueTrack[]) => void>();

function mockUpNextChanged(): void {
  mockUpNextListeners.forEach((cb) => cb([...mockUpNext]));
}

/** The managed list — seed via commands.upnextList, then live updates. */
export function onUpNextChanged(cb: (list: QueueTrack[]) => void): () => void {
  if (IN_TAURI) {
    const un = listen<QueueTrack[]>("upnext-changed", (e) => cb(e.payload));
    return () => {
      un.then((f) => f());
    };
  }
  mockUpNextListeners.add(cb);
  return () => {
    mockUpNextListeners.delete(cb);
  };
}

/** Fires when play history is wiped (prefs Data → Clear play history). The
 * queue's Earlier feed resets on it (useHistoryFeed — entries, paging
 * latches, and the module thumb/uri caches); Search doesn't subscribe — it
 * recomputes its resurfacing rows on every summon. Mock: never fires. */
export function onHistoryCleared(cb: () => void): () => void {
  if (!IN_TAURI) return () => {};
  const un = listen("history-cleared", () => cb());
  return () => {
    un.then((f) => f());
  };
}

/** Fires once per finalized listen (a track change past the listen floor). */
export function onHistoryAppended(cb: (e: HistoryEntry) => void): () => void {
  if (IN_TAURI) {
    const un = listen<HistoryEntry>("history-appended", (e) => cb(e.payload));
    return () => {
      un.then((f) => f());
    };
  }
  mockHistoryListeners.add(cb);
  return () => {
    mockHistoryListeners.delete(cb);
  };
}

// Preview affordance: drive a track change from views without a next button
// (the pill — where the track-change announcement lives) via the console.
if (!IN_TAURI) {
  (window as unknown as { __mockNext?: () => void }).__mockNext = () => mockSkip(1);
}

// Preview affordance: an in-song dropout — zero bands for `ms` while status
// stays "playing" (the process-loopback packet gap the Waveform's playing
// grace exists for; the real trigger only exists in the installed app).
let mockSilenceUntil = 0;
if (!IN_TAURI) {
  (window as unknown as { __mockSilence?: (ms: number) => void }).__mockSilence = (ms) => {
    mockSilenceUntil = Date.now() + ms;
  };
}

/** Mutate the mock payload, advancing the seq stamp like the backend does. */
function pushMock(patch: Partial<NowPlaying>): void {
  mock = { ...mock, ...patch, seq: mock.seq + 1 };
}

/** Deterministic fake album cover so preview exercises art + accent extraction. */
function mockArt(): string {
  const c = document.createElement("canvas");
  c.width = 144;
  c.height = 144;
  const ctx = c.getContext("2d")!;
  const g = ctx.createLinearGradient(0, 0, 144, 144);
  g.addColorStop(0, "#0f3d8a");
  g.addColorStop(0.6, "#2f6fd0");
  g.addColorStop(1, "#0a1f44");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 144, 144);
  ctx.fillStyle = "#e8b23c";
  ctx.beginPath();
  ctx.arc(100, 44, 26, 0, Math.PI * 2);
  ctx.fill();
  return c.toDataURL("image/png");
}

/** A seek HOTKEY fired (lib.rs emits the direction only) — the SeekButton
 * runs the same one-revolution spin a click gets, so both entry points speak
 * one feedback language. Mock: never fires (the browser has no global
 * hotkeys; IconLab demos the spin). */
export function onSeekNudge(cb: (dir: -1 | 1) => void): () => void {
  if (!IN_TAURI) return () => {};
  const un = listen<-1 | 1>("seek-nudge", (e) => cb(e.payload));
  return () => {
    un.then((f) => f());
  };
}

export function onNowPlaying(cb: (np: NowPlaying) => void): () => void {
  if (IN_TAURI) {
    /** While playing, the backend emits at least every heartbeat (position
     * pairs defeat its diff-suppression) — so "last payload said playing AND
     * nothing for 15s" is the signature of a dead event stream, not idleness.
     * The 2026-07-15 freeze (media loop wedged in a WinRT call) sat exactly
     * there, and the frontend trusted the stream's liveness forever. */
    const STALE_RESEED_MS = 15_000;
    let gotEvent = false;
    let lastPayloadAt = Date.now();
    let lastStatus = "";
    const deliver = (np: NowPlaying) => {
      lastPayloadAt = Date.now();
      lastStatus = np.status;
      cb(np);
    };
    const un = listen<NowPlaying>("now-playing", (e) => {
      gotEvent = true;
      deliver(e.payload);
    });
    // Emits are diff-suppressed backend-side, so a fresh webview (mount, dev
    // reload) seeds itself instead of waiting for the next change. An event
    // that lands first wins — it is always at least as new as the seed.
    void invoke<NowPlaying>("now_playing")
      .then((np) => {
        if (!gotEvent) deliver(np);
      })
      .catch(() => {});
    // Staleness net: re-seed from a live backend read. Attempts are paced at
    // STALE_RESEED_MS regardless of outcome (a failure must not retry at the
    // interval's 5s), at most one invoke is in flight (a hung backend gets
    // ONE stuck promise, never a stack), and a hidden window never re-seeds
    // (the backend deliberately emits nothing while hidden — silence there is
    // policy, not staleness; WebView2 mirrors window visibility into
    // document.hidden). posClock's seq gate drops a response that is
    // genuinely a stale straggler.
    let reseedInflight = false;
    let lastAttemptAt = 0;
    const reseed = window.setInterval(() => {
      if (reseedInflight || lastStatus !== "playing" || document.hidden) return;
      const now = Date.now();
      if (now - lastPayloadAt < STALE_RESEED_MS || now - lastAttemptAt < STALE_RESEED_MS) return;
      lastAttemptAt = now;
      reseedInflight = true;
      console.warn("now-playing stream stale while playing — re-seeding");
      void invoke<NowPlaying>("now_playing")
        .then(deliver)
        .catch(() => {})
        .finally(() => {
          reseedInflight = false;
        });
    }, 5_000);
    return () => {
      window.clearInterval(reseed);
      un.then((f) => f());
    };
  }
  if (NOTHING_PARAM) {
    cb({
      ...mock,
      player: "none",
      status: "none",
      title: "",
      artist: "",
      album: "",
      art_id: null,
    });
    return () => {};
  }
  if (AM_PROFILE) {
    let i = 0;
    let timer = 0;
    const push = () => {
      if (mock.status === "playing") {
        const now = Date.now();
        amTruth = { pos: (amTruth.pos + (now - amTruth.at)) % MOCK_DURATION, at: now };
        pushMock({ position_ms: Math.floor(amTruth.pos / 1000) * 1000, position_at_ms: now });
      }
      cb(mock);
      timer = window.setTimeout(push, AM_PUSH_MS[i++ % AM_PUSH_MS.length]);
    };
    push();
    return () => window.clearTimeout(timer);
  }
  const tick = () => {
    if (mock.status === "playing") {
      const now = Date.now();
      pushMock({
        position_ms: (mock.position_ms + (now - mock.position_at_ms)) % MOCK_DURATION,
        position_at_ms: now,
      });
    }
    cb(mock);
  };
  tick();
  const id = window.setInterval(tick, 500);
  return () => window.clearInterval(id);
}

/** Work-area corner the window is docked to — dock.rs owns the derivation
 * (drag-release snap, launch, tray reset) and pushes changes; ModeContent
 * anchors the fixed content plane to it so resizes reveal instead of drag. */
export type DockCorner = "top-left" | "top-right" | "bottom-left" | "bottom-right";

export function onDockCorner(cb: (corner: DockCorner) => void): () => void {
  if (!IN_TAURI) return () => {}; // mock frame always docks bottom-right
  let gotEvent = false;
  const un = listen<DockCorner>("dock-corner", (e) => {
    gotEvent = true;
    cb(e.payload);
  });
  // Seed like onNowPlaying: the mount-time set_window_size emit can land
  // before the listener registration completes, so read once after
  // subscribing; an event that beat the seed wins (always at least as new).
  void invoke<DockCorner | null>("dock_corner").then((c) => {
    if (c && !gotEvent) cb(c);
  });
  return () => {
    un.then((f) => f());
  };
}

/** Fires when the window goes click-through (the cursor left the interactive
 * footprint — dock.rs hit watcher): WS_EX_TRANSPARENT stops all mouse
 * messages, so the webview never receives that exit's mouseleave. Hover
 * state must be JS-owned and dropped on this signal — CSS :hover would
 * freeze true. */
export function onCursorLeft(cb: () => void): () => void {
  if (!IN_TAURI) return () => {}; // mock: real mouseleave always fires
  const un = listen("cursor-left", () => cb());
  return () => {
    un.then((f) => f());
  };
}

/** `?fs` seeds the browser mock's presence state (fullscreen ⇒ concealed,
 * mirroring the real engine) so the conceal-driven UI reactions and the dev
 * overlay are preview-iterable without a live fullscreen app. */
const MOCK_PRESENCE: PresenceState = !IN_TAURI
  ? {
      fullscreen: new URLSearchParams(window.location.search).has("fs"),
      concealed: new URLSearchParams(window.location.search).has("fs"),
    }
  : { fullscreen: false, concealed: false };

/** Settled presence states (presence.rs) — diff-suppressed, ~1s cadence. */
export function onPresence(cb: (p: PresenceState) => void): () => void {
  if (IN_TAURI) {
    let gotEvent = false;
    const un = listen<PresenceState>("presence", (e) => {
      gotEvent = true;
      cb(e.payload);
    });
    // Seed like onNowPlaying: emits are diff-suppressed, so a fresh webview
    // reads the last settled state once; an event that lands first wins.
    void invoke<PresenceState>("presence_state").then((p) => {
      if (!gotEvent) cb(p);
    });
    return () => {
      un.then((f) => f());
    };
  }
  cb(MOCK_PRESENCE);
  return () => {};
}

/** Raw presence signals — flows only while some consumer (the dev overlay)
 * is subscribed: subscription votes the backend's debug flag on, unsubscribe
 * votes it back off. */
export function onPresenceDebug(cb: (d: PresenceDebug) => void): () => void {
  if (IN_TAURI) {
    const un = listen<PresenceDebug>("presence-debug", (e) => cb(e.payload));
    void invoke("set_presence_debug", { enabled: true });
    return () => {
      void invoke("set_presence_debug", { enabled: false });
      un.then((f) => f());
    };
  }
  // Mock: a synthetic tick mirroring MOCK_PRESENCE so the overlay renders.
  const id = window.setInterval(() => {
    cb({
      fg_exe: "mock.exe",
      fg_class: "MockWindow",
      fg_pid: 0,
      rect_verdict: MOCK_PRESENCE.fullscreen ? "fullscreen" : "windowed",
      on_widget_monitor: true,
      quns: 5,
      quns_name: "ACCEPTS_NOTIFICATIONS",
      fs_raw: MOCK_PRESENCE.fullscreen,
      fs_settled: MOCK_PRESENCE.fullscreen,
    });
  }, 1000);
  return () => window.clearInterval(id);
}

export const SPECTRUM_BINS = 16;

export interface AudioBands {
  bass: number;
  mid: number;
  high: number;
  level: number;
  /** SPECTRUM_BINS log-spaced bins bass→high, 0..1, smoothed like the bands. */
  spectrum: number[];
}

/** ~30Hz band energies while music plays; zeroed on stop/hide. */
export function onAudioBands(cb: (b: AudioBands) => void): () => void {
  if (IN_TAURI) {
    const un = listen<AudioBands>("audio-bands", (e) => cb(e.payload));
    return () => {
      un.then((f) => f());
    };
  }
  // Mock: musical-ish motion so preview exercises the reactive layer.
  const id = window.setInterval(() => {
    if (mock.status !== "playing" || Date.now() < mockSilenceUntil) {
      cb({ bass: 0, mid: 0, high: 0, level: 0, spectrum: new Array<number>(SPECTRUM_BINS).fill(0) });
      return;
    }
    const t = Date.now() / 1000;
    const beat = Math.max(0, Math.sin(t * Math.PI * 2 * 1.9)) ** 3; // ~114bpm kick
    const bass = 0.25 + beat * 0.75;
    const mid = 0.35 + 0.3 * Math.sin(t * 2.7) ** 2;
    const high = 0.25 + 0.35 * Math.sin(t * 8.1) ** 2;
    // Bins lerp bass→mid→high by position, with per-bin phase/rate offsets so
    // the bars variant visibly moves independently in browser preview.
    const spectrum = Array.from({ length: SPECTRUM_BINS }, (_, i) => {
      const p = i / (SPECTRUM_BINS - 1);
      const base = p < 0.5 ? bass + (mid - bass) * p * 2 : mid + (high - mid) * (p - 0.5) * 2;
      const wobble = 0.6 + 0.4 * Math.sin(t * (3 + i * 0.7) + i * 1.3) ** 2;
      return Math.min(1, base * wobble);
    });
    cb({ bass, mid, high, level: bass * 0.5 + mid * 0.35 + high * 0.15, spectrum });
  }, 33);
  return () => window.clearInterval(id);
}

// ---- Preferences window (prefs.rs seam) ----

/** One resolved global-hotkey row (lib.rs HotkeyInfo). `registered` is the OS
 * truth — false means the chord was rejected (usually system-reserved), which
 * the Hotkeys UI surfaces as a persistent note. `chord` is a Tauri accelerator
 * string ("ctrl+alt+k", "ctrl+alt+left"). */
export interface HotkeyInfo {
  id: string;
  label: string;
  chord: string;
  registered: boolean;
}

/** The prefs window's mount snapshot (prefs.rs PrefsSeed). */
export interface PrefsSeed {
  version: string;
  reactive_separator: boolean;
  launch_mode: string;
  start_at_login: boolean;
  hide_on_fullscreen: boolean;
  spotify_connected: boolean;
  lastfm_api_key: string;
  seen_intro: boolean;
  hotkeys: HotkeyInfo[];
}

/** Real hotkey defaults (mirrors lib.rs HK_* + hotkey_defs order). The mock
 * marks the two seek chords unregistered so the OS-fail note is preview-
 * reachable at /?window=prefs (Ctrl+Alt+←/→ is the real-world motivator). */
const MOCK_HOTKEYS: HotkeyInfo[] = [
  { id: "playpause", label: "Play / pause", chord: "ctrl+alt+k", registered: true },
  { id: "seekback", label: "Seek backward", chord: "ctrl+alt+left", registered: false },
  { id: "seekfwd", label: "Seek forward", chord: "ctrl+alt+right", registered: false },
  { id: "next", label: "Next track", chord: "ctrl+alt+n", registered: true },
  { id: "prev", label: "Previous track", chord: "ctrl+alt+p", registered: true },
  { id: "showhide", label: "Show / hide Palette", chord: "ctrl+alt+m", registered: true },
  { id: "search", label: "Summon search", chord: "ctrl+alt+s", registered: true },
];

/** Mutable browser-mock settings state so the prefs UI's toggles/segments and
 * rebinds reflect back at /?window=prefs (no Tauri backend). */
const mockSettings = {
  version: "0.7.1",
  reactive_separator: true,
  launch_mode: "card",
  start_at_login: false,
  hide_on_fullscreen: true,
  // Non-empty so the search window's discovery section + the queue's
  // more-like-this button are previewable by default; ?discovery=<status>
  // and ?similar=<status> still force each fallback.
  lastfm_api_key: "mock-lastfm-key",
  seen_intro: false,
  hotkeys: MOCK_HOTKEYS.map((h) => ({ ...h })),
};

const mockHotkeysListeners = new Set<(h: HotkeyInfo[]) => void>();

/** Live hotkey-table updates after a rebind/reset (lib.rs "hotkeys-changed"). */
export function onHotkeysChanged(cb: (h: HotkeyInfo[]) => void): () => void {
  if (IN_TAURI) {
    const un = listen<HotkeyInfo[]>("hotkeys-changed", (e) => cb(e.payload));
    return () => {
      un.then((f) => f());
    };
  }
  mockHotkeysListeners.add(cb);
  return () => {
    mockHotkeysListeners.delete(cb);
  };
}

/** A setting changed from another surface (tray ⇄ prefs mirror). */
export function onSettingsChanged(
  cb: (change: { key: string; value: unknown }) => void,
): () => void {
  if (!IN_TAURI) return () => {}; // mock: single surface, nothing to mirror
  const un = listen<{ key: string; value: unknown }>("settings-changed", (e) => cb(e.payload));
  return () => {
    un.then((f) => f());
  };
}

/** In-app OAuth failure (spotify.rs) — shown in Connectors / at a gate point. */
export function onSpotifyAuthError(cb: (message: string) => void): () => void {
  if (!IN_TAURI) return () => {};
  const un = listen<{ message: string }>("spotify-auth-error", (e) => cb(e.payload.message));
  return () => {
    un.then((f) => f());
  };
}

/** Nudge to a section when prefs is already open (tray "Shortcuts / Help"). */
export function onPrefsSection(cb: (section: string) => void): () => void {
  if (!IN_TAURI) return () => {};
  const un = listen<string>("prefs-section", (e) => cb(e.payload));
  return () => {
    un.then((f) => f());
  };
}

export const commands = {
  /** Tell the backend whether reactive visuals are wanted (false under
   * reduced motion) — it stops audio capture entirely when not. */
  setReactiveEnabled(enabled: boolean): void {
    if (IN_TAURI) void invoke("set_reactive_enabled", { enabled });
  },
  /** Native window drag — call from mousedown on any non-interactive surface.
   * Routed through Rust so a queued corner-snap animation dies first. */
  startDrag(): void {
    if (IN_TAURI) void invoke("start_drag");
  },
  /** Dock the native window at a logical size (one corner-pinned
   * SetWindowPos — Rust owns all positioning, see src-tauri/src/dock.rs).
   * Called ONCE at launch with WINDOW_MAX; the window never resizes after
   * that — mode changes are the shell's CSS glide. `mode*` is
   * MODE_SIZES[launch mode]: the restored rect is the WINDOW's, and Rust
   * needs the widget's own box to find it inside that rect. */
  setWindowSize(width: number, height: number, modeWidth: number, modeHeight: number): void {
    if (IN_TAURI)
      void invoke("set_window_size", {
        width,
        height,
        modeWidth,
        modeHeight,
      });
  },
  /** Report both corner-anchored boxes (logical px). `width`/`height` is the
   * INTERACTIVE footprint — the Rust cursor watcher makes everything outside
   * it click-through, so it unions the queue popover and any transient
   * overlay. `mode*` is the mode's own MODE_SIZES box, which is what
   * PLACEMENT uses: compensating a dock-corner flip with the popover union
   * would move the window by a distance the shell never travels. */
  setHitSize(width: number, height: number, modeWidth: number, modeHeight: number): void {
    if (IN_TAURI)
      void invoke("set_hit_size", { width, height, modeWidth, modeHeight });
  },
  /** Hide the widget (the right-click menu's "Hide Palette") — a dedicated
   * hide through the intent path, not a toggle. */
  hideWidget(): void {
    if (IN_TAURI) void invoke("hide_widget");
  },
  /** Quit the app (the right-click menu's "Quit Palette"). */
  quitApp(): void {
    if (IN_TAURI) void invoke("quit_app");
  },
  playPause(): void {
    if (IN_TAURI) {
      void invoke("media_play_pause");
    } else if (AM_PROFILE) {
      const now = Date.now();
      if (mock.status === "playing") {
        // Pause: freeze the hidden truth; AM's frozen-timeline push reports
        // the floor with a fresh stamp. Wrap like the playing tick does — a
        // clamp here pins a near-boundary pause at exactly track-end until the
        // next tick's % corrects it.
        amTruth = { pos: (amTruth.pos + (now - amTruth.at)) % MOCK_DURATION, at: now };
        pushMock({
          status: "paused",
          position_ms: Math.floor(amTruth.pos / 1000) * 1000,
          position_at_ms: now,
        });
      } else {
        // Resume: AM's first playing payload re-sends the PAUSE-ERA pair
        // untouched — the exact payload posClock must refuse to
        // staleness-project (doing so would leap the clock forward by the
        // pause length, then snap back on the next fresh push).
        amTruth = { ...amTruth, at: now };
        pushMock({ status: "playing" });
      }
    } else {
      // Advance the position before re-stamping, like a real player freezing
      // its timeline at the pause point — a fresh stamp on a stale position
      // is exactly the regression profile the posClock filters, and the mock
      // must not fabricate it.
      const now = Date.now();
      const advanced =
        mock.status === "playing"
          ? Math.min(mock.position_ms + (now - mock.position_at_ms), mock.duration_ms)
          : mock.position_ms;
      pushMock({
        status: mock.status === "playing" ? "paused" : "playing",
        position_ms: advanced,
        position_at_ms: now,
      });
    }
  },
  next(): void {
    if (IN_TAURI) {
      void invoke("media_next");
      return;
    }
    // Queue-aware like the backend (upnext::try_queue_skip): with a
    // connected session and a queued front that maps to a ring track, next
    // lands ON it (mockJumpTo pops the matching front) instead of walking
    // the ring — so the preview mirrors the real skip semantics.
    const front = mockUpNext[0];
    const ringIdx = front
      ? MOCK_TRACKS.findIndex((t) => mockQueueTrack(t).uri === front.uri)
      : -1;
    if (mockSpotifyConnected && ringIdx !== -1) {
      mockSpotifyJumpListeners.forEach((cb) => cb({ title: front.title, artist: front.artist }));
      mockJumpTo(ringIdx);
    } else {
      mockSkip(1);
    }
  },
  prev(): void {
    if (IN_TAURI) void invoke("media_prev");
    else mockSkip(-1);
  },
  // Both seeks rebase the posClock optimistically FIRST (the UI lands on the
  // target immediately; the kernel's grace window absorbs pre-seek
  // stragglers), then send the command. seekTo returns null when the player
  // can't seek (Apple Music) — no command, no optimistic lie. Relative seeks
  // anchor on the display clock itself and go out absolute, so the player
  // lands exactly where the UI already is.
  seekRel(deltaMs: number): void {
    commands.seekAbs(posClock.now() + deltaMs);
  },
  seekAbs(positionMs: number): void {
    const target = posClock.seekTo(positionMs);
    if (target === null) return;
    if (IN_TAURI) {
      void invoke("media_seek_abs", { positionMs: Math.round(target) });
    } else {
      pushMock({ position_ms: Math.round(target), position_at_ms: Date.now() });
    }
  },
  async art(artId: string): Promise<string | null> {
    if (!IN_TAURI) return artId === "mock-art" ? mockArt() : null;
    return invoke<string | null>("media_art", { artId });
  },
  /** Start the Spotify OAuth consent flow (PKCE, system browser). Progress
   * narrates on the tray label; the "spotify-status" event lands on success. */
  spotifyConnect(): void {
    if (IN_TAURI) void invoke("spotify_connect");
    else pushMockSpotify(true);
  },
  spotifyDisconnect(): void {
    if (IN_TAURI) void invoke("spotify_disconnect");
    else pushMockSpotify(false);
  },
  /** Pulse-managed up-next list (seed; "upnext-changed" is the live half). */
  async upnextList(): Promise<QueueTrack[]> {
    if (!IN_TAURI) return [...mockUpNext];
    return invoke<QueueTrack[]>("upnext_list");
  },
  upnextAdd(item: QueueTrack, at?: number): void {
    if (IN_TAURI) {
      void invoke("upnext_add", { item, at: at ?? null });
    } else {
      mockUpNext.splice(Math.min(at ?? mockUpNext.length, mockUpNext.length), 0, item);
      mockUpNextChanged();
    }
  },
  upnextRemove(uri: string): void {
    if (IN_TAURI) {
      void invoke("upnext_remove", { uri });
    } else {
      const i = mockUpNext.findIndex((t) => t.uri === uri);
      if (i !== -1) mockUpNext.splice(i, 1);
      mockUpNextChanged();
    }
  },
  upnextMove(from: number, to: number): void {
    if (IN_TAURI) {
      void invoke("upnext_move", { from, to });
    } else if (from < mockUpNext.length && to < mockUpNext.length && from !== to) {
      const [item] = mockUpNext.splice(from, 1);
      mockUpNext.splice(to, 0, item);
      mockUpNextChanged();
    }
  },
  /** Context-preserving jump (spotify.rs play_now); from silence it starts
   * playback outright. Statuses: ok | busy | no_device | gone | diverged |
   * partial | disconnected | offline. The caller owns announcement
   * suppression around this (backend also arms every realm via
   * "spotify-jump"). */
  async playNow(uri: string): Promise<string> {
    if (!IN_TAURI) {
      if (!mockSpotifyConnected) return "disconnected";
      const i = MOCK_TRACKS.findIndex((t) => mockQueueTrack(t).uri === uri);
      if (i === -1) return "gone";
      // Rotate the ring straight to the target — one announcement, like the
      // real jump after suppression.
      mockJumpTo(i);
      return JUMP_PARTIAL ? "partial" : "ok";
    }
    return invoke<string>("spotify_play_now", { uri });
  },
  /** Newest-first history page; `before` = the oldest loaded entry's
   * started_at_ms for infinite scroll, null seeds from the newest. */
  async historyPage(before: number | null, limit: number): Promise<HistoryEntry[]> {
    if (!IN_TAURI) {
      let end = mockHistory.length;
      if (before !== null) {
        const i = mockHistory.findIndex((e) => e.started_at_ms >= before);
        if (i !== -1) end = i;
      }
      return mockHistory.slice(Math.max(0, end - limit), end).reverse();
    }
    return invoke<HistoryEntry[]>("history_page", { beforeStartedAtMs: before, limit });
  },
  /** Push a downscaled cover into the thumb cache — once per art revision
   * (App's useHistoryThumb owns the gating). */
  historyThumb(key: string, dataUrl: string): void {
    if (IN_TAURI) void invoke("history_thumb", { key, dataUrl });
  },
  /** Thumb for an identity key, or null when never captured / evicted. */
  async historyThumbUrl(key: string): Promise<string | null> {
    if (!IN_TAURI) return mockHistory.some((e) => e.key === key) ? mockArt() : null;
    return invoke<string | null>("history_thumb_url", { key });
  },
  async lyrics(
    artist: string,
    title: string,
    album: string,
    durationMs: number,
  ): Promise<Lyrics> {
    if (!IN_TAURI) {
      const numericParam =
        LYRICS_PARAM && LYRICS_PARAM !== "none" && LYRICS_PARAM !== "offline";
      const delayMs = numericParam ? Number(LYRICS_PARAM) || 0 : 0;
      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
      if (LYRICS_PARAM === "none") return LYRICS_MISS;
      if (LYRICS_PARAM === "offline") return LYRICS_OFFLINE;
      // Mock: verses on a 4s cadence with real instrumental gaps, so preview
      // exercises karaoke AND every break-synthesis path (parseLrc): a 12s
      // intro, a marker-pinned break (the empty stamp at 64s — the mock's
      // start position of 63s sits right on its doorstep), an UN-marked
      // 100→124s gap (the estimated-hold path), and a marker-pinned outro.
      const stamp = (s: number) =>
        `[${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}.00]`;
      const lines: string[] = [];
      let n = 0;
      const verse = (from: number, to: number) => {
        for (let s = from; s <= to; s += 4) {
          lines.push(`${stamp(s)}Mock lyric line ${++n} — la la la (${title})`);
        }
      };
      verse(12, 60);
      lines.push(`${stamp(64)} `); // vocal-end marker → break 64s→84s
      verse(84, 100);
      verse(124, 156); // the un-marked gap before this verse estimates its hold
      lines.push(`${stamp(160)} `); // vocal-end marker → outro to durationMs
      return { synced: lines.join("\n"), plain: null };
    }
    return lyricsLatestWins(() => invoke("media_lyrics", { artist, title, album, durationMs }));
  },
  /** Free-text track search (spotify.rs search_tracks) — the search window's
   * result list. Debounce + latest-wins live with the caller. */
  async spotifySearch(query: string, limit = 8): Promise<SearchResult> {
    if (!IN_TAURI) {
      if (!mockSpotifyConnected) return { status: "disconnected", tracks: [] };
      const q = query.trim().toLowerCase();
      const pool = [...MOCK_TRACKS, ...MOCK_SEARCH_EXTRAS];
      const tracks = pool
        .filter(
          (t) => t.title.toLowerCase().includes(q) || t.artist.toLowerCase().includes(q),
        )
        .slice(0, limit)
        .map(mockQueueTrack);
      // A breath of latency so the searching state is preview-visible.
      await new Promise((r) => setTimeout(r, 180));
      return { status: "ok", tracks };
    }
    return invoke<SearchResult>("spotify_search", { query, limit });
  },
  /** Dismiss the search window (Esc / background click / post-play). */
  searchHide(): void {
    if (IN_TAURI) void invoke("search_hide");
  },
  /** Open the fullscreen focus takeover (focus.rs — creates the window,
   * hides the widget via VisIntent). Mock: no window system — no-op; the
   * focus UI itself is iterable at /?window=focus. */
  focusOpen(): void {
    if (IN_TAURI) void invoke("focus_open");
  },
  /** Close the takeover (Esc / collapse). Destroy-on-close; the Destroyed
   * handler restores the widget to its exact prior intent. */
  focusClose(): void {
    if (IN_TAURI) void invoke("focus_close");
  },
  /** Fill up-next with Last.fm-similar tracks for the current track
   * (similar.rs). Statuses: ok:<n> | no_matches | no_data | no_key | busy |
   * disconnected | offline. Rows land incrementally via "upnext-changed". */
  async moreLikeThis(title: string, artist: string): Promise<string> {
    if (!IN_TAURI) {
      void title;
      void artist;
      if (!mockSpotifyConnected) return "disconnected";
      if (SIMILAR_FORCE) return SIMILAR_FORCE;
      // Ring tracks not already queued arrive one at a time, mirroring the
      // backend's per-add emits (the arrival-flash choreography's driver).
      const current = mockQueueTrack(MOCK_TRACKS[mockTrack]).uri;
      const candidates = MOCK_TRACKS.map(mockQueueTrack).filter(
        (t) => t.uri !== current && !mockUpNext.some((q) => q.uri === t.uri),
      );
      candidates.forEach((t, i) => {
        window.setTimeout(() => {
          // Push-time dedupe, like the backend's per-add uris re-read.
          if (mockUpNext.some((q) => q.uri === t.uri)) return;
          mockUpNext.push(t);
          mockUpNextChanged();
        }, 300 * (i + 1));
      });
      await new Promise((r) => setTimeout(r, 300 * candidates.length + 150));
      return candidates.length ? `ok:${candidates.length}` : "no_data";
    }
    return invoke<string>("more_like_this", { title, artist });
  },
  /** Resolve Last.fm-similar tracks for the given played seeds, minus the
   * `exclude` set (normalized `artist(U+0001)title` keys of the history pool) —
   * the search window's "Something different" rows. Unlike moreLikeThis this
   * RETURNS the picks (never queues). Statuses: ok | no_key | bad_key |
   * disconnected | offline | no_data | busy. */
  async discoveryPicks(
    seeds: { title: string; artist: string }[],
    exclude: string[],
  ): Promise<{ status: string; picks: { seed_title: string; track: QueueTrack }[] }> {
    if (!IN_TAURI) {
      if (!mockSpotifyConnected) return { status: "disconnected", picks: [] };
      if (mockSettings.lastfm_api_key.trim().length === 0) return { status: "no_key", picks: [] };
      if (DISCOVERY_FORCE) return { status: DISCOVERY_FORCE, picks: [] };
      // Suggest from the search extras (deliberately NOT in the mock history
      // ring), minus anything the caller already excluded — the same
      // normalized key the backend/Search.tsx use.
      const norm = (artist: string, title: string) =>
        `${artist.trim().toLowerCase()}\u0001${title.trim().toLowerCase()}`;
      const ex = new Set(exclude);
      const seedTitle = seeds[0]?.title ?? "your library";
      const picks = MOCK_SEARCH_EXTRAS.filter((t) => !ex.has(norm(t.artist, t.title)))
        .slice(0, 3)
        .map((t) => ({ seed_title: seedTitle, track: mockQueueTrack(t) }));
      // A breath of latency so the progressive fill (history first, then
      // discovery below) is preview-visible.
      await new Promise((r) => setTimeout(r, 600));
      return { status: picks.length ? "ok" : "no_data", picks };
    }
    return invoke<{ status: string; picks: { seed_title: string; track: QueueTrack }[] }>(
      "discovery_picks",
      { seeds, exclude },
    );
  },
  /** Search-resolve a uri for a history row that was never enriched
   * (pre-enrichment entries, Apple Music listens). Null = no match. */
  async spotifyResolveUri(title: string, artist: string): Promise<string | null> {
    if (!IN_TAURI) {
      if (!mockSpotifyConnected) return null;
      // Ring tracks resolve to the mock scheme; anything else is a miss so
      // the "Couldn't find it on Spotify" toast is preview-exercisable.
      void artist;
      const hit = MOCK_TRACKS.some((t) => t.title === title);
      return hit ? `spotify:track:mock-${title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}` : null;
    }
    return invoke<string | null>("spotify_resolve_uri", { title, artist });
  },

  // ---- preferences window (prefs.rs) ----

  /** Open the prefs window (create-on-open) at an optional section. */
  openPrefs(section?: string): void {
    if (IN_TAURI) void invoke("open_prefs", { section: section ?? null });
  },
  /** Close (destroy) the prefs window — its own floating ×. */
  closePrefs(): void {
    if (IN_TAURI) void invoke("close_prefs");
  },
  /** The prefs mount snapshot. */
  async prefsSeed(): Promise<PrefsSeed> {
    if (!IN_TAURI) {
      return {
        version: mockSettings.version,
        reactive_separator: mockSettings.reactive_separator,
        launch_mode: mockSettings.launch_mode,
        start_at_login: mockSettings.start_at_login,
        hide_on_fullscreen: mockSettings.hide_on_fullscreen,
        spotify_connected: mockSpotifyConnected,
        lastfm_api_key: mockSettings.lastfm_api_key,
        seen_intro: mockSettings.seen_intro,
        hotkeys: mockSettings.hotkeys.map((h) => ({ ...h })),
      };
    }
    return invoke<PrefsSeed>("prefs_seed");
  },
  /** Persist an inert setting (reactive separator, launch mode, Last.fm key,
   * seenIntro). Side-effect settings use their own commands. */
  setSetting(key: string, value: unknown): void {
    if (IN_TAURI) {
      // set_setting now returns Result — it rejects a non-allow-listed key or an
      // oversized value (e.g. a >4KB paste into the Last.fm key field). Rust
      // already log::warn!s the reason; swallow here so a rejected persist never
      // surfaces as an "Uncaught (in promise)". First-party UI only sends the
      // four allow-listed keys, so this path is near-unreachable in practice.
      void invoke("set_setting", { key, value }).catch((e) => {
        console.warn(`set_setting rejected for ${key}:`, e);
      });
    } else {
      (mockSettings as Record<string, unknown>)[key] = value;
    }
  },
  /** Persist one hotkey override + re-register live. Returns the fresh table
   * (with per-row `registered` truth). */
  async rebindHotkey(id: string, chord: string): Promise<HotkeyInfo[]> {
    if (!IN_TAURI) {
      mockSettings.hotkeys = mockSettings.hotkeys.map((h) =>
        h.id === id ? { ...h, chord, registered: true } : h,
      );
      const snap = mockSettings.hotkeys.map((h) => ({ ...h }));
      mockHotkeysListeners.forEach((cb) => cb(snap));
      return snap;
    }
    return invoke<HotkeyInfo[]>("rebind_hotkey", { id, chord });
  },
  /** Suspend (true) / resume (false) the global shortcuts while the prefs
   * hotkey capture listens: registered chords are swallowed system-wide by
   * RegisterHotKey, so an un-suspended capture can never SEE a bound chord —
   * pressing one fired its action instead (Ctrl+Alt+S summoned Search over
   * the prefs window). Awaitable so capture starts only after the OS truly
   * released the chords; idempotent both directions. Mock: no OS registry —
   * every chord already reaches the page. */
  async setHotkeysCapture(active: boolean): Promise<void> {
    if (IN_TAURI) await invoke("set_hotkeys_capture", { active });
  },
  /** Clear all overrides + re-register defaults. Returns the fresh table. */
  async resetHotkeys(): Promise<HotkeyInfo[]> {
    if (!IN_TAURI) {
      mockSettings.hotkeys = MOCK_HOTKEYS.map((h) => ({ ...h }));
      const snap = mockSettings.hotkeys.map((h) => ({ ...h }));
      mockHotkeysListeners.forEach((cb) => cb(snap));
      return snap;
    }
    return invoke<HotkeyInfo[]>("reset_hotkeys");
  },
  /** Start at login — mirrors the tray. Returns the registry's actual state. */
  async setStartAtLogin(enabled: boolean): Promise<boolean> {
    if (!IN_TAURI) {
      mockSettings.start_at_login = enabled;
      return enabled;
    }
    return invoke<boolean>("set_start_at_login", { enabled });
  },
  /** Hide on fullscreen — mirrors the tray. */
  setHideOnFullscreen(enabled: boolean): void {
    if (IN_TAURI) {
      void invoke("set_hide_on_fullscreen", { enabled });
    } else {
      mockSettings.hide_on_fullscreen = enabled;
    }
  },
  /** Validate a Last.fm key against the service. "ok" | "invalid" | "offline". */
  async testLastfmKey(key: string): Promise<string> {
    if (!IN_TAURI) {
      await new Promise((r) => setTimeout(r, 500));
      return key.trim() ? "ok" : "invalid";
    }
    return invoke<string>("test_lastfm_key", { key });
  },
  /** Whether a Last.fm key is present (the reusable gate signal). */
  async lastfmHasKey(): Promise<boolean> {
    if (!IN_TAURI) return mockSettings.lastfm_api_key.trim().length > 0;
    return invoke<boolean>("lastfm_has_key");
  },
  /** Wipe play history + thumbnails. */
  async clearHistory(): Promise<boolean> {
    if (!IN_TAURI) {
      mockHistory.length = 0;
      return true;
    }
    return invoke<boolean>("clear_history");
  },
  /** Reveal the log dir in the OS file manager. */
  openLogs(): void {
    if (IN_TAURI) void invoke("open_logs");
  },
  /** Reveal the app-data folder. */
  openDataFolder(): void {
    if (IN_TAURI) void invoke("open_data_folder");
  },
  /** Open the source repo in the browser. */
  openRepo(): void {
    if (IN_TAURI) void invoke("open_repo");
    else window.open("https://github.com/thientran01/palette", "_blank", "noopener");
  },
  /** On-demand update check. "uptodate" | "dev" | "busy" | "failed" (an
   * installed update replaces the process and never returns). */
  async checkForUpdates(): Promise<string> {
    if (!IN_TAURI) {
      await new Promise((r) => setTimeout(r, 600));
      return "uptodate";
    }
    return invoke<string>("check_for_updates");
  },
  /** The connected Spotify account's display name (prefs "Connected as …"). */
  async spotifyDisplayName(): Promise<string | null> {
    if (!IN_TAURI) return mockSpotifyConnected ? "thien" : null;
    return invoke<string | null>("spotify_display_name");
  },
};

/** `offline` (lyrics.rs) distinguishes a transport failure from a served "no
 * lyrics" answer, so a caption can read "unavailable — offline" vs "No synced
 * lyrics". Optional/false everywhere except a genuine offline bail. */
type Lyrics = { synced: string | null; plain: string | null; offline?: boolean };
const LYRICS_MISS: Lyrics = { synced: null, plain: null };
const LYRICS_OFFLINE: Lyrics = { synced: null, plain: null, offline: true };

let lyricsGen = 0;

/**
 * Latest-wins lyric fetches. useLyrics fires one fetch per track change WITHOUT
 * awaiting the previous, so the newest track's fetch must NOT wait behind an
 * older, still-in-flight one. The prior "single-flight" gate serialized them,
 * which meant a slow fetch on the outgoing track blocked the incoming track's
 * fetch from even STARTING — the "next song sits ~10s before lyrics show up"
 * stall. Here every call invokes immediately; a fetch superseded by a newer one
 * resolves to a miss (its track key is already stale, so useLyrics' lastKey
 * guard drops it regardless). There is no hard concurrency cap: a fast scrub
 * through several uncached tracks can put a few fetches in flight at once, and
 * a quick A→B→A flip can even fetch A twice before its cache write lands. That
 * is acceptable here — fetches are human-paced and idempotent, and each track
 * short-circuits on the Rust-side disk cache / session-miss set next time — but
 * it is NOT the prior single-flight gate's hard "one in flight" guarantee.
 */
function lyricsLatestWins(start: () => Promise<Lyrics>): Promise<Lyrics> {
  const gen = ++lyricsGen;
  return start()
    .catch(() => LYRICS_MISS)
    .then((l) => (gen === lyricsGen ? l : LYRICS_MISS));
}
