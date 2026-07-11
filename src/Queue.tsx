/*
 * Queue & history UI (design "11a"): the Pulse-managed up-next list and the
 * "Earlier" play-history feed, rendered in two garments off ONE open/closed
 * bit — a popover above the pill/card, a full content surface inside
 * expanded. State is shared, never reset by resizing (the handoff's
 * continuity rule falls out of the single bit: expand with the popover open
 * and the surface is already active; collapse and the popover is open).
 *
 * Data reality: "Up next" is upnext.rs's list (Spotify's API can't remove/
 * reorder, so all list mutations are local + instant); "Earlier" is
 * history.rs's log (player-agnostic, infinite scroll, newest first).
 * Play-now rides spotify.rs's context-preserving jump; the pill's
 * track-change announcement is suppressed for the jump's intermediate
 * flickers via isAnnounceSuppressed (the target's arrival announces once,
 * normally).
 */
import { memo, useCallback, useEffect, useRef, useState } from "react";
import { MorphIcon } from "./icons/MorphIcon";
import {
  commands,
  onHistoryAppended,
  onSpotifyStatus,
  onUpNextChanged,
} from "./lib/backend";
import type { HistoryEntry, NowPlaying, QueueTrack } from "./types";

const HISTORY_PAGE = 30;
/** Row height — the drag math's grid (swap threshold ±26 = just past half). */
const ROW_H = 44;
const SWAP_AT = 26;
/** Popover garment box (the handoff's 312×330, height re-derived from the
 * real 440px window per mode — the prototype's 520px frame had more room). */
export const POPOVER_W = 312;
export const POPOVER_GAP = 12;

// ---- data hooks ----

export function useSpotifyConnected(): boolean {
  const [connected, setConnected] = useState(false);
  useEffect(() => onSpotifyStatus((s) => setConnected(s.connected)), []);
  return connected;
}

export function useUpNext(): QueueTrack[] {
  const [list, setList] = useState<QueueTrack[]>([]);
  useEffect(() => {
    let gotEvent = false;
    const un = onUpNextChanged((l) => {
      gotEvent = true;
      setList(l);
    });
    // Seed after subscribing; an event that landed first is fresher.
    void commands.upnextList().then((l) => {
      if (!gotEvent) setList(l);
    });
    return un;
  }, []);
  return list;
}

/** The Earlier feed: seeds a page when first activated, live-prepends
 * finalized listens, and pages backwards on demand. Inert until `active` —
 * a closed queue UI costs nothing. */
export function useHistoryFeed(active: boolean): {
  entries: HistoryEntry[];
  loadMore: () => void;
  exhausted: boolean;
} {
  const [entries, setEntries] = useState<HistoryEntry[]>([]);
  const [exhausted, setExhausted] = useState(false);
  const seeded = useRef(false);
  const loading = useRef(false);
  // Updater functions must stay PURE (StrictMode double-invokes them — a
  // fetch inside one paged twice and duplicated rows); reads go through a
  // ref instead.
  const entriesRef = useRef(entries);
  entriesRef.current = entries;
  const sameEntry = (a: HistoryEntry, b: HistoryEntry) =>
    a.key === b.key && a.started_at_ms === b.started_at_ms;
  useEffect(() => {
    if (!active || seeded.current) return;
    seeded.current = true;
    void commands.historyPage(null, HISTORY_PAGE).then((page) => {
      // A live append can land while the seed is in flight — merge, don't
      // clobber (the page includes it too; dedupe).
      setEntries((cur) =>
        cur.length === 0 ? page : [...cur, ...page.filter((p) => !cur.some((c) => sameEntry(c, p)))],
      );
      if (page.length < HISTORY_PAGE) setExhausted(true);
    });
  }, [active]);
  useEffect(
    () =>
      onHistoryAppended((e) => {
        if (!seeded.current) return; // the seed will include it
        setEntries((prev) => [e, ...prev]);
      }),
    [],
  );
  const loadMore = useCallback(() => {
    if (loading.current || exhausted) return;
    loading.current = true;
    const oldest = entriesRef.current[entriesRef.current.length - 1];
    void commands.historyPage(oldest ? oldest.started_at_ms : null, HISTORY_PAGE).then((page) => {
      loading.current = false;
      if (page.length < HISTORY_PAGE) setExhausted(true);
      if (page.length > 0) {
        setEntries((cur) => [...cur, ...page.filter((p) => !cur.some((c) => sameEntry(c, p)))]);
      }
    });
  }, [exhausted]);
  return { entries, loadMore, exhausted };
}

