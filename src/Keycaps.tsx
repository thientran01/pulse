/*
 * A row of monochrome keycaps for a Tauri accelerator ("ctrl+alt+s" →
 * [Ctrl][Alt][S]). House tokens only — never accent (keycaps are chrome, not a
 * flourish). Shared by the empty-state nudge (sm) and the first-run bubble (md).
 */
import { chordCaps } from "./lib/chords";

const SIZE = {
  sm: "h-[18px] min-w-[16px] px-1 text-[10px]",
  md: "h-[22px] min-w-[20px] px-1.5 text-[11px]",
} as const;

export function Keycaps({
  chord,
  size = "md",
  className = "",
}: {
  chord: string;
  size?: keyof typeof SIZE;
  className?: string;
}) {
  const caps = chordCaps(chord);
  if (caps.length === 0) return null;
  return (
    <span className={`inline-flex items-center gap-1 ${className}`}>
      {caps.map((c, i) => (
        <kbd
          key={i}
          className={`inline-flex items-center justify-center rounded border border-border/15 bg-fg/[0.07] font-medium not-italic text-fg ${SIZE[size]}`}
        >
          {c}
        </kbd>
      ))}
    </span>
  );
}
