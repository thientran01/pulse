export interface LyricLine {
  /** Line start in ms. */
  t: number;
  text: string;
}

/**
 * Parse LRC text into sorted timed lines. Handles multiple timestamps per
 * line (`[00:12.30][01:02.00]chorus`) and skips empty/instrumental lines —
 * the previous line simply stays current through the gap.
 */
export function parseLrc(lrc: string): LyricLine[] {
  const out: LyricLine[] = [];
  for (const raw of lrc.split(/\r?\n/)) {
    const stamps = [...raw.matchAll(/\[(\d+):(\d+(?:\.\d+)?)\]/g)];
    if (stamps.length === 0) continue;
    const text = raw.replace(/\[\d+:\d+(?:\.\d+)?\]/g, "").trim();
    if (!text) continue;
    for (const m of stamps) {
      out.push({ t: Math.round((Number(m[1]) * 60 + Number(m[2])) * 1000), text });
    }
  }
  return out.sort((a, b) => a.t - b.t);
}

/** The highlight leads the vocal by this much — SMTC positions lag what the
 * user actually hears. One constant so the index search and the boundary
 * scheduler can never disagree about where a line starts. */
export const VOCAL_LEAD_MS = 250;

/** Index of the line active at `positionMs` (-1 before the first line). */
export function currentLineIndex(lines: LyricLine[], positionMs: number): number {
  const p = positionMs + VOCAL_LEAD_MS;
  let lo = 0;
  let hi = lines.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lines[mid].t <= p) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}

/** Ms of 1x playback until the line after `idx` becomes current, or null when
 * `idx` is the last line (nothing left to schedule). Guaranteed positive when
 * `idx === currentLineIndex(lines, positionMs)` — a position at the boundary
 * already belongs to the next line. */
export function msUntilNextLine(lines: LyricLine[], idx: number, positionMs: number): number | null {
  const next = lines[idx + 1];
  if (!next) return null;
  return Math.max(next.t - VOCAL_LEAD_MS - positionMs, 0);
}
