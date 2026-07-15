/*
 * The summon search (design "A1"): a Raycast-style floating search pane in
 * its OWN webview window (src-tauri/src/search.rs — created hidden at
 * setup, shown by Ctrl+Alt+S). One verb: get to a song in under a second.
 * Type → debounced Spotify search; Enter plays now (the context-preserving
 * jump; from silence it starts playback outright); Shift+Enter queues to
 * Pulse's up-next and stays open so several tracks queue in one summon.
 * Esc / blur / background click dismiss.
 *
 * The empty state answers "what do you want to hear?" with two or three
 * resurfacing rows computed from the local play history on each summon —
 * default content, not a feature surface. The search deliberately never
 * grows past this: verbs live on rows, not on the chrome.
 *
 * Realm notes (this is the codebase's first second window): this module
 * runs in its own JS realm — its own backend listeners, its own
 * initReactive vote (the per-window vote map in lib.rs), no posClock (the
 * search window never renders position). Announcement suppression for a play
 * lives in the MAIN realm, armed by the backend's "spotify-jump" emit —
 * never armed from here.
 */
import { useEffect, useRef, useState } from "react";
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

/** The empty state's picks: (1) the most-lived-in track you haven't played
 * in the last day, (2) an "on this day" from a prior month when one exists,
 * (3) a daily pick from the top listens. All relative measures — the history
 * log is young, and absolute thresholds would answer nothing for months.
 * DETERMINISTIC within a day: the old per-summon random wildcard made the
 * list shuffle on every open, which read as flakiness, not curation. */
async function computeResurfaced(): Promise<SearchRow[]> {
  const entries: HistoryEntry[] = [];
  let before: number | null = null;
  for (let i = 0; i < RESURFACE_PAGES; i++) {
    const page = await commands.historyPage(before, 200);
    entries.push(...page);
    if (page.length < 200) break;
    before = page[page.length - 1].started_at_ms;
  }
  interface Agg {
    key: string;
    title: string;
    artist: string;
    ms: number;
    last: number;
    uri: string | null;
  }
  const byKey = new Map<string, Agg>();
  for (const e of entries) {
    const cur = byKey.get(e.key) ?? {
      key: e.key,
      title: e.title,
      artist: e.artist,
      ms: 0,
      last: 0,
      uri: null,
    };
    cur.ms += e.ms_listened;
    cur.last = Math.max(cur.last, e.ended_at_ms);
    cur.uri = cur.uri ?? e.spotify_uri;
    byKey.set(e.key, cur);
  }
  const now = Date.now();
  const day = 86_400_000;
  const all = [...byKey.values()].filter((t) => t.ms >= RESURFACE_MIN_MS);
  const rested = all.filter((t) => now - t.last > day);
  const pool = (rested.length ? rested : all).slice().sort((a, b) => b.ms - a.ms);
  const picks: { agg: Agg; reason: string }[] = [];
  if (pool[0]) {
    picks.push({
      agg: pool[0],
      reason: rested.length ? "Haven't heard in a while" : "Most played",
    });
  }
  const today = new Date().getDate();
  const onThisDay = all.find(
    (t) =>
      new Date(t.last).getDate() === today &&
      now - t.last > 25 * day &&
      !picks.some((p) => p.agg === t),
  );
  if (onThisDay) picks.push({ agg: onThisDay, reason: "On this day" });
  const rest = pool.filter((t) => !picks.some((p) => p.agg === t)).slice(0, 10);
  if (rest.length) {
    // Rotates DAILY, stable within the day — a per-summon shuffle read as
    // a bug; a dated pick reads as curation.
    const daySeed = Math.floor(now / day);
    picks.push({ agg: rest[daySeed % rest.length], reason: "Today's pick" });
  }
  const rows: SearchRow[] = [];
  for (const p of picks.slice(0, 3)) {
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
  return rows;
}

function SearchGlyph() {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden>
      <circle cx="7" cy="7" r="4.4" />
      <path d="M 10.4,10.4 L 13.6,13.6" />
    </svg>
  );
}

const PlusGlyph = (
  <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" aria-hidden>
    <path d="M 8,3.4 L 8,12.6" />
    <path d="M 3.4,8 L 12.6,8" />
  </svg>
);
const PlayGlyph = (
  <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M 5.4,3.4 L 5.4,12.6" />
    <path d="M 5.4,3.4 L 13,8 L 5.4,12.6" />
  </svg>
);

