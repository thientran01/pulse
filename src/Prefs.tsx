/*
 * The preferences window (Milestone C) — a NORMAL 720×560 opaque, frameless,
 * non-resizable window (src-tauri/src/prefs.rs), not the widget's transparent
 * click-through model. Rebuilt from the design handoff (PulsePrefs.dc.html) on
 * the repo's house tokens + bundled Inter.
 *
 * Doctrine (hard rules, from CLAUDE.md + the handoff):
 * - Dark-only, monochrome chrome on semantic tokens (fg/muted on
 *   surface/surface-2).
 * - Accent (--accent, ember) appears in EXACTLY TWO places in this whole
 *   window: the live hotkey-capture ring and the Spotify "connected" dot.
 * - Toggles fill cream (--fg) when on, never accent.
 * - Warnings/conflicts use the desaturated rgb(214,142,116), never red-red,
 *   never accent.
 * - Motion on EASE/DUR tokens; the global reduced-motion kill (index.css)
 *   collapses every animation/transition here to instant.
 *
 * Hotkey capture reproduces the handoff's state machine: click a chord → the
 * row goes "listening" (accent ring) → modifiers collect live → a non-modifier
 * key WITH ≥1 modifier forms + auto-commits (persist + live re-register +
 * toast); no modifier → "Add a modifier"; a duplicate blocks and names the
 * clashing action; Esc/blur cancels. A chord that the OS rejects registers as
 * a persistent per-row "not registered" note.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  commands,
  onHotkeysChanged,
  onPrefsSection,
  onSettingsChanged,
  onSpotifyAuthError,
  onSpotifyStatus,
  type HotkeyInfo,
} from "./lib/backend";
import { chordCaps, tokenCap } from "./lib/chords";

const SECTIONS = ["connectors", "hotkeys", "playback", "general", "about", "data"] as const;
type Section = (typeof SECTIONS)[number];

// Desaturated warning literal (doctrine: never red-red, never accent). Not a
// token — used only for conflict/failure treatments here.
const WARN = "rgb(214,142,116)";
const WARN_TEXT = "rgb(240,205,192)";

const CAP_STYLE = `
@keyframes prefs-cap-listen {
  0%,100% { box-shadow: 0 0 0 0 rgb(var(--accent)/0.34); }
  50% { box-shadow: 0 0 0 4px rgb(var(--accent)/0); }
}
.prefs-cap-listen { animation: prefs-cap-listen 1.4s var(--ease-in-out-tk) infinite; }
.prefs-scroll::-webkit-scrollbar { width: 8px; }
.prefs-scroll::-webkit-scrollbar-thumb { background: rgb(var(--fg)/0.10); border-radius: 999px; }
`;

// ---- capture-side key mapping (display helpers moved to lib/chords.ts) ----

const MOD_CODES = new Set([
  "ControlLeft",
  "ControlRight",
  "AltLeft",
  "AltRight",
  "ShiftLeft",
  "ShiftRight",
  "MetaLeft",
  "MetaRight",
  "OSLeft",
  "OSRight",
]);

/** Live modifiers, in the canonical order Tauri parses. */
function eventMods(e: KeyboardEvent): string[] {
  const m: string[] = [];
  if (e.ctrlKey) m.push("ctrl");
  if (e.altKey) m.push("alt");
  if (e.shiftKey) m.push("shift");
  if (e.metaKey) m.push("super");
  return m;
}

/** The non-modifier key as a Tauri accelerator token, or null if it isn't one
 * we support (keyed off e.code so it's layout- and modifier-independent). */
function mainKeyToken(e: KeyboardEvent): string | null {
  const c = e.code;
  let m: RegExpExecArray | null;
  if ((m = /^Key([A-Z])$/.exec(c))) return m[1].toLowerCase();
  if ((m = /^Digit(\d)$/.exec(c))) return m[1];
  if ((m = /^F(\d{1,2})$/.exec(c))) return `f${m[1]}`;
  switch (c) {
    case "ArrowLeft":
      return "left";
    case "ArrowRight":
      return "right";
    case "ArrowUp":
      return "up";
    case "ArrowDown":
      return "down";
    case "Space":
      return "space";
    case "Enter":
      return "enter";
    default:
      return null;
  }
}

