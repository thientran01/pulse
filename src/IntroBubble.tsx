/*
 * The first-run hint bubble — shown ONCE, the first time a real track appears
 * (App gates it on the persisted `seenIntro`). A corner-aware speech bubble
 * tethered to the widget: it reuses the queue-popover's positioning grammar
 * (right/left pinned to the docked side, opening away from the docked edge) and
 * adds a tether pointing back at the shell. Monochrome per doctrine — the only
 * accent in view is inside the shared SpotifyConnectButton's connected state,
 * never here.
 *
 * Chords are the LIVE resolved ones (App passes them from the hotkey table), so
 * a rebind is reflected — the handoff's hardcoded chords were backwards.
 */
import type { CSSProperties } from "react";
import { Keycaps } from "./Keycaps";
import { SpotifyConnectButton } from "./SpotifyConnectButton";
import type { DockCorner } from "./lib/backend";

export function IntroBubble({
  corner,
  anchorPx,
  searchChord,
  showhideChord,
  onDismiss,
}: {
  corner: DockCorner;
  /** Distance from the docked vertical edge to the bubble's near edge (matches
   * the queue popover's offset so the bubble sits just off the shell). */
  anchorPx: number;
  searchChord: string;
  showhideChord: string;
  onDismiss: () => void;
}) {
  const right = corner.endsWith("right");
  const above = corner.startsWith("bottom");

  const pos: CSSProperties = {};
  pos[right ? "right" : "left"] = 6;
  pos[above ? "bottom" : "top"] = anchorPx;

  // Tether on the shell-facing edge, offset toward the docked side; its two
  // outward border faces form the arrow tip.
  const tether: CSSProperties = {};
  tether[right ? "right" : "left"] = 34;
  tether[above ? "bottom" : "top"] = -6;
  const tetherBorders = above ? "border-b border-r" : "border-t border-l";

  return (
    <div
      role="dialog"
      aria-label="Welcome to Palette"
      onMouseDown={(e) => e.stopPropagation()}
      className="absolute z-40 w-[300px] rounded-xl border border-border/12 bg-surface p-4 shadow-xl shadow-black/50 [transition:opacity_var(--transition-duration-2)_var(--ease-out-tk)]"
      style={pos}
    >
      <div className="mb-3 flex items-start gap-2">
        <p className="flex-1 text-[14px] font-semibold text-fg">Nice — Palette is listening</p>
        <button
          type="button"
          aria-label="Dismiss"
          onClick={onDismiss}
          className="grid h-[22px] w-[22px] place-items-center rounded-md text-muted [transition:background-color_var(--transition-duration-2),color_var(--transition-duration-2)] hover:bg-fg/[0.08] hover:text-fg"
        >
          <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
            <path d="M 4.5,4.5 L 11.5,11.5" />
            <path d="M 11.5,4.5 L 4.5,11.5" />
          </svg>
        </button>
      </div>
      <div className="mb-2 flex items-center gap-2">
        <span className="flex-1 text-[12.5px] text-muted">Show or hide anytime</span>
        <Keycaps chord={showhideChord} />
      </div>
      <div className="flex items-center gap-2">
        <span className="flex-1 text-[12.5px] text-muted">Open Search</span>
        <Keycaps chord={searchChord} />
      </div>
      <div className="mt-3.5 flex items-center gap-2 border-t border-border/[0.08] pt-3">
        <SpotifyConnectButton />
        <span className="text-[11px] leading-tight text-fg/40">for queue &amp; playback control</span>
      </div>
      <span
        aria-hidden
        className={`absolute h-3 w-3 rotate-45 border-border/12 bg-surface ${tetherBorders}`}
        style={tether}
      />
    </div>
  );
}
