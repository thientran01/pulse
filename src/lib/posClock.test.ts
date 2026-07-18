/*
 * posClock kernel tests — the monotonic-clock filter is the one place a
 * regression ships as a visible flash (lyric highlight snapping backward),
 * and every rule here was bought with a live repro. The five suites mirror
 * the 1.0 audit's ranked risk list: the AM pause-era stamp, the small-seek
 * straggler hole (A5-1), AM 1s-floor monotonicity, the pause-freeze /
 * paused-scrub band edges, and the identity/seq edges.
 *
 * The kernel is module-level state by design (it outlives React remounts),
 * so every test gets a virgin module via vi.resetModules + dynamic import.
 * Both clocks are mocked in lockstep: the kernel anchors on performance.now()
 * and reads Date.now() exactly once per ingest for staleness.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NowPlaying } from "../types";

type Clock = typeof import("./posClock");

let clock: Clock;
let perfNow: number;
let wallNow: number;
let seq: number;

/** Advance both mocked clocks together — real time between backend pushes. */
function tick(ms: number): void {
  perfNow += ms;
  wallNow += ms;
}

const BASE: Omit<NowPlaying, "seq" | "position_at_ms"> = {
  app_id: "Spotify.exe",
  player: "spotify",
  title: "Track",
  artist: "Artist",
  album: "Album",
  status: "playing",
  position_ms: 0,
  duration_ms: 204_000,
  can_seek: true,
  art_id: null,
};

/** One backend payload: seq auto-advances (the backend's monotonic contract)
 * and the stamp defaults to "now" (a fresh pair) unless the test pins a stale
 * one — the pause-era / straggler cases hinge on exactly that pin. */
function pay(over: Partial<NowPlaying>): NowPlaying {
  return { ...BASE, position_at_ms: wallNow, seq: ++seq, ...over };
}

/** Apple Music's payload profile: 1s-floored positions, no seek. */
const AM = {
  app_id: "AppleInc.AppleMusic",
  player: "apple_music",
  can_seek: false,
} as const;

