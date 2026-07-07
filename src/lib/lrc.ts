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

/** Index of the line active at `positionMs` (-1 before the first line). */
export function currentLineIndex(lines: LyricLine[], positionMs: number): number {
  // Small lookahead so the highlight lands with the vocal, not after it.
  const p = positionMs + 250;
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
