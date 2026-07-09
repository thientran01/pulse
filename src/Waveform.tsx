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

/** Three renditions of the same instrument: "sm" is the inline text separator
 * (5 bars); "md" is the lyrics-view header separator (7 bars, scaled up — the
 * header is that view's only now-playing signal, so it earns more presence
 * than a text separator); "lg" is the standalone hero in the expanded big-art
 * view (7 bars — the wider stage earns the extra pair) — same choreography,
 * scaled geometry. boxH/aliveW/restW size the container: sm/md morph
 * width between rest and alive; the lg footprint is CONSTANT (no width/margin
 * morph, rest keeps the full box) because it sits in a centered column above
 * the transport — collapsing it would re-center the column and move the art. */
type Size = "sm" | "md" | "lg";
const GEOM = {
  sm: { bar: "h-[9px] w-[2px]", dot: "h-[2px] w-[2px]", survivor: "h-[3px] w-[3px]", dropBlur: "blur-[1.5px]", boxH: "h-[11px]", aliveW: "w-[18px]", restW: "w-[5px]" },
  md: { bar: "h-[18px] w-[4px]", dot: "h-[3px] w-[3px]", survivor: "h-[4px] w-[4px]", dropBlur: "blur-[2px]", boxH: "h-[20px]", aliveW: "w-[46px]", restW: "w-[6px]" },
  lg: { bar: "h-[26px] w-[5px]", dot: "h-[5px] w-[5px]", survivor: "h-[7px] w-[7px]", dropBlur: "blur-[3px]", boxH: "h-[30px]", aliveW: "w-[65px]", restW: "w-[65px]" },
} as const;
/** Which spectrum bin each bar rides: center gets the lowest (Apple's
 * tall-middle silhouette); neighbors sit on staggered mids/highs so the
 * bars never bounce in lockstep. md and lg share the seven-bar spread —
 * sm's inner five plus an outer high pair. */
const BAR_BINS = { sm: [9, 4, 1, 6, 11], md: [12, 9, 4, 1, 6, 11, 14], lg: [12, 9, 4, 1, 6, 11, 14] } as const;
/** Minimum bar height while alive, as a fraction of the full bar. */
const REST = 0.15;
/** Frontend envelope on top of the backend's smoothing: fast attack so hits
 * land, release short enough that a bar visibly falls between beats (500ms
 * blurred adjacent kicks into a sway). */
const ENV_ATTACK_MS = 40;
const ENV_RELEASE_MS = 180;
/** Height shaping exponent: <1 lifts moderate energy, but 0.6 compressed
 * everything to "medium-tall" — 0.85 keeps the loud/quiet contrast. */
const SHAPE_EXP = 0.85;
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
 *
 * The bloom walks the SAME ladder in reverse (rest → one → three → dots →
 * alive) on faster beats: the middot warms to accent as the survivor takes
 * over (the color beat leads, loosely mirroring color-leaves-last on the
 * settle — the warm-up overlaps the first multiplication beat), pairs fade
 * in from the inside out, and the dots grow into bars.
 */
type Phase = "alive" | "dots" | "three" | "one" | "rest";
/** Bars → dots retraction; also the survivor's grow-to-middot beat, which
 * must run its full height/width transition before the rest handoff. */
const DOTS_MS = 260; // DUR[5]
/** Beat spacing between vanishing pairs. Their fades run 260ms (DUR[5]) on
 * this 200ms beat, so the outer pair is still dissolving when the inner
 * pair starts — a cascade, not discrete steps. */
const DROP_MS = 200; // DUR[3]
/** Beat spacing for the reverse (bloom) ladder — deliberately quicker than
 * the settle's beats: the settle is watched, the bloom gets out of the way
 * so the bars are riding the music as soon as possible. */
const BLOOM_MS = 140; // DUR[2]

/** Wake state survives mode-switch remounts (the mode-keyed subtree tears
 * the component down) so the separator doesn't re-bloom from the dot on
 * every pill/card/expanded change. */
