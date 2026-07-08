/*
 * The living separator: at rest it's a colorless middot between artist and
 * album — a plain typographic separator. When music plays it blooms into
 * five Apple-style accent capsules bouncing on live spectrum bins. On pause
 * it settles in beats: the bars retract into five dots, the dots vanish in
 * pairs from the outside in (reverse-reading as one dot having multiplied),
 * and the survivor drains to gray as the very last event. The app's ONLY
 * audio-reactive surface. State morphs use the house EASE token; per-frame
 * motion is DOM spans + scaleY transforms only (compositor-friendly) at
 * ~30fps.
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

/**
 * Settle phases, in order. "alive" is the audio-reactive waveform; the rest
 * are the collapse beats: bars retract into five equal dots ("dots"), the
 * outermost pair fades ("three"), the inner pair fades while the middle dot
 * grows to resting size ("one"), then the bars layer hands off to the
 * resting middot ("rest") — an invisible swap, since the middle dot and the
 * middot are pixel-identical at that moment — and the color drain fires.
 */
type Phase = "alive" | "dots" | "three" | "one" | "rest";
/** Bars → dots retraction; also the survivor's grow-to-middot beat, which
 * must run its full height/width transition before the rest handoff.
 * The settle deliberately runs a rung slower than the 220ms bloom — it's
 * meant to be watched; the bloom is meant to get out of the way. */
const DOTS_MS = 260; // DUR[5]
/** Beat spacing between vanishing pairs. Their fades run 260ms (DUR[5]) on
 * this 200ms beat, so the outer pair is still dissolving when the inner
 * pair starts — a cascade, not discrete steps. */
const DROP_MS = 200; // DUR[3]

/** Wake state survives mode-switch remounts (the mode-keyed subtree tears
 * the component down) so the separator doesn't re-bloom from the dot on
 * every pill/card/expanded change. */
let lastAlive = false;

/** Per-bar geometry/visibility for a phase. Transform is deliberately NOT
 * transitioned while alive — the rAF loop owns it per frame. */
function barClass(phase: Phase, i: number): string {
  if (phase === "alive")
    return "h-[9px] w-[2px] [transition:height_220ms_var(--ease-out-tk),width_220ms_var(--ease-out-tk),opacity_140ms_var(--ease-out-tk)]";
  const mid = i === 2;
  const dropped = phase === "three" ? i === 0 || i === 4 : phase !== "dots" && !mid;
  // The survivor grows to the middot's 3px once it's alone, so the final
  // layer handoff is pixel-perfect.
  const size = mid && (phase === "one" || phase === "rest") ? "h-[3px] w-[3px]" : "h-[2px] w-[2px]";
  return `${size} ${dropped ? "opacity-0 blur-[1.5px]" : "opacity-100 blur-0"} [transition:height_260ms_var(--ease-out-tk),width_260ms_var(--ease-out-tk),transform_260ms_var(--ease-out-tk),opacity_260ms_var(--ease-out-tk),filter_260ms_var(--ease-out-tk)]`;
}