type Capture = { id: string; live: string[]; conflict: string | null; needMod: boolean };

// ---- small building blocks ----------------------------------------------

function SectionHeader({ title, desc }: { title: string; desc: string }) {
  return (
    <>
      <p className="text-[18px] font-semibold text-fg">{title}</p>
      <p className="mt-1 mb-6 text-[13px] text-muted">{desc}</p>
    </>
  );
}

/** A settings row: label + description on the left, control on the right. */
function Row({
  label,
  desc,
  last,
  children,
}: {
  label: string;
  desc: string;
  last?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div
      className={`flex items-center gap-4 px-1 py-3.5 ${last ? "" : "border-b border-border/[0.06]"}`}
    >
      <div className="min-w-0 flex-1">
        <p className="text-[13.5px] text-fg">{label}</p>
        <p className="mt-0.5 text-[12px] text-muted">{desc}</p>
      </div>
      {children}
    </div>
  );
}

/** Cream-fill toggle (doctrine: ON = --fg, never accent). */
function Toggle({ on, onClick, label }: { on: boolean; onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      onClick={onClick}
      className={`relative h-[22px] w-[38px] shrink-0 rounded-full [transition:background-color_var(--transition-duration-2)_var(--ease-out-tk)] ${
        on ? "bg-fg" : "bg-fg/15"
      }`}
    >
      <span
        className={`absolute left-[2px] top-[2px] h-[18px] w-[18px] rounded-full [transition:transform_var(--transition-duration-2)_var(--ease-out-tk),background-color_var(--transition-duration-2)] ${
          on ? "translate-x-[16px] bg-surface" : "bg-muted"
        }`}
      />
    </button>
  );
}

