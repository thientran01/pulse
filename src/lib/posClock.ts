/*
 * posClock — the single owner of the playback position.
 *
 * The backend emits raw (position_ms, position_at_ms = GSMTC LastUpdatedTime)
 * pairs and never projects (see media.rs). This kernel turns those pairs into
 * the one display clock, and that clock is MONOTONIC per track while playing:
 * Apple Music floors its pushed positions to whole seconds (~1/s cadence), so
 * a fresh pair can project BEHIND the previous one — ~1s from quantization
 * alone, ~1.5s measured live once stamp/delivery lag stacks on top — and
 * passing that through is what flashed the lyric highlight backwards. Small backward
 * deltas are quantization jitter and are held; only genuine discontinuities
 * (seeks, restarts, track changes) may move the clock backwards.
 *
 * All monotonicity lives HERE, in one layer. The backend must never filter or
 * nudge positions — a Rust-side filter whose correctness depends on a
 * frontend latch is the cross-layer trap this design deliberately rejects.
 */
import type { NowPlaying } from "../types";

/** Backward deltas smaller than this are jitter, not deliberate movement —
 * sized per player. Apple Music: 1s floor quantization plus stamp/delivery
 * lag; a live capture (2,265 payloads, 2026-07-07) showed the real backward
 * tail reaching ~1.5s, so the band carries headroom above it — nothing
 * legitimate lives under 2s on AM (no programmatic seek; manual scrubs are
 * larger). Spotify is ms-precise. The paused-scrub branch shares this band
 * by construction, not just by reuse: the pause freeze can legitimately sit
 * up to a band above the player's report, so a sub-band paused backward move
 * is indistinguishable from that excess. (AM's 2000 coincidentally equals
 * SEEK_CONFIRM_MS — independent values, do not consolidate.) */
const JITTER_BAND_MS: Record<NowPlaying["player"], number> = {
  apple_music: 2000,
  spotify: 400,
  other: 800,
  none: 800,
};

/** A pair stamped this long ago carries no usable position (player wedged,
 * clock skew) — hold the running clock. The old backend gate fell back to the
 * RAW position here, which regressed up to a full Spotify push gap. */
const STALE_PAIR_MS = 30_000;

/** After a local seek: how long pre-seek stragglers are dropped, and how far
 * from the target a sample may land while still confirming it. The grace must
 * outlive a full Spotify push cycle (~5s) — a pre-seek pair can be re-pushed
 * that late, and adopting one snaps the UI back by the whole seek distance.
 * A genuinely failed seek (rare; can_seek-gated) corrects once, at expiry. */
const SEEK_GRACE_MS = 6000;
const SEEK_CONFIRM_MS = 2000;

/** Paused players report stable positions — any reported move beyond this is
 * a deliberate scrub in the player's own UI, jitter-band rules don't apply. */
const PAUSED_SCRUB_MS = 50;

/* Module-level state, deliberately: the kernel outlives React remounts. Two
 * lifecycle assumptions hold on Tauri: (1) a backend seq reset only happens
 * with a full process restart, which resets this module too, so the seq guard
 * can never go permanently deaf; (2) an HMR reload of this module self-heals
 * within one IPC round-trip — Fast Refresh re-runs App's effects, and the
 * onNowPlaying mount seed re-feeds the freshly reset state. */
let track = "";
let playing = false;
let durationMs = 0;
let canSeek = false;
let anchorPos = 0;
let anchorAt = 0;
let lastSeq = 0;
let seekTarget: number | null = null;
let seekGraceUntil = 0;
const subs = new Set<() => void>();

function notify(): void {
  for (const cb of subs) cb();
}

function rebase(pos: number): void {
  anchorPos = pos;
  anchorAt = performance.now();
}

/** Display position in ms: advances at 1x from the last accepted anchor while
 * playing, frozen while paused. Pure read — safe at any frequency. */
export function now(): number {
  const raw = anchorPos + (playing ? performance.now() - anchorAt : 0);
  return Math.min(Math.max(raw, 0), durationMs || Infinity);
}

/** Whether the clock is advancing — consumers use this to idle their own
 * timers/loops; an anchor notification fires on every play/pause flip. */
export function isPlaying(): boolean {
  return playing;
}

/** Anchor-change notifications (accepted payloads, seeks, pauses, track
 * changes), fired synchronously after the anchor commits, at most ~1/s.
 * Consumers re-derive everything from now()/isPlaying() on each call: the
 * lyric scheduler re-arms its boundary timer, and paused progress surfaces
 * use this as their ONLY repaint path (their rAF idles while frozen). */
export function subscribe(cb: () => void): () => void {
  subs.add(cb);
  return () => {
    subs.delete(cb);
  };
}

/** Feed one backend payload through the monotonic filter. Returns false when
 * the payload is a stale straggler (older seq) the caller must also ignore. */
