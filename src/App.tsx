import { memo, useEffect, useLayoutEffect, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { MorphIcon } from "./icons/MorphIcon";
import { useSeekTick } from "./icons/useSeekTick";
import { commands, onNowPlaying } from "./lib/backend";
import { currentLineIndex, msUntilNextLine, parseLrc, VOCAL_LEAD_MS, type LyricLine } from "./lib/lrc";
import { extractAccent } from "./lib/palette";
import * as posClock from "./lib/posClock";
import { initReactive } from "./lib/reactive";
import { DUR, EASE } from "./lib/tokens";
import { SeparatorDot, Waveform } from "./Waveform";
import type { NowPlaying } from "./types";

// Keep in sync with SEEK_STEP_MS in src-tauri/src/lib.rs (global hotkeys).
const SEEK_STEP_MS = 10_000;

type Mode = "pill" | "card" | "expanded";

/** Native window size per mode — the window grows out of its docked corner
 * (200ms EASE.inOut on the Rust side) while the content morphs. */
const MODE_SIZES: Record<Mode, [number, number]> = {
  pill: [300, 48],
  card: [380, 132], // anchored-cluster handoff: 52px art row, full-width progress, bottom transport
  expanded: [380, 440], // lyrics home; big-art fallback gets breathing room
};

function fmt(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** Current lyric line by SCHEDULING, not sampling: one timeout armed for the
 * next line boundary, recomputed on every kernel anchor event (seek, pause,
 * track change, accepted push). On fire the index is re-derived from the
 * clock — never blind-incremented — so throttled webview timers can only
 * delay a transition, never derail it. Transitions land with timer precision
 * instead of on a 250ms sampling grid. */
function useLyricIndex(lines: LyricLine[], leadMs: number): number {
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

/** Fields that change what the React tree shows — position fields excluded,
 * they live in posClock and would otherwise re-render the whole app per emit. */
const IDENTITY_FIELDS = [
  "app_id",
  "player",
  "title",
  "artist",
  "album",
  "status",
  "duration_ms",
  "can_seek",
  "art_id",
] as const satisfies readonly (keyof NowPlaying)[];

function sameIdentity(a: NowPlaying | null, b: NowPlaying): boolean {
  return a !== null && IDENTITY_FIELDS.every((k) => a[k] === b[k]);
}

function useArt(artId: string | null): string | null {
  const [url, setUrl] = useState<string | null>(null);
  const lastId = useRef<string | null>(null);
  useEffect(() => {
    if (artId === lastId.current) return;
    if (!artId) {
      lastId.current = null;
      setUrl(null);
      return;
    }
    let alive = true;
    void commands.art(artId).then((u) => {
      if (!alive) return;
      setUrl(u);
      // Only latch on success — a null (cache already advanced past this id)
      // retries on the next payload instead of leaving the cover blank.
      if (u) lastId.current = artId;
    });
    return () => {
      alive = false;
    };
  }, [artId]);
  return artId ? url : null;
}

type LyricsState =
  | { status: "loading" | "none" }
  | { status: "synced"; lines: LyricLine[]; key: string };

/** The track identity a lyric fetch is keyed on. Consumers compare a synced
 * state's stamped key against the CURRENT track's key before rendering —
 * useLyrics flips to "loading" one render after a track change, and that
 * one-render gap would otherwise pair the new track's header with the old
 * track's lines (and freeze that ghost into an exit animation). */
function lyricsKeyOf(np: NowPlaying | null): string | null {
  return np && np.player !== "none" && np.title && np.duration_ms > 0
    ? `${np.artist}|${np.title}|${np.album}|${np.duration_ms}`
    : null;
}

/** Fetch + parse synced lyrics per track; "none" is a definitive miss. */
function useLyrics(np: NowPlaying | null): LyricsState {
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
}) {
  const Tag = seekable ? "button" : "div";
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
      className={`relative rounded-md px-3 py-1 text-left text-base leading-normal transition-colors duration-3 ease-out-tk ${
        current ? "font-medium text-fg" : "text-muted/80"
      } ${seekable ? "cursor-pointer hover:bg-fg/5" : ""}`}
    >
      {/* Accent lives on the marker, never the text (contrast floor is 3:1). */}
      <span
        aria-hidden
        data-marker
        className={`absolute left-0 top-1/2 h-4 w-[3px] -translate-y-1/2 rounded-full bg-accent transition-opacity duration-3 ease-out-tk ${
          current ? "opacity-100" : "opacity-0"
        }`}
      />
      {text}
    </Tag>
  );
});

function LyricsPanel({
  lines,
  seekable,
  leadMs,
  entrance = false,
}: {
  lines: LyricLine[];
  seekable: boolean;
  leadMs: number;
  /** True when this mount is a real within-expanded arrival (the user was
   * watching the big-art fallback) — plays the anchor-outward cascade and
   * holds the accent marker back as the closing beat. */
  entrance?: boolean;
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
    const anchor = viewport.clientHeight * 0.4;
    const raw = idx < 0 ? 0 : line.offsetTop + line.offsetHeight / 2 - anchor;
    setAutoOffset(Math.round(Math.min(Math.max(raw, 0), maxOffset())));
  }, [idx, lines]);

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
      className="relative min-h-0 flex-1 overflow-hidden [mask-image:linear-gradient(transparent,black_28px,black_calc(100%-28px),transparent)]"
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
          className={`absolute left-1/2 z-10 flex -translate-x-1/2 items-center gap-1 rounded-full border border-border/10 bg-surface-2/90 py-1 pl-2.5 pr-2 text-[11px] font-medium leading-none text-muted transition duration-2 ease-out-tk [animation:caption-in_140ms_var(--ease-out-tk)_both] hover:text-fg active:scale-95 ${
            nowBelow ? "bottom-8" : "top-8"
          }`}
        >
          Now
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

