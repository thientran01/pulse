/*
 * Focus mode (design "B1") — the fullscreen now-playing takeover, in its
 * own webview window (src-tauri/src/focus.rs; opened from the expanded
 * view's expand bracket, closed by Esc / the collapse control / Alt-F4).
 *
 * Composition: "SOUNDBOARD" (the 3-design/3-judge panel's winner,
 * 2026-07-12), RETUNED 2026-07-14 after Thien's live verdicts on two
 * cuts: the original 1170×150 horizon band matched the progress bar's
 * width and read as a second timeline; PR #102's answer (a small wave in
 * the song block) was too small and off to the side. The keeper: the
 * three-band Soundboard skeleton with a SMALLER instrument — upper room
 * (identity column vertically centered on the lyric anchor + receding
 * lyric lines; the fallback centers the same stack), then the horizon
 * (room Waveform, now 19 capsules at 780×100 (⅔ the console) — clearly narrower than
 * the console), then the console. The horizon + console live OUTSIDE
 * the upper-room swap so they never remount: the horizon survives every
 * track change and runs the ANNOUNCEMENT (announceKey) — the pill is
 * hidden behind this takeover, so the horizon is the room's one
 * now-playing pulse. The upper room carries NO other Waveform
 * (SeparatorDot only): one reactive surface per view. Grafts: art at
 * ~560px (The Hang), the asymmetric deep-bottom lyric mask (The Hang),
 * the reserved lyrics-status caption slot (Gatefold), one-stack-two-seats
 * with an opacity crossfade (The Hang).
 *
 * Track-change grammar: lyricsLive flips false for the fetch interlude
 * on EVERY track change (the key-mismatch gate in lyricsKeyOf's doc
 * comment), so the active seat always exits through the fallback and
 * remounts — per-track state (title fade, lyric panel) resets for free.
 * Anything that must SURVIVE a track change (the announcing horizon)
 * must live outside the swap; nothing keyed inside a seat does.
 *
 * Realm notes: own onNowPlaying → posClock.ingest loop (posClock is
 * per-realm), own lyric fetch (disk cache makes the second fetch ~free),
 * own art + accent extraction (each window owns its document's --accent),
 * own initReactive vote (lib.rs's per-window map). The media loop and the
 * audio capture gate are widened backend-side to keep feeding this window
 * while the main widget hides behind it.
 */
import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { MorphIcon } from "./icons/MorphIcon";
import { commands, onNowPlaying } from "./lib/backend";
import { VOCAL_LEAD_MS } from "./lib/lrc";
import { extractAccent } from "./lib/palette";
import * as posClock from "./lib/posClock";
import { initReactive } from "./lib/reactive";
import { DUR, EASE } from "./lib/tokens";
import { LyricsPanel, lyricsKeyOf, useLyrics } from "./LyricsPanel";
import { QueuePanel, useSpotifyStatus } from "./Queue";
import { ProgressBar, Transport } from "./Transport";
import { SeparatorDot, Waveform } from "./Waveform";
import type { NowPlaying } from "./types";

/** How long the "No synced lyrics" caption stays before fading out — the
 * expanded view's rule (App.tsx NO_LYRICS_CAPTION_MS, kept in step): it's an
 * answer to "where are the lyrics", and once read it shouldn't sit under the
 * metadata forever. The reserved slot keeps its height, so nothing moves. */
const NO_LYRICS_CAPTION_MS = 4000;

/** Identity fields — the same re-render gate App.tsx uses (position lives
 * in posClock, never in React state). */
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

/** App.tsx's useArt, realm-local (the hook is small and App's module is the
 * whole widget — not worth importing for 20 lines). */
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
      if (u) lastId.current = artId;
    });
    return () => {
      alive = false;
    };
  }, [artId]);
  return artId ? url : null;
}

/** Accent extraction for THIS window's document (each realm owns its own
 * --accent; the main widget's extraction doesn't reach here). */
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

/** The identity stack: art + metadata + the reserved lyrics-status caption
 * slot (the Gatefold graft — the block never reflows when the state
 * resolves). One stack, two seats: the lyrics room seats it left, the
 * fallback room centers the same markup (The Hang's rule; the rooms swap
 * by opacity crossfade, the art never slides). */
