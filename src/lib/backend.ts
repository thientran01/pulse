/*
 * Thin backend seam: real Tauri IPC inside the app, a self-advancing mock in a
 * plain browser so the UI can be developed and verified with preview tooling.
 */
import { invoke } from "@tauri-apps/api/core";
import { LogicalSize, PhysicalPosition } from "@tauri-apps/api/dpi";
import { listen } from "@tauri-apps/api/event";
import { currentMonitor, getCurrentWindow } from "@tauri-apps/api/window";
import { IN_TAURI, type NowPlaying } from "../types";

const MOCK_DURATION = 204_000;
let mock: NowPlaying = {
  app_id: "Mock.Player",
  player: "spotify",
  title: "Savior",
  artist: "THE BOYZ",
  album: "THE BOYZ",
  status: "playing",
  position_ms: 63_000,
  duration_ms: MOCK_DURATION,
  emitted_at_ms: Date.now(),
  can_seek: true,
  art_id: "mock-art",
};

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
    const un = listen<NowPlaying>("now-playing", (e) => cb(e.payload));
    return () => {
      un.then((f) => f());
    };
  }
  const tick = () => {
    if (mock.status === "playing") {
      const now = Date.now();
      mock = {
        ...mock,
        position_ms: (mock.position_ms + (now - mock.emitted_at_ms)) % MOCK_DURATION,
        emitted_at_ms: now,
      };
    }
    cb(mock);
  };
  tick();
  const id = window.setInterval(tick, 500);
  return () => window.clearInterval(id);
}

export const commands = {
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
      mock = { ...mock, status: mock.status === "playing" ? "paused" : "playing", emitted_at_ms: Date.now() };
    }
  },
  next(): void {
    if (IN_TAURI) void invoke("media_next");
  },
  prev(): void {
    if (IN_TAURI) void invoke("media_prev");
  },
  seekRel(deltaMs: number): void {
    if (IN_TAURI) {
      void invoke("media_seek_rel", { deltaMs });
    } else {
      mock = {
        ...mock,
        position_ms: Math.min(Math.max(mock.position_ms + deltaMs, 0), mock.duration_ms),
        emitted_at_ms: Date.now(),
      };
    }
  },
  seekAbs(positionMs: number): void {
    if (IN_TAURI) {
      void invoke("media_seek_abs", { positionMs });
    } else {
      mock = { ...mock, position_ms: positionMs, emitted_at_ms: Date.now() };
    }
  },
  async art(artId: string): Promise<string | null> {
    if (!IN_TAURI) return artId === "mock-art" ? mockArt() : null;
    return invoke<string | null>("media_art", { artId });
  },
};
