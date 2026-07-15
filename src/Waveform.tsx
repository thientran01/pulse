/*
 * The living separator: at rest it's a colorless middot between artist and
 * album — a plain typographic separator. When music plays it blooms into
 * five Apple-style accent capsules bouncing on live spectrum bins. On pause
 * it settles in beats: the bars retract into dots, then the dots fade from
 * the outside in — a distance-staggered cascade normalized to the drop beat,
 * so a 5-bar and a 41-bar rendition collapse in the same wall-clock (reverse-
 * reading as one dot having multiplied) — and the survivor drains to gray as
 * the very last event. The app's ONLY
 * audio-reactive surface. State morphs use the house EASE token; per-frame
 * motion is DOM spans + scaleY transforms only (compositor-friendly) at
 * ~30fps.
 */
import { useEffect, useRef, useState } from "react";
import { type AudioBands } from "./lib/backend";
import { Envelope, subscribeBands } from "./lib/reactive";

/** Four renditions of the same instrument: "sm" is the pill's inline text
 * separator (5 bars); "md" is the card and lyrics-header separator (7 bars,
 * scaled up — those containers are ~3× the pill's, so the separator steps
 * with them; the lyrics header is also that view's only now-playing signal);
 * "lg" is the standalone hero in the expanded big-art view (9 bars — the
 * wider stage earns the extra pairs); "room" is focus mode's horizon (the
 * Soundboard design, 2026-07-12: a 1170×150 instrument spanning the lower
 * third of the fullscreen takeover). Room was RESHAPED 2026-07-12 after the
 * first cut read wrong at fullscreen size: 24px-wide bars turned into fat
 * ovals whenever they went short (a wide rounded-full shape is a blob when
 * height ≈ width), worst at the edges where the quiet high bins keep them
 * shortest. Now 41 thin (12px) capsules — a thin capsule stays a capsule at
 * any height — under a gentle symmetric peak envelope (roomPeak) so the
 * horizon reads as one intentional instrument (tall bass center, tapered
 * edges) instead of a random picket. Same choreography at every size.
 * boxH/aliveW/restW size the container: sm/md morph width between rest and
 * alive; the HERO footprints (lg, room) are CONSTANT (no width/margin morph,
 * rest keeps the full box) because they sit in centered columns/bands —
 * collapsing would re-seat everything around them. */
type Size = "sm" | "md" | "lg" | "room";
const GEOM = {
  sm: { bar: "h-[9px] w-[2px]", dot: "h-[2px] w-[2px]", survivor: "h-[3px] w-[3px]", dropBlur: "blur-[1.5px]", boxH: "h-[11px]", aliveW: "w-[18px]", restW: "w-[5px]" },
  md: { bar: "h-[18px] w-[4px]", dot: "h-[3px] w-[3px]", survivor: "h-[4px] w-[4px]", dropBlur: "blur-[2px]", boxH: "h-[20px]", aliveW: "w-[46px]", restW: "w-[6px]" },
  lg: { bar: "h-[26px] w-[5px]", dot: "h-[5px] w-[5px]", survivor: "h-[7px] w-[7px]", dropBlur: "blur-[3px]", boxH: "h-[30px]", aliveW: "w-[85px]", restW: "w-[85px]" },
  room: { bar: "h-[150px] w-[12px]", dot: "h-[6px] w-[6px]", survivor: "h-[10px] w-[10px]", dropBlur: "blur-[4px]", boxH: "h-[170px]", aliveW: "w-[1170px]", restW: "w-[1170px]" },
} as const;
/** The constant-footprint, purely-decorative standalone renditions. */
const HERO: ReadonlySet<Size> = new Set(["lg", "room"]);
/** Which spectrum bin each bar rides: center gets the lowest (Apple's
 * tall-middle silhouette); neighbors sit on staggered mids/highs so the
 * bars never bounce in lockstep. md is sm's inner five plus an outer high
 * pair; lg adds one more high pair outside those (15/13 deliberately
 * asymmetric — twin bins would bounce the edges in lockstep). room walks
 * the same asymmetric pattern out to 41: the center rides bass (bin 1 — the
 * tall middle) and the bins trend toward the highs at the edges (so energy
 * tapers outward WITH the roomPeak envelope), jittered so no two neighbors
 * share a bin and the two halves are never mirror images. */
