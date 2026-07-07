/*
 * Shared audio-reactive plumbing: one refcounted band subscription for the
 * whole app, reduced-motion gating (which also stops backend audio capture),
 * and the envelope/shaping helpers every reactive surface draws through.
 */
import { commands, onAudioBands, SPECTRUM_BINS, type AudioBands } from "./backend";

const ZERO_BANDS: AudioBands = {
  bass: 0,
  mid: 0,
  high: 0,
  level: 0,
  spectrum: new Array<number>(SPECTRUM_BINS).fill(0),
};

type BandsCb = (b: AudioBands) => void;

const subscribers = new Set<BandsCb>();
let unsub: (() => void) | null = null;
let initialized = false;
const mq = window.matchMedia("(prefers-reduced-motion: reduce)");

function apply(): void {
  // Also stops backend capture — no audio work for suppressed visuals.
  commands.setReactiveEnabled(!mq.matches);
  if (mq.matches) {
    unsub?.();
    unsub = null;
    // One final zero payload so subscribers decay to rest instead of freezing.
    for (const cb of subscribers) cb(ZERO_BANDS);
  } else if (!unsub && subscribers.size > 0) {
    unsub = onAudioBands((b) => {
      for (const cb of subscribers) cb(b);
    });
  }
}

/** Assert the reduced-motion vote to the backend even before any reactive
 * surface mounts (pill mode / nothing playing must still stop capture). */
export function initReactive(): void {
  if (initialized) return;
  initialized = true;
  mq.addEventListener("change", apply);
  apply();
}

export function subscribeBands(cb: BandsCb): () => void {
  initReactive();
  subscribers.add(cb);
  apply();
  return () => {
    subscribers.delete(cb);
    if (subscribers.size === 0) {
      unsub?.();
      unsub = null;
    }
  };
}

/**
 * Asymmetric exponential smoother: light blooms with a hit (fast attack) and
 * breathes out (slow release). Stacks on top of the backend's own smoothing.
 */
export class Envelope {
  private value = 0;

  constructor(
    private attackMs = 45,
    private releaseMs = 550,
  ) {}

  step(target: number, dtMs: number): number {
    const tau = target > this.value ? this.attackMs : this.releaseMs;
    this.value += (target - this.value) * (1 - Math.exp(-dtMs / tau));
    return this.value;
  }

  get current(): number {
    return this.value;
  }
}
