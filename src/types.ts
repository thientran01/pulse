export interface NowPlaying {
  /** Monotonic per-payload stamp (higher = later snapshot). Unused today —
   *  the position clock kernel (next PR) drops out-of-order payloads by it. */
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

/** Settled device-context state from the presence engine (presence.rs).
 * P0: sense-only — no behavior keys off it yet; the dev overlay observes it. */
export interface PresenceState {
  /** Hysteresis-settled: fullscreen content owns the widget's monitor, or a
   * GLOBAL QUNS state (exclusive D3D / presentation mode) is active — the
   * QUNS methods carry no monitor scoping. */
  fullscreen: boolean;
  /** Input idleness/intensity. Away wins over working (they can't
   * physically co-occur). */
  user: "active" | "working" | "away";
  /** What the engine did about it — always false until P1 ships conceal. */
  concealed: boolean;
}

/** Raw per-tick signals behind the settled state — "presence-debug" stream,
 * emitted only while the dev overlay has voted for it. */
export interface PresenceDebug {
  fg_exe: string;
  fg_class: string;
  fg_pid: number;
  rect_verdict: "fullscreen" | "maximized" | "windowed" | "none" | "shell" | "self";
  on_widget_monitor: boolean;
  quns: number;
  quns_name: string;
  idle_s: number;
  fs_raw: boolean;
  fs_settled: boolean;
  user: "active" | "working" | "away";
  /** Input duty over the working window, 0..1. */
  work_duty: number;
}

/** One finalized listen from the local play-history log (history.rs) —
 * player-agnostic, built from Pulse's own GSMTC stream. */
export interface HistoryEntry {
  /** Schema version — the seam for later columns. */
  v: number;
  /** Identity hash of (app_id, title, artist) — equals an art_id's key
   * prefix, and the thumb-cache filename (history_thumb_url). */
  key: string;
  app_id: string;
  player: NowPlaying["player"];
  title: string;
  artist: string;
  album: string;
  started_at_ms: number;
  ended_at_ms: number;
  /** Accumulated wall-clock ms spent in status "playing". */
  ms_listened: number;
  duration_ms: number;
  /** Stamped by the up-next engine while Spotify is connected (PR 3). */
  spotify_uri: string | null;
}

export const IN_TAURI = "__TAURI_INTERNALS__" in window;
