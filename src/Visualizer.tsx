/*
 * Focus mode's hero visualizer — SKELETON; the 3-design/3-judge panel owns
 * the final form. Deliberately NOT a fourth Waveform size: the Waveform's
 * grammar is "living separator" (a typographic pulse riding the title);
 * this is a room-scale instrument over the same 16-bin spectrum, and focus
 * mode's visualizer VIEW is the one reactive surface of that view (the
 * one-living-instance rule holds per view).
 *
 * Engine discipline is the Waveform's: refcounted bus subscription
 * (subscribeBands), per-frame scaleY writes straight to the DOM
 * (compositor-friendly, zero re-renders), envelope smoothing per bar, and
 * a rest state that parks the loop (the bus pushes one zero payload on
 * stop/reduced-motion; bars decay and the rAF loop exits).
 */
import { useEffect, useRef } from "react";
import { SPECTRUM_BINS } from "./lib/backend";
import { Envelope, subscribeBands } from "./lib/reactive";

/** Bars idle at this scale so the instrument reads as present, not dead. */
const REST_SCALE = 0.04;

export function Visualizer() {
  const barsRef = useRef<(HTMLSpanElement | null)[]>([]);

  useEffect(() => {
    const envs = Array.from({ length: SPECTRUM_BINS }, () => new Envelope());
    let latest = new Array<number>(SPECTRUM_BINS).fill(0);
    let raf = 0;
    let last = performance.now();
    let running = false;

    const frame = (now: number) => {
      const dt = Math.min(now - last, 100);
      last = now;
      let alive = false;
      for (let i = 0; i < SPECTRUM_BINS; i++) {
        const v = envs[i].step(latest[i], dt);
        if (v > 0.002 || latest[i] > 0) alive = true;
        const el = barsRef.current[i];
        if (el) el.style.transform = `scaleY(${Math.max(v, REST_SCALE)})`;
      }
      if (alive) {
        raf = requestAnimationFrame(frame);
      } else {
        running = false; // decayed to rest — park until the next payload
      }
    };
    const wake = () => {
      if (running) return;
      running = true;
      last = performance.now();
      raf = requestAnimationFrame(frame);
    };

    const unsubscribe = subscribeBands((b) => {
      latest = b.spectrum;
      if (b.spectrum.some((v) => v > 0)) wake();
      else wake(); // one more pass so the decay-to-rest animates
    });
    return () => {
      unsubscribe();
      cancelAnimationFrame(raf);
    };
  }, []);

  return (
    <div
      aria-hidden
      className="flex h-full w-full items-end justify-center gap-[0.6%] px-[4%] pb-[8%]"
    >
      {Array.from({ length: SPECTRUM_BINS }, (_, i) => (
        <span
          key={i}
          ref={(el) => {
            barsRef.current[i] = el;
          }}
          className="h-[70%] w-full origin-bottom rounded-full bg-accent"
          style={{ transform: `scaleY(${REST_SCALE})` }}
        />
      ))}
    </div>
  );
}
