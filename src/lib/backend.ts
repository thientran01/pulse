/*
 * Thin backend seam: real Tauri IPC inside the app, a self-advancing mock in a
 * plain browser so the UI can be developed and verified with preview tooling.
 */
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
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
  art_id: null,
};

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
    if (!IN_TAURI) return null;
    return invoke<string | null>("media_art", { artId });
  },
};
