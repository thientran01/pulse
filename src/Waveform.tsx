/*
 * Apple Music-style now-playing waveform: five tiny accent capsules that
 * bounce with the live spectrum and settle to resting dots when playback
 * stops. Sits inline where the em dash used to separate artist and album —
 * the app's ONLY audio-reactive surface. DOM spans + scaleY transforms only
 * (compositor-friendly), driven at ~30fps from envelope-smoothed bins.
 */
import { useEffect, useRef } from "react";
import { type AudioBands } from "./lib/backend";
import { Envelope, subscribeBands } from "./lib/reactive";

const BARS = 5;
/** Which spectrum bin each bar rides: center gets the lowest (Apple's
 * tall-middle silhouette); neighbors sit on staggered mids/highs so the
 * bars never bounce in lockstep. */
const BAR_BINS = [9, 4, 1, 6, 11];
/** Resting-dot height as a fraction of the full bar. */
const REST = 0.18;
/** Stop animating once every envelope has decayed below this. */
const IDLE_EPS = 0.004;

export function Waveform() {
  const barsRef = useRef<Array<HTMLSpanElement | null>>([]);

  useEffect(() => {
    const envs = Array.from({ length: BARS }, () => new Envelope(40, 500));
    let latest: AudioBands | null = null;
    let raf = 0;
    let running = false;
    let last = 0;

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
        if (el) el.style.transform = `scaleY(${(REST + e * (1 - REST)).toFixed(3)})`;
      }
      // Idle-stop on the resting dots; the next band event restarts the loop.
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
      if (b.level > 0.001) start();
    });

    return () => {
      unsub();
      running = false;
      cancelAnimationFrame(raf);
    };
  }, []);

  return (
    <span aria-hidden={false} className="mx-1.5 inline-flex h-[11px] items-center gap-[2px] align-middle">
      {/* AT still hears the separator the icon replaced. */}
      <span className="sr-only"> — </span>
      {Array.from({ length: BARS }, (_, i) => (
        <span
          key={i}
          ref={(el) => {
            barsRef.current[i] = el;
          }}
          aria-hidden
          className="h-full w-[2px] origin-center rounded-full bg-accent will-change-transform"
          style={{ transform: `scaleY(${REST})` }}
        />
      ))}
    </span>
  );
}
