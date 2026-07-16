/*
 * The karaoke lyrics surface — lifted out of App.tsx (mechanical move,
 * 2026-07-11) so the focus window's realm can import it without importing
 * the whole widget. Everything lyric-shaped lives here: the fetch hook
 * (useLyrics + lyricsKeyOf), the scheduled line index (useLyricIndex), the
 * rows, and the panel with its auto-follow / wheel-browse / arrival-cascade
 * machinery. Two type scales: "base" (the 380px expanded view) and "focus"
 * (the fullscreen takeover) — same grammar, bigger clothes.
 */
import { memo, useEffect, useLayoutEffect, useRef, useState } from "react";
import { commands } from "./lib/backend";
import {
  BREAK_DOTS,
  breakDotsFilled,
  currentLineIndex,
  msUntilNextDot,
  msUntilNextLine,
  parseLrc,
  type LyricLine,
} from "./lib/lrc";
import * as posClock from "./lib/posClock";
import type { NowPlaying } from "./types";

/** Current lyric line by SCHEDULING, not sampling: one timeout armed for the
 * next line boundary, recomputed on every kernel anchor event (seek, pause,
 * track change, accepted push). On fire the index is re-derived from the
 * clock — never blind-incremented — so throttled webview timers can only
 * delay a transition, never derail it. Transitions land with timer precision
 * instead of on a 250ms sampling grid. */
export function useLyricIndex(lines: LyricLine[], leadMs: number): number {
  const [idx, setIdx] = useState(() => currentLineIndex(lines, posClock.now(), leadMs));
  useEffect(() => {
    let timer: number | undefined;
    const sync = () => {
      window.clearTimeout(timer);
      timer = undefined;
      const pos = posClock.now();
      const i = currentLineIndex(lines, pos, leadMs);
      setIdx(i); // same value → React bails
      if (!posClock.isPlaying()) return; // clock frozen — anchor event re-arms
      const delay = msUntilNextLine(lines, i, pos, leadMs);
      if (delay === null) return; // last line — nothing left to schedule
      // Cap long waits and re-verify on fire, against timer throttling.
      timer = window.setTimeout(sync, Math.min(delay, 30_000));
    };
    sync();
    const unsubscribe = posClock.subscribe(sync);
    return () => {
      unsubscribe();
      window.clearTimeout(timer);
    };
  }, [lines, leadMs]);
  return idx;
}

/** Filled-dot count for the CURRENT break row — the same schedule-not-sample
 * pattern as useLyricIndex: one timeout armed for the next fifth-of-the-break
 * breakpoint, re-derived from the clock on fire and on every kernel anchor
 * event (seek, pause, accepted push), so a seek into the middle of a break
 * catches the dots up instantly and a pause freezes them. Inactive rows
 * (not current) schedule nothing. */
function useBreakDots(line: LyricLine, leadMs: number, active: boolean): number {
  // Lazy init like useLyricIndex — a row that mounts (or re-activates) mid-
  // break must paint the right count on its first frame, not flash 0 until
  // the post-paint effect corrects it.
  const [filled, setFilled] = useState(() =>
    active ? breakDotsFilled(line, posClock.now(), leadMs) : 0,
  );
  useEffect(() => {
    if (!active) {
      // Park at 0 so a LATER re-activation (a seek back into this break)
      // can't flash the previous stint's stale count for a frame.
      setFilled(0);
      return;
    }
    let timer: number | undefined;
    const sync = () => {
      window.clearTimeout(timer);
      timer = undefined;
      const pos = posClock.now();
      setFilled(breakDotsFilled(line, pos, leadMs)); // same value → React bails
      if (!posClock.isPlaying()) return; // clock frozen — anchor event re-arms
      const delay = msUntilNextDot(line, pos, leadMs);
      if (delay === null) return; // all five lit — nothing left to schedule
      // Cap long waits and re-verify on fire, against timer throttling.
      timer = window.setTimeout(sync, Math.min(delay, 30_000));
    };
    sync();
    const unsubscribe = posClock.subscribe(sync);
    return () => {
      unsubscribe();
      window.clearTimeout(timer);
    };
  }, [line, leadMs, active]);
  return active ? filled : 0;
}

