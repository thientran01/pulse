/*
 * Accelerator → keycap display helpers, shared by the prefs Hotkeys section
 * (Prefs.tsx) and the widget's onboarding surfaces (the empty-state nudge and
 * the first-run bubble), so they render one identical keycap vocabulary.
 *
 * These are the pure DISPLAY helpers only — the capture-side keyboard mapping
 * (eventMods/mainKeyToken/MOD_CODES) stays in Prefs.tsx, since it's specific to
 * the rebind state machine.
 */
import type { HotkeyInfo } from "./backend";

const MOD_LABEL: Record<string, string> = { ctrl: "Ctrl", alt: "Alt", shift: "Shift", super: "Win" };
const KEY_LABEL: Record<string, string> = {
  left: "←",
  right: "→",
  up: "↑",
  down: "↓",
  space: "Space",
  enter: "Enter",
};

/** One accelerator token → its keycap glyph. */
export function tokenCap(t: string): string {
  if (MOD_LABEL[t]) return MOD_LABEL[t];
  if (KEY_LABEL[t]) return KEY_LABEL[t];
  if (/^f\d{1,2}$/.test(t)) return t.toUpperCase();
  return t.length === 1 ? t.toUpperCase() : t;
}

/** A Tauri accelerator ("ctrl+alt+k") → its keycaps (["Ctrl","Alt","K"]). */
export function chordCaps(chord: string): string[] {
  return chord ? chord.split("+").map(tokenCap) : [];
}

/** The live chord for a hotkey id ("showhide", "search"), or "" if absent.
 * Chords are rebindable, so onboarding copy must read the resolved table
 * rather than hardcode a default (which the handoff got backwards). */
export function chordById(hotkeys: HotkeyInfo[], id: string): string {
  return hotkeys.find((h) => h.id === id)?.chord ?? "";
}
