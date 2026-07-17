/*
 * The transport family — lifted out of App.tsx (the LyricsPanel mechanical-
 * move precedent, 2026-07-12) so the focus window's realm imports the
 * controls without importing the whole widget. Everything control-shaped
 * lives here: IconButton, the play/pause optimistic morph, capability-gated
 * seek, the skip pass-through flick, the shared rAF progress driver, and
 * ProgressBar. New with the move: the "lg" tier (focus mode's console —
 * 56px hits, 22/26px glyphs, a 4→7px rail) alongside the widget's xs/sm/md.
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { MorphIcon } from "./icons/MorphIcon";
import { useSeekTick } from "./icons/useSeekTick";
import { useSkipFlick } from "./icons/useSkipFlick";
import { commands, onSeekNudge } from "./lib/backend";
import * as posClock from "./lib/posClock";
import { DUR, EASE } from "./lib/tokens";
import type { NowPlaying } from "./types";

// Keep in sync with SEEK_STEP_MS in src-tauri/src/lib.rs (global hotkeys).
export const SEEK_STEP_MS = 10_000;

export function fmt(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export type ButtonSize = "xs" | "sm" | "md" | "lg";

export function IconButton({
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
  size?: ButtonSize;
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
      // Press scale steps with the target: ~0.95 on the widget tiers, 0.97
      // on the console's 56px buttons — a small-button scale on a large
      // target reads as a lurch (the house size-proportional rule).
      className={`grid place-items-center rounded-md text-fg [transition:background-color_140ms_var(--ease-out-tk),opacity_140ms_var(--ease-out-tk),scale_90ms_var(--ease-out-tk)] hover:bg-fg/10 disabled:pointer-events-none disabled:opacity-40 ${
        size === "lg" ? "active:scale-[0.97]" : "active:scale-95"
      } ${
        size === "xs" ? "h-6 w-6" : size === "sm" ? "h-7 w-7" : size === "lg" ? "h-14 w-14" : "h-8 w-8"
      }`}
    >
      {children}
    </button>
  );
}

export const PLAYER_NAMES: Record<NowPlaying["player"], string> = {
  apple_music: "Apple Music",
  spotify: "Spotify",
  other: "Media",
  none: "",
};

/** Per-tier glyph sizes: skip/seek share one, play/pause reads primary. */
const GLYPH: Record<ButtonSize, { skip: number; seek: number; play: number }> = {
  xs: { skip: 16, seek: 17, play: 18 },
  sm: { skip: 16, seek: 17, play: 18 },
  md: { skip: 16, seek: 17, play: 18 },
  lg: { skip: 22, seek: 22, play: 26 },
};

/** The marquee morph, fired optimistically on pointerdown — the morph IS the
 * press response (SMTC command bools lie; the next emit is the
 * reconciliation). Diff-suppressed emits mean a silently failed command never
 * sends a correcting payload, so a timeout falls back to the prop. */
export function PlayPauseButton({
  playing,
  iconSize,
  size = "md",
}: {
  playing: boolean;
  iconSize?: number;
  size?: ButtonSize;
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
      <MorphIcon name={shown ? "pause" : "play"} size={iconSize ?? GLYPH[size].play} dur={DUR[2]} ease={EASE.out} />
    </IconButton>
  );
}