// ---- history thumbs (module cache — rows remount across garments) ----

const thumbCache = new Map<string, string | null>();
/** Mirrors the disk cache's bound (history.rs THUMB_MAX_FILES) — the widget
 * runs for days; an uncapped map of base64 JPEGs would only ever grow. */
const THUMB_CACHE_MAX = 300;

function useThumb(key: string): string | null {
  const [url, setUrl] = useState<string | null>(() => thumbCache.get(key) ?? null);
  useEffect(() => {
    if (thumbCache.has(key)) {
      setUrl(thumbCache.get(key) ?? null);
      return;
    }
    let alive = true;
    void commands.historyThumbUrl(key).then((u) => {
      if (thumbCache.size >= THUMB_CACHE_MAX) {
        const oldest = thumbCache.keys().next().value;
        if (oldest !== undefined) thumbCache.delete(oldest);
      }
      thumbCache.set(key, u);
      if (alive) setUrl(u);
    });
    return () => {
      alive = false;
    };
  }, [key]);
  return url;
}

// ---- announcement suppression (the jump's intermediate flickers) ----

const suppression = { until: 0, title: "", artist: "" };

/** True while a play_now jump is in flight and `np` is NOT the jump target —
 * the pill's track-change announcement holds for intermediates and fires
 * once, normally, when the target lands (or the window expires). Target
 * matching is title + artist overlap (upnext.rs's matches_track rule) — a
 * title-only match would end suppression early on a same-titled cover. */
export function isAnnounceSuppressed(np: Pick<NowPlaying, "title" | "artist"> | null): boolean {
  if (!np || Date.now() >= suppression.until) return false;
  if (np.title.trim().toLowerCase() !== suppression.title) return true;
  const a = np.artist.trim().toLowerCase();
  const b = suppression.artist;
  if (!a || !b) return false; // artistless metadata — title match is our best signal
  return !(a.includes(b) || b.includes(a));
}

async function playTrackNow(t: { uri: string; title: string; artist: string }): Promise<string> {
  suppression.until = Date.now() + 6000;
  suppression.title = t.title.trim().toLowerCase();
  suppression.artist = t.artist.trim().toLowerCase();
  const result = await commands.playNow(t.uri);
  if (result !== "ok" && result !== "partial") {
    suppression.until = 0; // nothing landed — nothing to suppress
  }
  return result;
}

// ---- rows ----

function RowThumb({ url }: { url: string | null }) {
  return (
    <span className="grid h-[26px] w-[26px] shrink-0 place-items-center overflow-hidden rounded-md bg-surface-2 text-muted">
      {url ? (
        <img src={url} alt="" className="h-full w-full object-cover" draggable={false} />
      ) : (
        <MorphIcon name="note" size={13} />
      )}
    </span>
  );
}

function RowActionButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      // Out of the Tab order: the ROW is the keyboard stop (Enter/Delete/
      // arrows cover these actions) — tabbable duplicates would cost 2-3
      // stops per row across an infinite-scroll list.
      tabIndex={-1}
      // Never start a row drag from its own action buttons.
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className="grid h-[26px] w-[26px] shrink-0 place-items-center rounded-md text-fg opacity-0 [transition:opacity_140ms_var(--ease-out-tk),background-color_140ms_var(--ease-out-tk),scale_90ms_var(--ease-out-tk)] hover:bg-fg/10 active:scale-95 group-hover/row:opacity-100 group-focus-within/row:opacity-100"
    >
      {children}
    </button>
  );
}

/** Tiny inline glyphs for the row actions — one-off SVGs, not morph icons
 * (they never morph; the 3-stroke system is for glyphs that do). */
const PlusGlyph = (
  <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" aria-hidden>
    <path d="M 8,3.4 L 8,12.6" />
    <path d="M 3.4,8 L 12.6,8" />
  </svg>
);
const CrossGlyph = (
  <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" aria-hidden>
    <path d="M 4.2,4.2 L 11.8,11.8" />
    <path d="M 11.8,4.2 L 4.2,11.8" />
  </svg>
);
const GripGlyph = (
  <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden>
    <path d="M 3.5,5.5 L 12.5,5.5" />
    <path d="M 3.5,10.5 L 12.5,10.5" />
  </svg>
);
const PlayGlyph = (
  <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M 5.4,3.4 L 5.4,12.6" />
    <path d="M 5.4,3.4 L 13,8 L 5.4,12.6" />
  </svg>
);

