import { memo, useEffect, useLayoutEffect, useRef, useState } from "react";
import { AnimatePresence, motion, useIsPresent, useReducedMotion } from "motion/react";
import type { MorphName } from "./icons/geometry";
import { MorphIcon } from "./icons/MorphIcon";
import { useSeekTick } from "./icons/useSeekTick";
import { useSkipFlick } from "./icons/useSkipFlick";
import { useBracketPulse } from "./icons/useBracketPulse";
import {
  commands,
  onCursorLeft,
  onDockCorner,
  onNowPlaying,
  onPresence,
  onPresenceDebug,
  type DockCorner,
} from "./lib/backend";
import { currentLineIndex, msUntilNextLine, parseLrc, VOCAL_LEAD_MS, type LyricLine } from "./lib/lrc";
import { extractAccent } from "./lib/palette";
import * as posClock from "./lib/posClock";
import { initReactive } from "./lib/reactive";
import { DUR, EASE } from "./lib/tokens";
import { SeparatorDot, Waveform } from "./Waveform";
import { IN_TAURI, type NowPlaying, type PresenceDebug, type PresenceState } from "./types";

// Keep in sync with SEEK_STEP_MS in src-tauri/src/lib.rs (global hotkeys).
const SEEK_STEP_MS = 10_000;

type Mode = "pill" | "card" | "expanded";

/** Each mode's FOOTPRINT (shell + gutter), in logical px. The native window
 * itself never resizes: it lives at WINDOW_MAX from birth (tauri.conf.json)
 * and every mode change is the shell's 200ms EASE.inOut CSS glide inside it,
 * clip-revealing the incoming mode's already-final ModeContent plane while
 * the content layers crossfade. (Resizing a WebView2 window at all costs one
 * wrong frame: per-frame animation shakes, a snap blinks — measured live
 * 2026-07-09/10.) These sizes still drive the shell/plane boxes and the
 * click-through hit rect (dock.rs). */
const MODE_SIZES: Record<Mode, [number, number]> = {
  pill: [300, 48],
  card: [380, 132], // anchored-cluster handoff: 52px art row, full-width progress, bottom transport
  expanded: [380, 440], // lyrics home; big-art fallback gets breathing room
};

/** The window's permanent size = the largest mode. Keep in sync with
 * tauri.conf.json width/height (the window must be BORN at this size —
 * matching them means the launch dock is pure positioning, no resize, no
 * first-frame artifact). */
const WINDOW_MAX: [number, number] = MODE_SIZES.expanded;


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

/** Feed the history thumb cache (history.rs): downscale the current cover to
 * a 96px JPEG once per ART REVISION — a rev bump means the first capture had
 * the previous track's image (the stale-art probe), so it must overwrite.
 * The key handed to the backend is the art_id's prefix (media::ident_key),
 * which is also the history entry's `key`. Fire-and-forget; the mock no-ops.
 *
 * The hook fetches the art ITSELF (media_art resolves an id to its bytes or
 * null): the display path's useArt keeps showing the OUTGOING track's URL
 * while the new fetch is in flight, so capturing that shared state here
 * would file the old cover under the new track's key (quick-review catch,
 * 2026-07-10). A miss or a failed decode un-latches so the next payload
 * retries instead of skipping the revision forever. */