function IdentityStack({
  np,
  artUrl,
  caption,
  captionExpired,
  centered,
}: {
  np: NowPlaying;
  artUrl: string | null;
  caption: string | null;
  /** The miss caption answers once, then leaves (the expanded view's
   * grammar) — when true the span fades out but stays mounted so the
   * reserved slot's height never moves; aria-hidden goes with it. */
  captionExpired: boolean;
  centered: boolean;
}) {
  const align = centered ? "items-center text-center" : "items-start text-left";
  return (
    // Width = var(--art), defined ONCE on each seat in Focus's return
    // (both seats set it identically) — the seats' stack-top math, this
    // width, and the lyric column's bottom-alignment all derive from the
    // same value, which is what makes the aligned edges exact.
    <div className={`flex w-(--art) flex-col ${align}`}>
      <div className="grid aspect-square w-full place-items-center overflow-hidden rounded-3xl bg-surface-2 text-muted">
        {artUrl ? (
          <img src={artUrl} alt="" className="h-full w-full object-cover" draggable={false} />
        ) : (
          <MorphIcon name="note" size={44} />
        )}
      </div>
      {/* Keyed per track: the metadata remounts with the title fade (fast
          and plain — a track change earns no choreography beyond this). */}
      <div key={`${np.title}|${np.artist}`} className="title-in mt-8 w-full min-w-0">
        <p className="truncate text-[40px] font-medium leading-tight text-fg">{np.title}</p>
        <p className="mt-1 truncate text-[22px] leading-7 text-muted">
          {np.artist}
          {np.album && <SeparatorDot />}
          {np.album}
        </p>
      </div>
      {/* Reserved slot — "Finding lyrics…" answers the wait, the miss stays
          quiet, and the fixed height means resolution never moves the art. */}
      <p className="mt-1 h-7 w-full truncate text-[17px] leading-7 text-muted/70">
        {caption && (
          <span
            key={caption}
            aria-hidden={captionExpired || undefined}
            className={`inline-block ${
              captionExpired
                ? "animate-[caption-out_260ms_var(--ease-out-tk)_both]"
                : `animate-[caption-in_200ms_var(--ease-out-tk)_both] ${
                    caption === "Finding lyrics…" ? "[animation-delay:400ms]" : ""
                  }`
            }`}
          >
            {caption}
          </span>
        )}
      </p>
    </div>
  );
}