let lastAlive = false;

/** Per-bar geometry/visibility for a phase. Transform is deliberately NOT
 * transitioned while alive — the rAF loop owns it per frame. */
function barClass(phase: Phase, i: number, size: Size): string {
  const g = GEOM[size];
  if (phase === "alive")
    return `${g.bar} [transition:height_220ms_var(--ease-out-tk),width_220ms_var(--ease-out-tk),opacity_140ms_var(--ease-out-tk)]`;
  // Distance from the center bar drives the collapse: "three" keeps the
  // survivor plus its immediate pair, so at lg the two outer pairs leave on
  // one beat — their 260ms fades on 200ms beats still read outside-in.
  const d = Math.abs(i - (BAR_BINS[size].length - 1) / 2);
  const mid = d === 0;
  const dropped = phase === "three" ? d > 1 : phase !== "dots" && !mid;
  // The survivor grows to the middot's size once it's alone, so the final
  // layer handoff is pixel-perfect.
  const dotSize = mid && (phase === "one" || phase === "rest") ? g.survivor : g.dot;
  return `${dotSize} ${dropped ? `opacity-0 ${g.dropBlur}` : "opacity-100 blur-0"} [transition:height_260ms_var(--ease-out-tk),width_260ms_var(--ease-out-tk),transform_260ms_var(--ease-out-tk),opacity_260ms_var(--ease-out-tk),filter_260ms_var(--ease-out-tk)]`;
}