const QueueRowBase = function QueueRow({
  track,
  index,
  dragging,
  dragDy,
  flash,
  onDragStart,
  onRemove,
  onKeyDown,
}: {
  track: QueueTrack;
  index: number;
  dragging: boolean;
  dragDy: number;
  flash: boolean;
  onDragStart: (e: React.PointerEvent, index: number) => void;
  onRemove: (uri: string) => void;
  onKeyDown: (e: React.KeyboardEvent, index: number) => void;
}) {
  return (
    <div
      role="listitem"
      tabIndex={0}
      aria-label={`${track.title} — ${track.artist}`}
      aria-keyshortcuts="ArrowUp ArrowDown Delete"
      onPointerDown={(e) => onDragStart(e, index)}
      onKeyDown={(e) => onKeyDown(e, index)}
      className={`group/row relative flex h-[44px] cursor-grab touch-none select-none items-center gap-2.5 rounded-md px-2 ${
        dragging
          ? "z-10 bg-surface-2 shadow-lg shadow-black/40"
          : "z-0 [transition:transform_140ms_var(--ease-out-tk),background-color_600ms_var(--ease-out-tk)] hover:bg-fg/5"
      } ${flash && !dragging ? "bg-accent/15" : ""}`}
      style={dragging ? { transform: `translateY(${dragDy}px)` } : undefined}
    >
      <RowThumb url={track.art_url} />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-xs font-medium text-fg">{track.title}</span>
        <span className="truncate text-[11px] text-muted">{track.artist}</span>
      </span>
      <span
        aria-hidden
        className="grid h-[26px] w-[18px] shrink-0 place-items-center text-muted opacity-0 transition-opacity duration-2 ease-out-tk group-hover/row:opacity-100 group-focus-within/row:opacity-100"
      >
        {GripGlyph}
      </span>
      <RowActionButton label="Remove from queue" onClick={() => onRemove(track.uri)}>
        {CrossGlyph}
      </RowActionButton>
    </div>
  );
};
const QueueRow = memo(QueueRowBase);

const HistoryRowBase = function HistoryRow({
  entry,
  actionable,
  onPlayNow,
  onAdd,
  onGhostStart,
  onKeyDown,
}: {
  entry: HistoryEntry;
  /** uri known AND Spotify connected — play-now/+/drag all need the uri. */
  actionable: boolean;
  onPlayNow: (e: HistoryEntry) => void;
  onAdd: (e: HistoryEntry) => void;
  onGhostStart: (ev: React.PointerEvent, e: HistoryEntry) => void;
  onKeyDown: (ev: React.KeyboardEvent, e: HistoryEntry) => void;
}) {
  const thumb = useThumb(entry.key);
  return (
    <div
      role="listitem"
      tabIndex={0}
      aria-label={`${entry.title} — ${entry.artist}`}
      aria-keyshortcuts={actionable ? "Enter" : undefined}
      onPointerDown={actionable ? (ev) => onGhostStart(ev, entry) : undefined}
      onKeyDown={(ev) => onKeyDown(ev, entry)}
      className={`group/row flex h-[44px] select-none items-center gap-2.5 rounded-md px-2 [transition:background-color_140ms_var(--ease-out-tk)] hover:bg-fg/5 ${
        actionable ? "cursor-grab touch-none" : ""
      }`}
    >
      <RowThumb url={thumb} />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-xs font-medium text-fg">{entry.title}</span>
        <span className="truncate text-[11px] text-muted">{entry.artist}</span>
      </span>
      {actionable && (
        <>
          <RowActionButton label="Play now" onClick={() => onPlayNow(entry)}>
            {PlayGlyph}
          </RowActionButton>
          <RowActionButton label="Add to queue" onClick={() => onAdd(entry)}>
            {PlusGlyph}
          </RowActionButton>
        </>
      )}
    </div>
  );
};
const HistoryRow = memo(HistoryRowBase);

// ---- the shared panel (both garments render this) ----

function historyToTrack(e: HistoryEntry): QueueTrack | null {
  if (!e.spotify_uri) return null;
  return {
    uri: e.spotify_uri,
    title: e.title,
    artist: e.artist,
    album: e.album,
    duration_ms: e.duration_ms,
    art_url: null,
  };
}

type Ghost = { x: number; y: number; entry: HistoryEntry; over: boolean };

/** Search-resolved uris for entries logged before enrichment ran (v0.6.0
 * history, Apple Music listens). One resolve per track key per session;
 * null = Spotify had no match (cached too — no retry storm on hover-spam). */
