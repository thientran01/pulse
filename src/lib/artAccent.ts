/*
 * Art → accent, per realm: each webview window owns its document's --accent
 * (the CSS var the whole accent layer paints with), extracted from the
 * current album art. Lifted from App.tsx/Focus.tsx's identical realm-local
 * copies when Search became the third realm needing them (the queue verb
 * flashing the SONG's color in the widget but the resting brand hue in
 * Search read as inconsistent — Thien, 2026-07-17; the accent layer's
 * grammar is "the playing song's color owns the accent surfaces", so every
 * window follows the song). The resting hue holds when nothing plays or a
 * cover has no extractable accent.
 */
import { useEffect, useRef, useState } from "react";
import { commands } from "./backend";
import { extractAccent } from "./palette";

/** Resolve an art_id to its data URL (null while unresolved/absent). Only
 * latches on success — a null (the cache already advanced past this id)
 * retries on the next payload instead of leaving the cover blank. */
export function useArt(artId: string | null): string | null {
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

/** Retint this document's accent layer from the current cover; the resting
 * accent when absent. */
export function useArtAccent(artUrl: string | null): void {
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
