import { onTrackNudge } from "./backend";

/**
 * Directional track-change ledger — one per window (module state, the
 * posClock pattern). The slide grammar needs to know whether a change was
 * "next" (content exits left, enters from the right) or "prev" (mirrored),
 * but GSMTC only reports "new track" — so Palette can only KNOW direction
 * for changes it initiated: the transport skip buttons and the next/prev
 * hotkeys note a press here, and the identity-change handler consumes it.
 * Everything else — natural song end, skips made inside the player itself —
 * defaults to forward (the overwhelmingly common case; a prev pressed in
 * the Spotify app will read forward, a shipped-and-accepted limit).
 */
let noted: { dir: 1 | -1; at: number } | null = null;

/** How long a noted press stays credible. A prev pressed past a track's
 * opening seconds RESTARTS the same track (no identity change), so its note
 * must expire instead of mis-directing a later natural advance. */
const NOTE_TTL_MS = 3000;

export function noteTrackDir(dir: 1 | -1): void {
  noted = { dir, at: performance.now() };
}

/** Consume the note for the identity change happening now; forward when no
 * live note exists. Clears on read — one change, one direction. */
export function takeTrackDir(): 1 | -1 {
  const dir = noted !== null && performance.now() - noted.at < NOTE_TTL_MS ? noted.dir : 1;
  noted = null;
  return dir;
}

/** Wire the hotkey path: lib.rs emits "track-nudge" ±1 on the next/prev
 * hotkeys (the seek-nudge pattern) — the event reaches every window, so a
 * hotkey skip directs the slide in main AND focus. */
export function initTrackDir(): () => void {
  return onTrackNudge((dir) => noteTrackDir(dir));
}

/** Slide amplitude per surface (px) — deliberately small: opacity still
 * carries the swap, the offset only gives it a direction. Users skip a LOT;
 * anything bigger than "barely there" becomes fatigue (Thien, 2026-07-23). */
export const SLIDE_PX = { pill: 8, card: 10, header: 10, content: 14, room: 20 } as const;

/** One perceived track change per this window: GSMTC's piecemeal field
 * delivery flaps the raw track key 2–3 times per real skip (media props vs
 * timeline duration), and remount-keying the slides on the raw key
 * rubber-banded the exiting album block (re-adoption mid-exit). Key
 * changes inside the window update content in place instead. */
export const SLIDE_SETTLE_MS = 400;
