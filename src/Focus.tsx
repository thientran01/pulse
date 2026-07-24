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
 * track change and rides straight through it (its announce ladder was
 * removed 2026-07-23 — the collapse-to-one-dot read as a full reset at
 * room scale; the title fade is the room's track-change beat), staying
 * the room's one now-playing pulse. The upper room carries NO other Waveform
 * (SeparatorDot only): one reactive surface per view. Grafts: art at
 * ~560px (The Hang), the asymmetric deep-bottom lyric mask (The Hang),
 * the reserved lyrics-status caption slot (Gatefold), one-stack-two-seats
 * with an opacity crossfade (The Hang).
 *
 * Track-change grammar: lyricsLive flips false for the fetch interlude
 * on EVERY track change (the key-mismatch gate in lyricsKeyOf's doc
 * comment), so the active seat always exits through the fallback and
 * remounts — per-track state (title fade, lyric panel) resets for free.
 * Anything that must SURVIVE a track change (the riding horizon)
 * must live outside the swap; nothing keyed inside a seat does.
 *
 * Realm notes: own onNowPlaying → posClock.ingest loop (posClock is
 * per-realm), own lyric fetch (disk cache makes the second fetch ~free),
 * own art + accent extraction (each window owns its document's --accent),
 * own initReactive vote (lib.rs's per-window map). The media loop and the
 * audio capture gate are widened backend-side to keep feeding this window
 * while the main widget hides behind it.
 */
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { MorphIcon } from "./icons/MorphIcon";
import { commands, onNowPlaying, onSpotifyJump, onSpotifyJumpCancel } from "./lib/backend";
import { useArt, useArtAccent } from "./lib/artAccent";
import { VOCAL_LEAD_MS } from "./lib/lrc";
import * as posClock from "./lib/posClock";
import { initReactive } from "./lib/reactive";
import { DUR, EASE } from "./lib/tokens";
import { DeviceTag } from "./DeviceTag";
import { LyricsPanel, lyricsKeyOf, lyricsVerdictOf, useLyrics, useSeatHold } from "./LyricsPanel";
import { initTrackDir, SLIDE_PX, SLIDE_SETTLE_MS, takeTrackDir } from "./lib/trackDir";
import {
  armSuppression,
  clearSuppression,
  isAnnounceSuppressed,
  QueuePanel,
  useSpotifyDevice,
  useSpotifyStatus,
} from "./Queue";
import { ProgressBar, Transport } from "./Transport";
import { SeparatorDot, Waveform } from "./Waveform";
import type { NowPlaying, SpotifyDevice } from "./types";

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

// useArt / useArtAccent live in src/lib/artAccent.ts (one copy for all
// three realms — each window's own listener still owns its own document's
// --accent; the main widget's extraction doesn't reach here).

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
  device,
  dx = 0,
}: {
  np: NowPlaying;
  artUrl: string | null;
  caption: string | null;
  /** The miss caption answers once, then leaves (the expanded view's
   * grammar) — when true the span fades out but stays mounted so the
   * reserved slot's height never moves; aria-hidden goes with it. */
  captionExpired: boolean;
  centered: boolean;
  /** Non-PC playback device (or null) — the "Playing on <device>" tag under
   * the metadata; the room horizon is at rest because the audio is
   * elsewhere. Already gated to a live Spotify session. */
  device: SpotifyDevice | null;
  /** Track-change slide offset for the keyed metadata block (the CENTERED
   * room, where no seat remount carries direction — the split seat slides
   * as a whole plane and passes 0 so motion never doubles up). Art stays
   * static here; only the split's plane carries it. */
  dx?: number;
}) {
  const align = centered ? "items-center text-center" : "items-start text-left";
  // Broken art (a CDN 403/404, or AM's lagged first read) degrades to the note
  // glyph — App and the queue rows already do this; the fullscreen room showed
  // the ~560px broken-image icon otherwise (audit A6-7). Failure is keyed to
  // the url itself (RowThumb's pattern): the img never remounts on an art-
  // revision flip, so a new url simply stops matching failedUrl and retries.
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const showArt = artUrl !== null && artUrl !== failedUrl;
  return (
    // Width = var(--art), defined ONCE on each seat in Focus's return
    // (both seats set it identically) — the seats' stack-top math, this
    // width, and the lyric column's bottom-alignment all derive from the
    // same value, which is what makes the aligned edges exact.
    <div className={`flex w-(--art) flex-col ${align}`}>
      <div className="grid aspect-square w-full place-items-center overflow-hidden rounded-3xl bg-surface-2 text-muted">
        {showArt ? (
          <img
            src={artUrl}
            alt=""
            className="h-full w-full object-cover"
            draggable={false}
            onError={() => setFailedUrl(artUrl)}
          />
        ) : (
          <MorphIcon name="note" size={44} />
        )}
      </div>
      {/* Keyed per track: the metadata remounts with the title beat (fast
          and plain — directional when dx says the room saw a skip). */}
      <div
        key={`${np.title}|${np.artist}`}
        className={`${dx !== 0 ? "track-in" : "title-in"} mt-8 w-full min-w-0`}
        style={dx !== 0 ? ({ "--track-dx": `${dx}px` } as CSSProperties) : undefined}
      >
        <p className="truncate text-[40px] font-medium leading-tight text-fg">{np.title}</p>
        <p className="mt-1 truncate text-[22px] leading-7 text-muted">
          {np.artist}
          {np.album && <SeparatorDot />}
          {np.album}
        </p>
        {device && (
          <div className="mt-2">
            {/* size="lg" — DeviceTag's real room-scale knob; a className
                text-[15px] override silently lost to the component's own
                text-[11px] (conflicting-utility order is load-order). */}
            <DeviceTag device={device} playing={np.status === "playing"} showName size="lg" />
          </div>
        )}
      </div>
      {/* Reserved slot — "Finding lyrics…" answers the wait, the miss stays
          quiet, and the fixed height means resolution never moves the art. */}
      <p className="mt-1 h-7 w-full truncate text-[17px] leading-7 text-muted/85">
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
  // Track-change slide direction — the room's own copy of App's ledger
  // consumption (each window's trackDir module is its own instance; the
  // hotkey "track-nudge" event reaches both).
  const [trackDir, setTrackDir] = useState<1 | -1>(1);
  const lastTrackKey = useRef<string | null>(null);
  // The settled slide epoch — App's rule: one perceived change per
  // SLIDE_SETTLE_MS, so GSMTC's piecemeal field flaps can't remount the
  // seat mid-slide (the "held back by a rope" rubber-band, 2026-07-23).
  const [slideEpoch, setSlideEpoch] = useState(0);
  const epochAt = useRef(0);
  useEffect(
    () =>
      onNowPlaying((next) => {
        if (!posClock.ingest(next)) return;
        // track→track consumes; vanish/appear RESETS to forward and still
        // CLEARS the note (a new session can't inherit the last skip's -1,
        // and a stranded note can't misdirect a later advance — App's rule).
        const nextKey = lyricsKeyOf(next);
        if (nextKey !== lastTrackKey.current) {
          const noted = takeTrackDir();
          setTrackDir(nextKey !== null && lastTrackKey.current !== null ? noted : 1);
          lastTrackKey.current = nextKey;
          const now = performance.now();
          if (now - epochAt.current > SLIDE_SETTLE_MS) {
            epochAt.current = now;
            setSlideEpoch((e) => e + 1);
          }
        }
        setNp((prev) => (sameIdentity(prev, next) ? prev : next));
      }),
    [],
  );
  useEffect(() => initTrackDir(), []);
  const artUrl = useArt(np?.art_id ?? null);
  useArtAccent(artUrl);
  const lyrics = useLyrics(np);
  useEffect(() => initReactive(), []);
  const reducedMotion = useReducedMotion();
  const spotify = useSpotifyStatus();
  // Non-PC playback device (or null), gated to a live Spotify session — the
  // "Playing on <device>" tag; the room's horizon/waveform rests because the
  // audio is elsewhere.
  const activeDevice = useSpotifyDevice();
  const remoteDevice: SpotifyDevice | null =
    activeDevice && np?.player === "spotify" ? activeDevice : null;
  // Jump-intermediate suppression, exactly the pill's wiring (App.tsx): a
  // play_now jump flickers through intermediates that must not announce —
  // the target's arrival announces once, normally. Since the horizon's
  // visual announce ladder was removed (2026-07-23: its collapse-to-one-dot
  // read as a full reset at room scale), the AT live region below is this
  // window's one announcing surface.
  const announceSuppressed = isAnnounceSuppressed(np);
  useEffect(() => onSpotifyJump(armSuppression), []);
  useEffect(() => onSpotifyJumpCancel(clearSuppression), []);
  // The track-change AT announcement (App.tsx's wiring, own realm — each
  // webview owns its live regions): the room's visual layer is aria-hidden,
  // so identity changes reach AT only through this text. Ref-gated (the
  // first identity after open seeds silently — the takeover opened ON this
  // track) and suppression-held; the jump landing announces once.
  const [announceText, setAnnounceText] = useState("");
  const announcedKey = useRef<string | null>(null);
  useEffect(() => {
    const key = lyricsKeyOf(np);
    if (!np || !key || key === announcedKey.current || announceSuppressed) return;
    const first = announcedKey.current === null;
    announcedKey.current = key;
    if (first) return;
    setAnnounceText(np.artist ? `${np.title} — ${np.artist}` : np.title);
  }, [np, announceSuppressed]);
  // The room's queue/history surface — same QueuePanel at room scale, this
  // realm's own open bit (the widget's queueOpen is another window's state).
  // Closed when no session, like the widget (the toggle that opens it is
  // hidden then too).
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
  // What the state says about THIS track (stale verdicts read as pending) +
  // the verdict-gated hold — the room's seat rule matches the expanded
  // view's: the interlude never moves the surface, only verdicts do.
  const verdict = lyricsVerdictOf(np, lyrics);
  const hold = useSeatHold(np, verdict);
  const nothing = !np || np.player === "none";
  useEffect(() => {
    if (nothing) setQueueOpen(false);
  }, [nothing]);

  // The arrival cascade is earned ONCE per takeover: the first lyrics mount
  // after open plays it (the user summoned the room and waited on window
  // creation — or waited on the fetch); later remounts (track changes) swap
  // plain per the continuity rule.
  const entranceSpent = useRef(false);
  const entrance = lyricsLive && !entranceSpent.current;
  useEffect(() => {
    // Queue-gated spend: the panel doesn't mount while the queue owns the
    // column, and a resolve behind it must not burn the cascade unseen —
    // the user's first actual sighting (queue close) earns it instead.
    if (lyricsLive && !queueOpen) entranceSpent.current = true;
  }, [lyricsLive, queueOpen]);

  const caption = lyricsLive
    ? null
    : verdict === "pending"
      ? "Finding lyrics…"
      : verdict === "offline"
        ? "Lyrics unavailable — offline"
        : np && np.player !== "none"
          ? "No synced lyrics"
          : null;

  // The miss caption answers once, then leaves (the expanded view's rule) —
  // the timer restarts per track and per verdict flip so a pending→none
  // resolve gets its full read window.
  const trackKey = lyricsKeyOf(np);
  const [captionExpired, setCaptionExpired] = useState(false);
  useEffect(() => {
    setCaptionExpired(false);
    // Both terminal non-synced states expire (the expanded view's gate,
    // App.tsx — this room's own rule comment claims to keep in step): the
    // offline caption used to sit under the metadata forever.
    if (verdict !== "none" && verdict !== "offline") return;
    const t = window.setTimeout(() => setCaptionExpired(true), NO_LYRICS_CAPTION_MS);
    return () => window.clearTimeout(t);
  }, [verdict, trackKey]);

  // The room's held seat: while the verdict is pending the composition holds
  // — a held split keeps the identity column + a quiet lyric column (the
  // per-track key still crossfades old split → new split, fast and plain)
  // instead of collapsing to the centered fallback and re-splitting a few
  // frames later. Initial false: a takeover opened mid-fetch starts centered,
  // preserving the once-per-takeover arrival.
  const splitRef = useRef(false);
  const split = queueOpen || (hold ? splitRef.current : lyricsLive);
  useEffect(() => {
    splitRef.current = split;
  });

  const swapTiming = {
    duration: reducedMotion ? 0 : DUR[3] / 1000,
    ease: [...EASE.out] as [number, number, number, number],
  };

  // The seat's track-change slide: only a split→split key change (a skip
  // while lyrics hold the room) drifts directionally — split⇄centered swaps
  // are COMPOSITION changes (a verdict, the queue), not skips, and keep the
  // plain opacity crossfade (dx 0). Computed per render so the entering
  // seat's variants and the exiting seat's `custom` both see the change.
  // split seats key on the settled EPOCH, not the raw track key — raw-key
  // flaps (GSMTC piecemeal fields) update the seat's content in place
  // instead of remounting it mid-slide.
  const seatKey = split ? `split:${slideEpoch}` : "centered";
  const prevSeatKey = useRef(seatKey);
  const seatDx =
    seatKey !== prevSeatKey.current &&
    seatKey.startsWith("split:") &&
    prevSeatKey.current.startsWith("split:") &&
    !announceSuppressed
      ? trackDir * SLIDE_PX.room
      : 0;
  useEffect(() => {
    prevSeatKey.current = seatKey;
  });
  // Track-change slides run one rung faster (140/90 — Thien's live "a bit
  // dramatic" verdict, 2026-07-23) than the composition swaps, which keep
  // their pre-slide 200/140 feel; the dx-conditional transitions split them.
  const slideEase = [...EASE.out] as [number, number, number, number];
  const slideInT = { duration: reducedMotion ? 0 : DUR[2] / 1000, ease: slideEase };
  const slideOutT = { duration: reducedMotion ? 0 : DUR[1] / 1000, ease: slideEase };
  const compositionOutT = { duration: reducedMotion ? 0 : DUR[2] / 1000, ease: slideEase };
  const seatVariants = {
    enter: (dx: number) => ({ opacity: 0, x: dx }),
    center: (dx: number) => ({
      opacity: 1,
      x: 0,
      transition: dx !== 0 ? slideInT : swapTiming,
    }),
    exit: (dx: number) => ({
      opacity: 0,
      x: -dx,
      pointerEvents: "none" as const,
      transition: dx !== 0 ? slideOutT : compositionOutT,
    }),
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
    // monitors, 100vh-660px as the short-monitor guard, 40vw-390px as the
    // narrow-width guard (the identity column must end left of the
    // centered 780px horizon: 10vw + art ≤ (100vw-780)/2 → art ≤ 40vw-390
    // — width-correct at every vw; the earlier 50vw-582 form baked 10% of
    // exactly 1920 in as a 192px constant, breaking the invariant off-1920.
    // The metadata riding into the horizon's ROW is accepted per Thien's
    // Figma pass). --stack-top centers the identity STACK (art + 146px of
    // metadata) on the window's vertical midpoint (Thien's Figma verdict,
    // 2026-07-14: it lifts the art to meet the lyric cluster). Known,
    // accepted skew: the 146px metadata constant predates the DeviceTag
    // row (PR #109) — a remote-device session rides ~10px low.
    // --horizon-mb: the horizon's bottom margin, factored out so the
    // no-lyrics cluster can anchor off the SAME geometry (see its seat).
    <div className="group/focus room-in relative flex h-screen w-screen flex-col overflow-hidden bg-surface text-fg [--art:min(560px,46vh,100vh_-_660px,40vw_-_390px)] [--stack-top:calc(50vh_-_var(--art)/2_-_73px)] [--horizon-mb:calc((93vh_-_212px_-_var(--stack-top)_-_var(--art))/2)]">
      {/* Corner exit: hover-revealed + the has-[:focus-visible] keyboard
          reveal (the widget's contract). The contract-bracket verb, going
          home. */}
      <div className="pointer-events-none absolute right-4 top-4 z-10 flex gap-1 opacity-0 transition-opacity duration-2 ease-out-tk group-hover/focus:pointer-events-auto group-hover/focus:opacity-100 has-[:focus-visible]:pointer-events-auto has-[:focus-visible]:opacity-100">
        {/* Queue toggle hides with no session (the widget's rule — there is
            no queue surface to open over the resting pulse). */}
        {!nothing && (
          <button
            type="button"
            aria-label={queueOpen ? "Close queue" : "Open queue"}
            title={queueOpen ? "Close queue" : "Open queue"}
            aria-pressed={queueOpen}
            onClick={() => setQueueOpen((o) => !o)}
            className={`grid h-8 w-8 place-items-center rounded-md text-fg [transition:background-color_140ms_var(--ease-out-tk),scale_90ms_var(--ease-out-tk)] hover:bg-fg/10 active:scale-95 ${
              queueOpen ? "bg-fg/10" : ""
            }`}
          >
            <MorphIcon name="queue" size={15} dur={DUR[3]} ease={EASE.inOut} />
          </button>
        )}
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

      {/* The AT announcement region — outside the upper-room swap (like the
          horizon) so track changes never remount it; sr-only, content set
          only on a real, unsuppressed identity change. */}
      <span className="sr-only" aria-live="polite">
        {announceText}
      </span>

      {nothing ? (
        <div className="grid h-full w-full place-items-center">
          <span className="resting-pulse block h-2 w-2 rounded-full bg-muted" aria-hidden />
        </div>
      ) : (
        <>
          {/* THE UPPER ROOM — the only region that swaps (one stack, two
              seats). Crossfade by opacity; the art never slides. Seats are
              keyed per track (split) / per view (centered): a held split
              rides the fetch interlude (see `split` above — the seat no
              longer collapses to centered while the verdict is pending), so
              a track change crossfades old split → new split via the
              per-track key, fast and plain, and the fast-resolve path can't
              have AnimatePresence recycle the exiting seat.
              An OPEN QUEUE also forces the split composition: the queue
              surface lives in the lyric column's seat (below), so the
              identity stack must hold the left seat even with no lyrics —
              keyed on the settled slide EPOCH (one bump per perceived
              change), which stays honest when the seat is queue- or
              hold-forced through the fetch interlude. */}
          <div className="relative min-h-0 flex-1">
            <AnimatePresence initial={false} custom={seatDx}>
              {split ? (
                <motion.div
                  key={seatKey}
                  custom={seatDx}
                  variants={seatVariants}
                  initial="enter"
                  animate="center"
                  exit="exit"
                  transition={swapTiming}
                  className="absolute inset-0 flex items-stretch gap-[7%] px-[10%]"
                >
                  {/* Seated on the root's --stack-top (see the root div's
                      comment for the full layout-constant story). */}
                  <div className="flex min-h-0 shrink-0 flex-col pt-(--stack-top)">
                    <IdentityStack
                      np={np}
                      artUrl={artUrl}
                      caption={caption}
                      captionExpired={captionExpired}
                      centered={false}
                      device={remoteDevice}
                    />
                  </div>
                  {/* The lyric column keeps its own top (the ladder Thien
                      likes; tops can't align now that the art centers) and
                      its BOTTOM edge aligns with the album's — the explicit
                      height ends the box at --stack-top + --art, so the
                      bottom fade dissolves exactly at the art's bottom line
                      (Thien, 2026-07-14). */}
                  <div className="flex h-[calc(var(--stack-top)_+_var(--art)_-_11vh)] min-h-0 min-w-0 flex-1 flex-col mt-[11vh]">
                    {/* Unmounted while the queue owns the column (not just
                        covered): the queue box is art-width, narrower than
                        this column, so live lyric lines would peek out past
                        its right edge — and a first-lyrics resolve behind
                        the cover would burn the once-per-takeover cascade
                        unseen (its spend is queue-gated below to match).
                        Closing the queue mounts lyrics fresh; the panel
                        re-anchors itself. */}
                    {lyricsLive && !queueOpen && (
                      // Plain arrivals (lyrics resolving into a HELD split, or
                      // a queue close re-revealing the column) get the title-in
                      // beat — the seat's own crossfade no longer covers the
                      // resolve, which lands after it. The once-per-takeover
                      // entrance stays unwrapped so choreography never stacks.
                      <div
                        className={`flex min-h-0 min-w-0 flex-1 flex-col ${
                          entrance ? "" : "animate-[caption-in_140ms_var(--ease-out-tk)_both]"
                        }`}
                      >
                        <LyricsPanel
                          lines={lyrics.lines}
                          seekable={seekable}
                          leadMs={VOCAL_LEAD_MS[np.player]}
                          entrance={entrance}
                          scale="focus"
                        />
                      </div>
                    )}
                  </div>
                </motion.div>
              ) : (
                <motion.div
                  key={seatKey}
                  custom={seatDx}
                  variants={seatVariants}
                  initial="enter"
                  animate="center"
                  exit="exit"
                  transition={swapTiming}
                  className="absolute inset-0 flex items-end justify-center"
                >
                  {/* No-lyrics fallback: the identity stack is BOTTOM-anchored
                      to the horizon's top with a margin that seats the ARTIST
                      line equidistant from the wave and the console — not
                      pinned to --stack-top like the split view (that centers
                      the ART on the window midline, hanging the metadata +
                      caption ~146px below it, head-on into the horizon's band;
                      in split the metadata is far-left and the horizon
                      centered, so they clear — the collision is centered-only,
                      Thien's live catch 2026-07-17).

                      The seat anchors off the SAME geometry the horizon uses
                      (--horizon-mb): items-end pins the stack bottom to the
                      horizon top, and mb pushes it up by (--horizon-mb + 1vh),
                      mirroring the console's distance below the wave — then
                      MINUS the caption slot (mt-1 4px + h-7 28px = 32px) so
                      that reserved, usually-empty "No synced lyrics" line
                      drops out of the reckoning and the visible ARTIST line
                      lands on center — measured 139/141 @1080, 175/176 @1440
                      (Thien: "the wave's a bit low — the No synced lyrics
                      text"). The loading⇄synced crossfade already slides the
                      art center→left, so this rides the same opacity
                      crossfade, not a new "art slides" break. */}
                  <div className="mb-[calc(var(--horizon-mb)_+_1vh_-_32px)]">
                    <IdentityStack
                      np={np}
                      artUrl={artUrl}
                      caption={caption}
                      captionExpired={captionExpired}
                      centered
                      device={remoteDevice}
                      dx={announceSuppressed ? 0 : trackDir * SLIDE_PX.content}
                    />
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>

          {/* THE QUEUE — the room's content surface, seated IN THE LYRIC
              COLUMN (redesigned 2026-07-16: the widget-sized 380px popover
              read as a miniature lost on the big screen — Thien). This is
              the expanded garment's peer-layer grammar at room scale:
              content surfaces swap in place while identity holds still —
              the album + metadata keep the left seat (the upper room is
              queue-forced into the split composition above) and the queue
              takes the lyric column's exact box: same px/gap flex row with
              a --art spacer, same 11vh ladder top, same bottom edge on the
              art's bottom line. Opaque bg-surface covers the still-running
              lyrics behind it; opacity-only crossfade (in 200 / out 140,
              visibility deferred), inert when hidden, always MOUNTED so
              scroll + the history feed survive the toggle. Capped at 560px
              (= the art's design width) — full-column rows read sparse. */}
          <div className="pointer-events-none absolute inset-0 z-20 flex items-stretch gap-[7%] px-[10%]">
            <div className="w-(--art) shrink-0" />
            <div
              inert={!queueOpen}
              className={`pointer-events-auto mt-[11vh] flex h-[calc(var(--stack-top)_+_var(--art)_-_11vh)] w-full min-w-0 max-w-(--art) flex-col bg-surface ${
                queueOpen
                  ? "opacity-100 [transition:opacity_200ms_var(--ease-out-tk)]"
                  : "invisible opacity-0 [transition:opacity_140ms_var(--ease-out-tk),visibility_0s_140ms]"
              }`}
            >
              <QueuePanel np={np} connected={spotify.connected} open={queueOpen} scale="room" />
            </div>
          </div>

          {/* THE HORIZON — the room's one living reactive surface, OUTSIDE
              the swap (never remounts, so it survives every track change
              and rides straight through it — the pill is hidden behind
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
          <div className="mb-(--horizon-mb) flex shrink-0 items-center justify-center">
            <Waveform size="room" playing={np?.status === "playing"} />
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