const BAR_BINS = {
  sm: [9, 4, 1, 6, 11],
  md: [12, 9, 4, 1, 6, 11, 14],
  lg: [15, 12, 9, 4, 1, 6, 11, 14, 13],
  room: [
    12, 15, 13, 14, 15, 13, 15, 12, 14, 11, 13, 9, 12, 7, 10, 5, 8, 3, 6, 4, 1,
    3, 5, 7, 6, 9, 8, 11, 9, 13, 11, 14, 12, 15, 13, 15, 14, 13, 15, 14, 15,
  ],
} as const;
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
/** Room hero silhouette: a gentle symmetric envelope so the horizon reads as
 * one intentional instrument (tall center, tapered edges — Apple's soundwave
 * shape) instead of a random picket of equal-max bars. It caps each bar's
 * PEAK scaleY only; the REST floor stays uniform, so a quiet moment is a
 * clean flat line of equal capsules and energy blooms into the taper. Edges
 * never fall below EDGE_FLOOR of full height — the knob if the dome reads too
 * strong (raise toward 1 to flatten). Non-room sizes keep a flat peak of 1. */
const EDGE_FLOOR = 0.62;
function roomPeak(i: number, n: number): number {
  const t = (i / (n - 1)) * 2 - 1; // -1 (left edge) → 0 (center) → 1 (right edge)
  const shape = Math.pow(Math.cos((t * Math.PI) / 2), 0.7); // 1 at center, 0 at edges
  return EDGE_FLOOR + (1 - EDGE_FLOOR) * shape;
}
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
 * settle — the warm-up overlaps the first multiplication beat), pairs fade in
 * from the inside out — distance-staggered (riseDelayMs) so a 41-bar rendition
 * fans in as smoothly as a 5-bar one, the entrance mirror of the settle's
 * outside-in drop — and the dots grow into bars.
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
  // background-color in both lists: an art-change retint sweeps the capsules
  // at 220ms EASE.out like every accent-painted surface (progress fills, the
  // lyric marker) instead of snapping them. The survivor dot's rest-state
  // drain keeps its own slower, delayed timing — that one is choreography,
  // not a retint.
  if (phase === "alive")
    return `${g.bar} [transition:height_220ms_var(--ease-out-tk),width_220ms_var(--ease-out-tk),opacity_140ms_var(--ease-out-tk),background-color_220ms_var(--ease-out-tk)]`;
  // Distance from the center bar drives the collapse: "three" keeps the
  // survivor plus its immediate pair; everything outside that (d>1) drops on
  // this beat, but dropDelayMs staggers their fades by distance so they leave
  // outside-in as one smooth cascade at any bar count — the "one" beat then
  // takes the inner pair. (Formerly the whole d>1 group vanished on a single
  // beat, so a 9- or 41-bar rendition snapped straight to three dots.)
  const d = Math.abs(i - (BAR_BINS[size].length - 1) / 2);
  const mid = d === 0;
  const dropped = phase === "three" ? d > 1 : phase !== "dots" && !mid;
  // The survivor grows to the middot's size once it's alone, so the final
  // layer handoff is pixel-perfect.
  const dotSize = mid && (phase === "one" || phase === "rest") ? g.survivor : g.dot;
  return `${dotSize} ${dropped ? `opacity-0 ${g.dropBlur}` : "opacity-100 blur-0"} [transition:height_260ms_var(--ease-out-tk),width_260ms_var(--ease-out-tk),transform_260ms_var(--ease-out-tk),opacity_260ms_var(--ease-out-tk),filter_260ms_var(--ease-out-tk),background-color_220ms_var(--ease-out-tk)]`;
}

