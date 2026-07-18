/*
 * The widget's right-click context menu — the widget-native settings entry
 * (the tray is the always-there anchor; this is the fast in-place path). App
 * suppresses the WebView2 native menu and captures the cursor point; the menu
 * is cursor-anchored but App grows it toward the window interior (away from the
 * docked screen edge) so it can't clip. Dark tray-style surface, monochrome.
 *
 * While it's open App unions the hit rect to the whole window and paints the
 * dismiss scrim, so a click-away lands (the click-through gutter would swallow
 * it otherwise) and never starts a window drag.
 */
import { useEffect, useRef, type CSSProperties } from "react";
import { commands } from "./lib/backend";
import { Keycaps } from "./Keycaps";

/** Box dims (mirror the w-[204px] class + ~5 items) so App can clamp the
 * cursor-anchored position to keep the whole menu inside the fixed window. */
export const WIDGET_MENU_W = 204;
export const WIDGET_MENU_H = 200;

function Item({
  label,
  onClick,
  muted,
  chord,
}: {
  label: string;
  onClick: () => void;
  muted?: boolean;
  chord?: string;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      // active deepen, not scale: press feedback for a full-width text row
      // (a scale would wobble the label); rides the existing bg transition.
      className={`flex w-full items-center gap-3 rounded-md px-2.5 py-1.5 text-left text-[12.5px] [transition:background-color_var(--transition-duration-2)_var(--ease-out-tk)] hover:bg-fg/[0.08] active:bg-fg/[0.12] ${
        muted ? "text-muted" : "text-fg"
      }`}
    >
      <span className="flex-1">{label}</span>
      {chord && <Keycaps chord={chord} size="sm" />}
    </button>
  );
}

function Sep() {
  return <div className="mx-1.5 my-1 h-px bg-border/[0.08]" />;
}

export function WidgetMenu({
  style,
  spotifyConnected,
  showhideChord,
  onClose,
}: {
  style: CSSProperties;
  spotifyConnected: boolean;
  showhideChord: string;
  onClose: () => void;
}) {
  const act = (fn: () => void) => () => {
    fn();
    onClose();
  };
  const menuRef = useRef<HTMLDivElement>(null);
  // role=menu contract: focus the first item on open and rove focus with the
  // arrows / Home / End (Esc is App's, wired at the window level). Without
  // this the menu advertised menu semantics with ZERO keyboard behavior
  // (audit A7-3). Items are native <button> stops; focus is driven
  // imperatively so Item needn't forward a ref.
  useEffect(() => {
    menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
  }, []);
  const onKeyDown = (e: React.KeyboardEvent) => {
    const items = menuRef.current
      ? Array.from(menuRef.current.querySelectorAll<HTMLElement>('[role="menuitem"]'))
      : [];
    if (items.length === 0) return;
    const i = items.indexOf(document.activeElement as HTMLElement);
    if (e.key === "ArrowDown") {
      e.preventDefault();
      items[(i + 1) % items.length].focus(); // wrap; i=-1 → first
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      items[i <= 0 ? items.length - 1 : i - 1].focus(); // wrap; i≤0 → last
    } else if (e.key === "Home") {
      e.preventDefault();
      items[0].focus();
    } else if (e.key === "End") {
      e.preventDefault();
      items[items.length - 1].focus();
    }
  };
  return (
    <div
      role="menu"
      ref={menuRef}
      onKeyDown={onKeyDown}
      onMouseDown={(e) => e.stopPropagation()}
      // The popover recipe verbatim (rounded-xl border-border/10 shadow-xl
      // shadow-black/40, App.tsx) — this menu had drifted into a third
      // floating-surface recipe (10px/0.11/black-50). caption-in on mount =
      // the family's 140ms reveal (it copied the surface but entered at
      // 0ms); close stays instant — dismissing menus don't linger.
      className="absolute z-40 w-[204px] animate-[caption-in_140ms_var(--ease-out-tk)_both] rounded-xl border border-border/10 bg-surface-2 p-1.5 shadow-xl shadow-black/40"
      style={style}
    >
      <Item label="Preferences…" onClick={act(() => commands.openPrefs())} />
      {/* Ellipsis: opens the same prefs window "Preferences…" does. */}
      <Item label="Shortcuts…" onClick={act(() => commands.openPrefs("hotkeys"))} />
      <Item
        label={spotifyConnected ? "Disconnect Spotify" : "Connect Spotify"}
        onClick={act(() => (spotifyConnected ? commands.spotifyDisconnect() : commands.spotifyConnect()))}
      />
      <Sep />
      <Item label="Hide Palette" chord={showhideChord} onClick={act(() => commands.hideWidget())} />
      <Sep />
      <Item label="Quit Palette" muted onClick={act(() => commands.quitApp())} />
    </div>
  );
}