export default function Focus() {
  const [np, setNp] = useState<NowPlaying | null>(null);
  useEffect(
    () =>
      onNowPlaying((next) => {
        if (!posClock.ingest(next)) return;
        setNp((prev) => (sameIdentity(prev, next) ? prev : next));
      }),
    [],
  );
  const artUrl = useArt(np?.art_id ?? null);
  useArtAccent(artUrl);
  const lyrics = useLyrics(np);
  useEffect(() => initReactive(), []);
  const reducedMotion = useReducedMotion();
  const spotify = useSpotifyStatus();
  // The room's queue/history surface — same QueuePanel, this realm's own
  // open bit (the widget's queueOpen is another window's state).
  const [queueOpen, setQueueOpen] = useState(false);

  // Esc peels one layer: the queue panel first, then the room.
  const queueOpenRef = useRef(queueOpen);
  queueOpenRef.current = queueOpen;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (queueOpenRef.current) setQueueOpen(false);
      else commands.focusClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const seekable = !!np?.can_seek;
  const playing = np?.status === "playing";
  const lyricsLive =
    lyrics.status === "synced" && np !== null && lyrics.key === lyricsKeyOf(np);
  const nothing = !np || np.player === "none";

  // The arrival cascade is earned ONCE per takeover: the first lyrics mount
  // after open plays it (the user summoned the room and waited on window
  // creation — or waited on the fetch); later remounts (track changes) swap
  // plain per the continuity rule.
  const entranceSpent = useRef(false);
  const entrance = lyricsLive && !entranceSpent.current;
  useEffect(() => {
    if (lyricsLive) entranceSpent.current = true;
  }, [lyricsLive]);

  const caption = lyricsLive
    ? null
    : lyrics.status === "loading"
      ? "Finding lyrics…"
      : lyrics.status === "offline"
        ? "Lyrics unavailable — offline"
        : np && np.player !== "none"
          ? "No synced lyrics"
          : null;

  // The miss caption answers once, then leaves (the expanded view's rule) —
  // the timer restarts per track and per status flip so a loading→none
  // resolve gets its full read window.
  const trackKey = lyricsKeyOf(np);
  const [captionExpired, setCaptionExpired] = useState(false);
  useEffect(() => {
    setCaptionExpired(false);
    if (lyrics.status !== "none") return;
    const t = window.setTimeout(() => setCaptionExpired(true), NO_LYRICS_CAPTION_MS);
    return () => window.clearTimeout(t);
  }, [lyrics.status, trackKey]);

  const swap = {
    initial: { opacity: 0 },
    animate: { opacity: 1 },
    exit: { opacity: 0 },
  };
  const swapTiming = {
    duration: reducedMotion ? 0 : DUR[3] / 1000,
    ease: [...EASE.out] as [number, number, number, number],
  };

  return (
    // Opaque room, one 200ms opacity arrival for the whole surface — chrome
    // gets no theater; the lyrics cascade and the hero's own bloom are the
    // arrival's only choreography.
    //
    // --art / --stack-top: the room's two layout constants, defined ONCE
    // here (every band derives from them — the identity seat, the lyric
    // box's edges, the horizon's centering). --art = the album's size:
    // 560px design size, 46vh so the square art leaves room on normal
    // monitors, 100vh-660px as the short-monitor guard, 50vw-582px as the
    // narrow-width guard (the identity column must end left of the
    // centered 780px horizon: 192 + art ≤ (100vw-780)/2 — the metadata
    // riding into the horizon's ROW is accepted per Thien's Figma pass).
    // --stack-top centers the identity STACK (art + 146px of metadata) on
    // the window's vertical midpoint (Thien's Figma verdict, 2026-07-14:
    // it lifts the art to meet the lyric cluster).
    <div className="group/focus room-in relative flex h-screen w-screen flex-col overflow-hidden bg-surface text-fg [--art:min(560px,46vh,100vh_-_660px,50vw_-_582px)] [--stack-top:calc(50vh_-_var(--art)/2_-_73px)]">
      {/* Corner exit: hover-revealed + the has-[:focus-visible] keyboard
          reveal (the widget's contract). The contract-bracket verb, going
          home. */}
      <div className="pointer-events-none absolute right-4 top-4 z-10 flex gap-1 opacity-0 transition-opacity duration-2 ease-out-tk group-hover/focus:pointer-events-auto group-hover/focus:opacity-100 has-[:focus-visible]:pointer-events-auto has-[:focus-visible]:opacity-100">
        <button
          type="button"
          aria-label={queueOpen ? "Close queue" : "Show queue"}
          title={queueOpen ? "Close queue" : "Show queue"}
          onClick={() => setQueueOpen((o) => !o)}
          className={`grid h-8 w-8 place-items-center rounded-md text-fg [transition:background-color_140ms_var(--ease-out-tk),scale_90ms_var(--ease-out-tk)] hover:bg-fg/10 active:scale-95 ${
            queueOpen ? "bg-fg/10" : ""
          }`}
        >
          <MorphIcon name="queue" size={15} dur={DUR[3]} ease={EASE.inOut} />
        </button>
        <button
          type="button"
          aria-label="Leave focus (Esc)"
          title="Leave focus (Esc)"
          onClick={() => commands.focusClose()}
          className="grid h-8 w-8 place-items-center rounded-md text-fg [transition:background-color_140ms_var(--ease-out-tk),scale_90ms_var(--ease-out-tk)] hover:bg-fg/10 active:scale-95"
        >
          <MorphIcon name="contract" size={15} dur={DUR[3]} ease={EASE.inOut} />
        </button>
      </div>

      {nothing ? (
        <div className="grid h-full w-full place-items-center">
          <span className="resting-pulse block h-2 w-2 rounded-full bg-muted" aria-hidden />
        </div>
      ) : (
        <>
          {/* THE UPPER ROOM — the only region that swaps (one stack, two
              seats). Crossfade by opacity; the art never slides. Seats are
              keyed per track (split) / per view (centered): every track
              change exits through the fallback interlude anyway (lyricsLive
              flips while lyrics re-key), so the per-track key just makes
              the remount explicit and covers the fast-resolve path where
              AnimatePresence would otherwise recycle the exiting seat. */}
          <div className="relative min-h-0 flex-1">
            <AnimatePresence initial={false}>
              {lyricsLive ? (
                <motion.div
                  key={`split:${lyrics.key}`}
                  {...swap}
                  transition={swapTiming}
                  exit={{
                    opacity: 0,
                    pointerEvents: "none" as const,
                    transition: { duration: reducedMotion ? 0 : DUR[2] / 1000, ease: [...EASE.out] as [number, number, number, number] },
                  }}
                  className="absolute inset-0 flex items-stretch gap-[7%] px-[10%]"
                >
                  {/* Seated on the root's --stack-top (see the root div's
                      comment for the full layout-constant story). */}
                  <div className="flex min-h-0 shrink-0 flex-col pt-(--stack-top)">
                    <IdentityStack np={np} artUrl={artUrl} caption={caption} captionExpired={captionExpired} centered={false} />
                  </div>
                  {/* The lyric column keeps its own top (the ladder Thien
                      likes; tops can't align now that the art centers) and
                      its BOTTOM edge aligns with the album's — the explicit
                      height ends the box at --stack-top + --art, so the
                      bottom fade dissolves exactly at the art's bottom line
                      (Thien, 2026-07-14). */}
                  <div className="flex h-[calc(var(--stack-top)_+_var(--art)_-_11vh)] min-h-0 min-w-0 flex-1 flex-col mt-[11vh]">
                    <LyricsPanel
                      lines={lyrics.lines}
                      seekable={seekable}
                      leadMs={VOCAL_LEAD_MS[np.player]}
                      entrance={entrance}
                      scale="focus"
                    />
                  </div>
                </motion.div>
              ) : (
                <motion.div
                  key="centered"
                  {...swap}
                  transition={swapTiming}
                  exit={{
                    opacity: 0,
                    pointerEvents: "none" as const,
                    transition: { duration: reducedMotion ? 0 : DUR[2] / 1000, ease: [...EASE.out] as [number, number, number, number] },
                  }}
                  className="absolute inset-0 flex items-start justify-center"
                >
                  {/* Same seat rule as the lyrics view (identity stack
                      centered on the window midline), so the lyrics⇄fallback
                      crossfade holds the art still on the vertical axis. */}
                  <div className="pt-(--stack-top)">
                    <IdentityStack np={np} artUrl={artUrl} caption={caption} captionExpired={captionExpired} centered />
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>

          {/* The queue/history surface — the widget's QueuePanel wholesale,
              floating over the upper room's right side on the popover shell
              recipe. Always mounted (scroll + feed survive toggling), the
              expanded-surface visibility grammar. Bottom inset clears the
              CONSOLE — the only band it horizontally overlaps (the 420px
              horizon is centered and never reaches under this right-docked
              popover); the extra ~120px is breathing room, not a horizon
              budget. */}
          <div
            inert={!queueOpen}
            className={`absolute right-6 top-16 z-20 flex w-[380px] flex-col rounded-xl border border-border/10 bg-surface p-1.5 shadow-xl shadow-black/40 ${
              queueOpen
                ? "visible opacity-100 [transition:opacity_140ms_var(--ease-out-tk)]"
                : "invisible opacity-0 [transition:opacity_140ms_var(--ease-out-tk),visibility_0s_140ms]"
            }`}
            style={{ bottom: "calc(120px + 176px)" }}
          >
            <QueuePanel np={np} connected={spotify.connected} open={queueOpen} />
          </div>

          {/* THE HORIZON — the room's one living reactive surface, OUTSIDE
              the swap (never remounts, so it survives every track change
              and the announcement always fires — the pill is hidden behind
              this takeover, so the horizon is the only now-playing pulse on
              screen). RESIZED 2026-07-14 (Thien's live verdict): the 1170px
              band matched the progress bar's width and read as a second
              timeline — now a 780×100 nineteen-capsule instrument (⅔ the
              console's width), clearly narrower than the console. Seated
              EQUIDISTANT between the lyric box's bottom edge (= the art's
              bottom line, --stack-top + --art) and the console's top
              (93vh − 92px: 92 = progress row 20 + mt-4 16 + transport 56;
              keep in sync with the console's classes). In this flex
              column only the bottom margin positions the box — the flex-1
              region above absorbs the rest — so mb = half the free space
              (Thien, 2026-07-14: "even" gaps both sides). */}
          <div className="mb-[calc((93vh_-_212px_-_var(--stack-top)_-_var(--art))/2)] flex shrink-0 items-center justify-center">
            <Waveform size="room" announceKey={lyricsKeyOf(np) ?? undefined} />
          </div>

          {/* THE CONSOLE — persistent (a summoned takeover shows its
              required controls; the P3/P4 lesson is binding). Fixed below
              the horizon, so a view crossfade never moves it. */}
          <div className="mx-auto w-[1170px] max-w-[92vw] shrink-0 pb-[6vh] pt-[1vh]">
            <ProgressBar np={np} size="lg" />
            <div className="mt-4 flex items-center justify-center">
              <Transport np={np} seekable={seekable} playing={playing} room />
            </div>
          </div>
        </>
      )}
    </div>
  );
}
