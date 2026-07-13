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
import { currentLineIndex, msUntilNextLine, parseLrc, type LyricLine } from "./lib/lrc";
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

export type LyricsState =
  | { status: "loading" | "none" }
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
      const lines = l.synced ? parseLrc(l.synced).slice(0, 600) : [];
      setState(lines.length > 0 ? { status: "synced", lines, key } : { status: "none" });
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
 * 240px bottom ramp is what makes the room read "a sentence, not a page". */
const SCALE = {
  base: {
    row: "px-3 py-1 text-base leading-normal",
    marker: "h-4 w-[3px]",
    anchor: 0.4,
    mask: "[mask-image:linear-gradient(transparent,black_28px,black_calc(100%-28px),transparent)]",
    chipTop: "top-8",
    chipBottom: "bottom-8",
  },
  focus: {
    row: "px-6 py-3 text-[44px] leading-[1.27] tracking-[-0.01em]",
    marker: "h-9 w-[5px]",
    anchor: 0.46,
    mask: "[mask-image:linear-gradient(transparent,black_120px,black_calc(100%-240px),transparent)]",
    chipTop: "top-36",
    chipBottom: "bottom-64",
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

  const maxOffset = (): number => {
    const viewport = viewportRef.current;
    const list = listRef.current;
    if (!viewport || !list) return 0;
    return Math.max(list.scrollHeight - viewport.clientHeight, 0);
  };

  // Anchor the current line 40% from the top via a compositor-friendly
  // translate. Rounded — fractional offsets put text off the pixel grid.
  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    const list = listRef.current;
    if (!viewport || !list) return;
    const line = list.children[Math.max(idx, 0)] as HTMLElement | undefined;
    if (!line) return;
    const anchor = viewport.clientHeight * SCALE[scale].anchor;
    const raw = idx < 0 ? 0 : line.offsetTop + line.offsetHeight / 2 - anchor;
    setAutoOffset(Math.round(Math.min(Math.max(raw, 0), maxOffset())));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idx, lines, scale]);

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
        className={`flex flex-col gap-1 py-4 will-change-transform ${
          browsing || !anchored ? "" : "[transition:transform_220ms_var(--ease-in-out-tk)]"
        } ${entering ? "lyrics-entering" : ""}`}
        style={{ transform: `translateY(${-offset}px)` }}
      >
        {lines.map((line, i) => (
          <LyricLineRow
            key={`${line.t}-${i}`}
            text={line.text}
            index={i}
            current={i === idx}
            seekable={seekable}
            scale={scale}
            tier={scale === "focus" ? Math.min(Math.abs(i - Math.max(idx, 0)), 3) : null}
            browsing={browsing}
            anchor={i === Math.max(entranceIdx.current, 0)}
            cascadeDelayMs={
              CASCADE_BASE_MS +
              Math.min(Math.abs(i - Math.max(entranceIdx.current, 0)), CASCADE_CAP) * CASCADE_STEP_MS
            }
          />
        ))}
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
