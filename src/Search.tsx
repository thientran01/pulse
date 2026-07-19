/*
 * The summon search (design "A1"): a Raycast-style floating search pane in
 * its OWN webview window (src-tauri/src/search.rs — created hidden at
 * setup, shown by Ctrl+Alt+S). One verb: get to a song in under a second.
 * Type → debounced Spotify search; Enter plays now (the context-preserving
 * jump; from silence it starts playback outright); Shift+Enter queues to
 * Pulse's up-next and stays open so several tracks queue in one summon.
 * Esc / blur / background click dismiss.
 *
 * The empty state answers "what do you want to hear?" in two sections: "From
 * your history" (up to four resurfacing picks over the local play log) and
 * "Something different" (up to three Last.fm-similar discoveries, gated on a
 * Last.fm key + Spotify, filled in below the history rows). Both rotate on a
 * day-block seed — stable within a sitting, fresh a few times a day, never a
 * per-summon shuffle. Default content, not a feature surface: verbs live on
 * rows, not on the chrome.
 *
 * Realm notes (this is the codebase's first second window): this module
 * runs in its own JS realm — its own backend listeners, its own
 * initReactive vote (the per-window vote map in lib.rs), no posClock (the
 * search window never renders position). Announcement suppression for a play
 * lives in the MAIN realm, armed by the backend's "spotify-jump" emit —
 * never armed from here.
 *
 * FULLY MONOCHROME (Thien, 2026-07-17): accent lives where the song is
 * VISIBLE — widget and focus room render the playing track's identity, so
 * the song's extracted color has an anchor there; this pane renders no
 * now-playing content, and a song-colored queue flash arrived with no
 * referent (tried both the resting hue and a synced song accent — both
 * read wrong). The queued-row flash is a neutral fg/20 brightening (a
 * clear pop above the fg/10 selection wash) + the "Queued ·" note; the
 * realm runs no art→accent pipeline (the --accent var here only ever
 * holds the resting value, effectively unused).
 */
import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { commands, onSearchShown } from "./lib/backend";
import { initReactive } from "./lib/reactive";
import { RowThumb, useSpotifyStatus } from "./Queue";
import { SpotifyConnectButton } from "./SpotifyConnectButton";
import type { HistoryEntry, QueueTrack } from "./types";

const RESULT_LIMIT = 8;
const DEBOUNCE_MS = 250;
/** History pages scanned for the resurfacing picks (3 × 200 entries). */
const RESURFACE_PAGES = 3;
/** A pick must have been genuinely listened to (cumulative). */
const RESURFACE_MIN_MS = 60_000;

interface SearchRow {
  key: string;
  title: string;
  artist: string;
  artUrl: string | null;
  /** Full track when it came from search; resurfaced rows resolve on demand. */
  track: QueueTrack | null;
  uri: string | null;
  /** Why a resurfaced row is here — rendered on the row. Unlabeled, the
   * picks read as a bug ("why these two? why did one change?") — Thien's
   * live feedback, 2026-07-12. */
  reason?: string;
}

function searchRow(t: QueueTrack): SearchRow {
  return { key: t.uri, title: t.title, artist: t.artist, artUrl: t.art_url, track: t, uri: t.uri };
}

/** Resolve-on-demand cache for resurfaced rows (the Queue.tsx uriCache
 * pattern) — successes only: the search window lives for the whole app
 * session, and caching a transient miss would permanently dead-row a pick.
 * Actions are user-paced, so an occasional re-miss can't storm. */
const uriCache = new Map<string, string>();
async function resolveUri(row: SearchRow): Promise<string | null> {
  if (row.uri) return row.uri;
  const hit = uriCache.get(row.key);
  if (hit) return hit;
  const uri = await commands.spotifyResolveUri(row.title, row.artist);
  if (uri) uriCache.set(row.key, uri);
  return uri;
}

/** One history track, aggregated across its listens. */
interface Agg {
  key: string;
  title: string;
  artist: string;
  /** Cumulative ms listened, all time in the scanned window. */
  ms: number;
  /** Cumulative ms listened within the last 7 days (the "on repeat" signal). */
  ms7: number;
  last: number;
  uri: string | null;
}

const DAY_MS = 86_400_000;

/** The freshness clock for the empty state: three blocks a day (morning /
 * afternoon / evening, local time). Rotation is per day-PART now, not per day
 * — the picks feel curated and hold within a sitting, but the list has arcs
 * across the day. Still zero per-summon randomness (a shuffle read as a bug;
 * a dated pick reads as curation). Drives history rotation, discovery seeds,
 * and the discovery cache key — one integer explains all the freshness.
 * The day component derives from LOCAL midnight to match the local hour
 * buckets — a raw epoch-day rolls at UTC midnight (4-5pm PT), which injected
 * a phantom mid-block reshuffle (quick-review catch, 2026-07-16). */
function blockSeed(now: number): number {
  const d = new Date(now);
  const localDay = Math.floor((now - d.getTimezoneOffset() * 60_000) / DAY_MS);
  const h = d.getHours();
  return localDay * 3 + (h < 12 ? 0 : h < 18 ? 1 : 2);
}