function useHistoryThumb(artId: string | null): void {
  const lastId = useRef<string | null>(null);
  useEffect(() => {
    if (!artId || artId === lastId.current) return;
    lastId.current = artId;
    const unlatch = () => {
      if (lastId.current === artId) lastId.current = null;
    };
    void commands.art(artId).then((url) => {
      // null = the cache already advanced past this id — a newer payload
      // (with a newer art_id) is coming; let it retry.
      if (!url) return unlatch();
      const img = new Image();
      img.onerror = unlatch;
      img.onload = () => {
        const side = 96;
        const c = document.createElement("canvas");
        c.width = side;
        c.height = side;
        const ctx = c.getContext("2d");
        if (!ctx || img.width === 0 || img.height === 0) return;
        // Cover-crop the (usually already square) art into the square thumb.
        const s = Math.min(img.width, img.height);
        ctx.drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, side, side);
        commands.historyThumb(artId.split(":")[0], c.toDataURL("image/jpeg", 0.8));
      };
      img.src = url;
    });
  }, [artId]);
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
        // background-color joins opacity: an art-change retint must sweep the
        // marker like every accent-painted surface (220ms EASE.out, the
        // progress fills' retint timing) instead of snapping it.
        className={`absolute left-0 top-1/2 h-4 w-[3px] -translate-y-1/2 rounded-full bg-accent [transition:opacity_200ms_var(--ease-out-tk),background-color_220ms_var(--ease-out-tk)] ${
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
          className={`absolute left-1/2 z-10 flex -translate-x-1/2 items-center rounded-full border border-border/10 bg-surface-2/90 p-1.5 leading-none text-muted [transition:color_140ms_var(--ease-out-tk),scale_90ms_var(--ease-out-tk)] [animation:caption-in_140ms_var(--ease-out-tk)_both] hover:text-fg active:scale-95 ${
            nowBelow ? "bottom-8" : "top-8"
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
      // Press scale rides DUR[1] (ANIMATIONS_FROM_ZERO §6 — press feedback is
      // 90ms) while hover bg and the disabled fade keep DUR[2]. Tailwind v4's
      // scale-95 compiles to the native `scale` property, so that's the one
      // the shorthand names.
      className={`grid place-items-center rounded-md text-fg [transition:background-color_140ms_var(--ease-out-tk),opacity_140ms_var(--ease-out-tk),scale_90ms_var(--ease-out-tk)] hover:bg-fg/10 active:scale-95 disabled:pointer-events-none disabled:opacity-40 ${
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
  // The window can go click-through while the cursor rests on this line —
  // no mouseleave ever arrives then (see onCursorLeft), so the hover-hold
  // timer would open a tooltip over an unattended widget with nothing left
  // to close it. Drop the hold and the tooltip on the signal.
  useEffect(
    () =>
      onCursorLeft(() => {
        if (timer.current !== null) window.clearTimeout(timer.current);
        timer.current = null;
        setOpen(false);
      }),
    [],
  );
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
  const { scope, pulse } = useBracketPulse(to);
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
      // Pulse on pointerdown like every optimistic press response
      // (play/pause morph, seek spin); the mode change itself stays on click.
      onPointerDown={(e) => {
        if (e.button === 0 && !disabled) pulse();
      }}
      onClick={(e) => {
        if (disabled) return;
        if (e.detail === 0) pulse(); // keyboard never fires pointerdown
        onClick();
      }}
      className={`grid h-7 w-7 place-items-center rounded-md transition-colors duration-2 ease-out-tk ${
        disabled ? "pointer-events-none text-muted" : "text-fg hover:bg-fg/10"
      }`}
    >
      <span ref={scope} className="grid place-items-center will-change-transform">
        <MorphIcon name={to} size={13} slot={slot} dur={DUR[3]} ease={EASE.inOut} />
      </span>
    </motion.button>
  );
}

/** Ordered mode ladder the anchored cluster steps through. */
const MODE_ORDER: readonly Mode[] = ["pill", "card", "expanded"];

/** The 6px transparent gutter per side between the window edge and shell —
 * 2× SHELL_SEAT's 1.5 inset. Change the seat inset, change this too. */
const SHELL_GUTTER_PX = 12;
/** What the shell's chrome takes from the window before content: the 6px
 * gutter per side (SHELL_SEAT's 1.5 inset) + the shell's 1px border per
 * side. Change the seat inset or border, change this. */
const SHELL_CHROME_PX = 14;

/** Where the gliding shell seats within the window: on the docked corner, so
 * its size glide radiates out of the one corner that never moves. */
const SHELL_SEAT: Record<DockCorner, string> = {
  "top-left": "left-1.5 top-1.5",
  "top-right": "right-1.5 top-1.5",
  "bottom-left": "bottom-1.5 left-1.5",
  "bottom-right": "bottom-1.5 right-1.5",
};

/** The mode's content plane: laid out at its FINAL size from the first
 * frame, anchored to the docked corner, while the shell glides between mode
 * boxes and clip-reveals it (ANIMATIONS_FROM_ZERO §2: "content lays out at
 * final size immediately; the growing window reveals it"). Before this the
 * content filled the live box instead: every resize frame reflowed the whole
 * interior — rows sliding, boxes re-flexing — which read as the UI "catching
 * up with the expansion" instead of being revealed by it (Thien, live,
 * 2026-07-09). The fixed box also keeps the exiting mode's content from
 * squashing while it fades.
 *
 * Also marks the exiting subtree inert for the crossfade: the shell-level
 * exit pointerEvents can't do it alone — CSS pointer-events inherits, so a
 * descendant declaring its own pointer-events-auto (the pill scrim,
 * ViewToggle — both re-enabled by group-hover on the never-exiting root)
 * overrides the ancestor's none, and neither property touches the tab/AT
 * order (quick-review catches, 2026-07-09). framer freezes the exiting
 * child's props, so presence context is the only signal that still reaches
 * this subtree — and this instance's frozen `mode`/`corner` keep the
 * outgoing content seated while its shell shrinks over it. */
function ModeContent({
  mode,
  corner,
  children,
}: {
  mode: Mode;
  corner: DockCorner;
  children: React.ReactNode;
}) {
  const isPresent = useIsPresent();
  const [w, h] = MODE_SIZES[mode];
  return (
    <div
      inert={!isPresent}
      className={`absolute flex flex-col ${CORNER_SEAT[corner]}`}
      style={{ width: w - SHELL_CHROME_PX, height: h - SHELL_CHROME_PX }}
    >
      {children}
    </div>
  );
}

/** The plane pins to the corner dock.rs resizes out of — the one corner whose
 * screen position is fixed through the animation. Any other anchor puts the
 * content on a MOVING edge and it rides the resize instead of being revealed
 * by it (quick-review catch, 2026-07-09: the plane was hardcoded bottom-right
 * while the dock is corner-general). */
const CORNER_SEAT: Record<DockCorner, string> = {
  "top-left": "left-0 top-0",
  "top-right": "right-0 top-0",
  "bottom-left": "bottom-0 left-0",
  "bottom-right": "bottom-0 right-0",
};

/**
 * The anchored mode cluster (design handoff 2026-07-08): collapse + expand
 * live at the bottom-right corner — the corner dock.rs resizes out of — so
 * when the window is docked bottom-right the buttons occupy the same screen
 * pixels in every mode: park the cursor once, step the whole ladder.
 * Rendered ONCE in the app root, outside the mode-keyed remount, so it never
 * fades or rescales with the content morph — chrome holds still (the
 * expanded view's hoisted-chrome rule, promoted app-wide).
 *
 * Positioned in SHELL coordinates — this div lives inside the persistent
 * shell, beside (never inside) the content swap. The old hoist-to-root
 * reason died when the crossfading shells became one persistent shell: the
 * chrome can't fade anymore, and shell-relative seating is what keeps the
 * cluster glued to the VISIBLE box in every dock corner and every mode —
 * the window is permanently WINDOW_MAX-sized, so window-relative seating
 * would float it over the transparent gutter whenever the shell is smaller
 * (quick-review catch). Seat math:
 * right-[7px] shell = +1px border +6px gutter = 14px window (8px from the
 * shell's outer edge); bottom-[4px] shell = 11px window, putting the 28px
 * buttons' center 25px from the window bottom — the CONTROL CENTERLINE
 * every mode's controls sit on: the pill scrim's play/pause
 * (top-0/bottom-0.5 in the 36px shell → center 25px), and the card/expanded
 * transports via their pb-1/pb-0.5 column padding (the shell's 1px border
 * adds to both). Change one, change all four. The seat is CONSTANT in every
 * mode (no mode-dependent bottom) — docked bottom-right the shell's bottom-
 * right corner is welded through rests AND glides, so the cluster holds the
 * exact same screen pixels across pill/card/expanded: the
 * fixed-point guarantee, no drift even while hidden (ANIMATIONS.md §2 —
 * "opacity only, zero transforms; the fixed-point guarantee includes the
 * hidden state"). Hidden at rest (opacity 0, pointer-events none),
 * it reveals on widget hover — the root's data-hot, JS-owned (mousemove
 * arms, mouseleave + the Rust cursor-left event clear; CSS :hover freezes
 * true once the window goes click-through): opacity 0→1 over 140ms
 * EASE.out, no motion. Also reveals on KEYBOARD focus — has-[:focus-visible], NOT
 * focus-within: the buttons stay in the Tab order the whole time (hidden ≠
 * inert), so a hover-only reveal would strand keyboard users on an
 * invisible, invisibly-outlined control (quick-review catch, 2026-07-08) —
 * but plain focus-within also matched the residual focus a mouse click
 * leaves on the clicked button, pinning the chrome open after the cursor
 * left (Thien, 2026-07-10). Mouse clicks don't set :focus-visible; Tab does.
 */
function ModeCluster({ mode, onStep }: { mode: Mode; onStep: (d: -1 | 1) => void }) {
  return (
    <div
      className="pointer-events-none absolute bottom-[4px] right-[7px] z-20 flex items-center gap-1 opacity-0 transition-opacity duration-2 ease-out-tk group-data-[hot]/widget:pointer-events-auto group-data-[hot]/widget:opacity-100 group-has-[:focus-visible]/widget:pointer-events-auto group-has-[:focus-visible]/widget:opacity-100"
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

/** The expanded view preference — lyrics (default) or album art. Persisted
 * like pulse.mode: "I don't want to see lyrics" is a preference, not a
 * per-visit choice, so it survives mode switches and relaunches. */
function readViewPref(): "lyrics" | "art" {
  try {
    return localStorage.getItem("pulse.expandedView") === "art" ? "art" : "lyrics";
  } catch {
    return "lyrics";
  }
}

/**
 * The expanded view's art ⇄ lyrics toggle: one 28px seat at the top-right —
 * the corner the anchored cluster's move to the bottom freed up. Same
 * hover/keyboard-focus reveal contract as the cluster (hidden at rest,
 * opacity only, hidden ≠ inert, has-[:focus-visible] not focus-within — see
 * ModeCluster), same mousedown swallow so a press never falls through to
 * the window drag. The glyph names the DESTINATION:
 * mic = show lyrics (karaoke), note = show album cover; a track with no
 * synced lyrics disables the seat in place as a crossed-out mic — the seat
 * never unmounts, so there's nothing to hunt for and nothing shifts. */
function ViewToggle({
  glyph,
  label,
  disabled = false,
  onToggle,
}: {
  glyph: MorphName;
  label: string;
  disabled?: boolean;
  onToggle: () => void;
}) {
  return (
    <div
      className="pointer-events-none absolute right-2 top-2 z-10 opacity-0 transition-opacity duration-2 ease-out-tk group-data-[hot]/widget:pointer-events-auto group-data-[hot]/widget:opacity-100 group-has-[:focus-visible]/widget:pointer-events-auto group-has-[:focus-visible]/widget:opacity-100"
      onMouseDown={(e) => e.stopPropagation()}
    >
      <button
        type="button"
        aria-label={label}
        title={label}
        // aria-disabled (not disabled) keeps the seat focusable — the reveal
        // rides focus-within, and a hard-disabled button would drop out of
        // the Tab order entirely. Click guard covers Enter/Space.
        aria-disabled={disabled || undefined}
        onClick={() => {
          if (!disabled) onToggle();
        }}
        className={`grid h-7 w-7 place-items-center rounded-md [transition:color_140ms_var(--ease-out-tk),background-color_140ms_var(--ease-out-tk),opacity_140ms_var(--ease-out-tk),scale_90ms_var(--ease-out-tk)] ${
          disabled ? "pointer-events-none text-muted opacity-30" : "text-fg hover:bg-fg/10 active:scale-95"
        }`}
      >
        <MorphIcon name={glyph} size={13} slot="view-toggle" dur={DUR[3]} ease={EASE.inOut} />
      </button>
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
 * glance-only duplicate. Also fades on keyboard focus (has-[:focus-visible],
 * matching the controls' reveal signal exactly) — a keyboard user tabbing to
 * play/pause must not see it fight the still-visible time label, and a
 * mouse click's residual focus must not keep it hidden. */
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
      className="shrink-0 text-[11px] leading-4 tabular-nums text-muted transition-opacity duration-2 ease-out-tk group-data-[hot]/widget:opacity-0 group-has-[:focus-visible]/widget:opacity-0"
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

/** Prev/next with the pass-through flick (useSkipFlick): a masked strip of
 * three glyph copies — the live one plus ghosts parked at ±width, which the
 * hook's wrap-on-mash frame-identity depends on. The mask is the glyph's own
 * 16px box, so the wipe happens inside the button and never brushes the
 * neighboring seek button. */
function SkipButton({ dir, size }: { dir: -1 | 1; size?: "xs" | "sm" | "md" }) {
  const { scope, tick } = useSkipFlick(dir, 16);
  const glyph = dir < 0 ? "prev" : "next";
  return (
    <IconButton
      size={size}
      label={dir < 0 ? "Previous track" : "Next track"}
      onPointerDown={(e) => e.button === 0 && void tick()}
      onClick={(e) => {
        if (e.detail === 0) void tick(); // keyboard gets the flick too
        (dir < 0 ? commands.prev : commands.next)();
      }}
    >
      <span className="grid h-4 w-4 place-items-center overflow-hidden">
        <span ref={scope} className="relative grid place-items-center will-change-transform">
          <MorphIcon name={glyph} size={16} />
          <span aria-hidden className="absolute right-full top-0 grid">
            <MorphIcon name={glyph} size={16} />
          </span>
          <span aria-hidden className="absolute left-full top-0 grid">
            <MorphIcon name={glyph} size={16} />
          </span>
        </span>
      </span>
    </IconButton>
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
      <SkipButton size={size} dir={-1} />
      <SeekButton size={size} dir={-1} seekable={seekable} player={np.player} />
      <PlayPauseButton size={size} playing={playing} />
      <SeekButton size={size} dir={1} seekable={seekable} player={np.player} />
      <SkipButton size={size} dir={1} />
    </div>
  );
}

/** How soon after entering expanded a lyrics resolve still counts as "already
 * there": inside this window the swap renders plain (no arrival cascade), so
 * the inner choreography never stacks on the mode morph's tail. */
const SNAP_WINDOW_MS = 300;
/** How long the "No synced lyrics" caption stays before fading out — it's an
 * answer to "why am I looking at art instead of lyrics", and once read it
 * shouldn't sit under the metadata forever. The reserved slot keeps its
 * height, so the fade moves nothing. */
const NO_LYRICS_CAPTION_MS = 4000;
/** Entrance delay on the entering view so the exit visibly leads — the
 * overlap reads as one gesture (off the DUR scale deliberately: it's an
 * offset between beats, not a duration). */
const EXIT_LEAD_MS = 40;

/**
 * Expanded mode: big-art fallback while lyrics fetch, karaoke view once they
 * land — unless the user flipped the top-right ViewToggle to art, which wins
 * over available lyrics (a persisted preference, see readViewPref). Progress
 * and transport are HOISTED out of the swap — chrome holds perfectly still
 * (and the rAF-driven progress fill never remounts mid-write); only the
 * content region crossfades. Mode controls live in the app-root anchored
 * cluster; the view toggle is hoisted beside the swap for the same reason.
 * The arrival is choreographed (art exhales with the house blur, rows
 * cascade outward from the current line, the accent marker ignites last) —
 * but ONLY when lyrics resolve on their own: a user-initiated toggle is a
 * command, not an arrival, and swaps plain. The reverse — a track change —
 * exits fast and plain: continuity is earned by content identity, and the
 * outgoing view's art/lyrics belong to the outgoing track.
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

  // The user's art ⇄ lyrics preference. Lyrics still gate on availability:
  // "lyrics" with none synced falls back to art, and the preference sits
  // unchanged for the next track that has them.
  const [view, setView] = useState<"lyrics" | "art">(readViewPref);
  const showLyrics = lyricsLive && view === "lyrics";
  const toggleView = () => {
    // A toggle is a command, not an arrival — clear the art clock so the
    // swap it causes renders plain instead of earning the cascade.
    artShownAt.current = null;
    setView((v) => {
      const next = v === "lyrics" ? "art" : "lyrics";
      try {
        localStorage.setItem("pulse.expandedView", next);
      } catch {
        // non-fatal: the preference resets to lyrics next launch
      }
      return next;
    });
  };

  // The arrival cascade is earned by a real wait: the art view must have been
  // on screen past the snap window. Stamped in an effect (post-commit), read
  // on the later render the swap triggers. The clock restarts per TRACK, not
  // just per showLyrics edge — a none→loading track change keeps showLyrics
  // false throughout, and the stale timestamp would let the next track's
  // instant resolve wrongly earn the cascade.
  const trackKey = lyricsKeyOf(np);
  const artShownAt = useRef<number | null>(null);
  useEffect(() => {
    artShownAt.current = null;
  }, [trackKey]);
  useEffect(() => {
    if (showLyrics) {
      artShownAt.current = null;
    } else if (artShownAt.current === null) {
      artShownAt.current = performance.now();
    }
  });
  const celebrate =
    !reducedMotion &&
    artShownAt.current !== null &&
    performance.now() - artShownAt.current > SNAP_WINDOW_MS;

  // The miss caption answers once, then leaves (NO_LYRICS_CAPTION_MS); the
  // timer restarts per track and per status flip so a loading→none resolve
  // gets its full read window.
  const [captionExpired, setCaptionExpired] = useState(false);
  useEffect(() => {
    setCaptionExpired(false);
    if (lyrics.status !== "none") return;
    const t = window.setTimeout(() => setCaptionExpired(true), NO_LYRICS_CAPTION_MS);
    return () => window.clearTimeout(t);
  }, [lyrics.status, trackKey]);

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
    // pb-0.5 (+ the shell's 1px border) seats the h-8 transport row's center
    // on the 25px control centerline (see ModeCluster) — 2px less than the
    // card's pb-1 because this transport row is 4px taller.
    <div className="relative flex h-full flex-col gap-2 px-3 pb-0.5 pt-3">
      <div className="relative min-h-0 flex-1">
        <AnimatePresence initial={false}>
          {showLyrics ? (
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
              {/* pr-8 clears the hover-revealed ViewToggle seat — a long
                  title/artist must not run under the incoming button. */}
              <div className="flex items-center gap-2.5 pr-8">
                <Art url={artUrl} size={44} radiusPx={6} />
                <div className="min-w-0 flex-1">
                  {/* The living instance rides the TITLE, matching the card
                      and the pill — the capsules are a now-playing pulse and
                      belong to the song, one grammar across views (Thien,
                      2026-07-10). Flex row, not inline flow: a long title
                      truncates in its own box while the waveform keeps its
                      seat right after the clipped text — inline, it rode the
                      string's full width into the clip edge. ml-1 on top of
                      the waveform's mx-1.5 = the same 10px gap as the card. */}
                  <div className="flex min-w-0 items-center">
                    <TruncateTip text={np.title} className="text-[15px] font-medium text-fg" />
                    <span className="ml-1 flex shrink-0 items-center">
                      <Waveform size="md" trailing />
                    </span>
                  </div>
                  <TruncateTip text={np.artist} className="text-[13px] text-muted" />
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
                    turns the eventual arrival into an answered question. The
                    miss caption fades back out once read (captionExpired) —
                    the disabled toggle seat keeps carrying the answer;
                    aria-hidden goes with it, since opacity 0 alone would
                    leave AT announcing a caption sighted users can't see. */}
                <p className="mt-0.5 h-[15px] text-[10px] text-muted">
                  {lyrics.status !== "synced" && (
                    <span
                      key={lyrics.status}
                      aria-hidden={captionExpired || undefined}
                      className={`inline-block ${
                        captionExpired
                          ? "animate-[caption-out_260ms_var(--ease-out-tk)_both]"
                          : `animate-[caption-in_200ms_var(--ease-out-tk)_both] ${
                              lyrics.status === "loading" ? "[animation-delay:400ms]" : ""
                            }`
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
      {/* Hoisted chrome, like progress/transport below: the toggle keeps its
          seat while the content it switches crossfades under it. Glyph and
          label name the destination; no lyrics = disabled in place. The
          miss states key on status === "none" (not !== "synced"): during a
          track change there's a one-render gap where the OLD track's synced
          state hasn't flipped to loading yet (see lyricsKeyOf), and mapping
          it to micOff would kick a spurious slash morph on every skip. */}
      <ViewToggle
        glyph={lyricsLive ? (showLyrics ? "note" : "mic") : lyrics.status === "none" ? "micOff" : "mic"}
        label={
          lyricsLive
            ? showLyrics
              ? "Show album cover"
              : "Show lyrics"
            : lyrics.status === "none"
              ? "No synced lyrics"
              : "Finding lyrics…"
        }
        disabled={!lyricsLive}
        onToggle={toggleView}
      />
      {/* Hoisted chrome: one seat for both states. Progress sits ABOVE the
          transport (handoff order) so the transport is the very-bottom row —
          the anchored cluster shares its vertical band at the corner. */}
      <ProgressBar np={np} />
      {/* outline-offset 0: the md buttons fill this h-8 row, leaving only the
          pb-0.5 (2px) between their bottom edge and the shell's overflow clip
          — the house ring's 2px offset would push its bottom stroke entirely
          past the clip line, so here the 2px stroke hugs the button instead
          and exactly fits the clearance. */}
      <div className="flex h-8 items-center justify-center [&_button:focus-visible]:[outline-offset:0px]">
        <Transport np={np} seekable={seekable} playing={playing} />
      </div>
    </div>
  );
}

/** DEV-only presence observability (P0, sense-only): the settled "presence"
 * state plus the raw "presence-debug" signals behind it. Enabled by
 * `?presence` in the browser mock, or localStorage "pulse.presenceOverlay"
 * = "1" in the app (flip from devtools, then reload). Off = zero cost: the
 * component never mounts and the backend's debug stream stays voted off. */
const PRESENCE_OVERLAY =
  import.meta.env.DEV &&
  (IN_TAURI
    ? (() => {
        try {
          return localStorage.getItem("pulse.presenceOverlay") === "1";
        } catch {
          return false;
        }
      })()
    : new URLSearchParams(window.location.search).has("presence"));

/** Seat the overlay diagonally OPPOSITE the docked shell — that corner is
 * gutter in pill/card (expanded fills the window; some overlap is
 * unavoidable there for a display-only debug chip). */
const OVERLAY_SEAT: Record<DockCorner, string> = {
  "top-left": "bottom-1.5 right-1.5",
  "top-right": "bottom-1.5 left-1.5",
  "bottom-left": "top-1.5 right-1.5",
  "bottom-right": "top-1.5 left-1.5",
};

function PresenceOverlay({ corner }: { corner: DockCorner }) {
  const [state, setState] = useState<PresenceState | null>(null);
  const [dbg, setDbg] = useState<PresenceDebug | null>(null);
  useEffect(() => onPresence(setState), []);
  // Subscribing votes the backend's raw stream on; unmount votes it off.
  useEffect(() => onPresenceDebug(setDbg), []);
  return (
    // Display-only: click-through in-app (the gutter), pointer-events-none
    // in the mock, hidden from AT like every decorative element here.
    <div
      aria-hidden
      className={`pointer-events-none absolute z-50 rounded-md bg-black/70 px-2 py-1 font-mono text-[10px] leading-4 text-white/85 ${OVERLAY_SEAT[corner]}`}
    >
      <div>
        {state
          ? `presence fs=${state.fullscreen ? "YES" : "no"} concealed=${state.concealed ? "YES" : "no"}`
          : "presence …"}
      </div>
      {dbg && (
        <>
          <div>
            fg={dbg.fg_exe || "?"} rect={dbg.rect_verdict}
            {dbg.on_widget_monitor ? "" : " (other monitor)"} raw-fs={dbg.fs_raw ? "YES" : "no"}
          </div>
          <div>quns={dbg.quns_name}</div>
        </>
      )}
    </div>
  );
}

/** The pill's track key at the last commit — module-level so it survives
 * the mode-keyed remounts (the lastAlive pattern): switching INTO the pill
 * remounts the title spans with the same key, and that mount must not
 * replay the track-change fade. */
let lastPillKey: string | null = null;

/** Pill title/artist span: remounted per track key by the parent's `key`,
 * fading in ONLY when the mount is a real track change (a mode switch into
 * the pill re-creates the DOM with the same key — no beat). */
function TrackFadeSpan({
  k,
  className,
  children,
}: {
  k: string | null;
  className?: string;
  children: React.ReactNode;
}) {
  // Captured once at mount, BEFORE the commit effect below records the new
  // key — exactly "was this mount a change".
  const [animate] = useState(() => k !== null && lastPillKey !== null && k !== lastPillKey);
  useEffect(() => {
    lastPillKey = k;
  }, [k]);
  return <span className={`${animate ? "title-in " : ""}${className ?? ""}`}>{children}</span>;
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
  useHistoryThumb(np?.art_id ?? null);
  const lyrics = useLyrics(np);
  // Assert the reduced-motion capture vote even before any separator mounts.
  useEffect(() => initReactive(), []);

  const nothing = !np || np.player === "none";
  const playing = np?.status === "playing";
  // AM can't seek over SMTC (support matrix) — buttons gate on capability.
  const seekable = !!np?.can_seek;

  // Which work-area corner the window docks to (dock.rs owns the derivation;
  // bottom-right until it reports). ModeContent pins the content plane there.
  const [dockCorner, setDockCorner] = useState<DockCorner>("bottom-right");
  useEffect(() => onDockCorner(setDockCorner), []);

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
  }, [mode]);

  const reducedMotion = useReducedMotion();

  // One-time launch dock: the window is born at WINDOW_MAX (tauri.conf.json
  // matches, so this never resizes anything) — it positions the window in
  // its corner and seeds the dock-corner event. The window is never touched
  // again; every mode change below is pure CSS.
  useEffect(() => {
    commands.setWindowSize(WINDOW_MAX[0], WINDOW_MAX[1]);
  }, []);

  // JS-owned hover: mousemove arms it, mouseleave clears it, and the Rust
  // cursor-left event clears it for gutter exits — once the window goes
  // click-through the webview receives no more mouse events at all, so a
  // CSS :hover would freeze true and pin the revealed chrome open
  // (quick-review catch, 2026-07-10). Every reveal surface keys on the
  // root's data-hot instead of group-hover.
  const [hot, setHot] = useState(false);
  useEffect(() => onCursorLeft(() => setHot(false)), []);
  // Presence (presence.rs) reaches the UI for exactly one reason now:
  // conceal drops hover state (a hidden webview never receives the
  // mouseleave), so the revealed chrome isn't pinned open on restore. The
  // idle-driven mode overrides (P3 ambient grow, P4 working quiet) were
  // removed 2026-07-11 after two weeks of soak — behaviors that GUESS at
  // attention from idle timers fought manual intent badly enough to need
  // latches on their latches; conceal acts on a fact and never did.
  useEffect(
    () =>
      onPresence((p) => {
        if (p.concealed) setHot(false);
      }),
    [],
  );

  // Report the mode's interactive footprint: outside it the
  // fixed-size window is click-through (dock.rs hit watcher), so the
  // invisible gutter above a small shell can't eat clicks — or start drags
  // — meant for whatever is beneath the widget. Shrinks are DEFERRED past
  // the glide: the hit rect must never be smaller than the shell still on
  // screen, or clicks on the visibly-shrinking shell would fall through
  // mid-glide (quick-review catch, 2026-07-10). Grows apply instantly — the
  // gutter intercepting 200ms early is invisible; the shell arriving into a
  // dead zone would not be. hitCommanded keeps interrupted shrinks honest
  // (the winCommanded lesson from the snap era).
  const hitCommanded = useRef<[number, number] | null>(null);
  useEffect(() => {
    const [w1, h1] = MODE_SIZES[mode];
    const [cw, ch] = hitCommanded.current ?? [w1, h1];
    const uw = Math.max(w1, cw);
    const uh = Math.max(h1, ch);
    hitCommanded.current = [uw, uh];
    commands.setHitSize(uw, uh);
    let timer: number | undefined;
    if (uw !== w1 || uh !== h1) {
      timer = window.setTimeout(
        () => {
          hitCommanded.current = [w1, h1];
          commands.setHitSize(w1, h1);
        },
        reducedMotion ? 0 : DUR[3] + 80,
      );
    }
    return () => window.clearTimeout(timer);
  }, [mode, reducedMotion]);

  const morph = {
    // Opacity ONLY — no scale. The shell's size glide is the mode swap's
    // single motion system; a content zoom stacked on it runs out of phase
    // (EASE.out over EASE.inOut) and wobbles the edges — part of the
    // "bouncy" live feel (Thien, 2026-07-09). Also spec failure-mode #2:
    // growth must never read as a zoom.
    initial: reducedMotion ? {} : { opacity: 0 },
    animate: { opacity: 1 },
    // The outgoing content layer dissolves in place (opacity only, no
    // transform — the house exit rule) UNDER the incoming one's 200ms fade,
    // both clipped by the persistent shell, which itself never fades — the
    // widget can't blink toward the desktop mid-swap (ANIMATIONS_FROM_ZERO
    // §1: outgoing 140ms EASE.out sharing the resize window). pointerEvents
    // dies at exit start so a stray click can't land on dead controls.
    exit: {
      opacity: 0,
      pointerEvents: "none" as const,
      transition: {
        duration: reducedMotion ? 0 : DUR[2] / 1000,
        ease: [...EASE.out] as [number, number, number, number],
      },
    },
    transition: { duration: reducedMotion ? 0 : DUR[3] / 1000, ease: [...EASE.out] as [number, number, number, number] },
  };
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

  // Browser mock: there is no OS window to be the widget, so emulate one —
  // a desktop-ish backdrop under a mode-sized root (below). Without this the
  // widget stretches to the whole tab and nothing sits relative to anything.
  useEffect(() => {
    if (!IN_TAURI) document.body.style.background = "#33363c";
  }, []);

  return (
    <div
      className={`group/widget relative ${IN_TAURI ? "h-screen" : ""}`}
      // The mock window frame (browser dev only): the fake OS window, docked
      // 12px off the viewport's bottom-right like dock.rs's corner. Fixed at
      // WINDOW_MAX exactly like the real window — the visible glide belongs
      // to the shell in both worlds, so the mock previews the exact live
      // composition.
      style={
        IN_TAURI
          ? undefined
          : {
              position: "fixed",
              right: 12,
              bottom: 12,
              width: WINDOW_MAX[0],
              height: WINDOW_MAX[1],
            }
      }
      data-hot={hot || undefined}
      onMouseMove={() => setHot(true)}
      onMouseLeave={() => setHot(false)}
      onMouseDown={onDragStart}
    >
      {PRESENCE_OVERLAY && <PresenceOverlay corner={dockCorner} />}
      {/* THE widget box — persistent across modes: the chrome never remounts
          or fades, only the content layers crossfade inside it. It glides
          between mode boxes (200ms EASE.inOut, the house morph curve) out of
          the docked corner inside the never-resizing window — the webview
          compositor owns the entire visible resize, which is why it cannot
          shake or blink (see dock.rs's module comment). Shadow must die out
          inside the 6px window gutter — anything larger hard-clips at the
          transparent window edge and reads as a gray box on light surfaces.
          Opaque, not translucent: without a blur primitive (CSS backdrop-filter
          can't sample the desktop; native acrylic frosts the whole oversized
          window, gutter included) any alpha reads as a hole in the widget,
          not a material — measured at /97, desktop text ghosted through. */}
      <div
        className={`absolute overflow-hidden rounded-xl border border-border/10 bg-surface shadow-[0_1px_3px_rgb(0_0_0/0.18),0_3px_6px_rgb(0_0_0/0.12)] [transition:width_200ms_var(--ease-in-out-tk),height_200ms_var(--ease-in-out-tk)] ${SHELL_SEAT[dockCorner]}`}
        style={{
          width: MODE_SIZES[mode][0] - SHELL_GUTTER_PX,
          height: MODE_SIZES[mode][1] - SHELL_GUTTER_PX,
        }}
      >
      {/* Crossfading content layers, clipped by the gliding shell above. */}
      <AnimatePresence>
        <motion.div key={mode} {...morph} className="absolute inset-0">
        <ModeContent mode={mode} corner={dockCorner}>
        {nothing ? (
          /* The resting state: the note glyph, the words, and the living
             separator's resting middot with nothing to separate — breathing
             (opacity only, 8s) while it waits for a song. The ONE licensed
             ambient element outside the separator's bars (CLAUDE.md
             Presence clause 2). Geometry borrowed from SeparatorDot;
             Waveform's phase machine stays untouched. */
          <div className="flex h-full w-full items-center justify-center gap-1 text-muted">
            <MorphIcon name="note" size={22} />
            <span className="ml-1 text-sm">Nothing playing</span>
            <span className="relative inline-flex h-[11px] w-[5px] items-center" aria-hidden>
              <span className="resting-pulse absolute left-1/2 top-1/2 h-[3px] w-[3px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-muted" />
            </span>
          </div>
        ) : mode === "pill" ? (
          /* "5a — time at rest" (ANIMATIONS.md §3): at rest the pill is pure
             glance — art · title · artist · elapsed time, no buttons. On widget
             hover the time fades out (keeping its flex slot so the title/artist
             line never reflows) and a right-edge scrim carrying play/pause
             fades in; the anchored bracket cluster joins from the app root. All
             three cross at 140ms EASE.out, opacity only. */
          <>
            {/* pl-1.5, not px-3: the art gets ~5px of air vertically, so a
                12px left inset read as stranded (Thien, 2026-07-10). 6px
                also sits the art's 6px radius concentric with the shell's
                12px corner (outer = inset + inner). The text side keeps the
                12px it needs to breathe. */}
            <div className="flex h-full items-center gap-2 pl-1.5 pr-3">
              <Art url={shownArt} size={26} radiusPx={6} />
              {/* Track-change announcement (pill only — the quiet state is
                  where a change needs NOTICING; card/expanded already read
                  as now-playing surfaces): the incoming title/artist fade
                  in via remount (outgoing exits instantly — track changes
                  exit fast and plain) while the separator runs its announce
                  ladder — collapse, gray re-multiply, accent igniting last
                  in the NEW album's color. */}
              <p className="min-w-0 flex-1 truncate text-xs font-medium text-fg">
                <TrackFadeSpan key={`t:${lyricsKeyOf(np)}`} k={lyricsKeyOf(np)}>
                  {np.title}
                </TrackFadeSpan>
                <Waveform trailing={!np.artist} announceKey={lyricsKeyOf(np) ?? undefined} />
                <TrackFadeSpan
                  key={`a:${lyricsKeyOf(np)}`}
                  k={lyricsKeyOf(np)}
                  className="font-normal text-muted"
                >
                  {np.artist}
                </TrackFadeSpan>
              </p>
              <PillTime np={np} />
            </div>
            {/* Scrim + play/pause, revealed on hover. Absolute over the row so
                nothing reflows; the gradient lets the artist text fade UNDER
                the incoming control. 180px wide, play/pause ending 76px from
                the shell right edge — an 8px gap before the corner cluster.
                Stops 2px above the bottom so the progress hairline stays lit.
                Also reveals on keyboard focus (has-[:focus-visible], not
                focus-within — see ModeCluster; play/pause stays tabbable the
                whole time, and a mouse click's residual focus must not pin
                the scrim open, quick-review catch 2026-07-08 / Thien
                2026-07-10). */}
            <div
              className="pointer-events-none absolute bottom-0.5 right-0 top-0 flex w-[180px] items-center justify-end pr-[76px] opacity-0 transition-opacity duration-2 ease-out-tk group-data-[hot]/widget:pointer-events-auto group-data-[hot]/widget:opacity-100 group-has-[:focus-visible]/widget:pointer-events-auto group-has-[:focus-visible]/widget:opacity-100"
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
             with the corner cluster. pb-1 (+ the shell's 1px border) seats
             the h-7 transport row's center on the 25px control centerline
             (see ModeCluster), so the cluster and transport hold still
             across every mode. */
          <div className="flex h-full flex-col gap-1.5 px-3 pb-1 pt-3">
            <div className="flex min-h-0 flex-1 items-center gap-3">
              <Art url={shownArt} size={52} radiusPx={8} />
              <div className="min-w-0 flex-1">
                {/* The living separator rides the TITLE here, trailing (rest =
                    nothing, bars only while playing): at md — the size rung
                    steps with the container (pill sm → card md → expanded md
                    header / lg hero) — it overpowered the 12px artist·album
                    line as a separator, so that line keeps a static dot and
                    the waveform sits where the card has presence to spare
                    (Thien, 2026-07-10). One living instance per view.
                    FLEX row, not inline flow, same as the lyrics header: the
                    title truncates in its own box, and items-center seats the
                    capsules on the line box's center — inline align-middle
                    hangs an md box ~5px under the baseline, visibly low
                    against a cap-height bold title. ml-1 over the waveform's
                    own mx-1.5 = the 10px gap. */}
                <div className="flex min-w-0 items-center">
                  <p className="min-w-0 truncate text-[15px] font-medium text-fg">{np.title}</p>
                  <span className="ml-1 flex shrink-0 items-center">
                    <Waveform size="md" trailing />
                  </span>
                </div>
                <p className="truncate text-xs leading-4 text-muted">
                  {np.artist}
                  {np.album && <SeparatorDot />}
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
          <ExpandedView
            np={np}
            artUrl={shownArt}
            lyrics={lyrics}
            seekable={seekable}
            playing={playing}
          />
        )}
        </ModeContent>
        </motion.div>
      </AnimatePresence>
      {/* Inside the persistent shell but OUTSIDE the content swap: the shell
          never fades, so the cluster never fades with content — and seated
          on the shell it tracks the visible box in every dock corner and
          every mode of the fixed-size window. See ModeCluster. */}
      {!nothing && <ModeCluster mode={mode} onStep={stepMode} />}
      </div>
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
