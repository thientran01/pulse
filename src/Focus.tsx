/*
 * Focus mode (design "B1") — the fullscreen now-playing takeover, in its
 * own webview window (src-tauri/src/focus.rs; opened from the expanded
 * view's expand bracket, closed by Esc / the collapse control / Alt-F4).
 * ENGINEERING SKELETON: the surfaces, feeds, and entry/exit are real; the
 * visual composition (scale relationships, background treatment, the
 * visualizer's final form) belongs to the 3-design/3-judge panel.
 *
 * Two views on the expanded view's mic ⇄ note grammar:
 *   lyrics — hero header (art + title/artist) over the karaoke panel at
 *            the "focus" type scale; big-art fallback when nothing synced
 *   visualizer — the room-scale instrument (src/Visualizer.tsx), the one
 *            reactive surface of that view
 *
 * Realm notes: own onNowPlaying → posClock.ingest loop (posClock is
 * per-realm), own lyric fetch (disk cache makes the second fetch ~free),
 * own art + accent extraction (each window owns its document's --accent),
 * own initReactive vote (lib.rs's per-window map). The media loop and the
 * audio capture gate are widened backend-side to keep feeding this window
 * while the main widget hides behind it.
 */
import { useEffect, useRef, useState } from "react";
import { MorphIcon } from "./icons/MorphIcon";
import { commands, onNowPlaying } from "./lib/backend";
import { VOCAL_LEAD_MS } from "./lib/lrc";
import { extractAccent } from "./lib/palette";
import * as posClock from "./lib/posClock";
import { initReactive } from "./lib/reactive";
import { DUR, EASE } from "./lib/tokens";
import { LyricsPanel, lyricsKeyOf, useLyrics } from "./LyricsPanel";
import { SeparatorDot, Waveform } from "./Waveform";
import { Visualizer } from "./Visualizer";
import type { NowPlaying } from "./types";

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

function readViewPref(): "lyrics" | "visualizer" {
  try {
    return localStorage.getItem("pulse.focusView") === "visualizer" ? "visualizer" : "lyrics";
  } catch {
    return "lyrics";
  }
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

  const [view, setView] = useState<"lyrics" | "visualizer">(readViewPref);
  const toggleView = () => {
    setView((v) => {
      const next = v === "lyrics" ? "visualizer" : "lyrics";
      try {
        localStorage.setItem("pulse.focusView", next);
      } catch {
        // non-fatal: the preference resets next open
      }
      return next;
    });
  };

  // Esc closes — window-level so it works from anywhere in the view.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") commands.focusClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const seekable = !!np?.can_seek;
  const lyricsLive =
    lyrics.status === "synced" && np !== null && lyrics.key === lyricsKeyOf(np);
  const nothing = !np || np.player === "none";

  return (
    // Opaque room — the takeover owns the screen; chrome stays neutral.
    <div className="group/focus relative flex h-screen w-screen flex-col overflow-hidden bg-surface text-fg">
      {/* Corner controls: view toggle + collapse, the widget's hover-reveal
          contract (plain CSS hover is safe here — this window never goes
          click-through) PLUS the has-[:focus-visible] reveal: the buttons
          stay in the tab order, and a hover-only reveal strands keyboard
          users on invisible controls (the widget's own 2026-07-08 catch).
          Collapse = the contract-bracket verb, going home. */}
      <div className="pointer-events-none absolute right-4 top-4 z-10 flex gap-1 opacity-0 transition-opacity duration-2 ease-out-tk group-hover/focus:pointer-events-auto group-hover/focus:opacity-100 has-[:focus-visible]:pointer-events-auto has-[:focus-visible]:opacity-100">
        <button
          type="button"
          aria-label={view === "lyrics" ? "Show visualizer" : "Show lyrics"}
          title={view === "lyrics" ? "Show visualizer" : "Show lyrics"}
          onClick={toggleView}
          className="grid h-8 w-8 place-items-center rounded-md text-fg [transition:background-color_140ms_var(--ease-out-tk),scale_90ms_var(--ease-out-tk)] hover:bg-fg/10 active:scale-95"
        >
          <MorphIcon
            name={view === "lyrics" ? "note" : "mic"}
            size={15}
            slot="focus-view"
            dur={DUR[3]}
            ease={EASE.inOut}
          />
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
      ) : view === "visualizer" ? (
        <div className="relative h-full w-full">
          <Visualizer />
          {/* Quiet identity anchor — bottom-left, out of the instrument's way. */}
          <div className="absolute bottom-8 left-10 max-w-[40%]">
            <p className="truncate text-xl font-medium text-fg">{np.title}</p>
            <p className="truncate text-base text-muted">
              {np.artist}
              {np.album && <SeparatorDot />}
              {np.album}
            </p>
          </div>
        </div>
      ) : lyricsLive ? (
        <div className="mx-auto flex h-full w-full max-w-4xl flex-col px-10 py-12">
          <div className="flex items-center gap-5 pb-6 pr-20">
            {artUrl && (
              <img
                src={artUrl}
                alt=""
                width={96}
                height={96}
                className="h-24 w-24 rounded-xl object-cover"
              />
            )}
            <div className="min-w-0 flex-1">
              <div className="flex min-w-0 items-center">
                <p className="min-w-0 truncate text-3xl font-medium text-fg">{np.title}</p>
                <span className="ml-2 flex shrink-0 items-center">
                  <Waveform size="md" trailing />
                </span>
              </div>
              <p className="truncate text-lg text-muted">
                {np.artist}
                {np.album && <SeparatorDot />}
                {np.album}
              </p>
            </div>
          </div>
          <LyricsPanel
            lines={lyrics.lines}
            seekable={seekable}
            leadMs={VOCAL_LEAD_MS[np.player]}
            scale="focus"
          />
        </div>
      ) : (
        // No synced lyrics: the hero-art room. The art never moves; the
        // living separator is this view's one reactive surface.
        <div className="flex h-full w-full flex-col items-center justify-center gap-8">
          {artUrl && (
            <img
              src={artUrl}
              alt=""
              width={420}
              height={420}
              className="h-[420px] w-[420px] rounded-2xl object-cover"
            />
          )}
          <div className="min-w-0 max-w-[70%] text-center">
            <p className="truncate text-3xl font-medium text-fg">{np.title}</p>
            <p className="truncate text-lg text-muted">
              {np.artist}
              {np.album && <SeparatorDot />}
              {np.album}
            </p>
          </div>
          <Waveform size="lg" />
        </div>
      )}
    </div>
  );
}