export function SeekButton({
  dir,
  seekable,
  player,
  size = "md",
}: {
  dir: -1 | 1;
  seekable: boolean;
  player: NowPlaying["player"];
  size?: ButtonSize;
}) {
  const { scope, tick } = useSeekTick(dir);
  // Hotkey seeks spin the glyph exactly like a click (PR #21 follow-up).
  // tick is re-created per render, so the subscription reads it through a
  // ref instead of re-listening across the IPC every render. Gated on
  // seekable: the hotkey fires the SMTC call regardless, but for a player
  // that ignores it (Apple Music) a spin would claim a seek that never
  // happened — the disabled button stays still. seekable is also read
  // through a ref inside the callback: listen()/unlisten is promise-based,
  // so a capability flip to false has a brief async gap before the
  // subscription actually drops — the fire-time check closes it.
  const tickRef = useRef(tick);
  tickRef.current = tick;
  const seekableRef = useRef(seekable);
  seekableRef.current = seekable;
  useEffect(() => {
    if (!seekable) return;
    return onSeekNudge((d) => {
      if (d === dir && seekableRef.current) void tickRef.current();
    });
  }, [seekable, dir]);
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
        <MorphIcon name={dir < 0 ? "seekBack" : "seekFwd"} size={GLYPH[size].seek} />
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
export function useProgressDom(
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
        // A discontinuity SNAPS instead of gliding: the 90ms transform
        // transition exists for playback/seek deltas, but riding it through
        // a track-change reset visibly rewound the fill from the old song's
        // position to 0 — "track changes exit fast and plain" (motion pass,
        // 2026-07-16). >0.5 is far beyond any 90ms playback delta (a click
        // far up the bar snaps too — landing instantly is the honest read);
        // the first write after mount snaps for the same reason.
        const jump = lastFrac === -1 || (Math.abs(frac - lastFrac) > 0.5 && dragFrac === null);
        lastFrac = frac;
        if (jump) {
          const el = fill.current;
          el.style.transitionProperty = "background-color";
          el.style.transform = `scaleX(${frac})`;
          void el.offsetWidth; // flush so the write lands untransitioned
          el.style.transitionProperty = "";
        } else {
          fill.current.style.transform = `scaleX(${frac})`;
        }
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

export function ProgressBar({ np, size = "md" }: { np: NowPlaying; size?: "md" | "lg" }) {
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

  // The lg rail steps 4→7px (the widget's 3→5 move, one notch up) with 15px
  // labels sitting outside the track ends — focus mode's console shares the
  // instrument's edges.
  // Full literal class strings per branch — Tailwind's scanner needs the
  // complete token in source; a template-built `group-hover:${x}` never
  // generates its CSS.
  const label = size === "lg" ? "text-[15px] leading-5" : "text-[11px] leading-4";
  const railH =
    size === "lg"
      ? { rest: "h-[4px]", live: "h-[7px]", hover: "h-[4px] group-hover:h-[7px]" }
      : { rest: "h-[3px]", live: "h-[5px]", hover: "h-[3px] group-hover:h-[5px]" };
  return (
    <div className={`flex items-center ${size === "lg" ? "gap-4" : "gap-2"}`}>
      {/* No JSX children: the rAF driver owns this text (a rendered child
          would let drag re-renders clobber the drag-preview time). The
          pre-paint write() populates it at mount. */}
      {/* Hug width: the elapsed label's left edge sits flush on the album
          cover's left edge. tabular-nums keeps the width stable within a
          digit count, so the track edge only moves at e.g. 9:59→10:00. */}
      <span ref={timeRef} className={`${label} tabular-nums text-muted`} />
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
        className={`group relative flex-1 touch-none ${size === "lg" ? "h-4" : "h-3"} ${seekable ? "cursor-pointer" : ""}`}
      >
        <div
          className={`absolute inset-x-0 top-1/2 -translate-y-1/2 overflow-hidden rounded-full bg-fg/10 transition-[height] duration-2 ease-out-tk ${
            dragFrac !== null ? railH.live : seekable ? railH.hover : railH.rest
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
      <span className={`${label} tabular-nums text-muted`}>{fmt(np.duration_ms)}</span>
    </div>
  );
}

/** Prev/next with the pass-through flick (useSkipFlick): a masked strip of
 * three glyph copies — the live one plus ghosts parked at ±width, which the
 * hook's wrap-on-mash frame-identity depends on. The mask is the glyph's own
 * box (16px at the widget tiers, 22px at lg), so the wipe happens inside the
 * button and never brushes the neighboring seek button. */
export function SkipButton({ dir, size = "md" }: { dir: -1 | 1; size?: ButtonSize }) {
  const glyphPx = GLYPH[size].skip;
  const { scope, tick } = useSkipFlick(dir, glyphPx);
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
      <span
        className="grid place-items-center overflow-hidden"
        style={{ height: glyphPx, width: glyphPx }}
      >
        <span ref={scope} className="relative grid place-items-center will-change-transform">
          <MorphIcon name={glyph} size={glyphPx} />
          <span aria-hidden className="absolute right-full top-0 grid">
            <MorphIcon name={glyph} size={glyphPx} />
          </span>
          <span aria-hidden className="absolute left-full top-0 grid">
            <MorphIcon name={glyph} size={glyphPx} />
          </span>
        </span>
      </span>
    </IconButton>
  );
}

/** compact = the card's bottom row: 24px buttons on an 8px gap. Expanded
 * keeps the 32px/4px transport; room = focus mode's console (56px buttons,
 * gap-2 — the primary verb reads primary via the glyph step, not the hit). */
export function Transport({
  np,
  seekable,
  playing,
  compact = false,
  room = false,
}: {
  np: NowPlaying;
  seekable: boolean;
  playing: boolean;
  compact?: boolean;
  room?: boolean;
}) {
  const size: ButtonSize = room ? "lg" : compact ? "xs" : "md";
  return (
    <div className={`flex items-center ${room ? "gap-2" : compact ? "gap-2" : "gap-1"}`}>
      <SkipButton size={size} dir={-1} />
      <SeekButton size={size} dir={-1} seekable={seekable} player={np.player} />
      <PlayPauseButton size={size} playing={playing} />
      <SeekButton size={size} dir={1} seekable={seekable} player={np.player} />
      <SkipButton size={size} dir={1} />
    </div>
  );
}