/** Outside-in stagger for the settle collapse. Each dropped dot's fade is
 * delayed by how FAR IN it is from the outermost — normalized to the drop
 * beat (DROP_MS) so the whole sweep takes the same wall-clock no matter how
 * many bars a size has: outermost pair leads at 0, the d=2 pair lands just
 * under a full DROP_MS later (near the "one" beat that drops the inner d=1
 * pair), and the dots in between fill the gap evenly. sm (5 bars, maxD 2)
 * collapses to the old two-beat feel — d=2 leads on "three", d=1 on "one";
 * md/lg/room fan the former single-beat drop into a real cascade.
 *
 * Applied to the outer dots (d≥2, dropped on "three") in the hiding phases:
 * "alive"/"dots" carry no delay (the rAF loop and the retraction own those)
 * and the inner pair (d<2) needs none — the "one" beat IS its stagger. The
 * CALLER additionally gates this to the SETTLE ladder (settlingRef): the
 * announce/bloom ladders reuse these phase names on the faster BLOOM/
 * ANNOUNCE_MS beats — and the announcement fires at room's 41 bars too
 * (Focus.tsx), where a DROP_MS-normalized stagger would overrun their window —
 * so those collapse plainly, matching their "glanced at, not watched" cadence. */
function dropDelayMs(phase: Phase, i: number, size: Size): number {
  if (phase !== "three" && phase !== "one" && phase !== "rest") return 0;
  const n = BAR_BINS[size].length;
  const maxD = (n - 1) / 2;
  const d = Math.abs(i - (n - 1) / 2);
  if (d < 2 || maxD <= 1) return 0;
  return Math.round(((maxD - d) / (maxD - 1)) * DROP_MS);
}

/** Inside-out stagger for the bloom reveal — the entrance mirror of
 * dropDelayMs. On the bloom's "dots" beat every outer dot (d≥2) un-hides at
 * once; delay each by how FAR OUT it is so the reveal fans from the center
 * (the survivor + its just-revealed inner pair) outward, normalized to the
 * bloom beat (BLOOM_MS) so a 5-bar and a 41-bar rendition fan in the same
 * wall-clock. The innermost outer pair (d=2) leads at 0, the outermost lands a
 * full BLOOM_MS later — into the "alive" handoff, where the bars are already
 * growing. d<2 needs none (its pair revealed a beat earlier, on "three") and
 * sm (maxD 2) has no outer tier to fan. CALLER-gated to the bloom
 * (bloomingRef); the announcement reveals plainly, same reasoning as the drop
 * stagger. */
function riseDelayMs(phase: Phase, i: number, size: Size): number {
  if (phase !== "dots") return 0;
  const n = BAR_BINS[size].length;
  const maxD = (n - 1) / 2;
  const d = Math.abs(i - (n - 1) / 2);
  if (d < 2 || maxD <= 2) return 0;
  return Math.round(((d - 2) / (maxD - 2)) * BLOOM_MS);
}

/** Announcement (track change) beat spacing — the bloom's quick cadence for
 * both directions: an announcement is glanced at, not watched. */
const ANNOUNCE_MS = BLOOM_MS;

