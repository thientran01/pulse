/*
 * Thin backend seam: real Tauri IPC inside the app, a self-advancing mock in a
 * plain browser so the UI can be developed and verified with preview tooling.
 */
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { IN_TAURI, type NowPlaying, type PresenceDebug, type PresenceState } from "../types";
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
 * `?lyrics=none` forces a miss — both for exercising the expanded view's
 * art ↔ lyrics arrival transition in preview. */
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
  mockTrack = (mockTrack + dir + MOCK_TRACKS.length) % MOCK_TRACKS.length;
  const now = Date.now();
  amTruth = { pos: 0, at: now };
  pushMock({ ...MOCK_TRACKS[mockTrack], status: "playing", position_ms: 0, position_at_ms: now });
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

export function onNowPlaying(cb: (np: NowPlaying) => void): () => void {
  if (IN_TAURI) {
    let gotEvent = false;
    const un = listen<NowPlaying>("now-playing", (e) => {
      gotEvent = true;
      cb(e.payload);
    });
    // Emits are diff-suppressed backend-side, so a fresh webview (mount, dev
    // reload) seeds itself instead of waiting for the next change. An event
    // that lands first wins — it is always at least as new as the seed.
    void invoke<NowPlaying>("now_playing").then((np) => {
      if (!gotEvent) cb(np);
    });
    return () => {
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

/** `?fs` / `?away` seed the browser mock's presence state so presence-driven
 * UI (P1+ behaviors, the dev overlay) is preview-iterable without a live
 * fullscreen app or a real idle wait. */
const MOCK_PRESENCE: PresenceState = !IN_TAURI
  ? {
      fullscreen: new URLSearchParams(window.location.search).has("fs"),
      user: new URLSearchParams(window.location.search).has("away") ? "away" : "active",
      concealed: false,
    }
  : { fullscreen: false, user: "active", concealed: false };

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
      idle_s: MOCK_PRESENCE.user === "away" ? 300 : 0,
      fs_raw: MOCK_PRESENCE.fullscreen,
      fs_settled: MOCK_PRESENCE.fullscreen,
      user: MOCK_PRESENCE.user,
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
    if (mock.status !== "playing") {
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
   * that — mode changes are the shell's CSS glide. */
  setWindowSize(width: number, height: number): void {
    if (IN_TAURI) void invoke("set_window_size", { width, height });
  },
  /** Report the current mode's interactive footprint (logical px, anchored
   * at the docked corner). The Rust cursor watcher makes everything outside
   * it click-through — the fixed-size window's gutter must not eat clicks
   * meant for what's beneath. */
  setHitSize(width: number, height: number): void {
    if (IN_TAURI) void invoke("set_hit_size", { width, height });
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
    if (IN_TAURI) void invoke("media_next");
    else mockSkip(1);
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
  async lyrics(
    artist: string,
    title: string,
    album: string,
    durationMs: number,
  ): Promise<Lyrics> {
    if (!IN_TAURI) {
      const delayMs = LYRICS_PARAM && LYRICS_PARAM !== "none" ? Number(LYRICS_PARAM) || 0 : 0;
      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
      if (LYRICS_PARAM === "none") return LYRICS_MISS;
      // Mock: a line every 4s across the track so preview exercises karaoke.
      const lines = Array.from({ length: Math.floor(durationMs / 4000) }, (_, i) => {
        const t = i * 4;
        return `[${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}.00]Mock lyric line ${i + 1} — la la la (${title})`;
      });
      return { synced: lines.join("\n"), plain: null };
    }
    return lyricsLatestWins(() => invoke("media_lyrics", { artist, title, album, durationMs }));
  },
};

type Lyrics = { synced: string | null; plain: string | null };
const LYRICS_MISS: Lyrics = { synced: null, plain: null };

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
