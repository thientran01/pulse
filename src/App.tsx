import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { AnimatePresence, motion, useIsPresent, useReducedMotion } from "motion/react";
import type { MorphName } from "./icons/geometry";
import { MorphIcon } from "./icons/MorphIcon";
import { useBracketPulse } from "./icons/useBracketPulse";
import {
  commands,
  onCursorLeft,
  onDockCorner,
  onHotkeysChanged,
  onNowPlaying,
  onPresence,
  onPresenceDebug,
  onSettingsChanged,
  onSpotifyJump,
  onSpotifyJumpCancel,
  type DockCorner,
  type HotkeyInfo,
} from "./lib/backend";
import { chordById } from "./lib/chords";
import { Keycaps } from "./Keycaps";
import { IntroBubble } from "./IntroBubble";
import { WidgetMenu, WIDGET_MENU_W, WIDGET_MENU_H } from "./WidgetMenu";
import { VOCAL_LEAD_MS } from "./lib/lrc";
import { PlayPauseButton, ProgressBar, Transport, useProgressDom } from "./Transport";
import { LyricsPanel, lyricsKeyOf, useLyrics, type LyricsState } from "./LyricsPanel";
import { extractAccent } from "./lib/palette";
import * as posClock from "./lib/posClock";
import { initReactive, setReactiveEnabledSetting } from "./lib/reactive";
import { DUR, EASE } from "./lib/tokens";
import {
  armSuppression,
  clearSuppression,
  isAnnounceSuppressed,
  POPOVER_GAP,
  POPOVER_W,
  QueuePanel,
  useSpotifyStatus,
} from "./Queue";
import { SeparatorDot, Waveform } from "./Waveform";
import {
  IN_TAURI,
  type NowPlaying,
  type PresenceDebug,
  type PresenceState,
} from "./types";


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

// LyricsState / lyricsKeyOf / useLyrics / useLyricIndex / LyricsPanel moved
// to src/LyricsPanel.tsx (2026-07-11) so the focus window's realm imports
// the lyric surface without importing the whole widget.

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
/** The no-session resting state. The pill stays a single calm glance (art's
 * job is done by absence); card and expanded add a one-line nudge pointing at
 * Search — the play-from-silence path — so a stranger with nothing playing
 * learns how to start. The resting middot is the ONE licensed ambient element
 * outside the separator's bars (CLAUDE.md Presence clause 2); its markup rides
 * along here unchanged. */
function EmptyState({ mode, searchChord }: { mode: Mode; searchChord: string }) {
  const restingRow = (
    <div className="flex items-center justify-center gap-1 text-muted">
      <MorphIcon name="note" size={22} />
      <span className="ml-1 text-sm">Nothing playing</span>
      <span className="relative inline-flex h-[11px] w-[5px] items-center" aria-hidden>
        <span className="resting-pulse absolute left-1/2 top-1/2 h-[3px] w-[3px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-muted" />
      </span>
    </div>
  );
  // Pill stays calm; also fall back to the lone row until the chord table seeds
  // (empty chord → no honest keycaps to show).
  if (mode === "pill" || !searchChord) {
    return <div className="flex h-full w-full items-center justify-center">{restingRow}</div>;
  }
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-2">
      {restingRow}
      <p className="flex items-center gap-1.5 text-[12px] text-muted/80">
        Press <Keycaps chord={searchChord} size="sm" /> to play something
      </p>
    </div>
  );
}

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
function ModeCluster({
  mode,
  onStep,
  queueOpen,
}: {
  mode: Mode;
  onStep: (d: -1 | 1) => void;
  queueOpen: boolean;
}) {
  return (
    <div
      // The cluster stays revealed while the queue UI is open — the corner
      // chrome holds as one band while the popover/surface is up, so the
      // mode ladder stays reachable without re-earning the hover.
      className={`pointer-events-none absolute bottom-[4px] right-[7px] z-20 flex items-center gap-1 opacity-0 transition-opacity duration-2 ease-out-tk group-data-[hot]/widget:pointer-events-auto group-data-[hot]/widget:opacity-100 group-has-[:focus-visible]/widget:pointer-events-auto group-has-[:focus-visible]/widget:opacity-100 ${
        queueOpen ? "pointer-events-auto opacity-100" : ""
      }`}
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
      {/* The ladder's fourth rung: from expanded, the expand verb keeps
          going — into the fullscreen focus window (focus.rs). Focus is a
          TRANSIENT window, not a mode: MODE_ORDER/pulse.mode never learn
          about it, so a relaunch can never boot into it; Esc/collapse in
          the focus window steps back here. */}
      <ModeButton
        to="expand"
        label={
          mode === "pill"
            ? "Expand to card"
            : mode === "card"
              ? "Expand to lyrics"
              : "Expand to focus"
        }
        slot="mode-primary"
        onClick={() => {
          if (mode === "expanded") commands.focusOpen();
          else onStep(1);
        }}
      />
    </div>
  );
}

