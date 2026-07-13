/*
 * The like heart (A5) — lifted out of App.tsx (2026-07-12) so the focus
 * window's realm can seat it too. NOTE the standing constraint: Spotify
 * endpoint-blocks library writes for this app id (dev-mode 403 with valid
 * scopes, verified live) — SpotifyStatus.library_blocked latches on the
 * first 403 and every seat HIDES the heart (a control that flips and
 * reverts is a lie). The seats stay wired for the day the block lifts.
 */
import { useEffect, useRef, useState } from "react";
import { commands, onSpotifyNow } from "./lib/backend";
import type { NowPlaying, NowTrack } from "./types";

/** The Spotify-side current track — "spotify-now" seed + event. */
export function useSpotifyNow(): NowTrack | null {
  const [now, setNow] = useState<NowTrack | null>(null);
  useEffect(() => onSpotifyNow(setNow), []);
  return now;
}

/** GSMTC and the Web API are separate streams — the heart only trusts a
 * cached uri whose identity matches what the widget is showing. Title must
 * match exactly (ci); artists match on containment because Spotify joins
 * every credit ("IU, Wonstein") where GSMTC often carries the primary. */
function matchesNowTrack(np: NowPlaying, now: NowTrack): boolean {
  if (np.title.trim().toLowerCase() !== now.title.trim().toLowerCase()) return false;
  const a = np.artist.trim().toLowerCase();
  const b = now.artist.trim().toLowerCase();
  return a === "" || b === "" || a.includes(b) || b.includes(a);
}

/** One-off glyph, the Queue.tsx PlusGlyph class — it never morphs, so the
 * 3-stroke morph system is the wrong tool. Fill swaps with the state; the
 * press scale is the feedback. */
function HeartGlyph({ filled }: { filled: boolean }) {
  return (
    <svg width={13} height={13} viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M8 13.4C5.1 11.3 2.2 9 2.2 6.3 2.2 4.4 3.7 3 5.4 3c1 0 2 .6 2.6 1.5C8.6 3.6 9.6 3 10.6 3c1.7 0 3.2 1.4 3.2 3.3 0 2.7-2.9 5-5.8 7.1Z"
        fill={filled ? "currentColor" : "none"}
        stroke="currentColor"
        strokeWidth={1.5}
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** The like heart (A5): hover-revealed beside the title, rendered only for a
 * connected Spotify session. Actionable once the backend's "spotify-now"
 * identity matches the widget's track (the settled enrichment usually lands
 * within a second of a change); a pre-library-scope token disables it in
 * place with the reconnect answer. Rest state is fg — accent stays flourish,
 * so only the MOMENT of liking flashes accent and settles back. Failure
 * reverts the fill (the visible signal) and announces via the local live
 * region — the card has no toast surface, and inventing one for this would
 * be new chrome. */
export function HeartButton({
  np,
  now,
  library,
  className = "",
}: {
  np: NowPlaying;
  now: NowTrack | null;
  library: boolean;
  className?: string;
}) {
  // Episodes parse with spotify:episode: uris — /me/tracks can't hold them,
  // so the heart never arms for one (quick-review catch, 2026-07-11).
  const match =
    now !== null && now.uri.startsWith("spotify:track:") && matchesNowTrack(np, now)
      ? now
      : null;
  // Local guess until the backend's re-emit confirms; keyed to the uri it
  // was made for so a track change can't inherit it.
  const [optimistic, setOptimistic] = useState<{ uri: string; liked: boolean } | null>(null);
  const [flash, setFlash] = useState(false);
  const [srMsg, setSrMsg] = useState("");
  const flashTimer = useRef<number | null>(null);
  // One write at a time — overlapping PUT/DELETEs would let the last HTTP
  // response win over the user's last click (quick-review catch).
  const writing = useRef(false);
  useEffect(
    () => () => {
      if (flashTimer.current !== null) window.clearTimeout(flashTimer.current);
    },
    [],
  );
  // Track change: drop the guess AND the flash — a like-beat from the
  // previous track must not paint the next one's already-liked heart.
  useEffect(() => {
    setOptimistic(null);
    setSrMsg("");
    setFlash(false);
    if (flashTimer.current !== null) window.clearTimeout(flashTimer.current);
  }, [now?.uri]);
  // Backend confirmation (the re-emit): truth arrived, drop the guess — but
  // NOT the flash, which is a timed beat, not a pending-state indicator.
  useEffect(() => {
    setOptimistic(null);
  }, [now?.liked]);
  const liked = match
    ? optimistic?.uri === match.uri
      ? optimistic.liked
      : match.liked
    : false;
  const disabled = !library || !match;
  const label = !library
    ? "Reconnect Spotify to like tracks"
    : !match
      ? "Finding this track on Spotify…"
      : liked
        ? "Remove from Liked Songs"
        : "Add to Liked Songs";
  return (
    <span
      className={`pointer-events-none flex shrink-0 items-center opacity-0 transition-opacity duration-2 ease-out-tk group-data-[hot]/widget:pointer-events-auto group-data-[hot]/widget:opacity-100 group-has-[:focus-visible]/widget:pointer-events-auto group-has-[:focus-visible]/widget:opacity-100 ${className}`}
    >
      <button
        type="button"
        aria-label={label}
        title={label}
        aria-pressed={match ? liked : undefined}
        // aria-disabled (not disabled) keeps the seat focusable — the reveal
        // rides focus-within (the ViewToggle contract); click guard below.
        aria-disabled={disabled || undefined}
        onClick={() => {
          if (disabled || !match || writing.current) return;
          writing.current = true;
          const next = !liked;
          setOptimistic({ uri: match.uri, liked: next });
          setSrMsg("");
          if (next) {
            // The transient accent beat — liking only; settles via the
            // color transition when the timer clears it.
            setFlash(true);
            if (flashTimer.current !== null) window.clearTimeout(flashTimer.current);
            flashTimer.current = window.setTimeout(() => setFlash(false), 900);
          }
          const fail = () => {
            setOptimistic({ uri: match.uri, liked: !next });
            setFlash(false);
            setSrMsg("Couldn't save to Liked Songs");
          };
          commands
            .spotifySetLiked(match.uri, next)
            .then((status) => {
              if (status !== "ok") fail();
            })
            .catch(fail)
            .finally(() => {
              writing.current = false;
            });
        }}
        className={`grid h-[26px] w-[26px] place-items-center rounded-md [transition:color_140ms_var(--ease-out-tk),background-color_140ms_var(--ease-out-tk),opacity_140ms_var(--ease-out-tk),scale_90ms_var(--ease-out-tk)] ${
          disabled
            ? "pointer-events-none text-muted opacity-30"
            : `${flash && liked ? "text-accent" : "text-fg"} hover:bg-fg/10 active:scale-95`
        }`}
      >
        <HeartGlyph filled={liked} />
      </button>
      <span aria-live="polite" className="sr-only">
        {srMsg}
      </span>
    </span>
  );
}