export default function Search() {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<QueueTrack[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchStatus, setSearchStatus] = useState<"ok" | "disconnected" | "offline">("ok");
  const [resurfaced, setResurfaced] = useState<SearchRow[]>([]);
  const [selected, setSelected] = useState(0);
  const [note, setNote] = useState<string | null>(null);
  const [flashKeys, setFlashKeys] = useState<ReadonlySet<string>>(new Set());
  const spotify = useSpotifyStatus();
  const inputRef = useRef<HTMLInputElement>(null);
  const searchGen = useRef(0);
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

  // Summon signal: refocus, select-all the stale query, fresh resurfacing.
  useEffect(
    () =>
      onSearchShown(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
        setNote(null);
        setSelected(0);
        void computeResurfaced().then(setResurfaced);
      }),
    [],
  );
  useEffect(() => {
    inputRef.current?.focus();
    void computeResurfaced().then(setResurfaced);
  }, []);

  const hasQuery = query.trim().length > 0;
  // Row-source flips (typing the first char, clearing) restart selection at
  // the top — without this the RAW selected can sit past the new list and
  // ArrowUp reads as dead until it walks back into range.
  useEffect(() => {
    setSelected(0);
  }, [hasQuery]);

  const rows: SearchRow[] = hasQuery ? (results ?? []).map(searchRow) : resurfaced;
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
      setSelected(Math.max(sel - 1, 0));
    } else if (e.key === "Enter" && rows[sel] && !gated) {
      e.preventDefault();
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
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-border/10 bg-surface shadow-xl shadow-black/40">
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
            <span className="shrink-0 text-[11px] text-muted/60">↵ play · ⇧↵ queue</span>
          )}
        </div>

        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-1.5 [scrollbar-width:none]">
          {!spotify.connected ? (
            <div className="flex flex-col items-start gap-1.5 px-2.5 py-2.5">
              <SpotifyConnectButton />
              <p className="m-0 text-[12px] text-muted/70">Connect Spotify to search and play.</p>
            </div>
          ) : offline ? (
            <p className="m-0 px-2.5 py-2.5 text-[13px] text-muted">Spotify unreachable</p>
          ) : (
            <>
              {!hasQuery && rows.length > 0 && (
                <p className="m-0 px-2.5 pb-1.5 pt-2 text-[11px] uppercase tracking-widest text-muted">
                  From your history
                </p>
              )}
              {!hasQuery && rows.length === 0 && (
                <p className="m-0 px-2.5 py-2.5 text-[13px] text-muted">
                  Type to search Spotify — tracks you play will gather here.
                </p>
              )}
              {hasQuery && searching && rows.length === 0 && (
                <p className="m-0 px-2.5 py-2.5 text-[13px] text-muted">Searching…</p>
              )}
              {hasQuery && !searching && rows.length === 0 && (
                <p className="m-0 px-2.5 py-2.5 text-[13px] text-muted">No matches on Spotify</p>
              )}
              <div
                id="search-list"
                role="listbox"
                aria-label={hasQuery ? "Search results" : "From your history"}
              >
                {rows.map((row, i) => (
                  <div
                    key={row.key}
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
                    className={`group/row flex h-[52px] cursor-pointer select-none items-center gap-3 rounded-md px-3 [transition:background-color_140ms_var(--ease-out-tk)] ${
                      flashKeys.has(row.key) ? "bg-accent/15" : i === sel ? "bg-fg/10" : ""
                    }`}
                  >
                    <RowThumb url={row.artUrl} size={32} />
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate text-[14px] font-medium leading-5 text-fg">{row.title}</span>
                      <span className="truncate text-[12px] leading-4 text-muted">{row.artist}</span>
                    </span>
                    {/* Explicit verbs, revealed on hover (the history-row
                        grammar) — the bare row click also plays, but nothing
                        SAID so. Seated to the LEFT of the reason: at rest they
                        hold their slot invisibly, so the reason stays anchored
                        to the row's right edge instead of floating with the
                        empty button space stranded past it (Thien, 2026-07-13).
                        On hover they simply fill that gap; the reason holds. */}
                    <button
                      type="button"
                      tabIndex={-1}
                      aria-label={`Play ${row.title} now`}
                      title="Play now (Enter)"
                      onMouseDown={(e) => e.stopPropagation()}
                      onClick={(e) => {
                        e.stopPropagation();
                        void playRow(row);
                      }}
                      className="grid h-[30px] w-[30px] shrink-0 place-items-center rounded-md text-fg opacity-0 [transition:opacity_140ms_var(--ease-out-tk),background-color_140ms_var(--ease-out-tk),scale_90ms_var(--ease-out-tk)] hover:bg-fg/10 active:scale-95 group-hover/row:opacity-100"
                    >
                      {PlayGlyph}
                    </button>
                    <button
                      type="button"
                      tabIndex={-1}
                      aria-label={`Queue ${row.title}`}
                      title="Add to queue (Shift+Enter)"
                      onMouseDown={(e) => e.stopPropagation()}
                      onClick={(e) => {
                        e.stopPropagation();
                        void queueRow(row);
                      }}
                      className="grid h-[30px] w-[30px] shrink-0 place-items-center rounded-md text-fg opacity-0 [transition:opacity_140ms_var(--ease-out-tk),background-color_140ms_var(--ease-out-tk),scale_90ms_var(--ease-out-tk)] hover:bg-fg/10 active:scale-95 group-hover/row:opacity-100"
                    >
                      {PlusGlyph}
                    </button>
                    {/* The pick's why — without it the resurfacing reads as a
                        bug. Flush to the right edge; the hover controls slot in
                        to its left. */}
                    {row.reason && (
                      <span className="shrink-0 text-[11px] text-muted/60">
                        {row.reason}
                      </span>
                    )}
                  </div>
                ))}
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