/** Retint the accent layer from the current cover; house accent when absent. */
function useArtAccent(artUrl: string | null): void {
  useEffect(() => {
    const root = document.documentElement;
    if (!artUrl) {
      root.style.removeProperty("--accent");
      return;
    }
    let alive = true;
    void extractAccent(artUrl).then((rgb) => {
      if (!alive) return;
      if (rgb) root.style.setProperty("--accent", rgb);
      else root.style.removeProperty("--accent");
    });
    return () => {
      alive = false;
    };
  }, [artUrl]);
}

function IconButton({
  label,
  onClick,
  onPointerDown,
  disabled,
  size = "md",
  children,
}: {
  label: string;
  onClick: (e: React.MouseEvent<HTMLButtonElement>) => void;
  onPointerDown?: (e: React.PointerEvent<HTMLButtonElement>) => void;
  disabled?: boolean;
  size?: "xs" | "sm" | "md";
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      onPointerDown={onPointerDown}
      className={`grid place-items-center rounded-md text-fg transition duration-2 ease-out-tk hover:bg-fg/10 active:scale-95 disabled:pointer-events-none disabled:opacity-40 ${
        size === "xs" ? "h-6 w-6" : size === "sm" ? "h-7 w-7" : "h-8 w-8"
      }`}
    >
      {children}
    </button>
  );
}

const PLAYER_NAMES: Record<NowPlaying["player"], string> = {
  apple_music: "Apple Music",
  spotify: "Spotify",
  other: "Media",
  none: "",
};

/** Hover hold before the full-text tooltip shows — reading intent, not a
 * flyby. Native `title` waits about this long; this is the styled stand-in. */
const TIP_DELAY_MS = 500;

/** Truncating text line that reveals its full value in a mini tooltip after
 * a hover hold — only when the text is actually clipped, measured at hover
 * time so mode resizes can't leave a stale flag. The full string is already
 * in the accessibility tree (truncate is a visual clip), so the tooltip is
 * aria-hidden decoration, not the AT path. Chrome rules apply: raised
 * neutral surface, no accent. */