export function Waveform({ trailing, size = "sm" }: { trailing?: boolean; size?: Size }) {
  const barsRef = useRef<Array<HTMLSpanElement | null>>([]);
  const [phase, setPhase] = useState<Phase>(lastAlive ? "alive" : "rest");
  const phaseRef = useRef(phase);
  phaseRef.current = phase;

  const bins = BAR_BINS[size];

  useEffect(() => {
    const envs = bins.map(() => new Envelope(ENV_ATTACK_MS, ENV_RELEASE_MS));
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
      for (let i = 0; i < bins.length; i++) {
        const bin = bins[i];
        // Fallback for a payload without fine bins: coarse band by region.
        const target =
          b === null ? 0 : (b.spectrum?.[bin] ?? (bin <= 5 ? b.bass : bin <= 10 ? b.mid : b.high));
        const e = envs[i].step(target, dt);
        peak = Math.max(peak, e);
        const el = barsRef.current[i];
        // Mildly concave shaping: lifts moderate energy without flattening
        // the loud/quiet contrast (see SHAPE_EXP).
        if (el) el.style.transform = `scaleY(${(REST + Math.pow(e, SHAPE_EXP) * (1 - REST)).toFixed(3)})`;
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

    // Distinguishes a running bloom ladder from a settle ladder — the phase
    // names alone are ambiguous, and loud payloads arrive at ~30Hz while the
    // bloom plays; they must not clear or restart it.
    let blooming = false;

    const armSettle = () => {
      if (sleepTimer !== null) return;
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
        // The "one" beat runs the survivor's full grow before the rest
        // handoff — cutting it short would pop the swap. All ids are dead
        // once this last beat fires; empty the array so it can't grow
        // unbounded across play/pause cycles.
        seqTimers.push(
          window.setTimeout(() => {
            seqTimers.splice(0);
            setPhase("rest");
          }, DOTS_MS + DROP_MS + DOTS_MS),
        );
      }, SLEEP_MS);
    };

    const unsub = subscribeBands((b) => {
      latest = b;
      if (b.level > WAKE_LEVEL) {
        if (sleepTimer !== null) {
          window.clearTimeout(sleepTimer);
          sleepTimer = null;
        }
        lastAlive = true;
        if (blooming) {
          // Reverse ladder in flight — let it finish into "alive".
        } else if (
          phaseRef.current === "rest" &&
          !window.matchMedia("(prefers-reduced-motion: reduce)").matches
        ) {
          // Bloom from rest: walk the settle ladder backward. "one" first —
          // the muted middot crossfades out under the accent survivor
          // (identical geometry, so it reads as the dot catching the color).
          blooming = true;
          setPhase("one");
          seqTimers.push(window.setTimeout(() => setPhase("three"), BLOOM_MS));
          seqTimers.push(window.setTimeout(() => setPhase("dots"), BLOOM_MS * 2));
          seqTimers.push(
            window.setTimeout(() => {
              blooming = false;
              seqTimers.splice(0); // all fired — see armSettle
              setPhase("alive");
              start();
              // A pause that landed mid-bloom emitted its single zero
              // payload while the arming guard below couldn't fire (phase
              // wasn't "alive" yet), and the backend goes silent after it —
              // pick it up now or the separator strands as static bars.
              if (latest !== null && latest.level <= WAKE_LEVEL) armSettle();
            }, BLOOM_MS * 3),
          );
        } else if (phaseRef.current !== "alive") {
          // Wake mid-settle (or reduced motion at rest): snap straight back —
          // an interrupted collapse recovers fast, it doesn't re-choreograph.
          clearSeq();
          setPhase("alive");
          start();
        } else {
          start();
        }
      } else {
        // Quiet: let the bars decay, and fall back to the dot if it holds.
        // Pause emits a single zero payload, so this must be wall-clock.
        // Only arm from "alive" — zero payloads keep arriving while paused,
        // and re-arming mid-collapse would restart the sequence. A quiet
        // payload landing mid-bloom is caught by the bloom's final beat.
        if (phaseRef.current === "alive") armSettle();
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
  // Ignored at lg: the hero always keeps its middot (rest = a single dot in
  // the reserved box) and is purely decorative (no sr-only dash).
  const showDot = size === "lg" || !trailing;
  return (
    <span
      aria-hidden={size === "lg" || undefined}
      className={`relative inline-flex ${GEOM[size].boxH} items-center align-middle ${
        size === "lg"
          ? GEOM[size].aliveW
          : `[transition:width_220ms_var(--ease-out-tk),margin_220ms_var(--ease-out-tk)] ${
              atRest ? (trailing ? "mx-0 w-0" : `mx-1.5 ${GEOM[size].restW}`) : `mx-1.5 ${GEOM[size].aliveW}`
            }`
      }`}
    >
      {/* AT hears the separator only when it actually separates two things. */}
      {size === "sm" && !trailing && <span className="sr-only"> — </span>}
      {/* Resting state: a colorless middot — just a separator. It swaps in
          INSTANTLY over the survivor dot (identical pixels, so no crossfade
          is needed and none is wanted — a fade would ghost while the
          container width shrinks), still accent, then drains to muted as
          the LAST beat so losing the color reads as its own event. */}
      {showDot && (
        <span
          aria-hidden
          className={`absolute left-1/2 top-1/2 ${GEOM[size].survivor} -translate-x-1/2 -translate-y-1/2 rounded-full ${
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
        {bins.map((_, i) => (
          <span
            key={i}
            ref={(el) => {
              barsRef.current[i] = el;
            }}
            className={`origin-center rounded-full bg-accent will-change-transform ${barClass(phase, i, size)}`}
            style={{ transform: phase === "alive" ? `scaleY(${REST})` : "scale(1)" }}
          />
        ))}
      </span>
    </span>
  );
}

/** The living separator's inert twin: the same colorless middot, pixel-for-
 * pixel, with no audio subscription. For lines where the large Waveform is
 * already on screen — one view, one audio-reactive surface. */
export function SeparatorDot() {
  return (
    <span className="relative mx-1.5 inline-flex h-[11px] w-[5px] items-center align-middle">
      <span className="sr-only"> — </span>
      <span
        aria-hidden
        className="absolute left-1/2 top-1/2 h-[3px] w-[3px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-muted"
      />
    </span>
  );
}