/** The exclude-key contract shared with similar.rs's `norm_key`: a track's
 * dedupe identity is its lowercased, trimmed `artist‹U+0001›title`. Keep the
 * two in lockstep — a drift silently stops "different" from meaning un-played.
 * The separator is the ESCAPE sequence, never a literal control byte: an
 * invisible U+0001 in source fooled three review agents into reporting the
 * contract broken (quick-review, 2026-07-16), and no formatter/copy-paste
 * can be trusted to preserve it. */
function discoveryKey(artist: string, title: string): string {
  return `${artist.trim().toLowerCase()}\u0001${title.trim().toLowerCase()}`;
}

/** Up to two discovery seeds, rotated by the day-block so suggestions refresh
 * a few times a day. Seed B prefers a different artist than A, so two seeds
 * don't both pull the same artist's neighborhood. */
function pickSeeds(pool: Agg[], seed: number): { title: string; artist: string }[] {
  const top = pool.slice(0, 10);
  if (!top.length) return [];
  const a = top[seed % top.length];
  const seeds = [{ title: a.title, artist: a.artist }];
  const artistA = a.artist.trim().toLowerCase();
  const start = (seed * 7 + 3) % top.length;
  for (let i = 0; i < top.length; i++) {
    const c = top[(start + i) % top.length];
    if (c.key === a.key || c.artist.trim().toLowerCase() === artistA) continue;
    seeds.push({ title: c.title, artist: c.artist });
    break;
  }
  return seeds;
}

/** Discovery rows keyed by day-block. The window lives for the whole app
 * session, so a re-summon inside a block is network-free; a new block misses
 * (≤3 fetch rounds/day). Only successful ("ok") fetches are cached. */
const discoveryCache = new Map<number, SearchRow[]>();

/** The "From your history" section: up to four resurfacing picks over the
 * local play log, each a relative measure (the log is young; absolute
 * thresholds would answer nothing for months) with a short reason label, and
 * artist-diversified so the four don't read as one artist. Returns the picks
 * AND the aggregate pool, so the discovery seeds reuse it instead of
 * re-scanning history. Deterministic within a day-block (see blockSeed). */
async function computeResurfaced(
  now: number,
  offset = 0,
): Promise<{ rows: SearchRow[]; pool: Agg[]; played: Agg[] }> {
  const entries: HistoryEntry[] = [];
  let before: number | null = null;
  for (let i = 0; i < RESURFACE_PAGES; i++) {
    const page = await commands.historyPage(before, 200);
    entries.push(...page);
    if (page.length < 200) break;
    before = page[page.length - 1].started_at_ms;
  }
  const byKey = new Map<string, Agg>();
  for (const e of entries) {
    const cur = byKey.get(e.key) ?? {
      key: e.key,
      title: e.title,
      artist: e.artist,
      ms: 0,
      ms7: 0,
      last: 0,
      uri: null,
    };
    cur.ms += e.ms_listened;
    if (now - e.started_at_ms < 7 * DAY_MS) cur.ms7 += e.ms_listened;
    cur.last = Math.max(cur.last, e.ended_at_ms);
    cur.uri = cur.uri ?? e.spotify_uri;
    byKey.set(e.key, cur);
  }
  // Every track the log has seen (any listen, even below the pick floor) —
  // the exclude source for discovery, so "different" means genuinely un-played.
  const played = [...byKey.values()];
  const all = played.filter((t) => t.ms >= RESURFACE_MIN_MS);
  const rested = all.filter((t) => now - t.last > DAY_MS);
  const pool = (rested.length ? rested : all).slice().sort((a, b) => b.ms - a.ms);

  const picks: { agg: Agg; reason: string }[] = [];
  const taken = new Set<string>();
  // Push the FIRST candidate (from a priority-ordered list) that is neither
  // already taken nor a repeat artist — so a strategy whose top choice was
  // already claimed still contributes its next-best instead of silently
  // yielding nothing. A relaxed top-up pass below fills any remainder when
  // diversity ran the pool dry (a one-artist library still fills its rows).
  const pushFirst = (cands: Agg[], reason: string, start = 0): void => {
    const n = cands.length;
    for (let k = 0; k < n; k++) {
      const agg = cands[(start + k) % n];
      if (taken.has(agg.key)) continue;
      const artist = agg.artist.trim().toLowerCase();
      if (picks.some((p) => p.agg.artist.trim().toLowerCase() === artist)) continue;
      picks.push({ agg, reason });
      taken.add(agg.key);
      return;
    }
  };

  // Each strategy walks its ranked list from `offset`, so a pull-to-refresh
  // (offset++) advances the whole section to the next-best of each category —
  // the labels stay category-accurate, and mod-wrap means it never empties.
  // 1. The most lived-in track (pool is sorted by ms desc).
  pushFirst(pool, rested.length ? "Haven't heard in a while" : "Most played", offset);
  // 2. A prior month's same date, when one exists (usually absent).
  const today = new Date(now).getDate();
  pushFirst(
    all.filter((t) => new Date(t.last).getDate() === today && now - t.last > 25 * DAY_MS),
    "On this day",
    offset,
  );
  // 3. On repeat this week.
  pushFirst(
    all.filter((t) => t.ms7 >= RESURFACE_MIN_MS).sort((a, b) => b.ms7 - a.ms7),
    "On repeat lately",
    offset,
  );
  // 4. Heavy once, untouched for a month+.
  pushFirst(
    all.filter((t) => now - t.last > 30 * DAY_MS).sort((a, b) => b.ms - a.ms),
    "Forgotten favorite",
    offset,
  );
  // 5. A rotating deep cut from the top listens (day-block wildcard + refresh
  // offset), starting the walk at the combined offset.
  const rest = pool.filter((t) => !taken.has(t.key)).slice(0, 10);
  if (rest.length) pushFirst(rest, "Today's pick", (blockSeed(now) + offset) % rest.length);
  // Top-up: if diversity left us short of four, backfill from the pool
  // (offset-walked too) ignoring the artist constraint (one-artist library).
  for (let k = 0; k < pool.length; k++) {
    if (picks.length >= 4) break;
    const agg = pool[(offset + k) % pool.length];
    if (taken.has(agg.key)) continue;
    picks.push({ agg, reason: "Played before" });
    taken.add(agg.key);
  }

  const rows: SearchRow[] = [];
  for (const p of picks.slice(0, 4)) {
    rows.push({
      key: p.agg.key,
      title: p.agg.title,
      artist: p.agg.artist,
      artUrl: await commands.historyThumbUrl(p.agg.key),
      track: null,
      uri: p.agg.uri,
      reason: p.reason,
    });
  }
  return { rows, pool, played };
}

