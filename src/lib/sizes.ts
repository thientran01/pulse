/*
 * The mode ladder's box constants — split out of App.tsx when main.tsx (the
 * entry) started importing WINDOW_MAX for the crash-fallback hit-rect widen:
 * a non-component export on App.tsx demotes the app's most-edited module
 * from a Fast Refresh boundary (mixed exports), turning every App edit into
 * a full page reload up through the entry. Values only, never behavior.
 */

export type Mode = "pill" | "card" | "expanded";

/** Each mode's FOOTPRINT (shell + gutter), in logical px. The native window
 * itself never resizes: it lives at WINDOW_MAX from birth (tauri.conf.json)
 * and every mode change is the shell's 200ms EASE.inOut CSS glide inside it,
 * clip-revealing the incoming mode's already-final ModeContent plane while
 * the content layers crossfade. (Resizing a WebView2 window at all costs one
 * wrong frame: per-frame animation shakes, a snap blinks — measured live
 * 2026-07-09/10.) These sizes still drive the shell/plane boxes and the
 * click-through hit rect (dock.rs). */
export const MODE_SIZES: Record<Mode, [number, number]> = {
  pill: [300, 48],
  card: [380, 132], // anchored-cluster handoff: 52px art row, full-width progress, bottom transport
  expanded: [380, 440], // lyrics home; big-art fallback gets breathing room
};

/** The window's permanent size = the largest mode. Keep in sync with
 * tauri.conf.json width/height (the window must be BORN at this size —
 * matching them means the launch dock is pure positioning, no resize, no
 * first-frame artifact). Consumers: App.tsx everywhere, main.tsx's
 * crash-fallback widen — never duplicate the numbers. */
export const WINDOW_MAX: [number, number] = MODE_SIZES.expanded;