/** A segmented control (launch mode). Selected = fg/12 fill. */
function Segmented<T extends string | number>({
  options,
  value,
  onPick,
}: {
  options: { label: string; value: T }[];
  value: T;
  onPick: (v: T) => void;
}) {
  return (
    <div className="inline-flex gap-0.5 rounded-[9px] border border-border/[0.07] bg-fg/[0.05] p-[3px]">
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={String(o.value)}
            type="button"
            onClick={() => onPick(o.value)}
            className={`rounded-[7px] px-3 py-[5px] text-[12px] font-medium [transition:background-color_var(--transition-duration-2),color_var(--transition-duration-2)] ${
              on ? "bg-fg/12 text-fg" : "text-muted hover:text-fg"
            }`}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/** Neutral ghost button — the window's one button shape. */
function Ghost({
  onClick,
  disabled,
  children,
}: {
  onClick?: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="inline-flex h-8 shrink-0 items-center whitespace-nowrap rounded-lg border border-border/12 bg-fg/[0.04] px-3.5 text-[12.5px] font-medium text-fg [transition:background-color_var(--transition-duration-2)] hover:bg-fg/[0.08] disabled:opacity-50"
    >
      {children}
    </button>
  );
}

// ---- nav icons (static, decorative — inline SVG per the handoff) ----------

const NAV_ICON: Record<Section, React.ReactNode> = {
  connectors: (
    <>
      <path d="M 6.2,9.8 L 9.8,6.2" />
      <path d="M 8.4,4.6 C 9.7,3.3 11.4,3.6 12.4,4.6 C 13.4,5.6 13.4,7.2 12.2,8.4 L 11.2,9.4" />
      <path d="M 7.6,11.4 C 6.3,12.7 4.6,12.4 3.6,11.4 C 2.6,10.4 2.6,8.8 3.8,7.6 L 4.8,6.6" />
    </>
  ),
  hotkeys: (
    <>
      <rect x="2.4" y="4.8" width="11.2" height="6.4" rx="1.6" />
      <path d="M 5,8 L 5.02,8" />
      <path d="M 8,8 L 8.02,8" />
      <path d="M 11,8 L 11.02,8" />
    </>
  ),
  playback: (
    <>
      <path d="M 3,6 L 13,6" />
      <circle cx="6" cy="6" r="1.5" />
      <path d="M 3,10.5 L 13,10.5" />
      <circle cx="10" cy="10.5" r="1.5" />
    </>
  ),
  general: (
    <>
      <rect x="2.5" y="5.4" width="11" height="5.2" rx="2.6" />
      <circle cx="10.4" cy="8" r="1.7" />
    </>
  ),
  about: (
    <>
      <circle cx="8" cy="8" r="5.6" />
      <path d="M 8,7.6 L 8,10.8" />
      <path d="M 8,5.2 L 8.02,5.2" />
    </>
  ),
  data: (
    <>
      <path d="M 8,3 L 13,5.5 L 8,8 L 3,5.5 Z" />
      <path d="M 3,8.4 L 8,10.9 L 13,8.4" />
    </>
  ),
};

const NAV_LABEL: Record<Section, string> = {
  connectors: "Connectors",
  hotkeys: "Hotkeys",
  playback: "Playback",
  general: "General",
  about: "About",
  data: "Data",
};

function NavIcon({ section }: { section: Section }) {
  return (
    <span className="grid h-[18px] w-[18px] shrink-0 place-items-center">
      <svg
        viewBox="0 0 16 16"
        width="15"
        height="15"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {NAV_ICON[section]}
      </svg>
    </span>
  );
}

function WarnTriangle() {
  return (
    <span className="grid h-3 w-3 shrink-0 place-items-center">
      <svg
        viewBox="0 0 16 16"
        width="12"
        height="12"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M 8,2.6 L 14.2,13 L 1.8,13 Z" />
        <path d="M 8,6.6 L 8,9.4" />
        <path d="M 8,11.2 L 8.02,11.2" />
      </svg>
    </span>
  );
}

function CloseX({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      aria-label="Close preferences"
      onClick={onClick}
      className="absolute right-4 top-3.5 z-10 grid h-[30px] w-[30px] place-items-center rounded-lg text-muted [transition:background-color_var(--transition-duration-2),color_var(--transition-duration-2)] hover:bg-fg/[0.08] hover:text-fg"
    >
      <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
        <path d="M 4.5,4.5 L 11.5,11.5" />
        <path d="M 11.5,4.5 L 4.5,11.5" />
      </svg>
    </button>
  );
}

// ---- the window ----------------------------------------------------------

export default function Prefs() {
  const [section, setSection] = useState<Section>(() => {
    const s = new URLSearchParams(window.location.search).get("section");
    return s && (SECTIONS as readonly string[]).includes(s) ? (s as Section) : "connectors";
  });

  const [version, setVersion] = useState("");
  const [reactive, setReactive] = useState(true);
  const [launch, setLaunch] = useState("card");
  const [startLogin, setStartLogin] = useState(false);
  const [hideFs, setHideFs] = useState(true);
  const [seenIntro, setSeenIntro] = useState(false);

  const [spotifyConnected, setSpotifyConnected] = useState(false);
  const [spotifyName, setSpotifyName] = useState<string | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);

  const [lastfmKey, setLastfmKey] = useState("");
  const [testLabel, setTestLabel] = useState("Test key");

  const [hotkeys, setHotkeys] = useState<HotkeyInfo[]>([]);
  const [capture, setCapture] = useState<Capture | null>(null);

  const [introLabel, setIntroLabel] = useState("Show again");
  const [confirmClear, setConfirmClear] = useState(false);
  const [toastMsg, setToastMsg] = useState<string | null>(null);

  const toastTimer = useRef<number | undefined>(undefined);
  const toast = useCallback((msg: string) => {
    setToastMsg(msg);
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToastMsg(null), 1700);
  }, []);

  // Mount seed.
  useEffect(() => {
    let alive = true;
    void commands.prefsSeed().then((s) => {
      if (!alive) return;
      setVersion(s.version);
      setReactive(s.reactive_separator);
      setLaunch(s.launch_mode);
      setStartLogin(s.start_at_login);
      setHideFs(s.hide_on_fullscreen);
      setSeenIntro(s.seen_intro);
      setSpotifyConnected(s.spotify_connected);
      setLastfmKey(s.lastfm_api_key);
      setHotkeys(s.hotkeys);
    });
    return () => {
      alive = false;
    };
  }, []);

  // Live wiring: Spotify status, OAuth failure, hotkey table, tray mirror,
  // section nudges from an already-open window.
  useEffect(() => onSpotifyStatus((s) => setSpotifyConnected(s.connected)), []);
  useEffect(() => onSpotifyAuthError((m) => setAuthError(m)), []);
  useEffect(() => onHotkeysChanged((h) => setHotkeys(h)), []);
  useEffect(
    () =>
      onPrefsSection((s) => {
        if ((SECTIONS as readonly string[]).includes(s)) setSection(s as Section);
      }),
    [],
  );
  useEffect(
    () =>
      onSettingsChanged(({ key, value }) => {
        if (key === "start_at_login") setStartLogin(Boolean(value));
        else if (key === "companion") setHideFs(Boolean(value));
      }),
    [],
  );

  // Fetch the display name whenever the connection turns on; clear on off.
  useEffect(() => {
    if (!spotifyConnected) {
      setSpotifyName(null);
      return;
    }
    setAuthError(null);
    let alive = true;
    void commands.spotifyDisplayName().then((n) => {
      if (alive) setSpotifyName(n);
    });
    return () => {
      alive = false;
    };
  }, [spotifyConnected]);

  // ---- hotkey capture ----
  const captureRef = useRef<Capture | null>(capture);
  captureRef.current = capture;
  const hotkeysRef = useRef<HotkeyInfo[]>(hotkeys);
  hotkeysRef.current = hotkeys;

  const commitRebind = useCallback(
    (id: string, chord: string) => {
      setCapture(null);
      void commands.rebindHotkey(id, chord).then((fresh) => setHotkeys(fresh));
      toast("Shortcut updated");
    },
    [toast],
  );

  const onKey = useCallback(
    (e: KeyboardEvent) => {
      const cap = captureRef.current;
      if (!cap) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") {
        setCapture(null);
        return;
      }
      const mods = eventMods(e);
      if (MOD_CODES.has(e.code)) {
        setCapture({ ...cap, live: mods, conflict: null, needMod: false });
        return;
      }
      const main = mainKeyToken(e);
      if (!main) return; // unsupported key — keep listening
      if (mods.length === 0) {
        setCapture({ ...cap, live: [main], conflict: null, needMod: true });
        return;
      }
      const chord = [...mods, main].join("+");
      const clash = hotkeysRef.current.find((h) => h.id !== cap.id && h.chord === chord);
      if (clash) {
        setCapture({ ...cap, live: [...mods, main], conflict: clash.label, needMod: false });
        return;
      }
      commitRebind(cap.id, chord);
    },
    [commitRebind],
  );
  const onKeyRef = useRef(onKey);
  onKeyRef.current = onKey;

  const capturing = capture !== null;
  useEffect(() => {
    if (!capturing) return;
    const kd = (e: KeyboardEvent) => onKeyRef.current(e);
    const blur = () => setCapture(null);
    window.addEventListener("keydown", kd, true);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("keydown", kd, true);
      window.removeEventListener("blur", blur);
    };
  }, [capturing]);

  // ---- action handlers ----
  // Persist the Last.fm key debounced, but flush the pending value on blur, on
  // Test, and before close so a paste-then-close within the debounce window
  // isn't lost (the window destroys on close — no time for a late timer).
  const lastfmDebounce = useRef<number | undefined>(undefined);
  const lastfmPending = useRef<string | null>(null);
  const flushLastfm = useCallback(() => {
    if (lastfmPending.current === null) return;
    window.clearTimeout(lastfmDebounce.current);
    commands.setSetting("lastfm_api_key", lastfmPending.current);
    lastfmPending.current = null;
  }, []);
  const onLastfmInput = (v: string) => {
    setLastfmKey(v);
    setTestLabel("Test key");
    lastfmPending.current = v;
    window.clearTimeout(lastfmDebounce.current);
    lastfmDebounce.current = window.setTimeout(() => {
      commands.setSetting("lastfm_api_key", v);
      lastfmPending.current = null;
    }, 400);
  };
  const closePrefs = () => {
    flushLastfm();
    commands.closePrefs();
  };
  const testKey = async () => {
    flushLastfm();
    setTestLabel("Checking…");
    const r = await commands.testLastfmKey(lastfmKey);
    if (r === "ok") {
      setTestLabel("Valid ✓");
      toast("Last.fm key looks good");
    } else if (r === "invalid") {
      setTestLabel("Invalid key");
      toast("That key was rejected");
    } else {
      setTestLabel("Test key");
      toast("Couldn't reach Last.fm");
    }
  };

  const toggleSpotify = () => {
    if (spotifyConnected) {
      commands.spotifyDisconnect();
      toast("Disconnected");
    } else {
      setAuthError(null);
      commands.spotifyConnect();
      toast("Opening Spotify sign-in…");
    }
  };

  const toggleReactive = () => {
    const next = !reactive;
    setReactive(next);
    commands.setSetting("reactive_separator", next);
  };
  const pickLaunch = (v: string) => {
    setLaunch(v);
    commands.setSetting("launch_mode", v);
  };
  const toggleStartLogin = async () => {
    const next = !startLogin;
    setStartLogin(next);
    const actual = await commands.setStartAtLogin(next);
    setStartLogin(actual);
  };
  const toggleHideFs = () => {
    const next = !hideFs;
    setHideFs(next);
    commands.setHideOnFullscreen(next);
  };
  const showIntroAgain = () => {
    commands.setSetting("seenIntro", false);
    setSeenIntro(false);
    setIntroLabel("Will show next launch");
    toast("Welcome hint reset");
  };
  const checkUpdates = async () => {
    const r = await commands.checkForUpdates();
    if (r === "uptodate") toast("You're on the latest version");
    else if (r === "dev") toast("Update available (dev build — not installing)");
    else if (r === "busy") toast("Already checking…");
    else toast("Update check failed");
  };
  const doClear = async () => {
    setConfirmClear(false);
    await commands.clearHistory();
    toast("Play history cleared");
  };

  const resetHotkeys = () => {
    setCapture(null);
    void commands.resetHotkeys().then((fresh) => setHotkeys(fresh));
    toast("Shortcuts reset to defaults");
  };

  const spotifyBtnLabel = spotifyConnected ? "Disconnect" : "Connect";

  const detail = useMemo<Record<Section, React.ReactNode>>(
    () => ({
      connectors: (
        <>
          <SectionHeader
            title="Connectors"
            desc="Link the services that power lyrics, more-like-this, and playback control."
          />
          {/* Spotify */}
          <div className="mb-4 rounded-xl border border-border/[0.08] bg-fg/[0.015] p-4">
            <div className="flex items-center gap-3">
              <span className="grid h-[34px] w-[34px] shrink-0 place-items-center rounded-lg bg-surface-2 text-muted">
                <svg viewBox="0 0 16 16" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                  <circle cx="8" cy="8" r="6" />
                  <path d="M 4.4,6.2 C 6.8,5.4 9.4,5.6 11.4,6.8" />
                  <path d="M 5,8.5 C 6.9,7.9 8.9,8.1 10.5,9.1" />
                  <path d="M 5.6,10.6 C 7,10.2 8.5,10.3 9.7,11" />
                </svg>
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-[14px] font-medium text-fg">Spotify</p>
                <p className="mt-px flex items-center gap-1.5 text-[12px] text-muted">
                  {spotifyConnected ? (
                    <>
                      {/* Accent spot #1 of 2: the connected dot. */}
                      <span className="h-1.5 w-1.5 rounded-full bg-accent" />
                      Connected{spotifyName ? ` as ${spotifyName}` : ""}
                    </>
                  ) : (
                    <>
                      <span className="h-1.5 w-1.5 rounded-full bg-fg/25" />
                      Not connected
                    </>
                  )}
                </p>
              </div>
              <Ghost onClick={toggleSpotify}>{spotifyBtnLabel}</Ghost>
            </div>
            {authError && (
              <p
                className="mt-3 flex items-center gap-1.5 border-t border-border/[0.06] pt-3 text-[11.5px]"
                style={{ color: WARN }}
              >
                <WarnTriangle />
                {authError}
              </p>
            )}
            <p className="mt-3 border-t border-border/[0.06] pt-3 text-[11.5px] leading-relaxed text-fg/40">
              Development mode — connecting is limited to allow-listed accounts. Queue control and
              playback need this connection.
            </p>
          </div>
          {/* Last.fm */}
          <div className="rounded-xl border border-border/[0.08] bg-fg/[0.015] p-4">
            <div className="mb-3 flex items-center gap-3">
              <span className="grid h-[34px] w-[34px] shrink-0 place-items-center rounded-lg bg-surface-2 text-[15px] font-semibold text-muted">
                fm
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-[14px] font-medium text-fg">Last.fm</p>
                <p className="mt-px text-[12px] text-muted">Unlocks more-like-this recommendations.</p>
              </div>
            </div>
            <div className="flex gap-2">
              <input
                value={lastfmKey}
                onChange={(e) => onLastfmInput(e.target.value)}
                onBlur={flushLastfm}
                placeholder="API key"
                spellCheck={false}
                autoComplete="off"
                className="h-[34px] min-w-0 flex-1 select-text rounded-lg border border-border/12 bg-black/25 px-3 text-[12.5px] text-fg outline-none [transition:border-color_var(--transition-duration-2)] focus:border-border/30"
              />
              <Ghost onClick={testKey}>{testLabel}</Ghost>
            </div>
          </div>
        </>
      ),

      hotkeys: (
        <>
          {/* pr-10 keeps "Reset to defaults" clear of the detail pane's
              floating × (absolute top-right); it's the only section header
              with a right-aligned action. */}
          <div className="flex items-end justify-between pr-10">
            <p className="text-[18px] font-semibold text-fg">Hotkeys</p>
            <button
              type="button"
              onClick={resetHotkeys}
              className="rounded-md px-1.5 py-1 text-[12px] text-muted [transition:color_var(--transition-duration-2)] hover:text-fg"
            >
              Reset to defaults
            </button>
          </div>
          <p className="mt-1.5 mb-5 text-[13px] text-muted">
            Click a shortcut to rebind it. Global shortcuts work anywhere, even when Palette is hidden.
          </p>
          <div className="overflow-hidden rounded-xl border border-border/[0.08]">
            {hotkeys.map((h, i) => {
              const listening = capture?.id === h.id;
              const caps = listening ? capture.live.map(tokenCap) : chordCaps(h.chord);
              const conflict =
                listening && capture.conflict
                  ? `Already used by ${capture.conflict} — press a different combination.`
                  : listening && capture.needMod
                    ? "Add a modifier like Ctrl or Alt."
                    : null;
              const showNote = !listening && !h.registered;
              return (
                <div
                  key={h.id}
                  className={`${i === hotkeys.length - 1 ? "" : "border-b border-border/[0.06]"} ${
                    listening ? "bg-fg/[0.02]" : ""
                  }`}
                >
                  <div className="flex min-h-[52px] items-center gap-3 px-4 py-2">
                    <div className="min-w-0 flex-1">
                      <p className="text-[13.5px] text-fg">{h.label}</p>
                      {showNote && (
                        <p
                          className="mt-0.5 flex items-center gap-1.5 text-[11.5px]"
                          style={{ color: "rgba(214,142,116,0.9)" }}
                        >
                          <WarnTriangle />
                          Not registered — may be reserved by the system
                        </p>
                      )}
                    </div>
                    {listening ? (
                      // Accent spot #2 of 2: the live capture ring.
                      <div
                        className="prefs-cap-listen inline-flex items-center gap-2 rounded-lg border border-accent/50 bg-accent/[0.06] py-[5px] pl-3 pr-1.5"
                      >
                        {caps.length === 0 ? (
                          <span className="text-[12px] text-fg">Press keys…</span>
                        ) : (
                          caps.map((c, k) => (
                            <span
                              key={k}
                              className="inline-flex h-6 min-w-[22px] items-center justify-center rounded-md border border-border/[0.18] bg-fg/10 px-1.5 text-[11.5px] font-medium text-fg"
                            >
                              {c}
                            </span>
                          ))
                        )}
                        <button
                          type="button"
                          onClick={() => setCapture(null)}
                          className="grid h-6 place-items-center rounded-md bg-fg/[0.06] px-2 text-[10.5px] text-muted"
                        >
                          esc
                        </button>
                      </div>
                    ) : (
                      <button
                        type="button"
                        onClick={() => setCapture({ id: h.id, live: [], conflict: null, needMod: false })}
                        className="inline-flex items-center gap-1 rounded-md p-1 [transition:background-color_var(--transition-duration-2)] hover:bg-fg/[0.05]"
                      >
                        {caps.map((c, k) => (
                          <span
                            key={k}
                            className="inline-flex h-6 min-w-[22px] items-center justify-center rounded-md border border-border/[0.13] bg-fg/[0.07] px-1.5 text-[11.5px] font-medium text-fg"
                          >
                            {c}
                          </span>
                        ))}
                      </button>
                    )}
                  </div>
                  {conflict && (
                    <p className="px-4 pb-2.5 text-[11.5px]" style={{ color: WARN }}>
                      {conflict}
                    </p>
                  )}
                </div>
              );
            })}
          </div>
        </>
      ),

      playback: (
        <>
          <SectionHeader title="Playback" desc="How Palette behaves while music plays." />
          <Row
            label="Audio-reactive separator"
            desc="The waveform that pulses to the music. The only thing that moves on its own."
          >
            <Toggle on={reactive} onClick={toggleReactive} label="Audio-reactive separator" />
          </Row>
          <Row label="Default launch mode" desc="The size Palette opens at." last>
            <Segmented
              value={launch}
              onPick={pickLaunch}
              options={[
                { label: "Pill", value: "pill" },
                { label: "Card", value: "card" },
                { label: "Expanded", value: "expanded" },
              ]}
            />
          </Row>
        </>
      ),

      general: (
        <>
          <SectionHeader title="General" desc="System behavior and startup." />
          <Row label="Start at login" desc="Launch Palette when you sign in.">
            <Toggle on={startLogin} onClick={toggleStartLogin} label="Start at login" />
          </Row>
          <Row label="Hide on fullscreen" desc="Tuck away when another app goes fullscreen.">
            <Toggle on={hideFs} onClick={toggleHideFs} label="Hide on fullscreen" />
          </Row>
          <Row label="Welcome hint" desc="Show the first-run shortcuts card again." last>
            <Ghost onClick={showIntroAgain}>{introLabel}</Ghost>
          </Row>
        </>
      ),

      about: (
        <>
          <SectionHeader title="About" desc="Palette — the now-playing player Windows should've had." />
          <Row label="Version" desc={`${version || "…"} · up to date`}>
            <Ghost onClick={checkUpdates}>Check for updates</Ghost>
          </Row>
          <Row label="Source" desc="github.com/thientran01/palette">
            <Ghost onClick={() => commands.openRepo()}>Open repo</Ghost>
          </Row>
          <Row label="License" desc="MIT" last>
            <span />
          </Row>
        </>
      ),

      data: (
        <>
          <SectionHeader title="Data" desc="Everything Palette stores lives on your machine." />
          <Row label="Open logs" desc="Diagnostic output for troubleshooting.">
            <Ghost onClick={() => commands.openLogs()}>Open</Ghost>
          </Row>
          <Row label="Data folder" desc="Where history, thumbnails, and settings are kept.">
            <Ghost onClick={() => commands.openDataFolder()}>Reveal</Ghost>
          </Row>
          <div className="px-1 pb-1 pt-4">
            <div className="flex items-center">
              <div className="min-w-0 flex-1">
                <p className="text-[13.5px] text-fg">Clear play history</p>
                <p className="mt-0.5 text-[12px] text-muted">
                  Erases every logged track and its thumbnail. Can't be undone.
                </p>
              </div>
              {!confirmClear && <Ghost onClick={() => setConfirmClear(true)}>Clear…</Ghost>}
            </div>
            {confirmClear && (
              <div
                className="mt-3 flex items-center gap-3 rounded-[10px] border p-3.5"
                style={{ borderColor: "rgba(214,142,116,0.35)", background: "rgba(214,142,116,0.06)" }}
              >
                <p className="flex-1 text-[12.5px] text-fg">Erase all play history? This can't be undone.</p>
                <Ghost onClick={() => setConfirmClear(false)}>Cancel</Ghost>
                <button
                  type="button"
                  onClick={doClear}
                  className="h-8 rounded-lg border px-3.5 text-[12.5px] font-medium"
                  style={{
                    borderColor: "rgba(214,142,116,0.5)",
                    background: "rgba(214,142,116,0.14)",
                    color: WARN_TEXT,
                  }}
                >
                  Erase history
                </button>
              </div>
            )}
          </div>
        </>
      ),
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      section,
      spotifyConnected,
      spotifyName,
      authError,
      lastfmKey,
      testLabel,
      hotkeys,
      capture,
      reactive,
      launch,
      startLogin,
      hideFs,
      seenIntro,
      introLabel,
      version,
      confirmClear,
    ],
  );

  return (
    <div className="flex h-screen w-screen overflow-hidden border border-border/[0.09] bg-surface font-sans text-fg">
      <style>{CAP_STYLE}</style>

      {/* SIDEBAR */}
      <div className="flex w-[212px] shrink-0 flex-col border-r border-border/[0.06] bg-black/[0.16] p-2.5">
        <p
          data-tauri-drag-region
          className="mx-2 mb-3.5 mt-0.5 text-[15px] font-semibold text-fg"
        >
          Preferences
        </p>
        {SECTIONS.map((s) => {
          const on = section === s;
          return (
            <button
              key={s}
              type="button"
              onClick={() => {
                setSection(s);
                setConfirmClear(false);
              }}
              className={`mb-0.5 flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[13px] [transition:background-color_var(--transition-duration-2),color_var(--transition-duration-2)] ${
                on ? "bg-fg/[0.08] font-medium text-fg" : "text-muted hover:bg-fg/[0.05]"
              }`}
            >
              <NavIcon section={s} />
              {NAV_LABEL[s]}
            </button>
          );
        })}
        <div className="flex-1" />
        <p className="mx-2 text-[11px] tabular-nums text-fg/32">Palette {version || "…"}</p>
      </div>

      {/* DETAIL */}
      <div className="prefs-scroll relative min-w-0 flex-1 overflow-y-auto">
        <div className="px-[30px] pb-10 pt-[26px]">{detail[section]}</div>
        {/* Drag handle — a thin strip over the detail pane's empty top padding
            (the frameless window's title-bar grab area). Painted after the
            content so it sits above that padding, but the × (z-10) stays on
            top and every section control lives below it, so nothing
            interactive is captured. */}
        <div
          data-tauri-drag-region
          aria-hidden
          className="absolute inset-x-0 top-0 h-6"
        />
        <CloseX onClick={closePrefs} />
      </div>

      {/* TOAST */}
      <div
        aria-live="polite"
        className={`pointer-events-none absolute bottom-[18px] left-1/2 z-30 rounded-full border border-border/12 bg-surface-2 px-4 py-2 text-[12px] text-fg shadow-lg shadow-black/40 [transition:opacity_var(--transition-duration-2)_var(--ease-out-tk),transform_var(--transition-duration-2)_var(--ease-out-tk)] ${
          toastMsg ? "translate-x-[-50%] translate-y-0 opacity-100" : "translate-x-[-50%] translate-y-2 opacity-0"
        }`}
      >
        {toastMsg}
      </div>
    </div>
  );
}