const uriCache = new Map<string, string | null>();

/** The actionable form of a history entry: its enriched uri, a cached or
 * fresh search resolution, or null when Spotify can't find it. */
async function resolveTrack(entry: HistoryEntry): Promise<QueueTrack | null> {
  const direct = historyToTrack(entry);
  if (direct) return direct;
  let uri: string | null;
  const cached = uriCache.get(entry.key);
  if (cached !== undefined) {
    uri = cached;
  } else {
    uri = await commands.spotifyResolveUri(entry.title, entry.artist);
    uriCache.set(entry.key, uri);
  }
  return uri
    ? {
        uri,
        title: entry.title,
        artist: entry.artist,
        album: entry.album,
        duration_ms: entry.duration_ms,
        art_url: null,
      }
    : null;
}

export function QueuePanel({
  np,
  connected,
  open,
}: {
  np: NowPlaying | null;
  connected: boolean;
  /** The history feed activates on first open; rows stay mounted after. */
  open: boolean;
}) {
  const upnext = useUpNext();
  const { entries, loadMore, exhausted } = useHistoryFeed(open);
  const spotifyActive = np?.player === "spotify";
  const queueLive = connected && spotifyActive;

  // Quiet chip feedback (sentence case, middots, no exclamation marks).
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<number | null>(null);
  const showToast = (msg: string) => {
    setToast(msg);
    if (toastTimer.current !== null) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 1600);
  };
  useEffect(
    () => () => {
      if (toastTimer.current !== null) window.clearTimeout(toastTimer.current);
    },
    [],
  );

  // Newly-queued flash (900ms accent wash, fades on the 600ms bg transition).
  const [flashUri, setFlashUri] = useState<string | null>(null);
  const flashTimer = useRef<number | null>(null);
  const flash = (uri: string) => {
    setFlashUri(uri);
    if (flashTimer.current !== null) window.clearTimeout(flashTimer.current);
    flashTimer.current = window.setTimeout(() => setFlashUri(null), 900);
  };

  const addToQueue = (t: QueueTrack, at?: number) => {
    commands.upnextAdd(t, at);
    flash(t.uri);
    showToast(`Queued · ${t.title}`);
  };
  const playNow = (t: { uri: string; title: string; artist: string }) => {
    showToast(`Playing · ${t.title}`);
    void playTrackNow(t).then((r) => {
      if (r === "diverged" || r === "gone") showToast("Queue moved on — try again");
      else if (r === "partial") showToast("Played — some items couldn't re-queue");
      else if (r === "no_playback") showToast("Start playing something first");
      else if (r === "busy") showToast("Still landing the last jump");
      else if (r === "offline" || r === "disconnected") showToast("Spotify unreachable");
    });
  };

  // ---- queue reorder drag (translateY follow + live swap, the 11a spec) ----
  const [drag, setDrag] = useState<{ index: number; dy: number } | null>(null);
  const [order, setOrder] = useState<QueueTrack[] | null>(null); // drag overlay
  const rows = order ?? upnext;
  const upnextRef = useRef(upnext);
  upnextRef.current = upnext;
  // Active drag teardown — runs on unmount (the panel can die mid-drag: AM
  // session vanish flips `nothing`, conceal hides the window) so the window
  // listeners never leak and never fire against a dead component.
  const dragTeardown = useRef<(() => void) | null>(null);
  useEffect(
    () => () => {
      dragTeardown.current?.();
    },
    [],
  );

  const onQueueDragStart = (e: React.PointerEvent, index: number) => {
    if (e.button !== 0) return;
    e.preventDefault();
    try {
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    } catch {
      // Pointer already gone — the window listeners below still track it
      // (the ProgressBar precedent).
    }
    // Closure-local drag math (no state-updater side effects — StrictMode
    // double-invokes updaters); state only mirrors it for rendering.
    const startY = e.clientY;
    let y0 = startY;
    let i = index;
    let dy = 0;
    let armed = false; // 4px slop: a plain click must not flash drag chrome
    let list: QueueTrack[] = [];
    const move = (ev: PointerEvent) => {
      if (!armed) {
        if (Math.abs(ev.clientY - startY) < 4) return;
        armed = true;
        list = [...upnextRef.current];
        setOrder(list);
      }
      dy = ev.clientY - y0;
      let moved = false;
      while (dy > SWAP_AT && i < list.length - 1) {
        [list[i], list[i + 1]] = [list[i + 1], list[i]];
        i++;
        y0 += ROW_H;
        dy -= ROW_H;
        moved = true;
      }
      while (dy < -SWAP_AT && i > 0) {
        [list[i], list[i - 1]] = [list[i - 1], list[i]];
        i--;
        y0 -= ROW_H;
        dy += ROW_H;
        moved = true;
      }
      if (moved) setOrder([...list]);
      setDrag({ index: i, dy });
    };
    const finish = (commit: boolean) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      dragTeardown.current = null;
      if (!armed) return;
      if (commit && i !== index) commands.upnextMove(index, i);
      setDrag(null);
      // Hold the overlay one tick so the committed order's event replaces it
      // without a flash of the pre-drag order.
      window.setTimeout(() => setOrder(null), 50);
    };
    const up = () => finish(true);
    const cancel = () => finish(false);
    dragTeardown.current = cancel;
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
  };

  const onQueueKeyDown = (e: React.KeyboardEvent, index: number) => {
    if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      commands.upnextRemove(rows[index].uri);
    } else if (e.key === "ArrowUp" && index > 0) {
      e.preventDefault();
      commands.upnextMove(index, index - 1);
    } else if (e.key === "ArrowDown" && index < rows.length - 1) {
      e.preventDefault();
      commands.upnextMove(index, index + 1);
    }
  };

  // ---- history → queue ghost drag ----
  const zoneRef = useRef<HTMLDivElement>(null);
  const [ghost, setGhost] = useState<Ghost | null>(null);
  const ghostTeardown = useRef<(() => void) | null>(null);
  useEffect(
    () => () => {
      ghostTeardown.current?.();
    },
    [],
  );
  // Queue a history entry, resolving its uri first when it wasn't enriched
  // (pre-v0.6.1 entries, Apple Music listens). Fire-and-forget; misses toast.
  const addResolved = (entry: HistoryEntry, at?: number) => {
    void resolveTrack(entry).then((t) => {
      if (t) addToQueue(t, at);
      else showToast("Couldn't find it on Spotify");
    });
  };
  const playResolved = (entry: HistoryEntry) => {
    void resolveTrack(entry).then((t) => {
      if (t) playNow(t);
      else showToast("Couldn't find it on Spotify");
    });
  };

  const onGhostStart = (e: React.PointerEvent, entry: HistoryEntry) => {
    if (e.button !== 0) return;
    e.preventDefault();
    try {
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    } catch {
      // Pointer already gone — window listeners still track it.
    }
    let started = false;
    const startY = e.clientY;
    const overZone = (ev: PointerEvent) => {
      const r = zoneRef.current?.getBoundingClientRect();
      return !!(
        r &&
        r.width > 0 &&
        ev.clientX >= r.left &&
        ev.clientX <= r.right &&
        ev.clientY >= r.top &&
        ev.clientY <= r.bottom
      );
    };
    const move = (ev: PointerEvent) => {
      // A ghost is a drag, not a click — arm it only past a small slop.
      if (!started && Math.abs(ev.clientY - startY) < 4) return;
      started = true;
      setGhost({ x: ev.clientX, y: ev.clientY, entry, over: overZone(ev) });
    };
    const finish = (ev: PointerEvent | null) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      ghostTeardown.current = null;
      setGhost(null);
      if (!ev || !started || !overZone(ev)) return;
      const r = zoneRef.current!.getBoundingClientRect();
      const at = Math.max(
        0,
        Math.min(Math.round((ev.clientY - r.top - ROW_H / 2) / ROW_H), upnextRef.current.length),
      );
      addResolved(entry, at);
    };
    const up = (ev: PointerEvent) => finish(ev);
    const cancel = () => finish(null);
    ghostTeardown.current = cancel;
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
  };

  const onHistoryKeyDown = (e: React.KeyboardEvent, entry: HistoryEntry) => {
    if (e.key === "Enter" && queueLive) {
      e.preventDefault();
      addResolved(entry);
    }
  };

  // Infinite scroll: page when the scroll bottom nears.
  const scrollRef = useRef<HTMLDivElement>(null);
  const onScroll = () => {
    const el = scrollRef.current;
    if (el && el.scrollTop + el.clientHeight > el.scrollHeight - 120) loadMore();
  };

  const gateCaption = !connected
    ? "Queue works with Spotify — connect from the tray"
    : !spotifyActive
      ? "Queue works while Spotify is playing"
      : null;

  return (
    <div
      ref={scrollRef}
      onScroll={onScroll}
      className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto overscroll-contain [scrollbar-width:none]"
    >
      <div className="flex items-center gap-1.5 px-2 pb-0.5 pt-1.5">
        <span className="text-[10px] uppercase tracking-widest text-muted">
          Up next{rows.length > 0 && ` · ${rows.length}`}
        </span>
        <span className="text-[10px] text-muted/60">
          {queueLive ? "Spotify · drag to reorder" : "Spotify"}
        </span>
        {/* aria-live chip: quiet feedback for queue/play actions. */}
        <span aria-live="polite" className="ml-auto min-w-0 truncate text-[10px] text-fg">
          {toast}
        </span>
      </div>
      {/* The gate NARRATES instead of hiding: Pulse's list persists across
          players/connection, and queued rows vanishing on an Apple Music
          switch would read as data loss. remove/reorder stay live (they're
          local ops); only feed/play depend on Spotify. */}
      {gateCaption && <p className="m-0 px-2 pb-1 text-xs text-muted">{gateCaption}</p>}
      <div
        ref={zoneRef}
        role="list"
        aria-label="Up next"
        className={`flex flex-col rounded-lg border [transition:border-color_140ms_var(--ease-out-tk),background-color_140ms_var(--ease-out-tk)] ${
          ghost?.over ? "border-accent/55 bg-accent/5" : "border-transparent"
        }`}
      >
        {rows.length === 0 && !gateCaption && (
          <p className="m-0 px-2 py-2 text-xs text-muted">
            Queue is empty — press + on a track below or drag one here.
          </p>
        )}
        {(() => {
          // Keys must survive reorders (an index-keyed row remounts on every
          // swap — killed the glide AND dropped keyboard focus mid-reorder);
          // uri + per-render occurrence keeps duplicates legal.
          const seen = new Map<string, number>();
          return rows.map((t, i) => {
            const n = seen.get(t.uri) ?? 0;
            seen.set(t.uri, n + 1);
            return (
              <QueueRow
                key={`${t.uri}#${n}`}
                track={t}
                index={i}
                dragging={drag?.index === i}
                dragDy={drag?.index === i ? drag.dy : 0}
                flash={flashUri === t.uri}
                onDragStart={onQueueDragStart}
                onRemove={(uri) => commands.upnextRemove(uri)}
                onKeyDown={onQueueKeyDown}
              />
            );
          });
        })()}
      </div>
      <div className="px-2 pb-0.5 pt-2.5">
        <span className="text-[10px] uppercase tracking-widest text-muted">Earlier</span>
      </div>
      <div role="list" aria-label="Earlier" className="flex flex-col">
        {entries.length === 0 && (
          <p className="m-0 px-2 py-2 text-xs text-muted">
            Tracks you play land here{exhausted ? "" : "…"}
          </p>
        )}
        {/* Actionable whenever the queue is live: rows without an enriched
            uri (pre-enrichment history, Apple Music listens) resolve by
            search on demand — the uri gate here was what left EVERY row
            actionless on first connect (nothing had been enriched yet), an
            unbootstrappable queue (Thien's live find, 2026-07-11). */}
        {entries.map((e) => (
          <HistoryRow
            key={`${e.key}:${e.started_at_ms}`}
            entry={e}
            actionable={queueLive}
            onPlayNow={playResolved}
            onAdd={(en) => addResolved(en)}
            onGhostStart={onGhostStart}
            onKeyDown={onHistoryKeyDown}
          />
        ))}
      </div>
      {/* Ghost chip — fixed within the (window-sized) webview, riding the
          cursor; pure decoration, the pointer handlers own the semantics. */}
      {ghost && (
        <div
          aria-hidden
          className="pointer-events-none fixed z-50 flex items-center gap-2 rounded-lg border border-border/15 bg-surface-2 py-1 pl-1.5 pr-3 shadow-xl shadow-black/50"
          style={{
            left: ghost.x + 10,
            top: ghost.y - 16,
            transform: ghost.over ? "scale(1.02)" : "scale(1)",
          }}
        >
          <span className="grid h-[22px] w-[22px] place-items-center overflow-hidden rounded-[5px] bg-surface text-muted">
            <MorphIcon name="note" size={11} />
          </span>
          <span className="whitespace-nowrap text-xs font-medium text-fg">{ghost.entry.title}</span>
          <span className="whitespace-nowrap text-[11px] text-muted">{ghost.entry.artist}</span>
        </div>
      )}
    </div>
  );
}