/** The 11a queue toggle: opens the popover in pill/card, the queue surface
 * in expanded — one open/closed bit, the garment follows the mode. Active
 * wash while open, like the expanded view toggle's lyrics state. One
 * component, two seats (QueueSeat bottom-left in card/expanded, the pill's
 * hover scrim beside play/pause) so the affordance never drifts. */
function QueueButton({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      aria-label={open ? "Close queue" : "Open queue"}
      title={open ? "Close queue" : "Open queue"}
      aria-pressed={open}
      onClick={onToggle}
      className={`grid h-7 w-7 place-items-center rounded-md text-fg [transition:background-color_140ms_var(--ease-out-tk),scale_90ms_var(--ease-out-tk)] hover:bg-fg/10 active:scale-95 ${
        open ? "bg-fg/10" : ""
      }`}
    >
      <MorphIcon name="queue" size={13} />
    </button>
  );
}

/**
 * The queue seat: bottom-left corner, card + expanded only. Evicted from the
 * bracket cluster (2026-07-11): the brackets are CONTAINER verbs — three
 * seats crowded the corner and the pill's scrim seat was never re-derived
 * against the wider cluster (a 23px queue-over-play/pause overlap) — while
 * queue is a CONTENT surface, so it takes the corner the cluster's grammar
 * leaves free. Both garments are 380 wide, so docked either bottom corner
 * the seat holds its screen pixels across the card⇄expanded glide — the
 * same fixed-point continuity the brackets get on the right. The pill has
 * no free corner (bottom-left IS the album art, and a control overlaid on
 * artwork loses to the contained-icon doctrine), so its queue seat rides
 * the hover scrim beside play/pause instead — see the pill branch.
 * Same contract as ModeCluster: shell coordinates on the 25px control
 * centerline (bottom-[4px], mirrored left-[7px]), hidden at rest with the
 * hover/focus-visible reveal, pinned open while the queue UI it opened is
 * open (it hosts the control that closes it), mousedown swallowed so a
 * press never falls through to the root drag handler.
 */