function TruncateTip({ text, className }: { text: string; className: string }) {
  const [open, setOpen] = useState(false);
  const timer = useRef<number | null>(null);
  const clear = () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
  };
  useEffect(() => clear, []);
  const reducedMotion = useReducedMotion();
  return (
    <span className="relative block min-w-0">
      <span
        className={`block truncate ${className}`}
        onMouseEnter={(e) => {
          const el = e.currentTarget;
          clear();
          // +1 forgives subpixel rounding: a line clipped by half a pixel
          // isn't hiding anything worth a tooltip.
          timer.current = window.setTimeout(() => setOpen(el.scrollWidth > el.clientWidth + 1), TIP_DELAY_MS);
        }}
        onMouseLeave={() => {
          clear();
          setOpen(false);
        }}
      >
        {text}
      </span>
      <AnimatePresence>
        {open && (
          <motion.span
            aria-hidden
            initial={{ opacity: 0, y: -2 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            transition={{
              duration: reducedMotion ? 0 : DUR[2] / 1000,
              ease: [...EASE.out] as [number, number, number, number],
            }}
            // w-max up to the window's width minus the header's left gutter
            // (44px art + gaps) — long strings wrap instead of truncating
            // again inside their own tooltip.
            className="absolute left-0 top-full z-20 mt-1.5 w-max max-w-[250px] whitespace-normal break-words rounded-md border border-border/10 bg-surface-2 px-2 py-1 text-xs leading-4 text-fg shadow-lg shadow-black/40"
          >
            {text}
          </motion.span>
        )}
      </AnimatePresence>
    </span>
  );
}

/** One button of the anchored mode cluster: expand/contract corner brackets —
 * action verbs, not container pictograms (v1's pill/card/lyrics glyphs read
 * as abstract shapes at 13px). Glyphs are fixed per seat now; the slot
 * registry + layoutId stay so a future remount or seat change still morphs/
 * glides instead of popping. End-of-ladder buttons DISABLE in place (opacity
 * fade, 140ms EASE.out) — never unmount, which would shift the sibling.
 * pointer-events-none makes a dead button TRANSPARENT to hit-testing, so the
 * cluster wrapper swallows mousedown (see ModeCluster) — otherwise a press
 * on it would fall through to the root drag handler and move the window.
 * The click guard below covers keyboard activation: aria-disabled leaves the
 * button focusable, so Enter/Space must explicitly no-op. */
function ModeButton({
  to,
  label,
  slot,
  disabled = false,
  onClick,
}: {
  to: "expand" | "contract";
  label: string;
  slot: "mode-primary" | "mode-secondary";
  disabled?: boolean;
  onClick: () => void;
}) {
  const reducedMotion = useReducedMotion();
  return (
    <motion.button
      type="button"
      layoutId={slot}
      // motion owns opacity inline (layoutId projection writes it), so the
      // disabled fade must live here — an opacity-* class would be overridden.
      animate={{ opacity: disabled ? 0.28 : 1 }}
      transition={{
        layout: {
          duration: reducedMotion ? 0 : DUR[3] / 1000,
          ease: [...EASE.inOut] as [number, number, number, number],
        },
        opacity: {
          duration: reducedMotion ? 0 : DUR[2] / 1000,
          ease: [...EASE.out] as [number, number, number, number],
        },
        // Without this, whileTap's scale runs on motion's default spring —
        // press feedback must ride the tokens like every other button.
        scale: {
          duration: reducedMotion ? 0 : DUR[1] / 1000,
          ease: [...EASE.out] as [number, number, number, number],
        },
      }}
      whileTap={{ scale: reducedMotion || disabled ? 1 : 0.95 }}
      aria-label={label}
      title={label}
      aria-disabled={disabled || undefined}
      onClick={() => {
        if (!disabled) onClick();
      }}
      className={`grid h-7 w-7 place-items-center rounded-md transition-colors duration-2 ease-out-tk ${
        disabled ? "pointer-events-none text-muted" : "text-fg hover:bg-fg/10"
      }`}
    >
      <MorphIcon name={to} size={13} slot={slot} dur={DUR[3]} ease={EASE.inOut} />
    </motion.button>
  );
}

/** Ordered mode ladder the anchored cluster steps through. */
const MODE_ORDER: readonly Mode[] = ["pill", "card", "expanded"];

/**
 * The anchored mode cluster (design handoff 2026-07-08): collapse + expand
 * live at the bottom-right corner — the corner dock.rs resizes out of — so
 * when the window is docked bottom-right the buttons occupy the same screen
 * pixels in every mode: park the cursor once, step the whole ladder.
 * Rendered ONCE in the app root, outside the mode-keyed remount, so it never
 * fades or rescales with the content morph — chrome holds still (the
 * expanded view's hoisted-chrome rule, promoted app-wide).
 *
 * Positioned in WINDOW coordinates (this div lives in the p-1.5 root, not the
 * shell): right-3.5 = 14px window = 8px from the shell edge; bottom-4 = 16px
 * window = the handoff's 10px shell seat. That seat is CONSTANT in every mode
 * (no mode-dependent bottom) — docked bottom-right the window's bottom edge is
 * pinned, so the cluster holds the exact same screen pixels across
 * pill/card/expanded: the fixed-point guarantee, no drift even while hidden
 * (ANIMATIONS.md §2 — "opacity only, zero transforms; the fixed-point
 * guarantee includes the hidden state"). In the 36px pill shell a 28px button
 * at this seat overhangs the shell top by 2px into the transparent window pad
 * — invisible (the 13px glyph stays centered well inside the shell), and the
 * price of the fixed point. Hidden at rest (opacity 0, pointer-events none),
 * it reveals on widget hover (group/widget): opacity 0→1 over 140ms EASE.out,
 * no motion. Also reveals on focus-within — the buttons stay in the Tab
 * order the whole time (hidden ≠ inert), so a hover-only reveal would strand
 * keyboard users on an invisible, invisibly-outlined control (quick-review
 * catch, 2026-07-08).
 */
function ModeCluster({ mode, onStep }: { mode: Mode; onStep: (d: -1 | 1) => void }) {
  return (
    <div
      className="pointer-events-none absolute bottom-4 right-3.5 z-20 flex items-center gap-1 opacity-0 transition-opacity duration-2 ease-out-tk group-hover/widget:pointer-events-auto group-hover/widget:opacity-100 group-focus-within/widget:pointer-events-auto group-focus-within/widget:opacity-100"
      // Swallow mousedown: pointer-events-none makes a DISABLED button
      // transparent to hit-testing, so without this a press on it (or the
      // 4px gap between the buttons) would fall through to the root drag
      // handler and move the window — from a control the user read as a
      // click target.
      onMouseDown={(e) => e.stopPropagation()}
    >
      <ModeButton
        to="contract"
        label={mode === "expanded" ? "Collapse to card" : "Collapse to pill"}
        slot="mode-secondary"
        disabled={mode === "pill"}
        onClick={() => onStep(-1)}
      />
      <ModeButton
        to="expand"
        label={mode === "pill" ? "Expand to card" : "Expand to lyrics"}
        slot="mode-primary"
        disabled={mode === "expanded"}
        onClick={() => onStep(1)}
      />
    </div>
  );
}

/** The marquee morph, fired optimistically on pointerdown — the morph IS the
 * press response (SMTC command bools lie; the next emit is the
 * reconciliation). Diff-suppressed emits mean a silently failed command never
 * sends a correcting payload, so a timeout falls back to the prop. */
function PlayPauseButton({
  playing,
  iconSize = 18,
  size = "md",
}: {
  playing: boolean;
  iconSize?: number;
  size?: "xs" | "sm" | "md";
}) {
  const [optimistic, setOptimistic] = useState<boolean | null>(null);
  useEffect(() => setOptimistic(null), [playing]);
  useEffect(() => {
    if (optimistic === null) return;
    const t = window.setTimeout(() => setOptimistic(null), 2000);
    return () => window.clearTimeout(t);
  }, [optimistic]);
  const shown = optimistic ?? playing;
  return (
    <IconButton
      size={size}
      label={shown ? "Pause" : "Play"}
      // Primary button only — a right/middle click or an aborted press never
      // produces the click that fires the command, and the icon would sit
      // wrong until the 2s fallback.
      onPointerDown={(e) => e.button === 0 && setOptimistic(!shown)}
      onClick={(e) => {
        // Keyboard activation (e.detail === 0) never fires pointerdown —
        // give Enter/Space the same optimistic morph pointer users get.
        if (e.detail === 0) setOptimistic(!shown);
        commands.playPause();
      }}
    >
      <MorphIcon name={shown ? "pause" : "play"} size={iconSize} dur={DUR[2]} ease={EASE.out} />
    </IconButton>
  );
}

function SeekButton({
  dir,
  seekable,
  player,
  size,
}: {
  dir: -1 | 1;
  seekable: boolean;
  player: NowPlaying["player"];
  size?: "xs" | "sm" | "md";
}) {
  const { scope, tick } = useSeekTick(dir);
  return (
    <IconButton
      size={size}
      label={
        seekable
          ? dir < 0
            ? "Back 10 seconds"
            : "Forward 10 seconds"
          : `Seeking not supported by ${PLAYER_NAMES[player]}`
      }
      disabled={!seekable}
      onPointerDown={(e) => e.button === 0 && void tick()}
      onClick={(e) => {
        if (e.detail === 0) void tick(); // keyboard gets the tick too
        commands.seekRel(dir * SEEK_STEP_MS);
      }}
    >
      <span ref={scope} className="grid place-items-center will-change-transform">
        <MorphIcon name={dir < 0 ? "seekBack" : "seekFwd"} size={17} />
      </span>
    </IconButton>
  );
}

/** rAF driver shared by the progress surfaces: writes the fill's scaleX every
 * ~90ms (every frame while scrubbing) and the elapsed label + slider aria only
 * on integer-second changes — position never enters React state (the Waveform
 * pattern). Paused frames cost one compare; a hidden window stops rAF cold.
 * React never renders the rAF-owned transform/aria/label, so re-renders can't
 * reset them to stale values. */
function useProgressDom(
  durationMs: number,
  active: boolean,
  bar: React.RefObject<HTMLDivElement | null>,
  fill: React.RefObject<HTMLDivElement | null>,
  time?: React.RefObject<HTMLSpanElement | null>,
  drag?: React.RefObject<number | null>,
): void {
  useLayoutEffect(() => {
    let raf = 0;
    let last = 0;
    let lastFrac = -1;
    let lastSec = -1;
    const write = () => {
      const dragFrac = drag?.current ?? null;
      const pos = dragFrac !== null ? dragFrac * durationMs : posClock.now();
      const frac = durationMs > 0 ? Math.min(pos / durationMs, 1) : 0;
      if (fill.current && Math.abs(frac - lastFrac) > 0.0004) {
        lastFrac = frac;
        fill.current.style.transform = `scaleX(${frac})`;
      }
      const sec = Math.floor(pos / 1000);
      if (sec !== lastSec) {
        lastSec = sec;
        if (time?.current) time.current.textContent = fmt(pos);
        bar.current?.setAttribute("aria-valuenow", String(Math.round(pos)));
        bar.current?.setAttribute("aria-valuetext", `${fmt(pos)} of ${fmt(durationMs)}`);
      }
    };
    write(); // before first paint — the fill has NO baseline style (see JSX)
    if (!active) {
      // Frozen clock: no loop at all (the pre-PR paused cost was zero, keep
      // it zero). Kernel notifications repaint paused seeks/scrubs.
      return posClock.subscribe(write);
    }
    const loop = (t: number) => {
      raf = requestAnimationFrame(loop);
      // ~10fps is plenty for playback; every frame while scrubbing.
      if (drag?.current == null && t - last < 90) return;
      last = t;
      write();
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [durationMs, active, bar, fill, time, drag]);
}

function ProgressBar({ np }: { np: NowPlaying }) {
  const barRef = useRef<HTMLDivElement>(null);
  const fillRef = useRef<HTMLDivElement>(null);
  const timeRef = useRef<HTMLSpanElement>(null);
  // While dragging, the bar tracks the pointer; the seek commits on release.
  // Mirrored into a ref so the rAF loop reads it without effect churn.
  const [dragFrac, setDragFrac] = useState<number | null>(null);
  const dragRef = useRef<number | null>(null);
  dragRef.current = dragFrac;
  const seekable = np.can_seek && np.duration_ms > 0;
  useProgressDom(
    np.duration_ms,
    np.status === "playing" || dragFrac !== null,
    barRef,
    fillRef,
    timeRef,
    dragRef,
  );

  const fracFromPointer = (clientX: number): number => {
    const r = barRef.current!.getBoundingClientRect();
    return Math.min(Math.max((clientX - r.left) / r.width, 0), 1);
  };

  return (
    <div className="flex items-center gap-2">
      {/* No JSX children: the rAF driver owns this text (a rendered child
          would let drag re-renders clobber the drag-preview time). The
          pre-paint write() populates it at mount. */}
      {/* Hug width: the elapsed label's left edge sits flush on the album
          cover's left edge. tabular-nums keeps the width stable within a
          digit count, so the track edge only moves at e.g. 9:59→10:00. */}
      <span ref={timeRef} className="text-[11px] leading-4 tabular-nums text-muted" />
      <div
        ref={barRef}
        role={seekable ? "slider" : "progressbar"}
        aria-label="Track position"
        aria-valuemin={0}
        aria-valuemax={np.duration_ms}
        tabIndex={seekable ? 0 : -1}
        onKeyDown={(e) => {
          if (!seekable) return;
          if (e.key === "ArrowLeft") commands.seekRel(-5000);
          if (e.key === "ArrowRight") commands.seekRel(5000);
          if (e.key === "Home") commands.seekAbs(0);
          if (e.key === "End") commands.seekAbs(np.duration_ms);
        }}
        onPointerDown={(e) => {
          if (!seekable || !barRef.current) return;
          try {
            e.currentTarget.setPointerCapture(e.pointerId);
          } catch {
            // Pointer already gone (e.g. released between events) — a plain
            // click-to-seek still commits via onPointerUp.
          }
          setDragFrac(fracFromPointer(e.clientX));
        }}
        onPointerMove={(e) => {
          if (dragFrac === null || !barRef.current) return;
          setDragFrac(fracFromPointer(e.clientX));
        }}
        onPointerUp={() => {
          if (dragFrac === null) return;
          commands.seekAbs(Math.round(dragFrac * np.duration_ms));
          setDragFrac(null);
        }}
        onPointerCancel={() => setDragFrac(null)}
        className={`group relative h-3 flex-1 touch-none ${seekable ? "cursor-pointer" : ""}`}
      >
        <div
          className={`absolute inset-x-0 top-1/2 -translate-y-1/2 overflow-hidden rounded-full bg-fg/10 transition-[height] duration-2 ease-out-tk ${
            dragFrac !== null ? "h-[5px]" : seekable ? "h-[3px] group-hover:h-[5px]" : "h-[3px]"
          }`}
        >
          {/* Fill scales on the compositor instead of animating width (layout).
              The rAF driver's pre-paint write() styles this before the first
              frame, so it needs NO baseline — and must have none: a Tailwind
              scale-x-0 class compiles to the native CSS `scale` property in
              v4, which MULTIPLIES with the driver's inline transform and
              pinned this fill at zero width forever (found live 2026-07-08);
              an inline style baseline would let drag re-renders clobber the
              driver's writes (the PR-3 label lesson). */}
          <div
            ref={fillRef}
            className={`h-full w-full origin-left rounded-full bg-accent will-change-transform ${
              dragFrac === null
                ? "[transition:transform_90ms_var(--ease-out-tk),background-color_220ms_var(--ease-out-tk)]"
                : "[transition:background-color_220ms_var(--ease-out-tk)]"
            }`}
          />
        </div>
      </div>
      <span className="text-[11px] leading-4 tabular-nums text-muted">{fmt(np.duration_ms)}</span>
    </div>
  );
}

/** Non-interactive pill progress hairline — same rAF driver, aria only. */
function Hairline({ np }: { np: NowPlaying }) {
  const barRef = useRef<HTMLDivElement>(null);
  const fillRef = useRef<HTMLDivElement>(null);
  useProgressDom(np.duration_ms, np.status === "playing", barRef, fillRef);
  return (
    <div
      ref={barRef}
      role="progressbar"
      aria-label="Track position"
      aria-valuemin={0}
      aria-valuemax={np.duration_ms}
      className="absolute inset-x-0 bottom-0 h-[2px] bg-fg/10"
    >
      {/* Same no-baseline rule as ProgressBar's fill — see the comment there. */}
      <div
        ref={fillRef}
        className="h-full w-full origin-left bg-accent will-change-transform [transition:transform_90ms_var(--ease-out-tk),background-color_220ms_var(--ease-out-tk)]"
      />
    </div>
  );
}

/** The pill's resting elapsed label — rAF-driven exactly like the card's
 * (position never enters React state; the Waveform pattern). Fades out
 * opacity-only on widget hover (ANIMATIONS.md §3) so the title/artist line
 * never reflows as the controls take the corner. aria-hidden: the pill's
 * Hairline progressbar already announces position, so the visible label is a
 * glance-only duplicate. Also fades on focus-within — the swap must track
 * the same reveal signal as the controls it's trading places with, or a
 * keyboard user tabbing to play/pause would see it fight the still-visible
 * time label. */
function PillTime({ np }: { np: NowPlaying }) {
  const timeRef = useRef<HTMLSpanElement>(null);
  // Label only: the bar/fill refs stay unattached (useProgressDom null-guards
  // them), so this drives no second progress surface.
  const bar = useRef<HTMLDivElement>(null);
  const fill = useRef<HTMLDivElement>(null);
  useProgressDom(np.duration_ms, np.status === "playing", bar, fill, timeRef);
  return (
    <span
      ref={timeRef}
      aria-hidden
      className="shrink-0 text-[11px] leading-4 tabular-nums text-muted transition-opacity duration-2 ease-out-tk group-hover/widget:opacity-0 group-focus-within/widget:opacity-0"
    />
  );
}

function Art({ url, size, radiusPx }: { url: string | null; size: number; radiusPx: number }) {
  return (
    <div
      className="grid shrink-0 place-items-center overflow-hidden bg-surface-2 text-muted"
      style={{ width: size, height: size, borderRadius: radiusPx }}
    >
      {url ? (
        <img src={url} alt="" className="h-full w-full object-cover" draggable={false} />
      ) : (
        <MorphIcon name="note" size={22} />
      )}
    </div>
  );
}

/** compact = the card's bottom row: 24px buttons on an 8px gap. Expanded
 * keeps the 32px/4px transport — both center in a full-width bottom row. */
function Transport({
  np,
  seekable,
  playing,
  compact = false,
}: {
  np: NowPlaying;
  seekable: boolean;
  playing: boolean;
  compact?: boolean;
}) {
  const size = compact ? "xs" : "md";
  return (
    <div className={`flex items-center ${compact ? "gap-2" : "gap-1"}`}>
      <IconButton size={size} label="Previous track" onClick={commands.prev}>
        <MorphIcon name="prev" size={16} />
      </IconButton>
      <SeekButton size={size} dir={-1} seekable={seekable} player={np.player} />
      <PlayPauseButton size={size} playing={playing} />
      <SeekButton size={size} dir={1} seekable={seekable} player={np.player} />
      <IconButton size={size} label="Next track" onClick={commands.next}>
        <MorphIcon name="next" size={16} />
      </IconButton>
    </div>
  );
}

/** How soon after entering expanded a lyrics resolve still counts as "already
 * there": inside this window the swap renders plain (no arrival cascade), so
 * the inner choreography never stacks on the mode morph's tail. */
const SNAP_WINDOW_MS = 300;
/** Entrance delay on the entering view so the exit visibly leads — the
 * overlap reads as one gesture (off the DUR scale deliberately: it's an
 * offset between beats, not a duration). */
const EXIT_LEAD_MS = 40;

/**
 * Expanded mode: big-art fallback while lyrics fetch, karaoke view once they
 * land. Progress and transport are HOISTED out of the swap — chrome holds
 * perfectly still (and the rAF-driven progress fill never remounts
 * mid-write); only the content region crossfades. Mode controls live in the
 * app-root anchored cluster, so the top-right is free. The arrival
 * is choreographed (art exhales with the house blur, rows cascade outward
 * from the current line, the accent marker ignites last); the reverse — a
 * track change — exits fast and plain: continuity is earned by content
 * identity, and the outgoing view's art/lyrics belong to the outgoing track.
 */
function ExpandedView({
  np,
  artUrl,
  lyrics,
  seekable,
  playing,
}: {
  np: NowPlaying;
  artUrl: string | null;
  lyrics: LyricsState;
  seekable: boolean;
  playing: boolean;
}) {
  const reducedMotion = useReducedMotion();
  // Key-stamped gate: never render the new track's header over the old
  // track's lines during useLyrics' one-render loading gap (see lyricsKeyOf).
  const lyricsLive = lyrics.status === "synced" && lyrics.key === lyricsKeyOf(np);

  // The arrival cascade is earned by a real wait: the art view must have been
  // on screen past the snap window. Stamped in an effect (post-commit), read
  // on the later render the swap triggers. The clock restarts per TRACK, not
  // just per lyricsLive edge — a none→loading track change keeps lyricsLive
  // false throughout, and the stale timestamp would let the next track's
  // instant resolve wrongly earn the cascade.
  const trackKey = lyricsKeyOf(np);
  const artShownAt = useRef<number | null>(null);
  useEffect(() => {
    artShownAt.current = null;
  }, [trackKey]);
  useEffect(() => {
    if (lyricsLive) {
      artShownAt.current = null;
    } else if (artShownAt.current === null) {
      artShownAt.current = performance.now();
    }
  });
  const celebrate =
    !reducedMotion &&
    artShownAt.current !== null &&
    performance.now() - artShownAt.current > SNAP_WINDOW_MS;

  const swap = {
    initial: reducedMotion ? {} : { opacity: 0 },
    animate: { opacity: 1, filter: "blur(0px)" },
    transition: {
      duration: reducedMotion ? 0 : DUR[3] / 1000,
      delay: reducedMotion ? 0 : EXIT_LEAD_MS / 1000,
      ease: [...EASE.out] as [number, number, number, number],
    },
  };
  const exitFast = {
    duration: reducedMotion ? 0 : DUR[2] / 1000,
    ease: [...EASE.out] as [number, number, number, number],
  };

  return (
    <div className="relative flex h-full flex-col gap-2 px-3 pb-2.5 pt-3">
      <div className="relative min-h-0 flex-1">
        <AnimatePresence initial={false}>
          {lyricsLive ? (
            <motion.div
              // Keyed per TRACK: a fast resolve landing inside the previous
              // lyrics view's 140ms exit window would otherwise re-adopt the
              // exiting fiber — stale LyricsPanel state (entrance, anchored
              // transition) would animate a slide to the new track's offset.
              key={`lyrics:${lyrics.key}`}
              {...swap}
              // pointerEvents dies at exit start — a stray click during the
              // reverse fade must not seek the NEW track to a dead line.
              exit={{ opacity: 0, pointerEvents: "none", transition: exitFast }}
              className="absolute inset-0 flex flex-col gap-2"
            >
              <div className="flex items-center gap-2.5">
                <Art url={artUrl} size={44} radiusPx={6} />
                <div className="min-w-0 flex-1">
                  <TruncateTip text={np.title} className="text-[15px] font-medium text-fg" />
                  {/* Flex row, not inline flow: a long artist truncates in
                      its own box while the waveform keeps its seat right
                      after the clipped text — inline, it rode the string's
                      full width into the clip edge. */}
                  <div className="flex min-w-0 items-center">
                    <TruncateTip text={np.artist} className="text-[13px] text-muted" />
                    {/* md, not sm: this header is the lyrics view's only
                        now-playing signal, so it earns more presence than
                        an inline text separator. */}
                    <span className="flex shrink-0 items-center">
                      <Waveform size="md" trailing />
                    </span>
                  </div>
                </div>
              </div>
              <LyricsPanel
                lines={lyrics.lines}
                seekable={seekable}
                leadMs={VOCAL_LEAD_MS[np.player]}
                entrance={celebrate}
              />
            </motion.div>
          ) : (
            <motion.div
              key="art"
              {...swap}
              // The art dissolves IN PLACE — the house exit language (blur +
              // opacity, zero transforms; the art never moves, even to leave).
              exit={{
                opacity: 0,
                filter: reducedMotion ? "blur(0px)" : "blur(1.5px)",
                transition: exitFast,
              }}
              className="absolute inset-0 flex flex-col items-center justify-center gap-3"
            >
              <Art url={artUrl} size={190} radiusPx={12} />
              <div className="min-w-0 self-stretch text-center">
                <p className="truncate text-sm font-medium text-fg">{np.title}</p>
                <p className="truncate text-xs text-muted">
                  {np.artist}
                  {np.album && <SeparatorDot />}
                  {np.album}
                </p>
                {/* Height-reserved caption slot: the caption fading in must
                    not re-center the column and shift the art (it did — every
                    lyrics miss nudged the 190px cover ~7px). "Finding
                    lyrics…" waits 400ms so fast fetches never flash it, and
                    turns the eventual arrival into an answered question. */}
                <p className="mt-0.5 h-[15px] text-[10px] text-muted">
                  {lyrics.status !== "synced" && (
                    <span
                      key={lyrics.status}
                      className={`inline-block animate-[caption-in_200ms_var(--ease-out-tk)_both] ${
                        lyrics.status === "loading" ? "[animation-delay:400ms]" : ""
                      }`}
                    >
                      {lyrics.status === "loading" ? "Finding lyrics…" : "No synced lyrics"}
                    </span>
                  )}
                </p>
              </div>
              {/* The living separator at hero size, filling the dead zone
                  between the metadata and the transport. The metadata line
                  above keeps a static middot so the reactive surface isn't
                  on screen twice. mt-3 centers it in that dead zone: the
                  fixed 380x440 window plus this centered column puts half
                  the margin back below, landing ~24px on both sides. */}
              <div className="mt-3">
                <Waveform size="lg" />
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
      {/* Hoisted chrome: one seat for both states. Progress sits ABOVE the
          transport (handoff order) so the transport is the very-bottom row —
          the anchored cluster shares its vertical band at the corner. */}
      <ProgressBar np={np} />
      <div className="flex h-8 items-center justify-center">
        <Transport np={np} seekable={seekable} playing={playing} />
      </div>
    </div>
  );
}

function App() {
  const [np, setNp] = useState<NowPlaying | null>(null);
  useEffect(
    () =>
      onNowPlaying((next) => {
        // Every payload feeds the clock; only identity changes re-render.
        // A stale straggler the kernel rejects must not touch React state
        // either — adopting its identity would pair the new track's clock
        // with the old track's lyrics.
        if (!posClock.ingest(next)) return;
        setNp((prev) => (sameIdentity(prev, next) ? prev : next));
      }),
    [],
  );
  const artUrl = useArt(np?.art_id ?? null);
  // A data URL that fails to decode falls back to the note glyph instead of
  // the browser's broken-image icon.
  const [brokenArtUrl, setBrokenArtUrl] = useState<string | null>(null);
  const shownArt = artUrl !== null && artUrl !== brokenArtUrl ? artUrl : null;
  useArtAccent(shownArt);
  const lyrics = useLyrics(np);
  // Assert the reduced-motion capture vote even before any separator mounts.
  useEffect(() => initReactive(), []);

  const [mode, setMode] = useState<Mode>(() => {
    try {
      const saved = localStorage.getItem("pulse.mode");
      return saved === "pill" || saved === "expanded" ? saved : "card";
    } catch {
      return "card"; // storage unavailable — mode just won't persist
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem("pulse.mode", mode);
    } catch {
      // non-fatal: mode resets to card on next launch
    }
    const [w, h] = MODE_SIZES[mode];
    commands.setWindowSize(w, h);
  }, [mode]);

  const reducedMotion = useReducedMotion();
  const morph = {
    initial: reducedMotion ? {} : { opacity: 0, scale: 0.98 },
    animate: { opacity: 1, scale: 1 },
    transition: { duration: reducedMotion ? 0 : DUR[3] / 1000, ease: [...EASE.out] as [number, number, number, number] },
  };
  const nothing = !np || np.player === "none";
  const playing = np?.status === "playing";
  // AM can't seek over SMTC (support matrix) — buttons gate on capability.
  const seekable = !!np?.can_seek;

  // Whole-card drag, except interactive elements. (data-tauri-drag-region only
  // fires when the pressed element itself carries the attribute — art, gaps,
  // and icons didn't, which made the window feel undraggable.)
  const onDragStart = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    if (target.closest('button, [role="slider"]')) return;
    commands.startDrag();
  };

  // The anchored cluster steps this ladder one rung per click; the end
  // buttons disable instead of wrapping.
  const stepMode = (d: -1 | 1) =>
    setMode((m) => MODE_ORDER[Math.min(Math.max(MODE_ORDER.indexOf(m) + d, 0), MODE_ORDER.length - 1)]);

  return (
    <div className="group/widget relative h-screen p-1.5" onMouseDown={onDragStart}>
      <motion.div
        key={mode}
        {...morph}
        // Shadow must die out inside the 6px window padding (p-1.5 on the
        // root) — anything larger hard-clips at the transparent window edge
        // and reads as a gray box on light surfaces.
        className="relative flex h-full flex-col overflow-hidden rounded-xl border border-border/10 bg-surface/95 shadow-[0_1px_3px_rgb(0_0_0/0.18),0_3px_6px_rgb(0_0_0/0.12)]"
      >
        {nothing ? (
          <div className="flex h-full w-full items-center justify-center gap-2 text-muted">
            <MorphIcon name="note" size={22} />
            <span className="text-sm">Nothing playing</span>
          </div>
        ) : mode === "pill" ? (
          /* "5a — time at rest" (ANIMATIONS.md §3): at rest the pill is pure
             glance — art · title · artist · elapsed time, no buttons. On widget
             hover the time fades out (keeping its flex slot so the title/artist
             line never reflows) and a right-edge scrim carrying play/pause
             fades in; the anchored bracket cluster joins from the app root. All
             three cross at 140ms EASE.out, opacity only. */
          <>
            <div className="flex h-full items-center gap-2 px-3">
              <Art url={shownArt} size={26} radiusPx={6} />
              <p className="min-w-0 flex-1 truncate text-xs font-medium text-fg">
                {np.title}
                <Waveform trailing={!np.artist} />
                <span className="font-normal text-muted">{np.artist}</span>
              </p>
              <PillTime np={np} />
            </div>
            {/* Scrim + play/pause, revealed on hover. Absolute over the row so
                nothing reflows; the gradient lets the artist text fade UNDER
                the incoming control. 180px wide, play/pause ending 76px from
                the shell right edge — an 8px gap before the corner cluster.
                Stops 2px above the bottom so the progress hairline stays lit.
                Also reveals on focus-within (play/pause stays tabbable the
                whole time — a hover-only reveal would strand keyboard users
                on an invisible button, quick-review catch 2026-07-08). */}
            <div
              className="pointer-events-none absolute bottom-0.5 right-0 top-0 flex w-[180px] items-center justify-end pr-[76px] opacity-0 transition-opacity duration-2 ease-out-tk group-hover/widget:pointer-events-auto group-hover/widget:opacity-100 group-focus-within/widget:pointer-events-auto group-focus-within/widget:opacity-100"
              style={{ background: "linear-gradient(90deg, transparent, rgb(var(--surface) / 0.96) 45%)" }}
              // Swallow mousedown, same reason as ModeCluster: pointer-events
              // only turns on for the 180px scrim, but the button inside it
              // doesn't fill that box — a press that lands on the gradient
              // padding instead of the 28px button would otherwise fall
              // through to the root's onDragStart and move the window.
              onMouseDown={(e) => e.stopPropagation()}
            >
              <PlayPauseButton size="sm" iconSize={16} playing={playing} />
            </div>
            {/* Non-interactive progress hairline — still announced to AT. */}
            <Hairline np={np} />
          </>
        ) : mode === "card" ? (
          /* Anchored-cluster handoff (2026-07-08, supersedes Figma 874:299):
             art+titles fill the top, then full-width progress, then the
             transport as the very-bottom row — centered, sharing its band
             with the corner cluster. Bottom geometry matches expanded, so
             the cluster and transport hold still across card⇄expanded. */
          <div className="flex h-full flex-col gap-1.5 px-3 pb-2.5 pt-3">
            <div className="flex min-h-0 flex-1 items-center gap-3">
              <Art url={shownArt} size={52} radiusPx={8} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-[15px] font-medium text-fg">{np.title}</p>
                <p className="truncate text-xs leading-4 text-muted">
                  {np.artist}
                  <Waveform trailing={!np.album} />
                  {np.album}
                </p>
              </div>
            </div>
            <ProgressBar np={np} />
            <div className="flex h-7 items-center justify-center">
              <Transport np={np} seekable={seekable} playing={playing} compact />
            </div>
          </div>
        ) : (
          <ExpandedView np={np} artUrl={shownArt} lyrics={lyrics} seekable={seekable} playing={playing} />
        )}
      </motion.div>
      {/* Outside the mode-keyed remount: the cluster never fades or rescales
          with the content morph, and — docked bottom-right — never moves on
          screen. See ModeCluster. */}
      {!nothing && <ModeCluster mode={mode} onStep={stepMode} />}
      {/* Broken-art detector — OUTSIDE the mode-keyed subtree so the data URL
          isn't re-decoded on every mode switch, only per track. */}
      {artUrl && artUrl !== brokenArtUrl && (
        <img
          src={artUrl}
          alt=""
          className="hidden"
          aria-hidden
          onError={() => setBrokenArtUrl(artUrl)}
        />
      )}
    </div>
  );
}

export default App;
