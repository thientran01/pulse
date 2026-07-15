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
import type { CSSProperties } from "react";
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
      className={`flex w-full items-center gap-3 rounded-md px-2.5 py-1.5 text-left text-[12.5px] [transition:background-color_var(--transition-duration-2)] hover:bg-fg/[0.08] ${
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
  return (
    <div
      role="menu"
      onMouseDown={(e) => e.stopPropagation()}
      className="absolute z-40 w-[204px] rounded-[10px] border border-border/[0.11] bg-surface-2 p-1.5 shadow-xl shadow-black/50"
      style={style}
    >
      <Item label="Preferences…" onClick={act(() => commands.openPrefs())} />
      <Item label="Shortcuts" onClick={act(() => commands.openPrefs("hotkeys"))} />
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