export type LyricsState =
  // "none" = a definitive served miss (LRCLIB has no lyrics for this track);
  // "offline" = the fetch bailed on a transport failure (offline/DNS/timeout),
  // NOT recorded as a miss — a distinct, honest caption ("unavailable —
  // offline" vs "No synced lyrics"). lyrics.rs sets the `offline` flag.
  | { status: "loading" | "none" | "offline" }
  | { status: "synced"; lines: LyricLine[]; key: string };

/** The track identity a lyric fetch is keyed on. Consumers compare a synced
 * state's stamped key against the CURRENT track's key before rendering —
 * useLyrics flips to "loading" one render after a track change, and that
 * one-render gap would otherwise pair the new track's header with the old
 * track's lines (and freeze that ghost into an exit animation). */
export function lyricsKeyOf(np: NowPlaying | null): string | null {
  return np && np.player !== "none" && np.title && np.duration_ms > 0
    ? `${np.artist}|${np.title}|${np.album}|${np.duration_ms}`
    : null;
}

/** Fetch + parse synced lyrics per track; "none" is a definitive miss. */
export function useLyrics(np: NowPlaying | null): LyricsState {
  const [state, setState] = useState<LyricsState>({ status: "none" });
  const lastKey = useRef<string | null>(null);
  const key = lyricsKeyOf(np);
  useEffect(() => {
    if (!key || !np) {
      lastKey.current = null;
      setState({ status: "none" });
      return;
    }
    if (key === lastKey.current) return;
    lastKey.current = key;
    setState({ status: "loading" });
    let alive = true;
    void commands.lyrics(np.artist, np.title, np.album, np.duration_ms).then((l) => {
      if (!alive || lastKey.current !== key) return;
      // Cap far beyond any real song (~100 lines) — a pathological LRC file
      // shouldn't turn into thousands of DOM nodes.
      const lines = l.synced ? parseLrc(l.synced, np.duration_ms).slice(0, 600) : [];
      // A transport failure (l.offline) is NOT a miss — surface it as its own
      // state so the caption stays honest and a later track can retry.
      setState(
        lines.length > 0
          ? { status: "synced", lines, key }
          : l.offline
            ? { status: "offline" }
            : { status: "none" },
      );
    });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return state;
}

/** Browsing hands control back three ways, fastest first: the "Now" chip
 * (instant), scrolling back toward the live line into the re-latch band
 * (instant), or wheel idle (this timeout — the fallback, not the only path,
 * so it can sit tighter than the old 3500ms). */
const BROWSE_RESUME_MS = 2000;
/** Fraction of the viewport height around the live offset that counts as
 * "back at now": a wheel tick that lands inside this band while moving
 * TOWARD the live line re-latches auto-follow immediately. Toward-only, so
 * the first tick of a browse (inside the band but moving away) still opens
 * a browse instead of being swallowed. Also the chip's visibility gate —
 * inside the band the live line is on screen and a chip would be noise. */
const RELATCH_BAND = 0.5;

/** Arrival cascade (index.css `.lyrics-entering`): rows radiate outward from
 * the current line. The step is per-row stagger spacing (like the settle
 * ladder's beat constants, it lives off the DUR scale deliberately — it's
 * spacing, not a duration); distance caps so far rows arrive together
 * instead of trailing forever. */
const CASCADE_STEP_MS = 30;
const CASCADE_CAP = 10;
/** Head start so the art view's exhale clears before rows land. */
const CASCADE_BASE_MS = 90; // DUR[1]
/** base + cap*step + row animation (200ms) + slack; also bounds the anchor
 * marker's ignite — keep in sync with the 600ms transition-delay in
 * index.css. The class is removed only AFTER every row animation has
 * finished — ripping it off mid-cascade would snap fill-mode-held rows to
 * full opacity in one frame. */
const ENTRANCE_DONE_MS = 800;

export type LyricsScale = "base" | "focus";

/** Per-scale clothes + physics — same grammar, two rooms. The focus values
 * are the Soundboard design (panel verdict, 2026-07-12): 44px uniform rows
 * (recession by OPACITY, never size — Apple's fullscreen idiom, and size
 * steps would reflow the translate math), current line anchored slightly
 * deeper (0.46), and The Hang's asymmetric mask grafted on — the deep
 * bottom ramp is what makes the room read "a sentence, not a page". */
const SCALE = {
  base: {
    row: "px-3 py-1 text-base leading-normal",
    marker: "h-4 w-[3px]",
    anchor: 0.4,
    mask: "[mask-image:linear-gradient(transparent,black_28px,black_calc(100%-28px),transparent)]",
    chipTop: "top-8",
    chipBottom: "bottom-8",
    // Break-row dots — #79's original tuning: h-8 matches the base lyric row
    // height, 6px dots on gap-1 (two-thirds the dot) read as one countdown.
    breakRow: "h-8 px-3 py-1",
    breakDot: "h-[6px] w-[6px]",
    breakGap: "gap-1",
  },
  focus: {
    row: "px-6 py-3 text-[44px] leading-[1.27] tracking-[-0.01em]",
    marker: "h-9 w-[5px]",
    // 0.46: Thien's Figma pass (2026-07-14) zeroed the ladder's top
    // padding — in the room shrunken by the horizon's new mb-[10vh],
    // that lands the current line back on the original 0.46 seat.
    // Forward context leans on tier-1's brightness (the next line reads
    // through the ramp's start).
    anchor: 0.46,
    // Tuned to the ALIGNED box (Focus seats the lyric column's top on the
    // album's top edge via --art-top, 2026-07-14): ~2 strong + 1 faint
    // lines above the current line, ~2 + 1 faint below — Thien's live
    // rounds settled here ("that line is barely visible anyway, it'd fade
    // cleaner"). The knob if it wants more/less. The min() guards keep
    // the stops from crossing on short viewports (26%+34% ≤ 60% always
    // orders) — the ramps scale instead of inverting there.
    mask: "[mask-image:linear-gradient(transparent,black_min(240px,26%),black_calc(100%-min(320px,34%)),transparent)]",
    chipTop: "top-64",
    chipBottom: "bottom-84",
    // Break-row dots scaled up for the room — bigger dots on a wider gap so
    // the countdown reads at fullscreen distance (the feel knob for the
    // focus break row, 2026-07-13).
    breakRow: "px-6 py-3",
    breakDot: "h-[12px] w-[12px]",
    breakGap: "gap-2",
  },
} as const satisfies Record<LyricsScale, unknown>;

/** Focus-scale recession: opacity tiers by clamped distance from the current
 * line. Tiers (not raw distance) keep the row memo effective — a line
 * advance re-renders only the rows whose tier changed. While the user
 * wheel-browses, every non-current row relaxes to the base muted/80 (you
 * scrolled to READ — the falloff would gray out exactly what you came for)
 * and the tiers re-settle on re-latch. */
function focusTone(tier: number, browsing: boolean): string {
  if (browsing) return "text-muted/80";
  return tier <= 1 ? "text-muted/85" : tier === 2 ? "text-muted/50" : "text-muted/30";
}

/** One lyric line. Memoized so a line advance reconciles the two rows whose
 * `current` flipped instead of the whole list; clicks are delegated to the
 * list container via data-line, so rows carry no per-render closures. */
const LyricLineRow = memo(function LyricLineRow({
  text,
  index,
  current,
  seekable,
  cascadeDelayMs,
  anchor,
  scale,
  tier,
  browsing,
}: {
  text: string;
  index: number;
  current: boolean;
  seekable: boolean;
  /** Stable per mount — distance from the line that was current when the
   * panel mounted. Inert until the container carries .lyrics-entering. */
  cascadeDelayMs: number;
  /** The mount anchor: the ONLY row whose marker is held back for the
   * closing ignite beat. Scoping the hold here (not to whatever row is
   * current) means a mid-entrance line advance ignites the new row's marker
   * instantly — no JS disarm, no engine-dependent delay retargeting. */
  anchor: boolean;
  scale: LyricsScale;
  /** Clamped distance from the current line (focus recession); null at base. */
  tier: number | null;
  browsing: boolean;
}) {
  const Tag = seekable ? "button" : "div";
  const tone = current
    ? "font-medium text-fg"
    : tier === null
      ? "text-muted/80"
      : focusTone(tier, browsing);
  return (
    <Tag
      {...(seekable
        ? {
            type: "button" as const,
            "data-line": index,
            "aria-label": `Seek to ${text}`,
            // Out of the tab order — dozens of lines would otherwise sit
            // between the header and transport; keyboard seek lives on
            // the progress slider.
            tabIndex: -1,
          }
        : {})}
      data-cascade
      {...(anchor ? { "data-anchor": true } : {})}
      style={{ "--cascade-delay": `${cascadeDelayMs}ms` } as React.CSSProperties}
      className={`relative rounded-md text-left transition-colors duration-3 ease-out-tk ${SCALE[scale].row} ${tone} ${
        seekable ? "cursor-pointer hover:bg-fg/5" : ""
      }`}
    >
      {/* Accent lives on the marker, never the text (contrast floor is 3:1). */}
      <span
        aria-hidden
        data-marker
        // background-color joins opacity: an art-change retint must sweep the
        // marker like every accent-painted surface (220ms EASE.out, the
        // progress fills' retint timing) instead of snapping it.
        className={`absolute left-0 top-1/2 -translate-y-1/2 rounded-full bg-accent [transition:opacity_200ms_var(--ease-out-tk),background-color_220ms_var(--ease-out-tk)] ${SCALE[scale].marker} ${
          current ? "opacity-100" : "opacity-0"
        }`}
      />
      {text}
    </Tag>
  );
});

/** Per-dot stagger for the break-row exit: when the vocal resumes the dots
 * fade out RIGHT-TO-LEFT, rightmost first, one step apart — the waveform
 * settle's cadence collapsed to a single axis. Entrance is a plain
 * together-fade (the current state carries no delay). */
const BREAK_DOT_EXIT_STEP_MS = 55; // DUR-adjacent; 4·55 + 220 fade ≈ waveform settle

/** An instrumental-break row: five dots counting down the gap, one igniting
 * per fifth of the break — Apple Music's idle-progress idiom in the living
 * separator's capsule vocabulary (a content event, and the ONE ambient
 * living instance per view stays the Waveform). Accent on the lit dots is
 * the current-line marker's license — content feedback, not chrome; no
 * marker bar (the dots ARE the current indicator). Filled dots keep
 * background-color in the transition so an art-change retint sweeps them
 * like every accent surface.
 *
 * The row is a COLLAPSING line, Apple's "a new line is made for the break":
 * dormant it takes no vertical space (grid-rows 0fr, -mt-1 eating the flex
 * gap the zero-height row would still claim), so you never see reserved
 * emptiness ahead of a break; when the break goes current the line opens
 * (0fr→1fr) and the dots fade in. On the vocal returning the dots fade out
 * right-to-left FIRST (the collapse is delayed ~330ms), then the now-empty
 * line closes. Purely decorative — aria-hidden, no seek target (a break has
 * no lyric to sing to). Scale-aware via SCALE[scale]. */
const BreakRow = memo(function BreakRow({
  line,
  current,
  leadMs,
  scale,
}: {
  line: LyricLine;
  current: boolean;
  leadMs: number;
  scale: LyricsScale;
}) {
  const filled = useBreakDots(line, leadMs, current);
  return (
    <div
      aria-hidden
      // grid-rows 0fr↔1fr is a content-height glide that needs no hardcoded
      // height (works at both scales). Open is immediate; the collapse waits
      // (transition-delay) so the dots' right-to-left fade plays out in a
      // still-open row before the empty line closes. -mt-1 while collapsed
      // cancels the 4px flex-column gap a zero-height row would still take,
      // so a dormant break reads as ordinary line spacing.
      className={`grid ${
        current
          ? "mt-0 grid-rows-[1fr] [transition:grid-template-rows_260ms_var(--ease-out-tk),margin-top_260ms_var(--ease-out-tk)]"
          : "-mt-1 grid-rows-[0fr] [transition:grid-template-rows_260ms_var(--ease-out-tk),margin-top_260ms_var(--ease-out-tk)] [transition-delay:330ms]"
      }`}
    >
      <div className="overflow-hidden">
        <div className={`flex items-center ${SCALE[scale].breakRow} ${SCALE[scale].breakGap}`}>
      {Array.from({ length: BREAK_DOTS }, (_, i) => (
        <span
          key={i}
          aria-hidden
          // The exit stagger lives on the HIDDEN state, so it governs the
          // fade-OUT (current → not-current): rightmost dot leaves first,
          // each BREAK_DOT_EXIT_STEP_MS later. The current state carries no
          // delay, so the fade-IN is a plain together-fade.
          style={
            current
              ? undefined
              : { transitionDelay: `${(BREAK_DOTS - 1 - i) * BREAK_DOT_EXIT_STEP_MS}ms` }
          }
          // A fill is instant at the breakpoint; the 220ms sweep + grow is
          // how "instant" stays smooth (the retint timing, EASE.out). The
          // CURRENT row's unlit dots hold at 75% (bg-muted above the 3:1
          // non-text floor) so you can read which fifth you're in. Hidden
          // dots keep bg-accent so a completed break (all five lit — the
          // common exit) fades out AS accent instead of snapping muted first.
          className={`rounded-full ${SCALE[scale].breakDot} [transition:background-color_220ms_var(--ease-out-tk),scale_220ms_var(--ease-out-tk),opacity_220ms_var(--ease-out-tk)] ${
            !current
              ? "scale-90 bg-accent opacity-0"
              : i < filled
                ? "scale-100 bg-accent opacity-100"
                : "scale-90 bg-muted opacity-75"
          }`}
        />
      ))}
        </div>
      </div>
    </div>
  );
});

export function LyricsPanel({
  lines,
  seekable,
  leadMs,
  entrance = false,
  scale = "base",
}: {
  lines: LyricLine[];
  seekable: boolean;
  leadMs: number;
  /** True when this mount is a real within-expanded arrival (the user was
   * watching the big-art fallback) — plays the anchor-outward cascade and
   * holds the accent marker back as the closing beat. */
  entrance?: boolean;
  scale?: LyricsScale;
}) {
  const idx = useLyricIndex(lines, leadMs);
  const viewportRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [autoOffset, setAutoOffset] = useState(0);
  // Wheel-scrolling pauses auto-follow; it resumes via the "Now" chip,
  // scrolling back into the re-latch band, or a short idle (see RELATCH_BAND
  // / BROWSE_RESUME_MS).
  const [manualOffset, setManualOffset] = useState<number | null>(null);
  const resumeTimer = useRef<number | undefined>(undefined);

  // The anchor line at mount — cascade delays radiate from it, stable across
  // re-renders so a mid-entrance line advance can't reshuffle delays. The
  // entrance ends by timeout only (after every row animation has finished);
  // the marker-hold is scoped to the anchor row via data-anchor, so nothing
  // needs disarming when the song advances mid-cascade.
  const entranceIdx = useRef(idx);
  const [entering, setEntering] = useState(entrance);
  useEffect(() => {
    if (!entering) return;
    const t = window.setTimeout(() => setEntering(false), ENTRANCE_DONE_MS);
    return () => window.clearTimeout(t);
  }, [entering]);

  // The mount anchor must not animate: the offsetTop/clientHeight reads in
  // the layout effect force a reflow at translateY(0) BEFORE the offset
  // lands, which arms the transform transition and slides the whole list
  // ~hundreds of px on mount. Transition class only after the first paint.
  const [anchored, setAnchored] = useState(false);
  useEffect(() => setAnchored(true), []);

  // Head/tail scroll room so the FIRST and LAST lines can rise to the anchor
  // band instead of jamming against the top/bottom frame with nothing past
  // them (Thien, 2026-07-12 — focus mode pinned the opening/closing lines to
  // the edges). Sized to the anchor: padTop lets the first line rest where
  // every other current line does; padBottom lets the last line reach it. The
  // offset clamp still forbids over-scroll, so the ends stop exactly at the
  // anchor. Focus only — the compact expanded view (≈296px) is too short to
  // spend ~46% of itself on lead-in; it keeps the tight 16px ends. Re-measured
  // on resize (the fullscreen room can change monitors). */
  const [pad, setPad] = useState<{ top: number; bottom: number }>({ top: 16, bottom: 16 });
  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    if (scale !== "focus") {
      setPad({ top: 16, bottom: 16 });
      return;
    }
    const measure = () => {
      const h = viewport.clientHeight;
      const anchor = h * SCALE.focus.anchor;
      setPad({ top: Math.round(anchor), bottom: Math.round(h - anchor) });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(viewport);
    return () => ro.disconnect();
  }, [scale]);

  const maxOffset = (): number => {
    const viewport = viewportRef.current;
    const list = listRef.current;
    if (!viewport || !list) return 0;
    return Math.max(list.scrollHeight - viewport.clientHeight, 0);
  };

  // Anchor the current line SCALE.anchor down the viewport via a
  // compositor-friendly translate. Rounded — fractional offsets put text off
  // the pixel grid.
  const applyAnchor = () => {
    const viewport = viewportRef.current;
    const list = listRef.current;
    if (!viewport || !list) return;
    const line = list.children[Math.max(idx, 0)] as HTMLElement | undefined;
    if (!line) return;
    const anchor = viewport.clientHeight * SCALE[scale].anchor;
    const raw = idx < 0 ? 0 : line.offsetTop + line.offsetHeight / 2 - anchor;
    setAutoOffset(Math.round(Math.min(Math.max(raw, 0), maxOffset())));
  };
  const applyAnchorRef = useRef(applyAnchor);
  applyAnchorRef.current = applyAnchor;

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useLayoutEffect(() => applyAnchorRef.current(), [idx, lines, scale, pad.top, pad.bottom]);

  // Re-anchor on any list-height change too, not just line advance. A break
  // row opens/closes over 260ms (grid-rows glide); anchoring only at the
  // advance would measure that mid-animation — scrollHeight short by the
  // break's height — and never recompute, stranding the break's dots
  // off-screen for its whole duration (worst at the outro, where the break
  // is the last row). The observer keeps autoOffset glued to the settling
  // layout; manualOffset still wins the displayed offset while browsing.
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const ro = new ResizeObserver(() => applyAnchorRef.current());
    ro.observe(list);
    return () => ro.disconnect();
  }, []);

  useEffect(() => () => window.clearTimeout(resumeTimer.current), []);

  // Track change swaps `lines` — drop any in-progress browse so the new
  // track doesn't render scrolled to the old track's arbitrary offset.
  useEffect(() => {
    setManualOffset(null);
    window.clearTimeout(resumeTimer.current);
  }, [lines]);

  const browsing = manualOffset !== null;
  const offset = manualOffset ?? autoOffset;
  const band = (viewportRef.current?.clientHeight ?? 0) * RELATCH_BAND;
  // Where "now" sits relative to the browse — drives the chip's edge/arrow.
  const nowBelow = browsing && autoOffset > (manualOffset as number);

  const relatch = () => {
    setManualOffset(null);
    window.clearTimeout(resumeTimer.current);
  };

  const onWheel = (e: React.WheelEvent) => {
    const prev = manualOffset ?? autoOffset;
    const next = Math.round(Math.min(Math.max(prev + e.deltaY, 0), maxOffset()));
    // Magnetic re-latch: arriving inside the band while closing on the live
    // line IS the resume gesture — no idle wait. (When not browsing, prev is
    // autoOffset and the distance can only grow, so this never traps the
    // opening tick.)
    if (Math.abs(next - autoOffset) < Math.abs(prev - autoOffset) && Math.abs(next - autoOffset) <= band) {
      relatch();
      return;
    }
    setManualOffset(next);
    window.clearTimeout(resumeTimer.current);
    resumeTimer.current = window.setTimeout(() => setManualOffset(null), BROWSE_RESUME_MS);
  };

  return (
    <div
      ref={viewportRef}
      onWheel={onWheel}
      className={`relative min-h-0 flex-1 overflow-hidden ${SCALE[scale].mask}`}
      aria-label="Lyrics"
    >
      <div
        ref={listRef}
        onClick={(e) => {
          if (!seekable) return;
          const row = (e.target as HTMLElement).closest("[data-line]");
          const line = row ? lines[Number(row.getAttribute("data-line"))] : undefined;
          if (!line) return;
          // Land the lead ahead of the line start: the highlight maps position
          // p to the line whose t ≤ p + lead, so seeking to t itself flips the
          // highlight to the successor whenever the gap to it is under the
          // lead. [t - lead, next.t - lead) is the only interval guaranteed to
          // highlight the clicked line — and the runway into the vocal is what
          // a click-to-sing-along wants anyway. (The 0-clamp voids the
          // guarantee for lines inside the first lead-width of the track —
          // there is no earlier position to seek to; a neighboring intro line
          // may highlight instead.)
          commands.seekAbs(Math.max(line.t - leadMs, 0));
          relatch(); // hand control back to auto-follow
        }}
        className={`flex flex-col gap-1 will-change-transform ${
          browsing || !anchored ? "" : "[transition:transform_220ms_var(--ease-in-out-tk)]"
        } ${entering ? "lyrics-entering" : ""}`}
        style={{ transform: `translateY(${-offset}px)`, paddingTop: pad.top, paddingBottom: pad.bottom }}
      >
        {lines.map((line, i) => {
          const anchor = i === Math.max(entranceIdx.current, 0);
          const cascadeDelayMs =
            CASCADE_BASE_MS +
            Math.min(Math.abs(i - Math.max(entranceIdx.current, 0)), CASCADE_CAP) * CASCADE_STEP_MS;
          // Synthesized instrumental-break rows (line.end set) render the
          // five-dot countdown; sung lines render as text.
          return line.end !== undefined ? (
            <BreakRow key={`${line.t}-${i}`} line={line} current={i === idx} leadMs={leadMs} scale={scale} />
          ) : (
            <LyricLineRow
              key={`${line.t}-${i}`}
              text={line.text}
              index={i}
              current={i === idx}
              seekable={seekable}
              scale={scale}
              tier={scale === "focus" ? Math.min(Math.abs(i - Math.max(idx, 0)), 3) : null}
              browsing={browsing}
              anchor={anchor}
              cascadeDelayMs={cascadeDelayMs}
            />
          );
        })}
      </div>
      {/* Return-to-now chip — neutral chrome (accent stays on the line
       * marker), on the edge the live line sits past, outside the re-latch
       * band only (inside it the line is on screen and a wheel-back
       * re-latches anyway). 32px offsets clear the 28px mask fade. Exits
       * plain with the browse, per the house transition rule. */}
      {browsing && Math.abs((manualOffset as number) - autoOffset) > band && (
        <button
          type="button"
          aria-label="Now — back to the current line"
          onClick={relatch}
          className={`absolute left-1/2 z-10 flex -translate-x-1/2 items-center rounded-full border border-border/10 bg-surface-2/90 p-1.5 leading-none text-muted [transition:color_140ms_var(--ease-out-tk),scale_90ms_var(--ease-out-tk)] [animation:caption-in_140ms_var(--ease-out-tk)_both] hover:text-fg active:scale-95 ${
            nowBelow ? SCALE[scale].chipBottom : SCALE[scale].chipTop
          }`}
        >
          <svg
            width="9"
            height="9"
            viewBox="0 0 10 10"
            fill="none"
            aria-hidden
            className={nowBelow ? "" : "rotate-180"}
          >
            <path d="M2 3.5 5 6.5 8 3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      )}
    </div>
  );
}
