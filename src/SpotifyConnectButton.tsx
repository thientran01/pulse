/*
 * The one in-place "Connect Spotify" control — used by the first-run bubble and
 * every gated Spotify surface (up-next, Search). It runs the real OAuth flow in
 * place (idle → Connecting… → Connected ✓) and IS the in-app OAuth-failure
 * surface (subscribing "spotify-auth-error"), so a stranger who clicks Connect
 * learns why it failed here instead of only via a tray-label flip.
 *
 * Monochrome per doctrine — a neutral ghost button, no accent (accent stays a
 * flourish; the connected DOT in Connectors/Prefs is the app's Spotify accent,
 * not this button).
 */
import { useEffect, useState } from "react";
import { commands, onSpotifyAuthError, onSpotifyStatus } from "./lib/backend";

type State = "idle" | "connecting" | "connected" | "error";

function SpotifyGlyph() {
  return (
    <span className="grid h-[14px] w-[14px] place-items-center">
      <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
        <circle cx="8" cy="8" r="6" />
        <path d="M 4.4,6.2 C 6.8,5.4 9.4,5.6 11.4,6.8" />
        <path d="M 5,8.5 C 6.9,7.9 8.9,8.1 10.5,9.1" />
        <path d="M 5.6,10.6 C 7,10.2 8.5,10.3 9.7,11" />
      </svg>
    </span>
  );
}

export function SpotifyConnectButton({
  label = "Connect Spotify",
  className = "",
}: {
  label?: string;
  className?: string;
}) {
  const [state, setState] = useState<State>("idle");
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(
    () =>
      onSpotifyStatus((s) => {
        if (s.connected) {
          setState("connected");
          setMsg(null);
        } else {
          // Revert a stale "Connected ✓" (disabled) if the session drops while
          // this instance stays mounted — the un-gated bubble button; the gated
          // ones unmount on connect. Leave a live "connecting" alone.
          setState((prev) => (prev === "connected" ? "idle" : prev));
        }
      }),
    [],
  );
  useEffect(
    () =>
      onSpotifyAuthError((m) => {
        setState("error");
        setMsg(m);
      }),
    [],
  );

  const busy = state === "connecting" || state === "connected";
  const onClick = () => {
    if (busy) return;
    setState("connecting");
    setMsg(null);
    commands.spotifyConnect();
  };
  const text =
    state === "connecting" ? "Connecting…" : state === "connected" ? "Connected ✓" : label;

  return (
    <span className="inline-flex flex-col items-start gap-1">
      <button
        type="button"
        onClick={onClick}
        disabled={busy}
        className={`inline-flex h-[30px] shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg border border-border/[0.14] bg-fg/[0.05] px-3 text-[12px] font-medium text-fg [transition:background-color_var(--transition-duration-2)] hover:bg-fg/[0.08] disabled:opacity-60 ${className}`}
      >
        <SpotifyGlyph />
        {text}
      </button>
      {state === "error" && msg && (
        <span aria-live="polite" className="text-[11px]" style={{ color: "rgb(214,142,116)" }}>
          {msg}
        </span>
      )}
    </span>
  );
}
