export interface NowPlaying {
  app_id: string;
  player: "apple_music" | "spotify" | "other" | "none";
  title: string;
  artist: string;
  album: string;
  status: "playing" | "paused" | "stopped" | "none";
  position_ms: number;
  duration_ms: number;
  /** Unix ms at which position_ms was true — interpolate from here while playing. */
  emitted_at_ms: number;
  can_seek: boolean;
  art_id: string | null;
}

export const IN_TAURI = "__TAURI_INTERNALS__" in window;
