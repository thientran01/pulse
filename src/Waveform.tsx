/*
 * The living separator: at rest it's a colorless middot between artist and
 * album — a plain typographic separator. When music plays it blooms into
 * five Apple-style accent capsules bouncing on live spectrum bins, and
 * settles back to the dot on pause. The app's ONLY audio-reactive surface.
 * State morphs use the house EASE token; per-frame motion is DOM spans +
 * scaleY transforms only (compositor-friendly) at ~30fps.
 */
import { useEffect, useRef, useState } from "react";
import { type AudioBands } from "./lib/backend";
import { Envelope, subscribeBands } from "./lib/reactive";

const BARS = 5;
/** Which spectrum bin each bar rides: center gets the lowest (Apple's
 * tall-middle silhouette); neighbors sit on staggered mids/highs so the
 * bars never bounce in lockstep. */
const BAR_BINS = [9, 4, 1, 6, 11];
/** Minimum bar height while alive, as a fraction of the full bar. */
const REST = 0.25;
/** Stop animating once every envelope has decayed below this. */
const IDLE_EPS = 0.004;
/** Level above which the separator wakes; falls asleep after quiet holds. */
const WAKE_LEVEL = 0.02;
const SLEEP_MS = 500;

/** Wake state survives mode-switch remounts (the mode-keyed subtree tears
 * the component down) so the separator doesn't re-bloom from the dot on
 * every pill/card/expanded change. */
let lastAlive = false;

export function Waveform({ trailing }: { trailing?: boolean }) {
  const barsRef = useRef<Array<HTMLSpanElement | null>>([]);
  const [alive, setAlive] = useState(lastAlive);

  useEffect(() => {
    const envs = Array.from({ length: BARS }, () => new Envelope(40, 500));
    let latest: AudioBands | null = null;
    let raf = 0;
    let running = false;
    let last = 0;
    let sleepTimer: number | null = null;

    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      if (now - last < 33) return; // ~30fps
      const dt = Math.min(now - last, 100);
      last = now;
      const b = latest;
      let peak = 0;
      for (let i = 0; i < BARS; i++) {
        const bin = BAR_BINS[i];
        // Fallback for a payload without fine bins: coarse band by region.
        const target =
          b === null ? 0 : (b.spectrum?.[bin] ?? (bin <= 5 ? b.bass : bin <= 10 ? b.mid : b.high));
        const e = envs[i].step(target, dt);
        peak = Math.max(peak, e);
        const el = barsRef.current[i];
        // Concave shaping: moderate energy already reaches near-full height.
        if (el) el.style.transform = `scaleY(${(REST + Math.pow(e, 0.6) * (1 - REST)).toFixed(3)})`;
      }
      // Idle-stop once decayed; the next band event restarts the loop.
      if (peak < IDLE_EPS && (b === null || b.level <= 0.001)) {
        running = false;
        cancelAnimationFrame(raf);
      }
    };

    const start = () => {
      if (running) return;
      running = true;
      last = performance.now();
      raf = requestAnimationFrame(frame);
    };

    const unsub = subscribeBands((b) => {
      latest = b;
      if (b.level > WAKE_LEVEL) {
        if (sleepTimer !== null) {
          window.clearTimeout(sleepTimer);
          sleepTimer = null;
        }
        lastAlive = true;
        setAlive(true);
        start();
      } else {
        // Quiet: let the bars decay, and fall back to the dot if it holds.
        // Pause emits a single zero payload, so this must be wall-clock.
        if (sleepTimer === null) {
          sleepTimer = window.setTimeout(() => {
            sleepTimer = null;
            lastAlive = false;
            setAlive(false);
          }, SLEEP_MS);
        }
        if (b.level > 0.001) start();
      }
    });

    return () => {
      unsub();
      if (sleepTimer !== null) window.clearTimeout(sleepTimer);
      running = false;
      cancelAnimationFrame(raf);
    };
  }, []);

  // `trailing`: nothing follows this separator (lyrics view; empty album) —
  // there is nothing to separate, so rest state renders NOTHING (no dangling
  // dot, no sr-only dash) and the bars bloom in only while music plays.
  return (
    <span
      className={`relative inline-flex h-[11px] items-center align-middle [transition:width_220ms_var(--ease-out-tk),margin_220ms_var(--ease-out-tk)] ${
        alive ? "mx-1.5 w-[18px]" : trailing ? "mx-0 w-0" : "mx-1.5 w-[5px]"
      }`}
    >
      {/* AT hears the separator only when it actually separates two things. */}
      {!trailing && <span className="sr-only"> — </span>}
      {/* Resting state: a colorless middot — just a separator. Settle
          choreography: the bloom collapses into a still-accent dot first,
          and the color drains to muted as the LAST beat (drain delay =
          morph + a short hold), so losing the color reads as its own event. */}
      {!trailing && (
        <span
          aria-hidden
          className={`absolute left-1/2 top-1/2 h-[3px] w-[3px] -translate-x-1/2 -translate-y-1/2 rounded-full ${
            alive
              ? "bg-accent opacity-0 [transition:opacity_220ms_var(--ease-out-tk),background-color_220ms_var(--ease-out-tk)]"
              : "bg-muted opacity-100 [transition:opacity_220ms_var(--ease-out-tk),background-color_260ms_var(--ease-out-tk)_300ms]"
          }`}
        />
      )}
      {/* Playing state: the dot blooms into the waveform. */}
      <span
        aria-hidden
        className={`flex h-full w-full items-center justify-between overflow-hidden [transition:opacity_220ms_var(--ease-out-tk)] ${
          alive ? "opacity-100" : "opacity-0"
        }`}
      >
        {Array.from({ length: BARS }, (_, i) => (
          <span
            key={i}
            ref={(el) => {
              barsRef.current[i] = el;
            }}
            className="h-[9px] w-[2px] origin-center rounded-full bg-accent will-change-transform"
            style={{ transform: `scaleY(${REST})` }}
          />
        ))}
      </span>
    </span>
  );
}
