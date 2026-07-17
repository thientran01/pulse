import type { SpotifyDevice } from "./types";

/** A small static glyph for the playback device's kind. Deliberately NOT part
 * of the morphing icon system (src/icons/) — that skeleton is for glyphs that
 * tween into each other; this one never morphs. currentColor inherits the
 * tag's text-muted. */
function DeviceGlyph({ kind, px = 12 }: { kind: SpotifyDevice["kind"]; px?: number }) {
  const common = {
    width: px,
    height: px,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 2,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
  };
  switch (kind) {
    case "phone":
      return (
        <svg {...common}>
          <rect x="7" y="2" width="10" height="20" rx="2.5" />
          <line x1="10.5" y1="18.5" x2="13.5" y2="18.5" />
        </svg>
      );
    case "speaker":
      return (
        <svg {...common}>
          <rect x="6" y="2" width="12" height="20" rx="2.5" />
          <circle cx="12" cy="14" r="3.5" />
          <line x1="12" y1="6" x2="12" y2="6" />
        </svg>
      );
    case "tv":
      return (
        <svg {...common}>
          <rect x="2" y="4" width="20" height="13" rx="2" />
          <line x1="8" y1="21" x2="16" y2="21" />
        </svg>
      );
    default:
      // car / other → a generic "casting" mark (screen + signal arcs).
      return (
        <svg {...common}>
          <rect x="3" y="4" width="18" height="12" rx="2" />
          <path d="M4 20a4 4 0 0 1 4 4" transform="translate(0 -4)" />
          <line x1="6.5" y1="20" x2="6.5" y2="20" />
        </svg>
      );
  }
}

/** The device Spotify is playing on when it isn't this PC — a small, static,
 * neutral indicator that explains a quiet waveform (the audio is elsewhere,
 * not paused). Never accent, never animated. Icon-only by default (name in the
 * tooltip, for the tight card); pass showName in roomier views. Size is an
 * explicit knob ("sm" widget / "lg" focus room) — the name span used to
 * hardcode text-[11px], which silently defeated a className size override
 * (Tailwind conflicting-utility order is load-order, not class-order). */
const TAG_SIZE = {
  sm: { glyph: 12, name: "text-[11px]" },
  lg: { glyph: 16, name: "text-[15px]" },
} as const;

export function DeviceTag({
  device,
  playing = false,
  showName = false,
  size = "sm",
  className = "",
}: {
  device: SpotifyDevice;
  playing?: boolean;
  showName?: boolean;
  size?: keyof typeof TAG_SIZE;
  className?: string;
}) {
  // Screen readers get the device CATEGORY sighted users read from the glyph,
  // appended only when the name doesn't already carry it ("iPhone" already
  // says phone; "Kitchen" doesn't say speaker).
  const kindWord: Record<SpotifyDevice["kind"], string> = {
    phone: "phone",
    speaker: "speaker",
    tv: "TV",
    car: "car",
    other: "",
  };
  const kw = kindWord[device.kind];
  const kindSuffix = kw && !device.name.toLowerCase().includes(kw.toLowerCase()) ? ` ${kw}` : "";
  const label = `${playing ? "Playing on" : "On"} ${device.name}${kindSuffix}`;
  return (
    <span
      className={`inline-flex min-w-0 shrink-0 items-center gap-1 text-muted ${className}`}
      role="img"
      aria-label={label}
      title={label}
    >
      <DeviceGlyph kind={device.kind} px={TAG_SIZE[size].glyph} />
      {showName && (
        <span className={`min-w-0 truncate ${TAG_SIZE[size].name} leading-none`}>{device.name}</span>
      )}
    </span>
  );
}
