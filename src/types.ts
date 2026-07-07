export interface NowPlaying {
  /** Monotonic per-payload stamp — consumers drop out-of-order payloads. */
  seq: number;
  app_id: string;
  player: "apple_music" | "spotify" | "other" | "none";
  title: string;
  artist: string;
  album: string;
  status: "playing" | "paused" | "stopped" | "none";
  /** RAW player-reported position — no staleness projection applied. */
  position_ms: number;
  duration_ms: number;
  /**
   * Unix ms when the player last stamped its timeline (GSMTC LastUpdatedTime);
   * 0 = never. While playing, the true position is approximately
   * position_ms + (now - position_at_ms).
   */
  position_at_ms: number;
  can_seek: boolean;
  art_id: string | null;
}

export const IN_TAURI = "__TAURI_INTERNALS__" in window;
