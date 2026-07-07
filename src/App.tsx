import { memo, useEffect, useLayoutEffect, useRef, useState } from "react";
import { motion, useReducedMotion } from "motion/react";
import { commands, onNowPlaying } from "./lib/backend";
import { currentLineIndex, msUntilNextLine, parseLrc, type LyricLine } from "./lib/lrc";
import { extractAccent } from "./lib/palette";
import * as posClock from "./lib/posClock";
import { initReactive } from "./lib/reactive";
import { DUR, EASE } from "./lib/tokens";
import { Waveform } from "./Waveform";
import type { NowPlaying } from "./types";

// Keep in sync with SEEK_STEP_MS in src-tauri/src/lib.rs (global hotkeys).
const SEEK_STEP_MS = 10_000;

type Mode = "pill" | "card" | "expanded";

/** Native window size per mode — the window snaps, the content morphs. */
const MODE_SIZES: Record<Mode, [number, number]> = {
  pill: [300, 48],
  card: [380, 124],
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
function useLyricIndex(lines: LyricLine[]): number {
  const [idx, setIdx] = useState(() => currentLineIndex(lines, posClock.now()));
  useEffect(() => {
    let timer: number | undefined;
    const sync = () => {
      window.clearTimeout(timer);
      timer = undefined;
      const pos = posClock.now();
      const i = currentLineIndex(lines, pos);
      setIdx(i); // same value → React bails
      if (!posClock.isPlaying()) return; // clock frozen — anchor event re-arms
      const delay = msUntilNextLine(lines, i, pos);
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
  }, [lines]);
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

type LyricsState = { status: "loading" | "none" } | { status: "synced"; lines: LyricLine[] };

/** Fetch + parse synced lyrics per track; "none" is a definitive miss. */
function useLyrics(np: NowPlaying | null): LyricsState {
  const [state, setState] = useState<LyricsState>({ status: "none" });
  const lastKey = useRef<string | null>(null);
  const trackable = np && np.player !== "none" && np.title && np.duration_ms > 0;
  const key = trackable ? `${np.artist}|${np.title}|${np.album}|${np.duration_ms}` : null;
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
      setState(lines.length > 0 ? { status: "synced", lines } : { status: "none" });
    });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return state;
}

const BROWSE_RESUME_MS = 3500;

/** One lyric line. Memoized so a line advance reconciles the two rows whose
 * `current` flipped instead of the whole list; clicks are delegated to the
 * list container via data-line, so rows carry no per-render closures. */
const LyricLineRow = memo(function LyricLineRow({
  text,
  index,
  current,
  seekable,
}: {
  text: string;
  index: number;
  current: boolean;
  seekable: boolean;
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
      className={`relative rounded-md px-3 py-1 text-left text-base leading-normal transition-colors duration-3 ease-out-tk ${
        current ? "font-medium text-fg" : "text-muted/80"
      } ${seekable ? "cursor-pointer hover:bg-fg/5" : ""}`}
    >
      {/* Accent lives on the marker, never the text (contrast floor is 3:1). */}
      <span
        aria-hidden
        className={`absolute left-0 top-1/2 h-4 w-[3px] -translate-y-1/2 rounded-full bg-accent transition-opacity duration-3 ease-out-tk ${
          current ? "opacity-100" : "opacity-0"
        }`}
      />
      {text}
    </Tag>
  );
});

function LyricsPanel({ lines, seekable }: { lines: LyricLine[]; seekable: boolean }) {
  const idx = useLyricIndex(lines);
  const viewportRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [autoOffset, setAutoOffset] = useState(0);
  // Wheel-scrolling pauses auto-follow; it resumes after a short idle.
  const [manualOffset, setManualOffset] = useState<number | null>(null);
  const resumeTimer = useRef<number | undefined>(undefined);

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

  const onWheel = (e: React.WheelEvent) => {
    const next = Math.round(Math.min(Math.max((manualOffset ?? autoOffset) + e.deltaY, 0), maxOffset()));
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
          commands.seekAbs(line.t);
          setManualOffset(null); // hand control back to auto-follow
          window.clearTimeout(resumeTimer.current);
        }}
        className={`flex flex-col gap-1 py-4 will-change-transform ${
          browsing ? "" : "[transition:transform_220ms_var(--ease-in-out-tk)]"
        }`}
        style={{ transform: `translateY(${-offset}px)` }}
      >
        {lines.map((line, i) => (
          <LyricLineRow
            key={`${line.t}-${i}`}
            text={line.text}
            index={i}
            current={i === idx}
            seekable={seekable}
          />
        ))}
      </div>
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
  disabled,
  size = "md",
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  size?: "sm" | "md";
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className={`grid place-items-center rounded-md text-fg transition duration-2 ease-out-tk hover:bg-fg/10 active:scale-95 disabled:pointer-events-none disabled:opacity-40 ${
        size === "sm" ? "h-7 w-7" : "h-8 w-8"
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

/** Monochrome source-app marks (muted, tooltip carries the name). */
const PLAYER_ICONS: Record<NowPlaying["player"], React.ReactNode> = {
  spotify: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm4.58 14.42a.72.72 0 0 1-.99.25c-2.7-1.65-6.1-2.02-10.1-1.1a.72.72 0 0 1-.32-1.4c4.37-1 8.13-.57 11.16 1.28.34.2.45.65.25.97Zm1.23-2.72a.9.9 0 0 1-1.24.3c-3.09-1.9-7.8-2.45-11.45-1.34a.9.9 0 1 1-.52-1.72c4.17-1.27 9.36-.65 12.92 1.53.42.26.55.81.29 1.23Zm.1-2.83C14.3 8.72 8.16 8.51 4.62 9.58a1.08 1.08 0 1 1-.62-2.06c4.06-1.23 10.81-1 14.93 1.45a1.08 1.08 0 0 1-1.1 1.86Z" />
    </svg>
  ),
  apple_music: (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
      <path d="M13.9 1.22a.9.9 0 0 1 .35.72v8.6a2.5 2.5 0 1 1-1.5-2.29V5.02L6.75 6.3v6.02a2.5 2.5 0 1 1-1.5-2.29V3.65a.9.9 0 0 1 .7-.88l7.2-1.7a.9.9 0 0 1 .75.15Z" />
    </svg>
  ),
  other: (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
      <path d="M6 13.5a2 2 0 1 1-1-1.73V4.6a.8.8 0 0 1 .57-.77l6-1.8A.8.8 0 0 1 12.6 2.8v8.2a2 2 0 1 1-1-1.73V5.06l-5 1.5v6.94Z" />
    </svg>
  ),
  none: null,
};

function PlayerBadge({ player }: { player: NowPlaying["player"] }) {
  if (player === "none") return null;
  return (
    <span
      role="img"
      aria-label={`Controlling ${PLAYER_NAMES[player]}`}
      title={PLAYER_NAMES[player]}
      className="grid shrink-0 place-items-center text-muted"
    >
      {PLAYER_ICONS[player]}
    </span>
  );
}

const icons = {
  prev: (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
      <path d="M3 2.5a.5.5 0 0 1 1 0v11a.5.5 0 0 1-1 0v-11ZM13.2 3a.6.6 0 0 1 .8.57v8.86a.6.6 0 0 1-.98.46L6.6 8.46a.6.6 0 0 1 0-.92L13.02 3.1a.6.6 0 0 1 .18-.1Z" />
    </svg>
  ),
  next: (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
      <path d="M13 2.5a.5.5 0 0 0-1 0v11a.5.5 0 0 0 1 0v-11ZM2.8 3a.6.6 0 0 0-.8.57v8.86a.6.6 0 0 0 .98.46l6.42-4.43a.6.6 0 0 0 0-.92L2.98 3.1a.6.6 0 0 0-.18-.1Z" />
    </svg>
  ),
  play: (
    <svg width="18" height="18" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
      <path d="M4.5 2.7a.7.7 0 0 1 1.06-.6l8.13 4.7a.7.7 0 0 1 0 1.2l-8.13 4.7a.7.7 0 0 1-1.06-.6V2.7Z" />
    </svg>
  ),
  pause: (
    <svg width="18" height="18" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
      <path d="M4 2.8c0-.44.36-.8.8-.8h1.4c.44 0 .8.36.8.8v10.4a.8.8 0 0 1-.8.8H4.8a.8.8 0 0 1-.8-.8V2.8Zm5 0c0-.44.36-.8.8-.8h1.4c.44 0 .8.36.8.8v10.4a.8.8 0 0 1-.8.8H9.8a.8.8 0 0 1-.8-.8V2.8Z" />
    </svg>
  ),
  back10: (
    <svg width="17" height="17" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden>
      <path d="M8 3a5 5 0 1 1-4.55 2.93" strokeLinecap="round" />
      <path d="M3.2 2.6v3.3h3.3" strokeLinecap="round" strokeLinejoin="round" />
      <text x="8" y="10.6" fontSize="5.4" fill="currentColor" stroke="none" textAnchor="middle" fontWeight="700">
        10
      </text>
    </svg>
  ),
  fwd10: (
    <svg width="17" height="17" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden>
      <path d="M8 3a5 5 0 1 0 4.55 2.93" strokeLinecap="round" />
      <path d="M12.8 2.6v3.3H9.5" strokeLinecap="round" strokeLinejoin="round" />
      <text x="8" y="10.6" fontSize="5.4" fill="currentColor" stroke="none" textAnchor="middle" fontWeight="700">
        10
      </text>
    </svg>
  ),
  note: (
    <svg width="22" height="22" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
      <path d="M6 13.5a2 2 0 1 1-1-1.73V4.6a.8.8 0 0 1 .57-.77l6-1.8A.8.8 0 0 1 12.6 2.8v8.2a2 2 0 1 1-1-1.73V5.06l-5 1.5v6.94Z" />
    </svg>
  ),
  chevronUp: (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden>
      <path d="M3.5 10 8 5.5l4.5 4.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  chevronDown: (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden>
      <path d="M3.5 6 8 10.5 12.5 6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
};

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
    write(); // before first paint — no mount sweep from scale-x-0
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
      <span ref={timeRef} className="w-9 text-right text-[11px] tabular-nums text-muted" />
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
              scale-x-0 is only the pre-first-write baseline — the rAF driver
              owns the inline transform from then on. */}
          <div
            ref={fillRef}
            className={`h-full w-full origin-left scale-x-0 rounded-full bg-accent will-change-transform ${
              dragFrac === null
                ? "[transition:transform_90ms_var(--ease-out-tk),background-color_220ms_var(--ease-out-tk)]"
                : "[transition:background-color_220ms_var(--ease-out-tk)]"
            }`}
          />
        </div>
      </div>
      <span className="w-9 text-[11px] tabular-nums text-muted">{fmt(np.duration_ms)}</span>
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
      <div
        ref={fillRef}
        className="h-full w-full origin-left scale-x-0 bg-accent will-change-transform [transition:transform_90ms_var(--ease-out-tk),background-color_220ms_var(--ease-out-tk)]"
      />
    </div>
  );
}

function Art({ url, size, radiusPx }: { url: string | null; size: number; radiusPx: number }) {
  return (
    <div
      className="grid shrink-0 place-items-center overflow-hidden bg-surface-2 text-muted"
      style={{ width: size, height: size, borderRadius: radiusPx }}
    >
      {url ? <img src={url} alt="" className="h-full w-full object-cover" draggable={false} /> : icons.note}
    </div>
  );
}

function Transport({ np, seekable, playing }: { np: NowPlaying; seekable: boolean; playing: boolean }) {
  return (
    <div className="flex items-center gap-0.5">
      <IconButton label="Previous track" onClick={commands.prev}>
        {icons.prev}
      </IconButton>
      <IconButton
        label={seekable ? "Back 10 seconds" : `Seeking not supported by ${PLAYER_NAMES[np.player]}`}
        disabled={!seekable}
        onClick={() => commands.seekRel(-SEEK_STEP_MS)}
      >
        {icons.back10}
      </IconButton>
      <IconButton label={playing ? "Pause" : "Play"} onClick={commands.playPause}>
        {playing ? icons.pause : icons.play}
      </IconButton>
      <IconButton
        label={seekable ? "Forward 10 seconds" : `Seeking not supported by ${PLAYER_NAMES[np.player]}`}
        disabled={!seekable}
        onClick={() => commands.seekRel(SEEK_STEP_MS)}
      >
        {icons.fwd10}
      </IconButton>
      <IconButton label="Next track" onClick={commands.next}>
        {icons.next}
      </IconButton>
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
  const contentFade = {
    initial: reducedMotion ? {} : { opacity: 0 },
    animate: { opacity: 1 },
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

  return (
    <div className="h-screen p-1.5" onMouseDown={onDragStart}>
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
            {icons.note}
            <span className="text-sm">Nothing playing</span>
          </div>
        ) : mode === "pill" ? (
          <>
            <div className="flex h-full items-center gap-2 pl-1.5 pr-1">
              <Art url={shownArt} size={26} radiusPx={6} />
              <p className="min-w-0 flex-1 truncate text-xs font-medium text-fg">
                {np.title}
                <Waveform trailing={!np.artist} />
                <span className="font-normal text-muted">{np.artist}</span>
              </p>
              <IconButton size="sm" label={playing ? "Pause" : "Play"} onClick={commands.playPause}>
                {playing ? icons.pause : icons.play}
              </IconButton>
              <IconButton size="sm" label="Expand to card" onClick={() => setMode("card")}>
                {icons.chevronUp}
              </IconButton>
            </div>
            {/* Non-interactive progress hairline — still announced to AT. */}
            <Hairline np={np} />
          </>
        ) : mode === "card" ? (
          <div className="flex h-full items-center gap-3 px-3">
            <Art url={shownArt} size={72} radiusPx={8} />
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <div className="flex items-center gap-1">
                <p className="min-w-0 flex-1 truncate text-[15px] font-medium text-fg">{np.title}</p>
                {/* Windows routes commands to the OS "current" session, which
                    hops between apps — always show which app this card controls. */}
                <PlayerBadge player={np.player} />
                <IconButton size="sm" label="Collapse to pill" onClick={() => setMode("pill")}>
                  {icons.chevronDown}
                </IconButton>
                <IconButton size="sm" label="Expand" onClick={() => setMode("expanded")}>
                  {icons.chevronUp}
                </IconButton>
              </div>
              <p className="truncate text-xs text-muted">
                {np.artist}
                <Waveform trailing={!np.album} />
                {np.album}
              </p>
              <div className="mt-0.5">
                <Transport np={np} seekable={seekable} playing={playing} />
              </div>
              <ProgressBar np={np} />
            </div>
          </div>
        ) : lyrics.status === "synced" ? (
          // Keyed fade so the big-art→lyrics swap dissolves instead of snapping
          // when a fetch resolves mid-view.
          <motion.div key="lyrics-view" {...contentFade} className="flex h-full flex-col gap-2 px-3 pb-2 pt-3">
            <div className="flex items-center gap-2.5">
              <Art url={shownArt} size={44} radiusPx={6} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-[15px] font-medium text-fg">{np.title}</p>
                <p className="truncate text-[13px] text-muted">
                  {np.artist}
                  <Waveform trailing />
                </p>
              </div>
              <PlayerBadge player={np.player} />
              <IconButton size="sm" label="Collapse to card" onClick={() => setMode("card")}>
                {icons.chevronDown}
              </IconButton>
            </div>
            <LyricsPanel lines={lyrics.lines} seekable={seekable} />
            <div className="flex justify-center">
              <Transport np={np} seekable={seekable} playing={playing} />
            </div>
            <ProgressBar np={np} />
          </motion.div>
        ) : (
          <motion.div
            key="art-view"
            {...contentFade}
            className="flex h-full flex-col items-center justify-center gap-3 px-4 pb-2 pt-4"
          >
            <div className="absolute right-2 top-2 flex items-center gap-1">
              <PlayerBadge player={np.player} />
              <IconButton size="sm" label="Collapse to card" onClick={() => setMode("card")}>
                {icons.chevronDown}
              </IconButton>
            </div>
            <Art url={shownArt} size={190} radiusPx={12} />
            <div className="min-w-0 self-stretch text-center">
              <p className="truncate text-sm font-medium text-fg">{np.title}</p>
              <p className="truncate text-xs text-muted">
                {np.artist}
                <Waveform trailing={!np.album} />
                {np.album}
              </p>
              {lyrics.status === "none" && (
                <p className="mt-0.5 text-[10px] text-muted">No synced lyrics</p>
              )}
            </div>
            <Transport np={np} seekable={seekable} playing={playing} />
            <div className="self-stretch">
              <ProgressBar np={np} />
            </div>
          </motion.div>
        )}
      </motion.div>
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
