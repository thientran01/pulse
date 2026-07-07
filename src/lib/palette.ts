/*
 * Album-art accent extraction. House rule (Phantom-style restraint): the
 * extracted color retints the ACCENT layer only — glow, progress fill,
 * highlights — never the neutral chrome.
 *
 * Pipeline: downscale to 24×24 on a canvas → score pixels for "vibrancy"
 * (saturated, mid-lightness) into hue buckets → weighted-average the winning
 * bucket → adjust lightness until it clears CONTRAST_FLOOR against the
 * current surface, so a near-black or near-white cover still yields a
 * readable accent.
 */

const SAMPLE = 24;
const HUE_BUCKETS = 12;
const CONTRAST_FLOOR = 3.0;

function srgbChannel(c: number): number {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

function luminance(r: number, g: number, b: number): number {
  return 0.2126 * srgbChannel(r) + 0.7152 * srgbChannel(g) + 0.0722 * srgbChannel(b);
}

export function contrast(rgb1: [number, number, number], rgb2: [number, number, number]): number {
  const l1 = luminance(...rgb1);
  const l2 = luminance(...rgb2);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === rn) h = ((gn - bn) / d + (gn < bn ? 6 : 0)) / 6;
  else if (max === gn) h = ((bn - rn) / d + 2) / 6;
  else h = ((rn - gn) / d + 4) / 6;
  return [h, s, l];
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  if (s === 0) {
    const v = Math.round(l * 255);
    return [v, v, v];
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const channel = (t: number): number => {
    let tn = t;
    if (tn < 0) tn += 1;
    if (tn > 1) tn -= 1;
    if (tn < 1 / 6) return p + (q - p) * 6 * tn;
    if (tn < 1 / 2) return q;
    if (tn < 2 / 3) return p + (q - p) * (2 / 3 - tn) * 6;
    return p;
  };
  return [Math.round(channel(h + 1 / 3) * 255), Math.round(channel(h) * 255), Math.round(channel(h - 1 / 3) * 255)];
}

/** Nudge lightness (toward the surface's opposite) until the contrast floor holds. */
function ensureContrast(
  rgb: [number, number, number],
  surface: [number, number, number],
): [number, number, number] {
  let [h, s, l] = rgbToHsl(...rgb);
  const lightenTarget = luminance(...surface) < 0.5;
  let out = rgb;
  for (let i = 0; i < 20 && contrast(out, surface) < CONTRAST_FLOOR; i++) {
    l = lightenTarget ? Math.min(l + 0.04, 0.95) : Math.max(l - 0.04, 0.05);
    out = hslToRgb(h, s, l);
  }
  return out;
}

/** Read the current `--surface` channels ("20 18 16") off the document root. */
function currentSurface(): [number, number, number] {
  const raw = getComputedStyle(document.documentElement).getPropertyValue("--surface").trim();
  const parts = raw.split(/\s+/).map(Number);
  if (parts.length === 3 && parts.every((n) => Number.isFinite(n))) {
    return [parts[0], parts[1], parts[2]];
  }
  return [20, 18, 16];
}

/**
 * Extract an accent from an image URL. Resolves to "r g b" channel string for
 * the --accent CSS var, or null when nothing usable is found (grayscale art,
 * decode failure) — callers should fall back to the house accent.
 */
export function extractAccent(url: string): Promise<string | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = SAMPLE;
      canvas.height = SAMPLE;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (!ctx) {
        resolve(null);
        return;
      }
      let data: Uint8ClampedArray;
      try {
        // drawImage throws InvalidStateError for zero-dimension decodes —
        // keep it inside the guard so the promise always resolves.
        ctx.drawImage(img, 0, 0, SAMPLE, SAMPLE);
        data = ctx.getImageData(0, 0, SAMPLE, SAMPLE).data;
      } catch {
        resolve(null);
        return;
      }
      const buckets = Array.from({ length: HUE_BUCKETS }, () => ({ score: 0, r: 0, g: 0, b: 0 }));
      for (let i = 0; i < data.length; i += 4) {
        const [r, g, b, a] = [data[i], data[i + 1], data[i + 2], data[i + 3]];
        if (a < 200) continue;
        const [h, s, l] = rgbToHsl(r, g, b);
        // Vibrancy: saturated and mid-lightness; near-black/white contribute ~0.
        const score = s * s * (1 - Math.abs(l - 0.5) * 2);
        if (score <= 0.02) continue;
        const bucket = buckets[Math.min(Math.floor(h * HUE_BUCKETS), HUE_BUCKETS - 1)];
        bucket.score += score;
        bucket.r += r * score;
        bucket.g += g * score;
        bucket.b += b * score;
      }
      const best = buckets.reduce((a, b) => (b.score > a.score ? b : a));
      if (best.score < 1) {
        resolve(null); // effectively grayscale art — keep the house accent
        return;
      }
      const rgb: [number, number, number] = [
        Math.round(best.r / best.score),
        Math.round(best.g / best.score),
        Math.round(best.b / best.score),
      ];
      resolve(ensureContrast(rgb, currentSurface()).join(" "));
    };
    img.onerror = () => resolve(null);
    img.src = url;
  });
}