function QueueSeat({ queueOpen, onToggle }: { queueOpen: boolean; onToggle: () => void }) {
  return (
    <div
      className={`pointer-events-none absolute bottom-[4px] left-[7px] z-20 opacity-0 transition-opacity duration-2 ease-out-tk group-data-[hot]/widget:pointer-events-auto group-data-[hot]/widget:opacity-100 group-has-[:focus-visible]/widget:pointer-events-auto group-has-[:focus-visible]/widget:opacity-100 ${
        queueOpen ? "pointer-events-auto opacity-100" : ""
      }`}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <QueueButton open={queueOpen} onToggle={onToggle} />
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

/** How soon after entering expanded a lyrics resolve still counts as "already
 * there": inside this window the swap renders plain (no arrival cascade), so
 * the inner choreography never stacks on the mode morph's tail. */
const SNAP_WINDOW_MS = 300;
/** How long the "No synced lyrics" caption stays before fading out — it's an
 * answer to "why am I looking at art instead of lyrics", and once read it
 * shouldn't sit under the metadata forever. The reserved slot keeps its
 * height, so the fade moves nothing. */
const NO_LYRICS_CAPTION_MS = 4000;

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
  queueOpen,
  onCloseQueue,
  spotifyConnected,
}: {
  np: NowPlaying;
  artUrl: string | null;
  lyrics: LyricsState;
  seekable: boolean;
  playing: boolean;
  /** The 11a queue surface, layered over whichever of art/lyrics shows.
   * Chrome (progress/transport/toggles) lives outside the surface and
   * never moves during the swap. */
  queueOpen: boolean;
  onCloseQueue: () => void;
  spotifyConnected: boolean;
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

  // Which of the three peer views owns the surface. They crossfade IN PLACE
  // under a fixed header — switching content, never a panel over a panel.
  const active: "lyrics" | "album" | "queue" = queueOpen
    ? "queue"
    : showLyrics
      ? "lyrics"
      : "album";
  // The header is shown for lyrics + queue (identical markup, so crossing
  // between them never moves it); the album view is the one headerless
  // surface (its big cover is the identity), so the header fades only there.
  const headerShown = active !== "album";

  // Peer-layer visibility: opaque, same footprint, OPACITY-ONLY crossfade —
  // in 200ms / out 140ms EASE.out, visibility deferred past the fade so a
  // hidden layer neither eats clicks nor ghosts. No scale/transform: a scale
  // exhale reads as a panel opening and lets the layer behind peek at the
  // edges (both were live bugs, 2026-07-12). `inert` drops the inactive
  // layers from hit-testing and the a11y tree. (prefers-reduced-motion is
  // handled by the global transition kill in index.css.)
  const layer = (on: boolean): string =>
    on
      ? "opacity-100 [transition:opacity_200ms_var(--ease-out-tk)]"
      : "invisible opacity-0 [transition:opacity_140ms_var(--ease-out-tk),visibility_0s_140ms]";

  return (
    // pb-0.5 (+ the shell's 1px border) seats the h-8 transport row's center
    // on the 25px control centerline (see ModeCluster) — 2px less than the
    // card's pb-1 because this transport row is 4px taller.
    <div className="relative flex h-full flex-col gap-2 px-3 pb-0.5 pt-3">
      {/* The content surface: one box, three peer views (lyrics · album ·
          queue) crossfading IN PLACE beneath a fixed header — only which
          layer is opaque changes, so a swap reads as switching content, never
          a panel sliding over (the queue used to be a scale-overlay: it read
          as a panel opening AND let the view behind peek at the edges). */}
      <div className="relative min-h-0 flex-1">
        {/* Fixed now-playing header — ABSOLUTE, so it never reflows the bodies
            (a flex-flow header shifted the album column ~50px on every swap:
            the "content starts ~20px down then jumps up" bug). Carries the one
            living md waveform. Shown for lyrics + queue (headerShown holds
            across that swap, so it doesn't even fade); fades only for the
            album view. pr-8 clears the hover-revealed ViewToggle seat. */}
        <div
          inert={!headerShown}
          className={`absolute inset-x-0 top-0 z-10 flex items-center gap-2.5 pr-8 ${layer(headerShown)}`}
        >
          <Art url={artUrl} size={44} radiusPx={6} />
          <div className="min-w-0 flex-1">
            {/* The living instance rides the TITLE, matching the card and the
                pill — the capsules are a now-playing pulse and belong to the
                song (Thien, 2026-07-10). Flex row, not inline flow: a long
                title truncates in its own box while the waveform keeps its
                seat right after the clipped text. ml-1 over the waveform's
                mx-1.5 = the same 10px gap as the card. */}
            <div className="flex min-w-0 items-center">
              <TruncateTip text={np.title} className="text-[15px] font-medium text-fg" />
              {/* Mounted only while the header shows — one living Waveform per
                  state (doctrine: one reactive surface per view). In the album
                  view the lg hero is that surface; leaving both always-mounted
                  ran two rAF/bands loops at once. lastAlive carries the bloom
                  state across this mount/unmount, so the album toggle doesn't
                  re-bloom the capsules from the dot. */}
              {headerShown && (
                <span className="ml-1 flex shrink-0 items-center">
                  <Waveform size="md" trailing />
                </span>
              )}
            </div>
            <TruncateTip text={np.artist} className="text-[13px] text-muted" />
          </div>
        </div>

        {/* Lyrics view — pt-[52px] clears the fixed header. Keyed per track so
            a change re-anchors fresh instead of sliding the old offset. */}
        <div
          inert={active !== "lyrics"}
          className={`absolute inset-0 flex flex-col bg-surface pt-[52px] ${layer(active === "lyrics")}`}
        >
          {lyricsLive && (
            <LyricsPanel
              key={lyrics.key}
              lines={lyrics.lines}
              seekable={seekable}
              leadMs={VOCAL_LEAD_MS[np.player]}
              entrance={celebrate}
            />
          )}
        </div>

        {/* Album view — big cover centered in the full box (headerless, no pt);
            the identity when lyrics are off or missing. Absolute inset-0, so it
            never reflows regardless of the header's presence. */}
        <div
          inert={active !== "album"}
          className={`absolute inset-0 flex flex-col items-center justify-center gap-3 bg-surface ${layer(active === "album")}`}
        >
          <Art url={artUrl} size={190} radiusPx={12} />
          <div className="min-w-0 self-stretch text-center">
            <p className="truncate text-sm font-medium text-fg">{np.title}</p>
            <p className="truncate text-xs text-muted">
              {np.artist}
              {np.album && <SeparatorDot />}
              {np.album}
            </p>
            {/* Height-reserved caption slot: the caption fading in must not
                re-center the column and shift the art (it did — every lyrics
                miss nudged the 190px cover ~7px). "Finding lyrics…" waits
                400ms so fast fetches never flash it; the miss caption fades
                back out once read (captionExpired), aria-hidden going with it
                so AT doesn't announce a caption sighted users can't see. */}
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
          {/* The living separator at hero size, filling the dead zone between
              the metadata and the transport. The metadata line keeps a static
              middot so the reactive surface isn't on screen twice. Mounted
              only while the album view is active — one living Waveform per
              state (the header's md carries lyrics + queue); lastAlive bridges
              the mount so the toggle doesn't re-bloom it from the dot. */}
          {active === "album" && (
            <div className="mt-3">
              <Waveform size="lg" />
            </div>
          )}
        </div>

        {/* Queue view — the same fixed header sits above it; the list is the
            body. Was an always-mounted scale-overlay (that read as a panel
            opening, and the .98 exhale let the view behind peek at the edges);
            now a peer layer that crossfades like the others, still always
            mounted so scroll position and the history feed survive the swap. */}
        <div
          inert={active !== "queue"}
          onMouseDown={(e) => e.stopPropagation()}
          className={`absolute inset-0 flex flex-col bg-surface pt-[52px] ${layer(active === "queue")}`}
        >
          <QueuePanel np={np} connected={spotifyConnected} open={queueOpen} />
        </div>
      </div>
      {/* Hoisted chrome, like progress/transport below: the toggle keeps its
          seat while the content it switches crossfades under it. Glyph and
          label name the destination; no lyrics = disabled in place. The
          miss states key on status === "none" (not !== "synced"): during a
          track change there's a one-render gap where the OLD track's synced
          state hasn't flipped to loading yet (see lyricsKeyOf), and mapping
          it to micOff would kick a spurious slash morph on every skip.
          11a: the note seat is the ONLY lyrics entry — from the queue
          surface it EXITS to lyrics (or art when none are synced). */}
      <ViewToggle
        glyph={
          queueOpen
            ? lyricsLive
              ? "mic"
              : "note"
            : lyricsLive
              ? showLyrics
                ? "note"
                : "mic"
              : lyrics.status === "none"
                ? "micOff"
                : "mic"
        }
        label={
          queueOpen
            ? lyricsLive
              ? "Show lyrics"
              : "Show album cover"
            : lyricsLive
              ? showLyrics
                ? "Show album cover"
                : "Show lyrics"
              : lyrics.status === "none"
                ? "No synced lyrics"
                : "Finding lyrics…"
        }
        disabled={!queueOpen && !lyricsLive}
        onToggle={() => {
          if (queueOpen) {
            // Exit the queue surface toward lyrics (the note seat's promise);
            // with none synced the art base is what's underneath anyway.
            if (lyricsLive && view !== "lyrics") toggleView();
            onCloseQueue();
            return;
          }
          toggleView();
        }}
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
  suppress = false,
  className,
  children,
}: {
  k: string | null;
  /** A play_now jump's intermediate flicker — real remount, no announcement
   * (the target's own mount animates normally; see isAnnounceSuppressed). */
  suppress?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  // Captured once at mount, BEFORE the commit effect below records the new
  // key — exactly "was this mount a change".
  const [animate] = useState(() => !suppress && k !== null && lastPillKey !== null && k !== lastPillKey);
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
  // Resolved global-hotkey table (seeded below), so onboarding surfaces render
  // the LIVE Search / show-hide chords rather than a hardcoded default.
  const [hotkeys, setHotkeys] = useState<HotkeyInfo[]>([]);
  // Onboarding + widget-menu overlays. seenIntro defaults true (assume seen)
  // so the bubble can't flash before the seed resolves the real value.
  const [seenIntro, setSeenIntro] = useState(true);
  const [introOpen, setIntroOpen] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const didIntro = useRef(false);
  // Assert the reduced-motion capture vote even before any separator mounts,
  // then compose the persisted "Audio-reactive separator" preference on top:
  // seed it once from prefsSeed and keep it live via "settings-changed" (a
  // prefs toggle emits it). reactive.ts ANDs it with reduced motion and gates
  // both the visual subscription and backend audio capture.
  useEffect(() => {
    initReactive();
    let alive = true;
    void commands.prefsSeed().then((s) => {
      if (!alive) return;
      setReactiveEnabledSetting(s.reactive_separator);
      // Live hotkey chords power the empty-state nudge + first-run bubble, so
      // onboarding copy tracks a rebind instead of hardcoding a default.
      setHotkeys(s.hotkeys);
      setSeenIntro(s.seen_intro);
    });
    const un = onSettingsChanged(({ key, value }) => {
      if (key === "reactive_separator") setReactiveEnabledSetting(Boolean(value));
    });
    const unHotkeys = onHotkeysChanged(setHotkeys);
    return () => {
      alive = false;
      un();
      unHotkeys();
    };
  }, []);
  const searchChord = chordById(hotkeys, "search");
  const showhideChord = chordById(hotkeys, "showhide");

  const nothing = !np || np.player === "none";
  const playing = np?.status === "playing";
  // AM can't seek over SMTC (support matrix) — buttons gate on capability.
  const seekable = !!np?.can_seek;

  // The queue UI (11a): ONE open/closed bit; the garment follows the mode
  // (popover over pill/card, content surface inside expanded), so state is
  // shared across the ladder and never reset by resizing — the continuity
  // rule for free. Closed when no session (the cluster that opens it is
  // hidden then too).
  const [queueOpen, setQueueOpen] = useState(false);
  useEffect(() => {
    if (nothing) setQueueOpen(false);
  }, [nothing]);
  const spotify = useSpotifyStatus();
  const spotifyConnected = spotify.connected;
  // Jump-intermediate suppression for the pill's announcement layer.
  const announceSuppressed = isAnnounceSuppressed(np);
  // Backend-initiated jumps (the queue-aware skip: transport next /
  // Ctrl+Alt+N landing on the up-next front) arm the same suppression the
  // frontend's own play-now does — one announcement, on the target — and
  // clear it when the backend fell back to a plain skip (that legitimate
  // change must announce).
  useEffect(() => onSpotifyJump(armSuppression), []);
  useEffect(() => onSpotifyJumpCancel(clearSuppression), []);

  // Which work-area corner the window docks to (dock.rs owns the derivation;
  // bottom-right until it reports). ModeContent pins the content plane there.
  // Starts null — not the default — so the seat FLIP below can tell the
  // launch seed (null → corner, never animated) from a real corner change.
  const [dockCorner, setDockCorner] = useState<DockCorner | null>(null);
  useEffect(() => onDockCorner(setDockCorner), []);
  const corner = dockCorner ?? "bottom-right";

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

  // First-run hint: the first time a REAL track appears (not the resting
  // state), show the bubble ONCE and immediately persist seenIntro — so it
  // never reappears, even across a crash before dismiss. Prefs "Show again"
  // re-arms it for next launch. didIntro guards against a same-session
  // nothing↔playing flap re-triggering it.
  useEffect(() => {
    if (seenIntro || nothing || didIntro.current) return;
    didIntro.current = true;
    setIntroOpen(true);
    commands.setSetting("seenIntro", true);
  }, [seenIntro, nothing]);

  // The bubble and the right-click menu are transient overlays that extend past
  // the mode box. While either is open the whole window goes hit-active (below)
  // and a dismiss scrim is painted, so a click-away lands instead of falling
  // through the click-through gutter to the desktop.
  const overlayOpen = introOpen || menu !== null;
  const closeOverlays = () => {
    setIntroOpen(false);
    setMenu(null);
  };
  useEffect(() => {
    if (!overlayOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeOverlays();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [overlayOpen]);

  // A dock-corner CHANGE re-seats the shell across the fixed-size window —
  // as a bare class flip it teleports the visible widget mid-snap, which
  // blended into the native glide as one too-fast lurch (Thien, live,
  // 2026-07-10). FLIP it instead: start the shell at its old seat via
  // `translate` and release to 0, so the re-seat glides (EASE.out, DUR 3 =
  // SNAP_MS — .shell-glide) in step with the native window glide, composing
  // into one continuous motion from drop point to dock. The null-start on
  // dockCorner exempts the launch seed; only real corner changes animate.
  const shellRef = useRef<HTMLDivElement>(null);
  const prevCornerRef = useRef<DockCorner | null>(null);
  useLayoutEffect(() => {
    const prev = prevCornerRef.current;
    prevCornerRef.current = dockCorner;
    const el = shellRef.current;
    if (!prev || !dockCorner || prev === dockCorner || !el || reducedMotion) return;
    const inset = SHELL_GUTTER_PX / 2;
    const w = MODE_SIZES[mode][0] - SHELL_GUTTER_PX;
    const h = MODE_SIZES[mode][1] - SHELL_GUTTER_PX;
    // SHELL_SEAT's geometry in numbers: the seat's top-left within the window.
    const seat = (c: DockCorner): [number, number] => [
      c.endsWith("right") ? WINDOW_MAX[0] - inset - w : inset,
      c.startsWith("bottom") ? WINDOW_MAX[1] - inset - h : inset,
    ];
    const [px, py] = seat(prev);
    const [nx, ny] = seat(dockCorner);
    // A previous corner glide may still be in flight — fold its current
    // animated offset into the new start point. Assuming "at rest at
    // seat(prev)" would measure the jump from the wrong baseline and pop
    // on rapid successive corner changes (quick-review catch). Read BEFORE
    // muting: the mute snaps the computed value to the inline target.
    const inFlight = getComputedStyle(el).translate;
    let tx = 0;
    let ty = 0;
    if (inFlight && inFlight !== "none") {
      const parts = inFlight.split(" ").map(parseFloat);
      tx = parts[0] || 0;
      ty = parts[1] || 0;
    }
    const dx = px - nx + tx;
    const dy = py - ny + ty;
    if (!dx && !dy) return;
    // Classic FLIP: jump to the old seat with the transition muted, flush
    // styles so the jump is the transition's start value, then release.
    // Muted via transitionProperty scoped to width/height — NOT
    // transition:none, which would also snap an in-flight mode-size glide
    // to its end box (quick-review catch, three agents converged).
    el.style.transitionProperty = "width, height";
    el.style.translate = `${dx}px ${dy}px`;
    void el.offsetWidth;
    el.style.transitionProperty = "";
    el.style.translate = "0px 0px";
  }, [dockCorner, mode, reducedMotion]);

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
        if (p.concealed) {
          setHot(false);
          // A conceal mid-overlay hides the window; drop the overlays so a
          // stale bubble/menu can't reappear floating on restore (seenIntro is
          // already persisted, so the bubble won't re-trigger).
          setIntroOpen(false);
          setMenu(null);
        }
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
  // The popover extends the interactive footprint past the mode box — the
  // hit rect must union it while open or its clicks fall through to the
  // desktop (the worst failure class in this app). Height derived from the
  // real 440px window: shell inset (6) + gap (12) + popover + inset (6).
  const popoverVisible = queueOpen && mode !== "expanded" && !nothing;
  useEffect(() => {
    const [mw, mh] = MODE_SIZES[mode];
    const popH = Math.min(330, WINDOW_MAX[1] - mh - POPOVER_GAP);
    // Popover extent from the docked corner: the 6px near-side inset + its
    // box (NOT the full 12px both-sides gutter — a fatter rect would let the
    // widget capture a 6px band of desktop past the popover's far edge).
    const pw = popoverVisible ? Math.max(mw, POPOVER_W + SHELL_GUTTER_PX / 2) : mw;
    const ph = popoverVisible ? Math.min(WINDOW_MAX[1], mh + SHELL_GUTTER_PX / 2 + popH) : mh;
    // A transient overlay (first-run bubble, right-click menu) can extend in any
    // direction — make the WHOLE window interactive while one is open so the
    // dismiss scrim catches a click-away and nothing falls through the overlay
    // to the desktop. Max'd with the popover extent so it never shrinks below it.
    const w1 = overlayOpen ? Math.max(pw, WINDOW_MAX[0]) : pw;
    const h1 = overlayOpen ? Math.max(ph, WINDOW_MAX[1]) : ph;
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
  }, [mode, reducedMotion, popoverVisible, overlayOpen]);

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
      // Suppress the WebView2 native menu and open our own at the cursor (a
      // right-click also dismisses the bubble). App grows the menu toward the
      // window interior so it can't clip the fixed window / screen edge.
      onContextMenu={(e) => {
        e.preventDefault();
        setIntroOpen(false);
        setMenu({ x: e.clientX, y: e.clientY });
      }}
    >
      {PRESENCE_OVERLAY && <PresenceOverlay corner={corner} />}
      {/* THE widget box — persistent across modes: the chrome never remounts
          or fades, only the content layers crossfade inside it. It glides
          between mode boxes (200ms EASE.inOut, the house morph curve) out of
          the docked corner inside the never-resizing window — the webview
          compositor owns the entire visible resize, which is why it cannot
          shake or blink (see dock.rs's module comment). Corner changes glide
          too: the FLIP effect above rides `translate` back to the new seat
          (all three properties in .shell-glide). Shadow must die out
          inside the 6px window gutter — anything larger hard-clips at the
          transparent window edge and reads as a gray box on light surfaces.
          Opaque, not translucent: without a blur primitive (CSS backdrop-filter
          can't sample the desktop; native acrylic frosts the whole oversized
          window, gutter included) any alpha reads as a hole in the widget,
          not a material — measured at /97, desktop text ghosted through. */}
      <div
        ref={shellRef}
        className={`shell-glide absolute overflow-hidden rounded-xl border border-border/10 bg-surface shadow-[0_1px_3px_rgb(0_0_0/0.18),0_3px_6px_rgb(0_0_0/0.12)] ${SHELL_SEAT[corner]}`}
        style={{
          width: MODE_SIZES[mode][0] - SHELL_GUTTER_PX,
          height: MODE_SIZES[mode][1] - SHELL_GUTTER_PX,
        }}
      >
      {/* Crossfading content layers, clipped by the gliding shell above. */}
      <AnimatePresence>
        <motion.div key={mode} {...morph} className="absolute inset-0">
        <ModeContent mode={mode} corner={corner}>
        {nothing ? (
          <EmptyState mode={mode} searchChord={searchChord} />
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
                <TrackFadeSpan
                  key={`t:${lyricsKeyOf(np)}`}
                  k={lyricsKeyOf(np)}
                  suppress={announceSuppressed}
                >
                  {np.title}
                </TrackFadeSpan>
                {/* A play_now jump's intermediates don't announce — the
                    separator would run five drain/ignite ladders for tracks
                    the user only skipped through; the TARGET's arrival
                    announces once, normally (isAnnounceSuppressed). */}
                <Waveform
                  trailing={!np.artist}
                  announceKey={announceSuppressed ? undefined : (lyricsKeyOf(np) ?? undefined)}
                />
                <TrackFadeSpan
                  key={`a:${lyricsKeyOf(np)}`}
                  k={lyricsKeyOf(np)}
                  suppress={announceSuppressed}
                  className="font-normal text-muted"
                >
                  {np.artist}
                </TrackFadeSpan>
              </p>
              <PillTime np={np} />
            </div>
            {/* Scrim + [queue][play/pause], revealed on hover. Absolute over
                the row so nothing reflows; the gradient lets the artist text
                fade UNDER the incoming controls. 200px wide with the solid
                stop at 30%, so the surface fill is fully opaque from 140px
                in — PAST the queue seat's far edge (136): both buttons sit
                on solid ground and the ramp (140→200) stays a real fade.
                Re-derived twice 2026-07-11: the old 76px play/pause seat was
                computed against a two-bracket cluster (11a's third cluster
                seat overlapped it by 23px), and the old 180px/45% gradient
                was tuned for ONE button — its opaque zone ended at 99px,
                short of the queue seat (quick-review catch). Play/pause ends
                76px from the shell right edge — 9px before the two-bracket
                cluster's reach (7 + 28 + 4 + 28 = 67) — and the queue seat
                sits gap-1 to its left, ending 108px in: the pill has no
                free corner for QueueSeat (bottom-left IS the album art), so
                queue joins the grammar the pill already owns, everything in
                the right-edge reveal, spaced on the cluster's own 4px
                rhythm. Stops 2px above the bottom so the progress hairline
                stays lit. Also reveals on keyboard focus
                (has-[:focus-visible], not focus-within — see ModeCluster;
                play/pause stays tabbable the whole time, and a mouse click's
                residual focus must not pin the scrim open, quick-review
                catch 2026-07-08 / Thien 2026-07-10), and pins open while the
                pill's queue popover is up — it hosts the control that
                closes it. */}
            <div
              className={`pointer-events-none absolute bottom-0.5 right-0 top-0 flex w-[200px] items-center justify-end gap-1 pr-[76px] opacity-0 transition-opacity duration-2 ease-out-tk group-data-[hot]/widget:pointer-events-auto group-data-[hot]/widget:opacity-100 group-has-[:focus-visible]/widget:pointer-events-auto group-has-[:focus-visible]/widget:opacity-100 ${
                queueOpen ? "pointer-events-auto opacity-100" : ""
              }`}
              style={{ background: "linear-gradient(90deg, transparent, rgb(var(--surface) / 0.96) 30%)" }}
              // Swallow mousedown, same reason as ModeCluster: pointer-events
              // only turns on for the 180px scrim, but the buttons inside it
              // don't fill that box — a press that lands on the gradient
              // padding instead of a 28px button would otherwise fall
              // through to the root's onDragStart and move the window.
              onMouseDown={(e) => e.stopPropagation()}
            >
              <QueueButton open={queueOpen} onToggle={() => setQueueOpen((o) => !o)} />
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
            queueOpen={queueOpen}
            onCloseQueue={() => setQueueOpen(false)}
            spotifyConnected={spotifyConnected}
          />
        )}
        </ModeContent>
        </motion.div>
      </AnimatePresence>
      {/* Inside the persistent shell but OUTSIDE the content swap: the shell
          never fades, so the corner chrome never fades with content — and
          seated on the shell it tracks the visible box in every dock corner
          and every mode of the fixed-size window. See ModeCluster/QueueSeat.
          The queue seat skips the pill (its queue toggle rides the hover
          scrim instead — the pill's bottom-left corner is the album art). */}
      {!nothing && (
        <>
          {mode !== "pill" && (
            <QueueSeat queueOpen={queueOpen} onToggle={() => setQueueOpen((o) => !o)} />
          )}
          <ModeCluster mode={mode} onStep={stepMode} queueOpen={queueOpen} />
        </>
      )}
      </div>
      {/* The 11a queue popover — the pill/card garment, floating ABOVE the
          shell inside the never-resizing window (never inside it: the shell
          clips). Right-aligned to the docked corner's side; opens away from
          the shell (above when docked bottom, below when docked top — the
          prototype only modeled bottom-right). Its `bottom`/`top` ride the
          mode resize on the shell's own 200ms EASE.inOut so it glides with
          the garment change; reveal is 140ms opacity with visibility
          deferred (always mounted — the scroll position and history feed
          survive closing). Max height re-derived from the REAL 440px window
          (prototype frame was 520): pill 330, card 296. While open, the hit
          rect unions this box (see the footprint effect above). */}
      {!nothing && (
        <div
          inert={!popoverVisible}
          onMouseDown={(e) => e.stopPropagation()}
          className={`absolute z-30 flex flex-col rounded-xl border border-border/10 bg-surface p-1.5 shadow-xl shadow-black/40 ${
            corner.endsWith("right") ? "right-1.5" : "left-1.5"
          } ${
            popoverVisible
              ? "visible opacity-100 [transition:opacity_140ms_var(--ease-out-tk),top_200ms_var(--ease-in-out-tk),bottom_200ms_var(--ease-in-out-tk)]"
              : "invisible opacity-0 [transition:opacity_140ms_var(--ease-out-tk),top_200ms_var(--ease-in-out-tk),bottom_200ms_var(--ease-in-out-tk),visibility_0s_140ms]"
          }`}
          style={{
            width: POPOVER_W,
            maxHeight: Math.min(330, WINDOW_MAX[1] - MODE_SIZES[mode][1] - POPOVER_GAP),
            ...(corner.startsWith("bottom")
              ? { bottom: MODE_SIZES[mode][1] - SHELL_GUTTER_PX + 6 + POPOVER_GAP }
              : { top: MODE_SIZES[mode][1] - SHELL_GUTTER_PX + 6 + POPOVER_GAP }),
          }}
        >
          <QueuePanel np={np} connected={spotifyConnected} open={popoverVisible} />
        </div>
      )}
      {/* Dismiss scrim — full-window while a transient overlay is open. Its
          stopPropagation is what stops the dismissing click from ALSO starting
          a native window drag (the root's onMouseDown), and its click closes
          the overlays. Below the overlays (z-40), above the shell/content. */}
      {overlayOpen && (
        <div
          aria-hidden
          className="absolute inset-0 z-30"
          onMouseDown={(e) => {
            e.stopPropagation();
            closeOverlays();
          }}
          onContextMenu={(e) => {
            e.preventDefault();
            e.stopPropagation();
            closeOverlays();
          }}
        />
      )}
      {introOpen && (
        <IntroBubble
          corner={corner}
          // Sit just off the shell's far edge — but clamp so the bubble stays
          // fully on-screen in EXPANDED, where the shell fills the window and
          // the raw offset (446) would push it off (a burned one-shot hint).
          anchorPx={Math.min(
            MODE_SIZES[mode][1] - SHELL_GUTTER_PX + 6 + POPOVER_GAP,
            WINDOW_MAX[1] - 210,
          )}
          searchChord={searchChord}
          showhideChord={showhideChord}
          onDismiss={() => setIntroOpen(false)}
        />
      )}
      {menu && (
        <WidgetMenu
          style={{
            // Anchor at the cursor, clamped so the whole menu stays inside the
            // fixed window at ANY corner — the cursor can sit far from the
            // docked corner on a wide shell, where corner-derived growth alone
            // would push the menu off the far window edge.
            left: Math.max(4, Math.min(menu.x, WINDOW_MAX[0] - WIDGET_MENU_W - 4)),
            top: Math.max(4, Math.min(menu.y, WINDOW_MAX[1] - WIDGET_MENU_H - 4)),
          }}
          spotifyConnected={spotifyConnected}
          showhideChord={showhideChord}
          onClose={() => setMenu(null)}
        />
      )}
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