beforeEach(async () => {
  perfNow = 50_000;
  wallNow = 1_700_000_000_000;
  seq = 0;
  vi.spyOn(performance, "now").mockImplementation(() => perfNow);
  vi.spyOn(Date, "now").mockImplementation(() => wallNow);
  vi.resetModules();
  clock = await import("./posClock");
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("AM pause→resume (the pause-era stamp)", () => {
  it("never projects the pause-era stamp: no forward leap, no backward tick", () => {
    clock.ingest(pay({ ...AM, position_ms: 60_000 }));
    expect(clock.now()).toBe(60_000);
    tick(5_000);
    expect(clock.now()).toBe(65_000);
    // Pause: AM freezes its timeline and reports the floor, freshly stamped.
    const pauseStamp = wallNow;
    clock.ingest(pay({ ...AM, status: "paused", position_ms: 65_000 }));
    expect(clock.now()).toBe(65_000);
    tick(10_000);
    expect(clock.now()).toBe(65_000); // frozen through the pause
    // Resume: AM re-sends the PAUSE-ERA pair untouched. Staleness-projecting
    // its 10s would leap the clock to ~75s, then snap back on the next fresh
    // push — the exact flash the kernel exists to prevent.
    clock.ingest(
      pay({ ...AM, status: "playing", position_ms: 65_000, position_at_ms: pauseStamp }),
    );
    expect(clock.now()).toBe(65_000);
    // And the next floored fresh push must not tick the clock backward.
    tick(900);
    expect(clock.now()).toBe(65_900);
    clock.ingest(pay({ ...AM, position_ms: 65_000 }));
    expect(clock.now()).toBe(65_900);
  });
});

describe("small-seek straggler (A5-1)", () => {
  it("holds a re-pushed pre-seek pair instead of confirming off it", () => {
    clock.ingest(pay({ position_ms: 60_000 }));
    const preSeekStamp = wallNow;
    tick(100);
    // A 1.4s jump — between the Spotify band (400) and SEEK_CONFIRM_MS
    // (2000): the range where the far-from-target test alone can't tell a
    // straggler from a confirmation.
    expect(clock.seekTo(61_500)).toBe(61_500);
    expect(clock.now()).toBe(61_500); // optimistic landing
    tick(200);
    // Spotify re-pushes the PRE-seek pair (same position + stamp, fresh seq
    // — the seq gate can't help). It projects to 60_300: within
    // SEEK_CONFIRM_MS of the target, so the old kernel "confirmed" the seek
    // off it and the band rule adopted 60_300 — the backward flash.
    expect(clock.ingest(pay({ position_ms: 60_000, position_at_ms: preSeekStamp }))).toBe(true);
    expect(clock.now()).toBe(61_700); // held on the optimistic clock
    // Still armed: a later straggler is held the same way.
    tick(300);
    expect(clock.ingest(pay({ position_ms: 60_000, position_at_ms: preSeekStamp }))).toBe(true);
    expect(clock.now()).toBe(62_000);
    // The genuine post-seek pair confirms; normal band rules resume.
    tick(300);
    clock.ingest(pay({ position_ms: 62_100 }));
    expect(clock.now()).toBe(62_300); // confirmed — 200ms behind is sub-band jitter, held
    tick(1_000);
    clock.ingest(pay({ position_ms: 63_600 }));
    expect(clock.now()).toBe(63_600); // forward truth adopts
  });

  it("a genuinely failed seek corrects once, at grace expiry", () => {
    clock.ingest(pay({ position_ms: 60_000 }));
    tick(100);
    // Backward small seek the player silently ignores — its timeline keeps
    // running from 60_100, never crossing the target.
    expect(clock.seekTo(58_500)).toBe(58_500);
    for (let i = 1; i <= 5; i++) {
      tick(1_000);
      clock.ingest(pay({ position_ms: 60_100 + i * 1_000 }));
      // Inside the 6s grace every pre-seek-timeline push is held.
      expect(clock.now()).toBe(58_500 + i * 1_000);
    }
    tick(2_000); // grace (6s) expires
    clock.ingest(pay({ position_ms: 67_100 }));
    expect(clock.now()).toBe(67_100); // one correction, then truth
  });
});

describe("AM 1s-quantization monotonicity", () => {
  it("floored pushes on an irregular cadence never move now() backward", () => {
    // Hidden ms-precise truth; pushes carry only its floor (the /?am mock's
    // profile) — a fresh pair can project up to ~1s behind the running clock.
    let truth = 63_400;
    clock.ingest(pay({ ...AM, position_ms: Math.floor(truth / 1000) * 1000 }));
    let prev = clock.now();
    for (const step of [1000, 700, 1300, 900, 1100, 1000, 700, 1300]) {
      tick(step);
      truth += step;
      clock.ingest(pay({ ...AM, position_ms: Math.floor(truth / 1000) * 1000 }));
      const shown = clock.now();
      expect(shown).toBeGreaterThanOrEqual(prev);
      prev = shown;
    }
  });
});

describe("pause-freeze and the paused-scrub band", () => {
  it("freezes at the max on pause; paused deltas follow scrub/band rules", () => {
    clock.ingest(pay({ position_ms: 60_000 }));
    tick(3_000); // clock at 63_000
    // The transition pair can be a full push-gap stale — freeze at the MAX,
    // never step back onto the report.
    clock.ingest(pay({ status: "paused", position_ms: 60_500 }));
    expect(clock.now()).toBe(63_000);
    tick(500);
    expect(clock.now()).toBe(63_000); // frozen
    // Paused steady-state: forward past PAUSED_SCRUB_MS (50) is a scrub.
    clock.ingest(pay({ status: "paused", position_ms: 63_100 }));
    expect(clock.now()).toBe(63_100);
    // Exactly PAUSED_SCRUB_MS is NOT past it (strict >) — held.
    clock.ingest(pay({ status: "paused", position_ms: 63_150 }));
    expect(clock.now()).toBe(63_100);
    // Sub-band backward: indistinguishable from the freeze's legitimate
    // excess over the player's report — held.
    clock.ingest(pay({ status: "paused", position_ms: 62_900 }));
    expect(clock.now()).toBe(63_100);
    // At the band exactly (>=): a deliberate backward scrub — adopted.
    clock.ingest(pay({ status: "paused", position_ms: 62_700 }));
    expect(clock.now()).toBe(62_700);
    clock.ingest(pay({ status: "paused", position_ms: 50_000 }));
    expect(clock.now()).toBe(50_000);
  });
});

describe("identity and seq edges", () => {
  it("restart adopts 0, vanish resets, stale seq rejects, stale pair holds", () => {
    clock.ingest(pay({ position_ms: 200_000 }));
    expect(clock.now()).toBe(200_000);
    // Same-key restart (repeat-one / re-queued current): a beyond-band
    // backward discontinuity — the normal rule adopts it, no special case.
    clock.ingest(pay({ position_ms: 0 }));
    expect(clock.now()).toBe(0);
    tick(1_000);
    // Session vanish (AM deregisters on stop): key change → hard reset.
    clock.ingest(
      pay({
        player: "none",
        status: "none",
        title: "",
        artist: "",
        album: "",
        position_ms: 0,
        can_seek: false,
      }),
    );
    expect(clock.isPlaying()).toBe(false);
    // The track back: key change again — adopt wherever it reports.
    clock.ingest(pay({ position_ms: 42_000 }));
    expect(clock.now()).toBe(42_000);
    // Stale straggler (lower seq): rejected, clock untouched — and the false
    // return is the caller contract (App must not adopt its identity either).
    expect(
      clock.ingest({ ...BASE, seq: 1, position_ms: 999, position_at_ms: wallNow }),
    ).toBe(false);
    expect(clock.now()).toBe(42_000);
    // A >30s-old stamp carries no usable position (STALE_PAIR): hold the
    // running clock, never adopt the raw value.
    tick(1_000);
    expect(clock.now()).toBe(43_000);
    clock.ingest(pay({ position_ms: 10_000, position_at_ms: wallNow - 31_000 }));
    expect(clock.now()).toBe(43_000);
  });
});
