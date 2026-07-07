/*
 * Thin backend seam: real Tauri IPC inside the app, a self-advancing mock in a
 * plain browser so the UI can be developed and verified with preview tooling.
 */
import { invoke } from "@tauri-apps/api/core";
import { LogicalSize, PhysicalPosition } from "@tauri-apps/api/dpi";
import { listen } from "@tauri-apps/api/event";
import { currentMonitor, getCurrentWindow } from "@tauri-apps/api/window";
import { IN_TAURI, type NowPlaying } from "../types";
import * as posClock from "./posClock";

const MOCK_DURATION = 204_000;
let mock: NowPlaying = {
  seq: 1,
  app_id: "Mock.Player",
  player: "spotify",
  title: "Savior",
  artist: "THE BOYZ",
  album: "THE BOYZ",
  status: "playing",
  position_ms: 63_000,
  duration_ms: MOCK_DURATION,
  position_at_ms: Date.now(),
  can_seek: true,
  art_id: "mock-art",
};

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
  /** Native window drag — call from mousedown on any non-interactive surface. */
  startDrag(): void {
    if (IN_TAURI) void getCurrentWindow().startDragging();
  },
  /**
   * Resize the native window to match the active size mode, then clamp the
   * position back into the monitor bounds — growing a window parked near the
   * bottom/right edge (or restored there by window-state) would otherwise
   * push it off-screen with no chrome to grab.
   */
  setWindowSize(width: number, height: number): void {
    if (!IN_TAURI) return;
    void (async () => {
      const win = getCurrentWindow();
      await win.setSize(new LogicalSize(width, height));
      const monitor = await currentMonitor();
      if (!monitor) return;
      const pos = await win.outerPosition();
      const size = await win.outerSize();
      const maxX = monitor.position.x + monitor.size.width - size.width;
      const maxY = monitor.position.y + monitor.size.height - size.height;
      const nx = Math.min(Math.max(pos.x, monitor.position.x), Math.max(maxX, monitor.position.x));
      const ny = Math.min(Math.max(pos.y, monitor.position.y), Math.max(maxY, monitor.position.y));
      if (nx !== pos.x || ny !== pos.y) {
        await win.setPosition(new PhysicalPosition(nx, ny));
      }
    })().catch((e) => console.error("setWindowSize failed:", e));
  },
  playPause(): void {
    if (IN_TAURI) {
      void invoke("media_play_pause");
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
  },
  prev(): void {
    if (IN_TAURI) void invoke("media_prev");
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
  ): Promise<{ synced: string | null; plain: string | null }> {
    if (!IN_TAURI) {
      // Mock: a line every 4s across the track so preview exercises karaoke.
      const lines = Array.from({ length: Math.floor(durationMs / 4000) }, (_, i) => {
        const t = i * 4;
        return `[${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}.00]Mock lyric line ${i + 1} — la la la`;
      });
      return { synced: lines.join("\n"), plain: null };
    }
    return invoke("media_lyrics", { artist, title, album, durationMs });
  },
};
