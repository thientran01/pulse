import { useEffect, useRef, useState } from "react";
import { commands, onNowPlaying } from "./lib/backend";
import type { NowPlaying } from "./types";

const SEEK_STEP_MS = 10_000;

function fmt(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** Position interpolated between backend emits while playing. */
function useLivePosition(np: NowPlaying | null): number {
  const [, force] = useState(0);
  useEffect(() => {
    if (np?.status !== "playing") return;
    const id = window.setInterval(() => force((n) => n + 1), 250);
    return () => window.clearInterval(id);
  }, [np?.status]);
  if (!np) return 0;
  const drift = np.status === "playing" ? Date.now() - np.emitted_at_ms : 0;
  return Math.min(np.position_ms + drift, np.duration_ms || Infinity);
}

function useArt(artId: string | null): string | null {
  const [url, setUrl] = useState<string | null>(null);
  const lastId = useRef<string | null>(null);
  useEffect(() => {
    if (artId === lastId.current) return;
    lastId.current = artId;
    if (!artId) {
      setUrl(null);
      return;
    }
    let alive = true;
    void commands.art(artId).then((u) => {
      if (alive) setUrl(u);
    });
    return () => {
      alive = false;
    };
  }, [artId]);
  return artId ? url : null;
}

function IconButton({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="grid h-7 w-7 place-items-center rounded-md text-fg transition duration-2 ease-out-tk hover:bg-fg/10 active:scale-95 disabled:pointer-events-none disabled:opacity-30"
    >
      {children}
    </button>
  );
}

const PLAYER_NAMES: Record<NowPlaying["player"], string> = {
  apple_music: "Apple Music",
  spotify: "Spotify",
  other: "Media",
  none: "",
};

const icons = {
  prev: (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
      <path d="M3 2.5a.5.5 0 0 1 1 0v11a.5.5 0 0 1-1 0v-11ZM13.2 3a.6.6 0 0 1 .8.57v8.86a.6.6 0 0 1-.98.46L6.6 8.46a.6.6 0 0 1 0-.92L13.02 3.1a.6.6 0 0 1 .18-.1Z" />
    </svg>
  ),
  next: (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
      <path d="M13 2.5a.5.5 0 0 0-1 0v11a.5.5 0 0 0 1 0v-11ZM2.8 3a.6.6 0 0 0-.8.57v8.86a.6.6 0 0 0 .98.46l6.42-4.43a.6.6 0 0 0 0-.92L2.98 3.1a.6.6 0 0 0-.18-.1Z" />
    </svg>
  ),
  play: (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
      <path d="M4.5 2.7a.7.7 0 0 1 1.06-.6l8.13 4.7a.7.7 0 0 1 0 1.2l-8.13 4.7a.7.7 0 0 1-1.06-.6V2.7Z" />
    </svg>
  ),
  pause: (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
      <path d="M4 2.8c0-.44.36-.8.8-.8h1.4c.44 0 .8.36.8.8v10.4a.8.8 0 0 1-.8.8H4.8a.8.8 0 0 1-.8-.8V2.8Zm5 0c0-.44.36-.8.8-.8h1.4c.44 0 .8.36.8.8v10.4a.8.8 0 0 1-.8.8H9.8a.8.8 0 0 1-.8-.8V2.8Z" />
    </svg>
  ),
  back10: (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden>
      <path d="M8 3a5 5 0 1 1-4.55 2.93" strokeLinecap="round" />
      <path d="M3.2 2.6v3.3h3.3" strokeLinecap="round" strokeLinejoin="round" />
      <text x="8" y="10.6" fontSize="5.4" fill="currentColor" stroke="none" textAnchor="middle" fontWeight="700">
        10
      </text>
    </svg>
  ),
  fwd10: (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden>
      <path d="M8 3a5 5 0 1 0 4.55 2.93" strokeLinecap="round" />
      <path d="M12.8 2.6v3.3H9.5" strokeLinecap="round" strokeLinejoin="round" />
      <text x="8" y="10.6" fontSize="5.4" fill="currentColor" stroke="none" textAnchor="middle" fontWeight="700">
        10
      </text>
    </svg>
  ),
  note: (
    <svg width="20" height="20" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
      <path d="M6 13.5a2 2 0 1 1-1-1.73V4.6a.8.8 0 0 1 .57-.77l6-1.8A.8.8 0 0 1 12.6 2.8v8.2a2 2 0 1 1-1-1.73V5.06l-5 1.5v6.94Z" />
    </svg>
  ),
};

function ProgressBar({ np, position }: { np: NowPlaying; position: number }) {
  const barRef = useRef<HTMLDivElement>(null);
  const frac = np.duration_ms > 0 ? position / np.duration_ms : 0;
  const seekable = np.can_seek && np.duration_ms > 0;
  return (
    <div className="flex items-center gap-2">
      <span className="w-8 text-right text-[10px] tabular-nums text-muted">{fmt(position)}</span>
      <div
        ref={barRef}
        role={seekable ? "slider" : "progressbar"}
        aria-label="Track position"
        aria-valuemin={0}
        aria-valuemax={np.duration_ms}
        aria-valuenow={Math.round(position)}
        tabIndex={seekable ? 0 : -1}
        onKeyDown={(e) => {
          if (!seekable) return;
          if (e.key === "ArrowLeft") commands.seekRel(-5000);
          if (e.key === "ArrowRight") commands.seekRel(5000);
        }}
        onPointerDown={(e) => {
          if (!seekable || !barRef.current) return;
          const r = barRef.current.getBoundingClientRect();
          const f = Math.min(Math.max((e.clientX - r.left) / r.width, 0), 1);
          commands.seekAbs(Math.round(f * np.duration_ms));
        }}
        className={`group relative h-3 flex-1 ${seekable ? "cursor-pointer" : ""}`}
      >
        <div className="absolute inset-x-0 top-1/2 h-[3px] -translate-y-1/2 overflow-hidden rounded-full bg-fg/10">
          <div
            className="h-full rounded-full bg-accent transition-[width] duration-1 ease-out-tk"
            style={{ width: `${Math.min(frac * 100, 100)}%` }}
          />
        </div>
      </div>
      <span className="w-8 text-[10px] tabular-nums text-muted">{fmt(np.duration_ms)}</span>
    </div>
  );
}

function App() {
  const [np, setNp] = useState<NowPlaying | null>(null);
  useEffect(() => onNowPlaying(setNp), []);
  const position = useLivePosition(np);
  const artUrl = useArt(np?.art_id ?? null);

  const nothing = !np || np.player === "none";
  const playing = np?.status === "playing";
  // AM can't seek over SMTC (support matrix) — buttons gate on capability.
  const seekable = !!np?.can_seek;

  return (
    <div data-tauri-drag-region className="h-screen p-1.5">
      <div
        data-tauri-drag-region
        className="flex h-full items-center gap-3 rounded-xl border border-border/10 bg-surface/95 px-3"
      >
        {nothing ? (
          <div data-tauri-drag-region className="flex w-full items-center justify-center gap-2 text-muted">
            {icons.note}
            <span className="text-sm">Nothing playing</span>
          </div>
        ) : (
          <>
            <div className="grid h-[72px] w-[72px] shrink-0 place-items-center overflow-hidden rounded-lg bg-surface-2 text-muted">
              {artUrl ? (
                <img src={artUrl} alt="" className="h-full w-full object-cover" draggable={false} />
              ) : (
                icons.note
              )}
            </div>
            <div className="flex min-w-0 flex-1 flex-col gap-0.5" data-tauri-drag-region>
              <div className="flex items-baseline gap-2" data-tauri-drag-region>
                <p className="min-w-0 flex-1 truncate text-sm font-medium text-fg" data-tauri-drag-region>
                  {np.title}
                </p>
                {/* Windows routes commands to the OS "current" session, which
                    hops between apps — always show which app this card controls. */}
                <span className="shrink-0 text-[9px] uppercase tracking-wider text-muted/80" data-tauri-drag-region>
                  {PLAYER_NAMES[np.player]}
                </span>
              </div>
              <p className="truncate text-xs text-muted" data-tauri-drag-region>
                {np.artist}
                {np.album ? ` — ${np.album}` : ""}
              </p>
              <div className="mt-0.5 flex items-center gap-0.5">
                <IconButton label="Previous track" onClick={commands.prev}>
                  {icons.prev}
                </IconButton>
                <IconButton
                  label="Back 10 seconds"
                  disabled={!seekable}
                  onClick={() => commands.seekRel(-SEEK_STEP_MS)}
                >
                  {icons.back10}
                </IconButton>
                <IconButton label={playing ? "Pause" : "Play"} onClick={commands.playPause}>
                  {playing ? icons.pause : icons.play}
                </IconButton>
                <IconButton
                  label="Forward 10 seconds"
                  disabled={!seekable}
                  onClick={() => commands.seekRel(SEEK_STEP_MS)}
                >
                  {icons.fwd10}
                </IconButton>
                <IconButton label="Next track" onClick={commands.next}>
                  {icons.next}
                </IconButton>
              </div>
              <ProgressBar np={np} position={position} />
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export default App;