export function Waveform({ trailing }: { trailing?: boolean }) {
  const barsRef = useRef<Array<HTMLSpanElement | null>>([]);
  const [phase, setPhase] = useState<Phase>(lastAlive ? "alive" : "rest");
  const phaseRef = useRef(phase);
  phaseRef.current = phase;

  useEffect(() => {
    const envs = Array.from({ length: BARS }, () => new Envelope(40, 500));
    let latest: AudioBands | null = null;
    let raf = 0;
    let running = false;
    let last = 0;
    let sleepTimer: number | null = null;
    const seqTimers: number[] = [];
    const clearSeq = () => {
      for (const t of seqTimers.splice(0)) window.clearTimeout(t);
    };

    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      // The settle sequence owns the bars once it starts; CSS transitions
      // animate them, so per-frame transform writes must stop.
      if (phaseRef.current !== "alive") {
        running = false;
        cancelAnimationFrame(raf);
        return;
      }
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
        clearSeq();
        lastAlive = true;
        setPhase("alive");
        start();
      } else {
        // Quiet: let the bars decay, and fall back to the dot if it holds.
        // Pause emits a single zero payload, so this must be wall-clock.
        // Only arm from "alive" — zero payloads keep arriving while paused,
        // and re-arming mid-collapse would restart the sequence.
        if (sleepTimer === null && phaseRef.current === "alive") {
          sleepTimer = window.setTimeout(() => {
            sleepTimer = null;
            lastAlive = false;
            // Reduced motion: one state change, not four discrete snaps —
            // the global CSS guard zeroes transitions but not these timers.
            if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
              setPhase("rest");
              return;
            }
            setPhase("dots");
            seqTimers.push(window.setTimeout(() => setPhase("three"), DOTS_MS));
            seqTimers.push(window.setTimeout(() => setPhase("one"), DOTS_MS + DROP_MS));
            // The "one" beat runs the survivor's full 220ms grow before the
            // rest handoff — cutting it short would pop the swap.
            seqTimers.push(window.setTimeout(() => setPhase("rest"), DOTS_MS + DROP_MS + DOTS_MS));
          }, SLEEP_MS);
        }
        if (b.level > 0.001) start();
      }
    });

    return () => {
      unsub();
      // A pending sleep timer means quiet was already in progress; count it
      // as settled so a mode-switch remount doesn't strand the next instance
      // in "alive" with no band event ever coming to collapse it (the
      // backend goes silent after pause's single zero payload).
      if (sleepTimer !== null) {
        window.clearTimeout(sleepTimer);
        lastAlive = false;
      }
      clearSeq();
      running = false;
      cancelAnimationFrame(raf);
    };
  }, []);

  const atRest = phase === "rest";

  // `trailing`: nothing follows this separator (lyrics view; empty album) —
  // there is nothing to separate, so rest state renders NOTHING (no dangling
  // dot, no sr-only dash) and the bars bloom in only while music plays.
  return (
    <span
      className={`relative inline-flex h-[11px] items-center align-middle [transition:width_220ms_var(--ease-out-tk),margin_220ms_var(--ease-out-tk)] ${
        atRest ? (trailing ? "mx-0 w-0" : "mx-1.5 w-[5px]") : "mx-1.5 w-[18px]"
      }`}
    >
      {/* AT hears the separator only when it actually separates two things. */}
      {!trailing && <span className="sr-only"> — </span>}
      {/* Resting state: a colorless middot — just a separator. It swaps in
          INSTANTLY over the survivor dot (identical pixels, so no crossfade
          is needed and none is wanted — a fade would ghost while the
          container width shrinks), still accent, then drains to muted as
          the LAST beat so losing the color reads as its own event. */}
      {!trailing && (
        <span
          aria-hidden
          className={`absolute left-1/2 top-1/2 h-[3px] w-[3px] -translate-x-1/2 -translate-y-1/2 rounded-full ${
            atRest
              ? "bg-muted opacity-100 [transition:background-color_260ms_var(--ease-out-tk)_300ms]"
              : "bg-accent opacity-0 [transition:opacity_220ms_var(--ease-out-tk),background-color_220ms_var(--ease-out-tk)]"
          }`}
        />
      )}
      {/* Playing state: the waveform, which collapses through the phase
          beats on settle. Hidden instantly at rest (the middot took over);
          fades back in on bloom. */}
      <span
        aria-hidden
        className={`flex h-full w-full items-center justify-between overflow-hidden ${
          atRest ? "opacity-0" : "opacity-100 [transition:opacity_220ms_var(--ease-out-tk)]"
        }`}
      >
        {Array.from({ length: BARS }, (_, i) => (
          <span
            key={i}
            ref={(el) => {
              barsRef.current[i] = el;
            }}
            className={`origin-center rounded-full bg-accent will-change-transform ${barClass(phase, i)}`}
            style={{ transform: phase === "alive" ? `scaleY(${REST})` : "scale(1)" }}
          />
        ))}
      </span>
    </span>
  );
}
