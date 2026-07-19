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
import { useEffect, useRef, useState, type CSSProperties } from "react";
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
  tabIndex,
}: {
  label: string;
  onClick: () => void;
  muted?: boolean;
  chord?: string;
  // Roving tabindex: the active item is 0 (the menu's one Tab stop), the rest
  // -1 (arrow-reachable, not Tab-reachable). See WidgetMenu.
  tabIndex: number;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      tabIndex={tabIndex}
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
  // role=menu contract: the full ARIA menu pattern — a SINGLE Tab stop
  // (roving tabindex: only `active` is tabbable, the rest tabIndex=-1) with
  // the arrows / Home / End moving WITHIN it and Esc handled at the window
  // level (App). Without the roving tabindex every native <button> was its
  // own Tab stop, so Tab past the last item escaped the open menu behind the
  // dismiss scrim (audit A7-3). `active` seeds at 0, so the effect focuses
  // the first item on open; focus then follows the roving index.
  const [active, setActive] = useState(0);
  const itemCount = () =>
    menuRef.current?.querySelectorAll('[role="menuitem"]').length ?? 0;
  useEffect(() => {
    const items = menuRef.current
      ? Array.from(menuRef.current.querySelectorAll<HTMLElement>('[role="menuitem"]'))
      : [];
    items[active]?.focus();
  }, [active]);
  const onKeyDown = (e: React.KeyboardEvent) => {
    const n = itemCount();
    if (n === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => (i + 1) % n); // wrap
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => (i <= 0 ? n - 1 : i - 1)); // wrap
    } else if (e.key === "Home") {
      e.preventDefault();
      setActive(0);
    } else if (e.key === "End") {
      e.preventDefault();
      setActive(n - 1);
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
      {/* tabIndex indices = DOM order of [role="menuitem"] (Sep isn't one), so
          they must stay in sync with the roving `active` index above. */}
      <Item label="Preferences…" tabIndex={active === 0 ? 0 : -1} onClick={act(() => commands.openPrefs())} />
      {/* Ellipsis: opens the same prefs window "Preferences…" does. */}
      <Item label="Shortcuts…" tabIndex={active === 1 ? 0 : -1} onClick={act(() => commands.openPrefs("hotkeys"))} />
      <Item
        label={spotifyConnected ? "Disconnect Spotify" : "Connect Spotify"}
        tabIndex={active === 2 ? 0 : -1}
        onClick={act(() => (spotifyConnected ? commands.spotifyDisconnect() : commands.spotifyConnect()))}
      />
      <Sep />
      <Item label="Hide Palette" chord={showhideChord} tabIndex={active === 3 ? 0 : -1} onClick={act(() => commands.hideWidget())} />
      <Sep />
      <Item label="Quit Palette" muted tabIndex={active === 4 ? 0 : -1} onClick={act(() => commands.quitApp())} />
    </div>
  );
}