export function Waveform({
  trailing,
  size = "sm",
  announceKey,
}: {
  trailing?: boolean;
  size?: Size;
  /** Track-identity key: a CHANGE while alive runs the announcement — the
   * capsules collapse (old song's color drains at the bottom), re-multiply
   * gray, and ignite last in the incoming track's accent. The pill's
   * track-change "notice me" beat; card/expanded instances don't pass it. */
  announceKey?: string;
}) {
  const barsRef = useRef<Array<HTMLSpanElement | null>>([]);
  const [phase, setPhase] = useState<Phase>(lastAlive ? "alive" : "rest");
  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  // Gates for the collapse/reveal stagger, each raised only by its own
  // choreographed ladder (read in render; set imperatively before the phase
  // change so the render sees it). The settle earns the OUTSIDE-IN drop
  // stagger (dropDelayMs); the bloom the INSIDE-OUT rise stagger (riseDelayMs).
  // The announcement reuses these phase names on faster beats — and runs at
  // room's 41 bars in focus mode (Focus.tsx), where either stagger would
  // overrun its window — so it collapses/reveals plainly, ungated.
  const settlingRef = useRef(false);
  const bloomingRef = useRef(false);
  // Render-visible half of the announce ladder: while true the bars paint
  // muted, so clearing it at the final beat lets the existing 220ms
  // background-color transition BE the accent ignition (color lands last —
  // the PR #30 arrival grammar).
  const [announceTint, setAnnounceTint] = useState(false);
  const announceRef = useRef<() => void>(() => {});

  const bins = BAR_BINS[size];

  useEffect(() => {
    const envs = bins.map(() => new Envelope(ENV_ATTACK_MS, ENV_RELEASE_MS));
    // Per-bar peak ceiling: the room silhouette envelope; a flat 1 elsewhere.
    const peaks = size === "room" ? bins.map((_, i) => roomPeak(i, bins.length)) : bins.map(() => 1);
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
        // Mildly concave shaping (SHAPE_EXP) between the uniform REST floor and
        // this bar's PEAK ceiling (the room envelope; 1 elsewhere) — quiet
        // settles to an even line, energy blooms into the tapered silhouette.
        if (el) el.style.transform = `scaleY(${(REST + Math.pow(e, SHAPE_EXP) * (peaks[i] - REST)).toFixed(3)})`;
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
    // Same guard for the announce ladder (alive → one → alive round trip on
    // a track change): loud payloads must ride through it untouched.
    let announcing = false;

    const armSettle = () => {
      if (sleepTimer !== null) return;
      sleepTimer = window.setTimeout(() => {
        sleepTimer = null;
        // A settle firing mid-announcement would interleave two ladders on
        // the same bars. Skip it — the announcement's final beat re-checks
        // the last payload and re-arms (the bloom's self-heal pattern).
        if (announcing) return;
        lastAlive = false;
        // Reduced motion: one state change, not four discrete snaps —
        // the global CSS guard zeroes transitions but not these timers.
        if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
          setPhase("rest");
          return;
        }
        // Arm the drop stagger: this is the watched settle, the one ladder
        // that earns the outside-in cascade (dropDelayMs).
        settlingRef.current = true;
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
            settlingRef.current = false;
            setPhase("rest");
          }, DOTS_MS + DROP_MS + DOTS_MS),
        );
      }, SLEEP_MS);
    };

    // The announcement (track change while alive): the settle ladder down to
    // the lone dot and straight back, on the bloom's quick cadence — the
    // song leaving and the next one multiplying in. Color grammar: the
    // drain lands at the bottom (announceTint flips as the survivor forms,
    // mirroring "color leaves last" on the way down) and the ignition is
    // the FINAL beat (clearing announceTint at "alive" lets the 220ms
    // background-color transition sweep the bars back to accent). When the
    // new album's palette has already resolved, the ignition lands in the
    // incoming color; when art lags the metadata (AM, up to ~10s — see the
    // CLAUDE.md gotcha) it ignites in the current accent and the standard
    // retint sweep recolors when the palette arrives. ~1.06s end to end —
    // the 2-beat bottom hold is the feel-check knob if it reads slow.
    announceRef.current = () => {
      if (phaseRef.current !== "alive" || blooming || announcing) return;
      if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
      announcing = true;
      setPhase("dots");
      seqTimers.push(window.setTimeout(() => setPhase("three"), ANNOUNCE_MS));
      seqTimers.push(
        window.setTimeout(() => {
          setPhase("one");
          setAnnounceTint(true); // the old song's color leaves at the bottom
        }, ANNOUNCE_MS * 2),
      );
      // Hold the lone gray dot for two beats — the drain needs a moment to
      // read before the multiplication reverses.
      seqTimers.push(window.setTimeout(() => setPhase("three"), ANNOUNCE_MS * 4));
      seqTimers.push(window.setTimeout(() => setPhase("dots"), ANNOUNCE_MS * 5));
      seqTimers.push(
        window.setTimeout(() => {
          announcing = false;
          seqTimers.splice(0);
          setAnnounceTint(false); // ignition: accent lands last
          setPhase("alive");
          start();
          // Mirror the bloom's self-heal: a pause mid-announcement emitted
          // its single zero payload while armSettle was skipping — re-check
          // or the separator strands as static bars.
          if (latest !== null && latest.level <= WAKE_LEVEL) armSettle();
        }, ANNOUNCE_MS * 6),
      );
    };

    // Mount watchdog: the crossfade mounts this instance BEFORE the outgoing
    // one's cleanup runs, so a swap inside the pause→settle window can seed
    // "alive" from a stale lastAlive with the backend already silent (its
    // single zero payload went to the old instance; subscribeBands never
    // replays). Arm the settle now: any live payload clears it within a
    // frame, silence collapses to rest on the normal ladder.
    if (phaseRef.current === "alive") armSettle();

    const unsub = subscribeBands((b) => {
      latest = b;
      if (b.level > WAKE_LEVEL) {
        // Any wake abandons an in-flight settle (snap-back, or a bloom that
        // reveals plainly) — disarm the drop stagger so a later announce/bloom
        // collapse can't inherit a stale settle flag.
        settlingRef.current = false;
        if (sleepTimer !== null) {
          window.clearTimeout(sleepTimer);
          sleepTimer = null;
        }
        lastAlive = true;
        if (blooming || announcing) {
          // A ladder is in flight — let it finish into "alive".
        } else if (
          phaseRef.current === "rest" &&
          !window.matchMedia("(prefers-reduced-motion: reduce)").matches
        ) {
          // Bloom from rest: walk the settle ladder backward. "one" first —
          // the muted middot crossfades out under the accent survivor
          // (identical geometry, so it reads as the dot catching the color).
          blooming = true;
          bloomingRef.current = true; // arm the inside-out rise stagger
          setPhase("one");
          seqTimers.push(window.setTimeout(() => setPhase("three"), BLOOM_MS));
          seqTimers.push(window.setTimeout(() => setPhase("dots"), BLOOM_MS * 2));
          seqTimers.push(
            window.setTimeout(() => {
              blooming = false;
              bloomingRef.current = false;
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

  // Fire the announcement on a track-identity CHANGE only — never the
  // initial key (mount/remount is not a track change; lastAlive already
  // keeps mode switches quiet). A transient undefined key (GSMTC populates
  // title before duration, so lyricsKeyOf can gap to null mid-change) must
  // not overwrite the memory — it would make the NEXT real track read as
  // an initial mount and silently skip (quick-review catch, 2026-07-10).
  const prevKeyRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    const prev = prevKeyRef.current;
    if (announceKey !== undefined) prevKeyRef.current = announceKey;
    if (announceKey === undefined || prev === undefined || prev === announceKey) return;
    announceRef.current();
  }, [announceKey]);

  const atRest = phase === "rest";

  // `trailing`: nothing follows this separator (lyrics view; empty album) —
  // there is nothing to separate, so rest state renders NOTHING (no dangling
  // dot, no sr-only dash) and the bars bloom in only while music plays.
  // Ignored at the hero sizes: a hero always keeps its middot (rest = a
  // single dot in the reserved box) and is purely decorative (no sr-only
  // dash).
  const showDot = HERO.has(size) || !trailing;
  return (
    <span
      aria-hidden={HERO.has(size) || undefined}
      className={`relative inline-flex ${GEOM[size].boxH} items-center align-middle ${
        HERO.has(size)
          ? GEOM[size].aliveW
          : `[transition:width_220ms_var(--ease-out-tk),margin_220ms_var(--ease-out-tk)] ${
              atRest ? (trailing ? "mx-0 w-0" : `mx-1.5 ${GEOM[size].restW}`) : `mx-1.5 ${GEOM[size].aliveW}`
            }`
      }`}
    >
      {/* AT hears the separator only when it actually separates two things —
          any text-separator size (the heroes are purely decorative). */}
      {!HERO.has(size) && !trailing && <span className="sr-only"> — </span>}
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
        {bins.map((_, i) => {
          // Per-bar stagger, each gated to its own ladder: the settle's
          // outside-in drop, the bloom's inside-out reveal. The announcement
          // (ungated) collapses/reveals plainly. undefined at delay 0 so the
          // alive state and the plain ladders carry no transition-delay at all.
          const delay = settlingRef.current
            ? dropDelayMs(phase, i, size)
            : bloomingRef.current
              ? riseDelayMs(phase, i, size)
              : 0;
          return (
            <span
              key={i}
              ref={(el) => {
                barsRef.current[i] = el;
              }}
              className={`origin-center rounded-full will-change-transform ${
                announceTint ? "bg-muted" : "bg-accent"
              } ${barClass(phase, i, size)}`}
              style={{
                transform: phase === "alive" ? `scaleY(${REST})` : "scale(1)",
                transitionDelay: delay ? `${delay}ms` : undefined,
              }}
            />
          );
        })}
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