export function ingest(np: NowPlaying): boolean {
  // The backend guarantees higher seq == later snapshot (seq is assigned in
  // the same critical section as the snapshot) — lower is a stale straggler.
  if (np.seq <= lastSeq) return false;
  lastSeq = np.seq;

  const shown = now(); // BEFORE mutating state — the clock's previous value
  const wasPlaying = playing;
  const isPlaying = np.status === "playing";
  // duration_ms is deliberately NOT part of track identity: a transient
  // duration misreport (0 for a beat during metadata churn) would force a
  // false track-change that bypasses every filter below. A genuine
  // same-title/artist track transition still lands correctly — its position
  // restart is a beyond-band discontinuity, which the normal rule adopts.
  const key = `${np.app_id}|${np.title}|${np.artist}`;

  // The wall clock is consulted exactly once per ingest and converted to a
  // projection immediately — the running clock is performance.now()-based,
  // so an NTP step can skew one sample, never the clock itself. Negative
  // staleness (skew) trusts the raw position.
  //
  // Staleness is projectable ONLY for steady-playing pairs (was playing, is
  // playing): a stamp is elapsed-playback-time only if the player was playing
  // for the whole stamp→now interval. The resume payload after a pause still
  // carries the pause-era stamp — projecting it would leap the clock forward
  // by the pause length, then snap back on the next fresh push: the exact
  // flash this kernel exists to prevent.
  const staleness = np.position_at_ms > 0 ? Date.now() - np.position_at_ms : 0;
  const usable = staleness < STALE_PAIR_MS;
  const projected =
    np.position_ms + (wasPlaying && isPlaying && usable && staleness > 0 ? staleness : 0);

  durationMs = np.duration_ms;
  canSeek = np.can_seek;
  playing = isPlaying;

  if (key !== track) {
    // Track change / session appear or vanish: hard reset, no filtering —
    // this is exactly when a backward move is correct.
    track = key;
    seekTarget = null;
    rebase(usable ? projected : np.position_ms);
    notify();
    return true;
  }

  // Local-seek grace: the player may not have applied the seek yet, so a
  // sample far from the target is a pre-seek straggler — keep the optimistic
  // anchor (continued from `shown`, which sits at the target).
  if (seekTarget !== null) {
    const inGrace = performance.now() < seekGraceUntil;
    if (inGrace && (!usable || Math.abs(projected - seekTarget) > SEEK_CONFIRM_MS)) {
      rebase(shown);
      notify();
      return true;
    }
    seekTarget = null; // confirmed, or grace expired — normal rules resume
  }

  if (!usable) {
    // Stale pair: hold the running clock, never adopt the raw value.
    rebase(shown);
    notify();
    return true;
  }

  const band = JITTER_BAND_MS[np.player];
  let next: number;
  if (wasPlaying && !isPlaying) {
    // Pausing: freeze at the max, unconditionally. The transition pair can be
    // a full push-gap stale (Spotify: up to ~5s) and nothing is projectable
    // once paused, so a backward delta here is indistinguishable from
    // staleness. A genuine pre-pause scrub arrives moments later via the
    // player's frozen-timeline push and the paused branch below adopts it.
    next = Math.max(shown, projected);
  } else if (!wasPlaying && !isPlaying) {
    // Paused steady-state: forward moves are deliberate scrubs; backward
    // moves must clear the band — the pause freeze can legitimately sit up
    // to a band above the player's quantized report, and stepping back onto
    // that report is the flash.
    next = projected - shown > PAUSED_SCRUB_MS || shown - projected >= band ? projected : shown;
  } else {
    // Playing or resuming: forward is always truth; backward is a
    // discontinuity only beyond the jitter band, so a resume never ticks
    // backwards on quantization jitter.
    next = projected >= shown || shown - projected >= band ? projected : shown;
  }
  if (import.meta.env.DEV && next === projected && shown - next > PAUSED_SCRUB_MS) {
    // Adopted backward moves are the one event class where a filter bug would
    // hide — every legitimate entry here is a real seek/restart/scrub. Watch
    // this during live soaks: unexpected entries = the flash trying to return.
    console.debug("posClock: backward discontinuity adopted", { shown, projected, player: np.player });
  }
  rebase(next);
  notify();
  return true;
}

/** Optimistic local seek: the UI lands on the target immediately; ingest's
 * grace window shields it from pre-seek stragglers until the player's
 * timeline confirms. Returns the clamped target, or null when the player
 * can't seek (Apple Music — never lie optimistically). */
export function seekTo(targetMs: number): number | null {
  if (!canSeek) return null;
  const target = Math.min(Math.max(targetMs, 0), durationMs || Infinity);
  rebase(target);
  seekTarget = target;
  seekGraceUntil = performance.now() + SEEK_GRACE_MS;
  notify();
  return target;
}
