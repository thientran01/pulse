import type { SpotifyDevice } from "./types";

/** A small static glyph for the playback device's kind. Deliberately NOT part
 * of the morphing icon system (src/icons/) — that skeleton is for glyphs that
 * tween into each other; this one never morphs. Drawn on the house 16-grid at
 * 1.5 stroke (every other static one-off glyph — SearchGlyph, the Queue row
 * verbs — shares that grid; these had drifted to a 24-viewBox at stroke 2,
 * audit A7-11). Coordinates are the mechanical ×2/3 of the old 24-grid, so the
 * silhouettes are unchanged. currentColor inherits the tag's text-muted. */
function DeviceGlyph({ kind, px = 12 }: { kind: SpotifyDevice["kind"]; px?: number }) {
  const common = {
    width: px,
    height: px,
    viewBox: "0 0 16 16",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.5,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
  };
  switch (kind) {
    case "phone":
      return (
        <svg {...common}>
          <rect x="4.67" y="1.33" width="6.67" height="13.33" rx="1.67" />
          <line x1="7" y1="12.33" x2="9" y2="12.33" />
        </svg>
      );
    case "speaker":
      return (
        <svg {...common}>
          <rect x="4" y="1.33" width="8" height="13.33" rx="1.67" />
          <circle cx="8" cy="9.33" r="2.33" />
          <line x1="8" y1="4" x2="8" y2="4" />
        </svg>
      );
    case "tv":
      return (
        <svg {...common}>
          <rect x="1.33" y="2.67" width="13.33" height="8.67" rx="1.33" />
          <line x1="5.33" y1="14" x2="10.67" y2="14" />
        </svg>
      );
    default:
      // car / other → a generic "casting" mark (screen + signal arcs).
      return (
        <svg {...common}>
          <rect x="2" y="2.67" width="12" height="8" rx="1.33" />
          <path d="M2.67 10.67a2.67 2.67 0 0 1 2.67 2.67" />
          <line x1="4.33" y1="13.33" x2="4.33" y2="13.33" />
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
