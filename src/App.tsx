import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { motion, useReducedMotion } from "motion/react";
import { commands, onNowPlaying } from "./lib/backend";
import { currentLineIndex, parseLrc, type LyricLine } from "./lib/lrc";
import { extractAccent } from "./lib/palette";
import { DUR, EASE } from "./lib/tokens";
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

/** Position interpolated between backend emits while playing. */
function useLivePosition(np: NowPlaying | null): number {
  const [, force] = useState(0);
  useEffect(() => {
    if (np?.status !== "playing") return;
    const id = window.setInterval(() => force((n) => n + 1), 250);
    return () => window.clearInterval(id);
  }, [np?.status]);
  if (!np) return 0;
  const drift = np.status === "playing" ? Date.now() - np.emitted_at_ms : 0;
  return Math.min(np.position_ms + drift, np.duration_ms || Infinity);
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

function LyricsPanel({
  lines,
  position,
  seekable,
}: {
  lines: LyricLine[];
  position: number;
  seekable: boolean;
}) {
  const idx = currentLineIndex(lines, position);
  const viewportRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [offset, setOffset] = useState(0);

  // Center-ish the current line (40% from the top) via a compositor-friendly
  // translate on the list, not scrollTop.
  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    const list = listRef.current;
    if (!viewport || !list) return;
    const line = list.children[Math.max(idx, 0)] as HTMLElement | undefined;
    if (!line) return;
    const anchor = viewport.clientHeight * 0.4;
    const target = idx < 0 ? 0 : line.offsetTop + line.offsetHeight / 2 - anchor;
    setOffset(Math.max(0, target));
  }, [idx, lines]);

  return (
    <div ref={viewportRef} className="relative min-h-0 flex-1 overflow-hidden" aria-label="Lyrics">
      <div
        ref={listRef}
        className="flex flex-col gap-1 py-3 will-change-transform [transition:transform_220ms_var(--ease-in-out-tk)]"
        style={{ transform: `translateY(${-offset}px)` }}
      >
        {lines.map((line, i) => {
          const current = i === idx;
          const Tag = seekable ? "button" : "div";
          return (
            <Tag
              key={`${line.t}-${i}`}
              {...(seekable
                ? {
                    type: "button" as const,
                    onClick: () => commands.seekAbs(line.t),
                    "aria-label": `Seek to ${line.text}`,
                    // Out of the tab order — dozens of lines would otherwise sit
                    // between the header and transport; keyboard seek lives on
                    // the progress slider.
                    tabIndex: -1,
                  }
                : {})}
              className={`relative rounded-md px-3 py-0.5 text-left text-sm leading-snug transition-colors duration-3 ease-out-tk ${
                current ? "font-medium text-fg" : "text-muted/80"
              } ${seekable ? "cursor-pointer hover:bg-fg/5" : ""}`}
            >
              {/* Accent lives on the marker, never the text (contrast floor is 3:1). */}
              <span
                aria-hidden
                className={`absolute left-0 top-1/2 h-3.5 w-[3px] -translate-y-1/2 rounded-full bg-accent transition-opacity duration-3 ease-out-tk ${
                  current ? "opacity-100" : "opacity-0"
                }`}
              />
              {line.text}
            </Tag>
          );
        })}
      </div>
      {/* Edge fades so lines dissolve instead of clipping (tall enough to
          cover a wrapped second line on CJK tracks). */}
      <div className="pointer-events-none absolute inset-x-0 top-0 h-8 bg-[linear-gradient(rgb(var(--surface)/0.95),transparent)]" />
      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-8 bg-[linear-gradient(transparent,rgb(var(--surface)/0.95))]" />
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
        size === "sm" ? "h-6 w-6" : "h-7 w-7"
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

const icons = {
  prev: (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
      <path d="M3 2.5a.5.5 0 0 1 1 0v11a.5.5 0 0 1-1 0v-11ZM13.2 3a.6.6 0 0 1 .8.57v8.86a.6.6 0 0 1-.98.46L6.6 8.46a.6.6 0 0 1 0-.92L13.02 3.1a.6.6 0 0 1 .18-.1Z" />
    </svg>
  ),
  next: (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
      <path d="M13 2.5a.5.5 0 0 0-1 0v11a.5.5 0 0 0 1 0v-11ZM2.8 3a.6.6 0 0 0-.8.57v8.86a.6.6 0 0 0 .98.46l6.42-4.43a.6.6 0 0 0 0-.92L2.98 3.1a.6.6 0 0 0-.18-.1Z" />
    </svg>
  ),
  play: (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
      <path d="M4.5 2.7a.7.7 0 0 1 1.06-.6l8.13 4.7a.7.7 0 0 1 0 1.2l-8.13 4.7a.7.7 0 0 1-1.06-.6V2.7Z" />
    </svg>
  ),
  pause: (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
      <path d="M4 2.8c0-.44.36-.8.8-.8h1.4c.44 0 .8.36.8.8v10.4a.8.8 0 0 1-.8.8H4.8a.8.8 0 0 1-.8-.8V2.8Zm5 0c0-.44.36-.8.8-.8h1.4c.44 0 .8.36.8.8v10.4a.8.8 0 0 1-.8.8H9.8a.8.8 0 0 1-.8-.8V2.8Z" />
    </svg>
  ),
  back10: (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden>
      <path d="M8 3a5 5 0 1 1-4.55 2.93" strokeLinecap="round" />
      <path d="M3.2 2.6v3.3h3.3" strokeLinecap="round" strokeLinejoin="round" />
      <text x="8" y="10.6" fontSize="5.4" fill="currentColor" stroke="none" textAnchor="middle" fontWeight="700">
        10
      </text>
    </svg>
  ),
  fwd10: (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden>
      <path d="M8 3a5 5 0 1 0 4.55 2.93" strokeLinecap="round" />
      <path d="M12.8 2.6v3.3H9.5" strokeLinecap="round" strokeLinejoin="round" />
      <text x="8" y="10.6" fontSize="5.4" fill="currentColor" stroke="none" textAnchor="middle" fontWeight="700">
        10
      </text>
    </svg>
  ),
  note: (
    <svg width="20" height="20" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
      <path d="M6 13.5a2 2 0 1 1-1-1.73V4.6a.8.8 0 0 1 .57-.77l6-1.8A.8.8 0 0 1 12.6 2.8v8.2a2 2 0 1 1-1-1.73V5.06l-5 1.5v6.94Z" />
    </svg>
  ),
  chevronUp: (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden>
      <path d="M3.5 10 8 5.5l4.5 4.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  chevronDown: (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden>
      <path d="M3.5 6 8 10.5 12.5 6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
};

function ProgressBar({ np, position }: { np: NowPlaying; position: number }) {
  const barRef = useRef<HTMLDivElement>(null);
  // While dragging, the bar tracks the pointer; the seek commits on release.
  const [dragFrac, setDragFrac] = useState<number | null>(null);
  const seekable = np.can_seek && np.duration_ms > 0;
  const shownMs = dragFrac !== null ? dragFrac * np.duration_ms : position;
  const frac = np.duration_ms > 0 ? shownMs / np.duration_ms : 0;

  const fracFromPointer = (clientX: number): number => {
    const r = barRef.current!.getBoundingClientRect();
    return Math.min(Math.max((clientX - r.left) / r.width, 0), 1);
  };

  return (
    <div className="flex items-center gap-2">
      <span className="w-8 text-right text-[10px] tabular-nums text-muted">{fmt(shownMs)}</span>
      <div
        ref={barRef}
        role={seekable ? "slider" : "progressbar"}
        aria-label="Track position"
        aria-valuemin={0}
        aria-valuemax={np.duration_ms}
        aria-valuenow={Math.round(shownMs)}
        aria-valuetext={`${fmt(shownMs)} of ${fmt(np.duration_ms)}`}
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
          <div
            className={`h-full rounded-full bg-accent ${
              dragFrac === null
                ? "[transition:width_90ms_var(--ease-out-tk),background-color_220ms_var(--ease-out-tk)]"
                : "[transition:background-color_220ms_var(--ease-out-tk)]"
            }`}
            style={{ width: `${Math.min(frac * 100, 100)}%` }}
          />
        </div>
      </div>
      <span className="w-8 text-[10px] tabular-nums text-muted">{fmt(np.duration_ms)}</span>
    </div>
  );
}

function Art({ url, sizeClass, glow }: { url: string | null; sizeClass: string; glow?: boolean }) {
  return (
    <div
      className={`grid shrink-0 place-items-center overflow-hidden rounded-lg bg-surface-2 text-muted ${sizeClass} ${
        glow ? "shadow-[0_8px_48px_-10px_rgb(var(--accent)/0.55)] transition-shadow duration-4 ease-out-tk" : ""
      }`}
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
  useEffect(() => onNowPlaying(setNp), []);
  const position = useLivePosition(np);
  const artUrl = useArt(np?.art_id ?? null);
  // A data URL that fails to decode falls back to the note glyph instead of
  // the browser's broken-image icon.
  const [brokenArtUrl, setBrokenArtUrl] = useState<string | null>(null);
  const shownArt = artUrl !== null && artUrl !== brokenArtUrl ? artUrl : null;
  useArtAccent(shownArt);
  const lyrics = useLyrics(np);

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

  const frac = np && np.duration_ms > 0 ? Math.min(position / np.duration_ms, 1) : 0;

  return (
    <div className="h-screen p-1.5" onMouseDown={onDragStart}>
      <motion.div
        key={mode}
        {...morph}
        className="relative flex h-full flex-col overflow-hidden rounded-xl border border-border/10 bg-surface/95 shadow-[0_0_36px_-12px_rgb(var(--accent)/0.4)] transition-shadow duration-4 ease-out-tk"
      >
        {nothing ? (
          <div className="flex h-full w-full items-center justify-center gap-2 text-muted">
            {icons.note}
            <span className="text-sm">Nothing playing</span>
          </div>
        ) : mode === "pill" ? (
          <>
            <div className="flex h-full items-center gap-2 pl-1.5 pr-1">
              <Art url={shownArt} sizeClass="h-[26px] w-[26px] rounded-md" />
              <p className="min-w-0 flex-1 truncate text-xs font-medium text-fg">
                {np.title}
                <span className="font-normal text-muted"> — {np.artist}</span>
              </p>
              <IconButton size="sm" label={playing ? "Pause" : "Play"} onClick={commands.playPause}>
                {playing ? icons.pause : icons.play}
              </IconButton>
              <IconButton size="sm" label="Expand to card" onClick={() => setMode("card")}>
                {icons.chevronUp}
              </IconButton>
            </div>
            {/* Non-interactive progress hairline — still announced to AT. */}
            <div
              role="progressbar"
              aria-label="Track position"
              aria-valuemin={0}
              aria-valuemax={np.duration_ms}
              aria-valuenow={Math.round(position)}
              aria-valuetext={`${fmt(position)} of ${fmt(np.duration_ms)}`}
              className="absolute inset-x-0 bottom-0 h-[2px] bg-fg/10"
            >
              <div
                className="h-full bg-accent [transition:width_90ms_var(--ease-out-tk),background-color_220ms_var(--ease-out-tk)]"
                style={{ width: `${frac * 100}%` }}
              />
            </div>
          </>
        ) : mode === "card" ? (
          <div className="flex h-full items-center gap-3 px-3">
            <Art url={shownArt} sizeClass="h-[72px] w-[72px]" />
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <div className="flex items-center gap-1">
                <p className="min-w-0 flex-1 truncate text-sm font-medium text-fg">{np.title}</p>
                {/* Windows routes commands to the OS "current" session, which
                    hops between apps — always show which app this card controls. */}
                <span className="shrink-0 text-[10px] uppercase tracking-wider text-muted">
                  {PLAYER_NAMES[np.player]}
                </span>
                <IconButton size="sm" label="Collapse to pill" onClick={() => setMode("pill")}>
                  {icons.chevronDown}
                </IconButton>
                <IconButton size="sm" label="Expand" onClick={() => setMode("expanded")}>
                  {icons.chevronUp}
                </IconButton>
              </div>
              <p className="truncate text-xs text-muted">
                {np.artist}
                {np.album ? ` — ${np.album}` : ""}
              </p>
              <div className="mt-0.5">
                <Transport np={np} seekable={seekable} playing={playing} />
              </div>
              <ProgressBar np={np} position={position} />
            </div>
          </div>
        ) : lyrics.status === "synced" ? (
          // Keyed fade so the big-art→lyrics swap dissolves instead of snapping
          // when a fetch resolves mid-view.
          <motion.div key="lyrics-view" {...contentFade} className="flex h-full flex-col gap-2 px-3 pb-2 pt-3">
            <div className="flex items-center gap-2.5">
              <Art url={shownArt} sizeClass="h-[44px] w-[44px] rounded-md" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-fg">{np.title}</p>
                <p className="truncate text-xs text-muted">{np.artist}</p>
              </div>
              <span className="shrink-0 text-[10px] uppercase tracking-wider text-muted">
                {PLAYER_NAMES[np.player]}
              </span>
              <IconButton size="sm" label="Collapse to card" onClick={() => setMode("card")}>
                {icons.chevronDown}
              </IconButton>
            </div>
            <LyricsPanel lines={lyrics.lines} position={position} seekable={seekable} />
            <div className="flex justify-center">
              <Transport np={np} seekable={seekable} playing={playing} />
            </div>
            <ProgressBar np={np} position={position} />
          </motion.div>
        ) : (
          <motion.div
            key="art-view"
            {...contentFade}
            className="flex h-full flex-col items-center justify-center gap-3 px-4 pb-2 pt-4"
          >
            <div className="absolute right-2 top-2 flex items-center gap-1">
              <span className="text-[10px] uppercase tracking-wider text-muted">{PLAYER_NAMES[np.player]}</span>
              <IconButton size="sm" label="Collapse to card" onClick={() => setMode("card")}>
                {icons.chevronDown}
              </IconButton>
            </div>
            <Art url={shownArt} sizeClass="h-[190px] w-[190px] rounded-xl" glow />
            <div className="min-w-0 self-stretch text-center">
              <p className="truncate text-sm font-medium text-fg">{np.title}</p>
              <p className="truncate text-xs text-muted">
                {np.artist}
                {np.album ? ` — ${np.album}` : ""}
              </p>
              {lyrics.status === "none" && (
                <p className="mt-0.5 text-[10px] text-muted">No synced lyrics</p>
              )}
            </div>
            <Transport np={np} seekable={seekable} playing={playing} />
            <div className="self-stretch">
              <ProgressBar np={np} position={position} />
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