/** A ghost of one result row — shown where real rows will land while a fetch
 * runs (discovery fill and first search results), so the wait fills its space
 * with the shape of the answer instead of a void. Geometry mirrors the real
 * row exactly (h-52, 32px thumb, gap-3 px-3.5, reason bar flush right → in-place
 * swap, zero shift); widths stagger so three read as content, not a grid.
 * Opacity-breathing only (.skeleton-pulse): the classic shimmer is a translate
 * sweep, and that motion vocabulary belongs to the waveform. The breathe is
 * delayed per COLUMN (thumb → text → reason), identical across rows, so the
 * crest reads as a left-to-right sweep — a per-ROW stagger read as
 * top-to-bottom (Thien, 2026-07-16). Visual-only (presentation + aria-hidden)
 * — rows landing are the AT-visible event, as before. */
const SKELETON_WIDTHS: readonly [string, string, string][] = [
  ["42%", "28%", "21%"],
  ["33%", "22%", "17%"],
  ["46%", "25%", "23%"],
  ["37%", "31%", "19%"],
  ["44%", "20%", "22%"],
];
/** The left→right feel knob: per-column delay into the 1300ms breathe.
 * Paired with the crest shape in skeleton-breathe — the two together set how
 * gently the light passes (crest widened 8/22→12/34 + delay 220→280 after
 * "too fast, cadence good" — Thien, 2026-07-16). */
const SKELETON_COL_DELAY_MS = 280;
function SkeletonRow({ index, reason = false }: { index: number; reason?: boolean }) {
  const [titleW, artistW, reasonW] = SKELETON_WIDTHS[index % SKELETON_WIDTHS.length];
  const col = (n: number) => ({ animationDelay: `${n * SKELETON_COL_DELAY_MS}ms` });
  return (
    <div role="presentation" aria-hidden className="flex h-[52px] items-center gap-3 px-3.5">
      {/* Thumb one tone brighter than the text bars — real rows are bright
          art beside muted text, and a single tone read as a flat gray grid. */}
      <span
        className="skeleton-pulse h-[32px] w-[32px] shrink-0 rounded-md bg-surface-2"
        style={col(0)}
      />
      <span className="flex min-w-0 flex-1 flex-col gap-[7px]">
        <span
          className="skeleton-pulse h-[10px] rounded-full bg-fg/5"
          style={{ width: titleW, ...col(1) }}
        />
        <span
          className="skeleton-pulse h-[8px] rounded-full bg-fg/5"
          style={{ width: artistW, ...col(1) }}
        />
      </span>
      {/* Only the discovery wait promises a reason label — search results
          never carry one, so their ghosts must not either. */}
      {reason && (
        <span
          className="skeleton-pulse h-[8px] shrink-0 rounded-full bg-fg/5"
          style={{ width: reasonW, ...col(2) }}
        />
      )}
    </div>
  );
}

function SearchGlyph() {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden>
      <circle cx="7" cy="7" r="4.4" />
      <path d="M 10.4,10.4 L 13.6,13.6" />
    </svg>
  );
}

/** One elevated keycap for the search-row hint. The old inline glyphs
 * ("↵ play · ⇧↵ queue") sat in the same 11px muted run as their labels and
 * read as compressed noise — you couldn't tell what to press (Thien,
 * 2026-07-16). First cut was a cream neutral-inversion fill; Thien's live
 * verdicts shaped the rest: "needs to look a bit more elevated" (Raycast's
 * footer chips as the direction) → a RAISED dark key — fill one step above
 * the bar, hairline top light + soft drop shadow for keycap depth; then
 * "the icons are too cramped" → the UNICODE arrows were the problem (font
 * glyphs go mushy at 11px), so the keys draw their own stroke SVGs in the
 * house icon language (1.5 stroke, round caps — the search glyph's
 * grammar) inside a slightly wider chip. Never accent. A one-off because
 * these are single GLYPH caps, not chord strings (Keycaps.tsx). */
function HintKey({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="inline-flex h-[18px] min-w-[20px] items-center justify-center rounded-[5px] border border-border/[0.08] bg-fg/[0.09] px-[3px] not-italic text-fg/90 shadow-[0_1px_2px_rgb(0_0_0/0.35),inset_0_1px_0_rgb(var(--fg)/0.07)]">
      {children}
    </kbd>
  );
}

/** The three hint glyphs, stroke-drawn (never font arrows — see HintKey). */
const hintSvg = {
  viewBox: "0 0 16 16",
  width: 12,
  height: 12,
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.5,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
};
function EnterGlyph() {
  return (
    <svg {...hintSvg}>
      <path d="M 12.5,4 L 12.5,9 L 4.5,9" />
      <path d="M 7.5,6 L 4.5,9 L 7.5,12" />
    </svg>
  );
}
function ShiftGlyph() {
  return (
    <svg {...hintSvg}>
      <path d="M 8,3 L 12.8,8.4 L 9.9,8.4 L 9.9,12.5 L 6.1,12.5 L 6.1,8.4 L 3.2,8.4 Z" />
    </svg>
  );
}
function UpGlyph() {
  return (
    <svg {...hintSvg}>
      <path d="M 8,12.5 L 8,3.5" />
      <path d="M 4.5,7 L 8,3.5 L 11.5,7" />
    </svg>
  );
}

export default function Search() {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<QueueTrack[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchStatus, setSearchStatus] = useState<"ok" | "disconnected" | "offline">("ok");
  const [resurfaced, setResurfaced] = useState<SearchRow[]>([]);
  // "Something different" — Last.fm discovery, additive below the history
  // rows, gated on a Last.fm key + Spotify (fills in after the history rows).
  const [discovery, setDiscovery] = useState<SearchRow[]>([]);
  // A discovery fetch is in flight with nothing to show yet — the section
  // header + skeleton rows render on this so the wait is visible (a silent
  // multi-second fill read as broken — Thien's live feedback, 2026-07-16).
  // One state covers both summon-fill and pull-refresh: same underlying wait.
  const [discoveryPending, setDiscoveryPending] = useState(false);
  // The refresh number the current rows landed with (0 = summon/mount). >0
  // keys a remount + .row-swap-in ripple so a pull visibly re-presents the
  // set — next to the skeleton's visible wait, history's instant swap read
  // as "nothing happened". Summon fills stay plain by construction.
  const [swapTick, setSwapTick] = useState(0);
  const [selected, setSelected] = useState(0);
  const [note, setNote] = useState<string | null>(null);
  const [flashKeys, setFlashKeys] = useState<ReadonlySet<string>>(new Set());
  const spotify = useSpotifyStatus();
  // Live connection for the summon-time discovery fetch (the onSearchShown
  // listener is registered once and must not close over a stale value).
  const connectedRef = useRef(spotify.connected);
  connectedRef.current = spotify.connected;
  const inputRef = useRef<HTMLInputElement>(null);
  const searchGen = useRef(0);
  // Bumped per empty-state refresh so a slow discovery fetch from a prior
  // summon can't land over a newer one.
  const resurfaceGen = useRef(0);
  // Pull-to-refresh (Up at the top slot): a monotonic offset that rotates BOTH
  // sections to a fresh set. Reset to 0 on each summon.
  const refreshCount = useRef(0);
  // Discovery keys already surfaced this session — fed into the exclude so a
  // refresh brings genuinely new suggestions, not the same neighbors. Cleared
  // on summon.
  const discoveryShown = useRef<Set<string>>(new Set());
  // The gen that owns the in-flight discovery fetch (0 = idle) — the Up
  // handler blocks new pulls while set. A TOKEN, not a boolean: a superseded
  // run's finally must not clear a newer run's flag (quick-review catch —
  // a stale clear let a third rapid pull slip the guard, get "busy" from the
  // backend single-flight, and silently blank the section).
  const refreshBusy = useRef(0);
  // The in-flight discoveryPicks promise — new runs AWAIT it before fetching,
  // so the backend's single-flight never bounces the newer (gen-winning)
  // request while the older one's result gets gen-discarded anyway
  // (quick-review catch: a summon during a pull's fetch starved discovery).
  const discoveryFlight = useRef<Promise<unknown> | null>(null);
  // Last.fm key presence, resolved once per summon (one local IPC) and read
  // SYNCHRONOUSLY by pulls — see the single-commit note in refreshEmptyState.
  const lastfmKeyRef = useRef(false);
  const noteTimer = useRef<number | null>(null);
  const flashTimers = useRef(new Map<string, number>());
  const busy = useRef(false);
  // Hover only steals the selection on a REAL pointer move (>3px): the
  // search window spawns near the cursor, and a hand resting on the mouse must
  // not snap keyboard navigation back to whatever row it happens to cover
  // (quick-review catch).
  const lastMouse = useRef<{ x: number; y: number } | null>(null);

  // The per-window reactive vote (lib.rs vote map) — the search window renders no
  // reactive surface, but a realm that never votes would leave the previous
  // default standing for it.
  useEffect(() => initReactive(), []);

  const showNote = (msg: string, holdMs = 2400) => {
    setNote(msg);
    if (noteTimer.current !== null) window.clearTimeout(noteTimer.current);
    noteTimer.current = window.setTimeout(() => setNote(null), holdMs);
  };

  const flash = (key: string) => {
    setFlashKeys((s) => new Set(s).add(key));
    const prev = flashTimers.current.get(key);
    if (prev !== undefined) window.clearTimeout(prev);
    flashTimers.current.set(
      key,
      window.setTimeout(() => {
        flashTimers.current.delete(key);
        setFlashKeys((s) => {
          const next = new Set(s);
          next.delete(key);
          return next;
        });
      }, 900),
    );
  };
  useEffect(
    () => () => {
      flashTimers.current.forEach((t) => window.clearTimeout(t));
      if (noteTimer.current !== null) window.clearTimeout(noteTimer.current);
    },
    [],
  );

  // Debounced, latest-wins search.
  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setResults(null);
      setSearching(false);
      setSearchStatus("ok");
      return;
    }
    setSearching(true);
    const t = window.setTimeout(() => {
      const gen = ++searchGen.current;
      void commands.spotifySearch(q, RESULT_LIMIT).then((r) => {
        if (gen !== searchGen.current) return;
        setSearching(false);
        setSearchStatus(r.status);
        setResults(r.tracks);
        setSelected(0);
      });
    }, DEBOUNCE_MS);
    return () => window.clearTimeout(t);
  }, [query]);

  // The empty state: history rows first (local, instant), then a gated,
  // fire-and-forget discovery fetch that fills in below — never blocking the
  // history rows. One block seed drives the whole refresh.
  const refreshEmptyState = useCallback(async (refreshN = 0) => {
    const now = Date.now();
    const gen = ++resurfaceGen.current;
    const { rows, pool, played } = await computeResurfaced(now, refreshN);
    if (gen !== resurfaceGen.current) return;

    // Resolve EVERYTHING that decides the discovery section BEFORE touching
    // state, so rows + tick + section land in ONE commit — an await between
    // them unmounted the "Something different" header for a frame and the
    // list height tore on every pull (design-eng pass, 2026-07-16). The key
    // check is one local IPC per summon, cached in a ref for pulls.
    if (refreshN === 0) {
      lastfmKeyRef.current = await commands.lastfmHasKey();
      if (gen !== resurfaceGen.current) return;
    }
    // Discovery is gated on a Last.fm key + a live Spotify session (URIs must
    // resolve to be playable). Its absence is silent — ambient content, not a
    // feature whose failure needs narrating.
    const canDiscover = connectedRef.current && pool.length > 0 && lastfmKeyRef.current;
    // The seed rotates per refresh, so each pull pulls a different seed's
    // neighborhood. The pristine block (refreshN 0) is cached so a re-summon
    // inside the block is free; a user-driven refresh always fetches fresh.
    const seed = blockSeed(now) + refreshN;
    const playedKeys = new Set(played.map((t) => discoveryKey(t.artist, t.title)));
    let cached = refreshN === 0 && canDiscover ? discoveryCache.get(seed) : undefined;
    if (cached) {
      // Re-validate a same-block hit against what's been played SINCE it was
      // cached — playing a suggestion then re-summoning must not re-suggest
      // it (quick-review catch). An emptied hit falls through to a fresh
      // fetch rather than pinning a dead section for the rest of the block.
      cached = cached.filter((r) => !playedKeys.has(discoveryKey(r.artist, r.title)));
      if (!cached.length) {
        discoveryCache.delete(seed);
        cached = undefined;
      }
    }
    const remember = (list: SearchRow[]) =>
      list.forEach((r) => discoveryShown.current.add(discoveryKey(r.artist, r.title)));

    // The one commit: history rows, the swap tick (= the refresh number, so
    // summon/mount resets it and renders plain), and the discovery section's
    // fate — cached rows, skeletons (pending), or silently absent.
    setResurfaced(rows);
    setSwapTick(refreshN);
    if (cached) {
      remember(cached);
      setDiscovery(cached);
      setDiscoveryPending(false);
      return;
    }
    setDiscovery([]);
    setDiscoveryPending(canDiscover);
    if (!canDiscover) return;

    const seeds = pickSeeds(pool, seed);
    // Exclude EVERY played track (not just the rested seed pool — a track heard
    // in the last day is in `played` but NOT in `pool`) AND everything a prior
    // refresh already surfaced this session, so a pull can't repeat a pick.
    const exclude = [...playedKeys, ...discoveryShown.current];
    // Serialize behind any in-flight fetch (its result is gen-discarded, but
    // racing it would get THIS request bounced "busy" by the backend's
    // single-flight); re-check gen — a newer run may have started meanwhile.
    if (discoveryFlight.current) {
      await discoveryFlight.current.catch(() => {});
      if (gen !== resurfaceGen.current) return;
    }
    refreshBusy.current = gen;
    let res: Awaited<ReturnType<typeof commands.discoveryPicks>> | null;
    const flight = commands.discoveryPicks(seeds, exclude);
    discoveryFlight.current = flight;
    try {
      res = await flight;
    } catch {
      res = null; // transport hiccup — same silent fallback as a non-ok status
    } finally {
      // Owner-only clears throughout: a superseded run's finally must not
      // free a newer run's token or flight (the same clobber class twice).
      if (discoveryFlight.current === flight) discoveryFlight.current = null;
      if (refreshBusy.current === gen) refreshBusy.current = 0;
      // A stale gen never touches pending — the newer run owns it now.
      if (gen === resurfaceGen.current) setDiscoveryPending(false);
    }
    if (gen !== resurfaceGen.current || !res || res.status !== "ok") return;
    const seen = new Set(rows.map((r) => r.uri).filter((u): u is string => !!u));
    const rows2: SearchRow[] = res.picks
      .filter((p) => !seen.has(p.track.uri))
      .slice(0, 3)
      .map((p) => ({
        key: p.track.uri,
        title: p.track.title,
        artist: p.track.artist,
        artUrl: p.track.art_url,
        track: p.track,
        uri: p.track.uri,
        reason: `Because you played ${p.seed_title}`,
      }));
    remember(rows2);
    setDiscovery(rows2);
    // Cache only a NON-EMPTY pristine set: `if (cached)` treats [] as a hit,
    // and one pathological empty post-filter would otherwise pin the section
    // dead for the whole block (quick-review catch).
    if (refreshN === 0 && rows2.length) discoveryCache.set(seed, rows2);
  }, []);

  // Summon signal: refocus, select-all the stale query, fresh empty state.
  useEffect(
    () =>
      onSearchShown(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
        setNote(null);
        setSelected(0);
        // Every summon starts from the curated set; a pull-refresh advances
        // from there.
        refreshCount.current = 0;
        discoveryShown.current.clear();
        void refreshEmptyState(0);
      }),
    [refreshEmptyState],
  );
  // Mount + whenever the Spotify connection resolves/flips: the initial
  // render is disconnected until the status seed lands, and discovery needs a
  // live session — so recompute when it settles (also refills discovery after
  // a reconnect without waiting for the next summon).
  useEffect(() => {
    inputRef.current?.focus();
    refreshCount.current = 0;
    discoveryShown.current.clear();
    void refreshEmptyState(0);
  }, [refreshEmptyState, spotify.connected]);

  const hasQuery = query.trim().length > 0;
  // Row-source flips (typing the first char, clearing) restart selection at
  // the top — without this the RAW selected can sit past the new list and
  // ArrowUp reads as dead until it walks back into range. The swap tick
  // resets with it: after a pull, a type-then-clear round trip re-showed the
  // SAME rows through the pull ripple — replayed motion for content that
  // didn't change (unlicensed; the ripple is pull feedback only).
  useEffect(() => {
    setSelected(0);
    setSwapTick(0);
  }, [hasQuery]);

  // Discovery appends BELOW history, so a late-arriving discovery fill never
  // shifts the selected index (the clamp handles list growth).
  const rows: SearchRow[] = hasQuery
    ? (results ?? []).map(searchRow)
    : [...resurfaced, ...discovery];
  const sel = Math.min(selected, Math.max(rows.length - 1, 0));

  const playRow = async (row: SearchRow) => {
    if (busy.current) return;
    busy.current = true;
    try {
      // Resolve BEFORE dismissing — it's one fast search for un-enriched
      // history rows (instant for search results), and "couldn't find it"
      // still has a surface to land on.
      const uri = await resolveUri(row);
      if (!uri) {
        showNote("Couldn't find it on Spotify");
        return;
      }
      // Light exit (Thien's call, 2026-07-12): dismiss the INSTANT the
      // intent is actionable — the music changing is the confirmation.
      // The jump itself takes seconds and runs behind the dismissal; a
      // rare post-dismiss failure is deliberately silent.
      setQuery("");
      setNote(null);
      commands.searchHide();
      void commands.playNow(uri);
    } finally {
      busy.current = false;
    }
  };

  const queueRow = async (row: SearchRow) => {
    // Same one-write-at-a-time gate as playRow: a held Shift+Enter
    // key-repeats, and upnext_add has no dedupe (quick-review catch).
    if (busy.current) return;
    busy.current = true;
    try {
      const uri = await resolveUri(row);
      if (!uri) {
        showNote("Couldn't find it on Spotify");
        return;
      }
      commands.upnextAdd(
        row.track ?? {
          uri,
          title: row.title,
          artist: row.artist,
          album: "",
          duration_ms: 0,
          art_url: row.artUrl,
        },
      );
      flash(row.key);
      showNote(`Queued · ${row.title}`);
    } finally {
      busy.current = false;
    }
  };

  // Disconnected → an in-place Connect button (below); connected-but-offline
  // still narrates. `gated` blocks Enter-to-play and hides the ↵/⇧↵ hint.
  const offline = spotify.connected && searchStatus === "offline";
  const gated = !spotify.connected || offline;

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      commands.searchHide();
    } else if (e.key === "ArrowDown") {
      // Step from the CLAMPED position — the raw state can sit past a
      // shrunken list, where stepping it would strand the highlight.
      e.preventDefault();
      setSelected(Math.min(sel + 1, Math.max(rows.length - 1, 0)));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      // Pull-to-refresh: Up while ALREADY at the top slot rolls a fresh set
      // (the phone gesture). Only in the empty state, with rows to replace,
      // and never while a fetch is in flight (would answer "busy"). No
      // toast: the skeleton wait + the row-swap ripple ARE the refresh
      // narration — the "Fresh picks" caption was double-speak (Thien,
      // 2026-07-17).
      if (!hasQuery && sel === 0 && !gated && rows.length > 0 && !refreshBusy.current) {
        refreshCount.current += 1;
        void refreshEmptyState(refreshCount.current);
        return;
      }
      setSelected(Math.max(sel - 1, 0));
    } else if (e.key === "Enter" && rows[sel] && !gated) {
      e.preventDefault();
      // A HELD Enter/Shift+Enter key-repeats, and the busy gate frees in a
      // microtask (resolveUri resolves synchronously for enriched rows)
      // before the next repeat keydown — so a repeat slips the gate and
      // upnext_add, which has no dedupe, double-queues (audit A6-5). One
      // physical press = one action: ignore auto-repeat outright. The play
      // path dismisses on its first fire, but a held repeat still reached
      // playNow twice before the hide landed — this covers both verbs.
      if (e.repeat) return;
      if (e.shiftKey) void queueRow(rows[sel]);
      else void playRow(rows[sel]);
    }
  };

  return (
    // The window is transparent and fixed-size; the p-3 gutter gives the
    // shell's shadow room. A click on the gutter (outside the shell)
    // dismisses — the fixed window's unused area must never read as dead.
    <div
      className="flex h-screen w-screen flex-col p-3"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) commands.searchHide();
      }}
      onKeyDown={onKeyDown}
    >
      {/* The queue popover's shadow recipe (App.tsx) — not a third invented
          elevation; it also stays inside the 12px gutter, the transparent-
          window clip budget the card shadow once overflowed. */}
      <div
        // Keep focus in the input: the root onKeyDown (Esc/arrows/Enter) lives
        // on a non-focusable div, so a mousedown on non-interactive panel
        // content moves focus to <body> and the pane goes keyboard-dead until
        // the next click (audit A6-9). preventDefault suppresses the focus
        // shift without touching click, so row clicks still play and the input
        // keeps its native caret/selection.
        onMouseDown={(e) => {
          if (e.target !== inputRef.current) e.preventDefault();
        }}
        className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-border/10 bg-surface shadow-xl shadow-black/40"
      >
        {/* Search row — the search's one verb. */}
        <div className="flex items-center gap-3 border-b border-border/10 px-5 py-4">
          <span className={searching ? "text-fg" : "text-muted"}>
            <SearchGlyph />
          </span>
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Play something…"
            aria-label="Search Spotify"
            role="combobox"
            aria-expanded={rows.length > 0}
            aria-controls="search-list"
            aria-activedescendant={rows[sel] ? `search-opt-${sel}` : undefined}
            spellCheck={false}
            autoCorrect="off"
            autoComplete="off"
            // focus-visible:outline-none out-specificities index.css's global
            // accent focus ring — it's built for 28px buttons, and on a bare
            // full-width input it rendered as a square orange bar (Thien's
            // live feedback). The caret is this input's focus signal; it is
            // the pane's only focusable element.
            className="search-input min-w-0 flex-1 bg-transparent text-[18px] text-fg outline-none placeholder:text-muted focus-visible:[outline:none]"
          />
          {!gated && (
            <>
              {/* AT mirror: the visual chips are glyph soup to a reader
                  ("return symbol upwards arrow…") — hide them and say it in
                  words, the skeletons' aria-hidden pattern. */}
              <span className="sr-only">
                Enter plays. Shift+Enter queues.
                {!hasQuery && rows.length > 0 ? " Up arrow refreshes suggestions." : ""}
              </span>
              <span aria-hidden className="flex shrink-0 items-center gap-2 text-[11px] text-muted/85">
              {/* "↑ more" only when there ARE rows to re-roll — the Up guard
                  requires rows, and an empty-history user was being promised
                  a no-op (quick-review catch). Raycast's footer grammar:
                  verb label first, then its key(s); groups separated by a
                  hairline, not middots. */}
              <span className="flex items-center gap-1.5">
                play
                <HintKey><EnterGlyph /></HintKey>
              </span>
              <span className="h-3 w-px bg-border/10" />
              <span className="flex items-center gap-1.5">
                queue
                <span className="flex items-center gap-[3px]">
                  <HintKey><ShiftGlyph /></HintKey>
                  <HintKey><EnterGlyph /></HintKey>
                </span>
              </span>
              {!hasQuery && rows.length > 0 && (
                <>
                  <span className="h-3 w-px bg-border/10" />
                  <span className="flex items-center gap-1.5">
                    more
                    <HintKey><UpGlyph /></HintKey>
                  </span>
                </>
              )}
              </span>
            </>
          )}
        </div>

        {/* AT mirror of the states the visuals paint for sighted users (the
            skeletons are aria-hidden): search-in-flight — a status the old
            "Searching…" text used to provide — the discovery wait, and the
            landed suggestion count (quick-review a11y catches, 2026-07-16). */}
        <span role="status" className="sr-only">
          {hasQuery && searching && rows.length === 0
            ? "Searching Spotify"
            : !hasQuery && discoveryPending
              ? "Finding suggestions"
              : !hasQuery && discovery.length > 0
                ? `${discovery.length} suggestion${discovery.length === 1 ? "" : "s"} added`
                : ""}
        </span>

        {/* One left line for the whole pane: the list container's p-1.5 (6px)
            plus px-3.5 (14px) lands rows, headers, prose, and skeletons on
            the SAME 20px inset as the search row's px-5 glyph — the input's
            magnifier, section labels, and row thumbs share one vertical
            line (the alignment sweep, 2026-07-16). */}
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-1.5 [scrollbar-width:none]">
          {!spotify.connected ? (
            <div className="flex flex-col items-start gap-1.5 px-3.5 py-2.5">
              <SpotifyConnectButton />
              <p className="m-0 text-[12px] text-muted/85">Connect Spotify to search and play.</p>
            </div>
          ) : offline ? (
            <p className="m-0 px-3.5 py-2.5 text-[13px] text-muted">Spotify unreachable</p>
          ) : (
            <>
              {!hasQuery && rows.length === 0 && (
                <p className="m-0 px-3.5 py-2.5 text-[13px] text-muted">
                  Type to search Spotify — tracks you play will gather here.
                </p>
              )}
              {/* First results still in flight — the same ghost rows as the
                  discovery wait (the glyph in the search row tints too), at
                  the count results actually land with (3 ghosts → 8 rows was
                  a vertical jump), and reason-less like real result rows. */}
              {hasQuery &&
                searching &&
                rows.length === 0 &&
                Array.from({ length: RESULT_LIMIT }, (_, i) => (
                  <SkeletonRow key={i} index={i} />
                ))}
              {hasQuery && !searching && rows.length === 0 && (
                <p className="m-0 px-3.5 py-2.5 text-[13px] text-muted">No matches on Spotify</p>
              )}
              <div
                id="search-list"
                role="listbox"
                aria-label={hasQuery ? "Search results" : "Recommendations"}
              >
                {rows.map((row, i) => {
                  // Section headers ride INSIDE the flat list so keyboard nav
                  // spans both sections with one index; presentation role so a
                  // reader skips them as options.
                  const header =
                    !hasQuery && i === 0 && resurfaced.length > 0
                      ? "From your history"
                      : !hasQuery && discovery.length > 0 && i === resurfaced.length
                        ? "Something different"
                        : null;
                  return (
                    // The tick prefix remounts the SET on a pull so the ripple
                    // is uniform (partially-animating rows read as a bug, and
                    // a class flip on survivors would replay anyway); headers
                    // remount too but carry no animation — chrome holds still.
                    <Fragment key={`${swapTick}:${row.key}`}>
                      {header && (
                        <p
                          role="presentation"
                          className="m-0 px-3.5 pb-1.5 pt-2 text-[11px] uppercase tracking-widest text-muted"
                        >
                          {header}
                        </p>
                      )}
                  <div
                    id={`search-opt-${i}`}
                    role="option"
                    aria-selected={i === sel}
                    onMouseMove={(e) => {
                      const prev = lastMouse.current;
                      lastMouse.current = { x: e.clientX, y: e.clientY };
                      if (prev && Math.abs(prev.x - e.clientX) + Math.abs(prev.y - e.clientY) < 3) return;
                      if (prev) setSelected(i);
                    }}
                    onClick={() => void playRow(row)}
                    className={`flex h-[52px] cursor-pointer select-none items-center gap-3 rounded-md px-3.5 [transition:background-color_140ms_var(--ease-out-tk)] ${
                      flashKeys.has(row.key) ? "bg-fg/20" : i === sel ? "bg-fg/10" : ""
                    } ${!hasQuery && swapTick > 0 ? "row-swap-in" : ""}`}
                    style={
                      // Stagger is LOCAL to each section's landing moment:
                      // history staggers from the pull commit; discovery rows
                      // mount seconds later and stagger from their own arrival
                      // — a flat-index delay left them invisible for 100ms+
                      // AFTER the skeleton wait (design-eng pass, 2026-07-16).
                      !hasQuery && swapTick > 0
                        ? {
                            animationDelay: `${(i < resurfaced.length ? i : i - resurfaced.length) * 20}ms`,
                          }
                        : undefined
                    }
                  >
                    <RowThumb url={row.artUrl} size={32} />
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate text-[14px] font-medium leading-5 text-fg">{row.title}</span>
                      <span className="truncate text-[12px] leading-4 text-muted">{row.artist}</span>
                    </span>
                    {/* The pick's why, flush to the right edge — without it the
                        picks read as a bug (Thien, 2026-07-12). No per-row mouse
                        buttons compete for the slot: this surface is
                        keyboard-first (↵ plays, ⇧↵ queues; a row click also
                        plays), so the reason stays perfectly aligned, nothing
                        shifts row to row (Thien's call, 2026-07-16). Capped +
                        truncated so a long "Because you played …" can't crush
                        the title column. */}
                    {row.reason && (
                      <span className="max-w-[45%] shrink-0 truncate text-[11px] text-muted/85">
                        {row.reason}
                      </span>
                    )}
                  </div>
                    </Fragment>
                  );
                })}
                {/* Discovery in flight, nothing to show yet (summon-fill OR
                    pull-refresh — same wait): the header appears at once with
                    three ghost rows holding the exact space the picks will
                    land in, so a multi-second Last.fm→Spotify walk never
                    reads as broken and the swap is in-place. */}
                {!hasQuery && discoveryPending && discovery.length === 0 && (
                  <>
                    <p
                      role="presentation"
                      className="m-0 px-3.5 pb-1.5 pt-2 text-[11px] uppercase tracking-widest text-muted"
                    >
                      Something different
                    </p>
                    {[0, 1, 2].map((i) => (
                      <SkeletonRow key={i} index={i} reason />
                    ))}
                  </>
                )}
              </div>
            </>
          )}
        </div>

        {/* Quiet feedback line — the search's toast. */}
        <p aria-live="polite" className="m-0 min-h-[30px] truncate border-t border-border/10 px-5 py-1.5 text-[12px] leading-[18px] text-muted">
          {note}
        </p>
      </div>
    </div>
  );
}
