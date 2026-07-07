/*
 * Audio-reactive halo behind the album art — the app's only reactive accent
 * surface. One tiny canvas at half-resolution backing store (the bilinear
 * upscale is the softener — no filter passes), redrawn at ~30fps from
 * envelope-smoothed band energies. The art itself never moves; only light does.
 */
import { useEffect, useRef } from "react";
import { SPECTRUM_BINS, type AudioBands } from "./lib/backend";
import { Envelope, expressive, subscribeBands } from "./lib/reactive";

export type GlowVariant = "bars" | "blob" | "rings";
export const GLOW_VARIANTS: readonly GlowVariant[] = ["bars", "blob", "rings"];

const FALLBACK_ACCENT = "232 122 90";
/** Stop drawing once every envelope has decayed below this. */
const IDLE_EPS = 0.004;

interface Scene {
  ctx: CanvasRenderingContext2D;
  c: number; // canvas center, css px
  half: number; // art half-size
  radius: number; // art corner radius
  s: number; // size scale (1 = 72px card art)
  rgb: string;
  time: number; // seconds, for slow drift
  bass: number;
  mid: number;
  high: number;
  spec: number[];
}

/** Distance from art center to its (square) boundary along (dx, dy). */
function boundaryDist(half: number, dx: number, dy: number): number {
  return half / Math.max(Math.abs(dx), Math.abs(dy));
}

/** Radiating EQ petals: 16 bins, bass at the bottom, highs at top, mirrored L/R. */
function drawBars({ ctx, c, half, s, rgb, spec }: Scene): void {
  ctx.lineCap = "round";
  for (let i = 0; i < SPECTRUM_BINS; i++) {
    // Right-side angle sweeping bottom → top (canvas y grows downward).
    const theta = Math.PI / 2 - ((i + 0.5) * Math.PI) / SPECTRUM_BINS;
    const e = spec[i];
    const len = (4 + e * 16) * s;
    for (const mirror of [1, -1]) {
      const dx = Math.cos(theta) * mirror;
      const dy = Math.sin(theta);
      const base = boundaryDist(half, dx, dy) + 2 * s;
      const bx = c + dx * base;
      const by = c + dy * base;
      const tx = bx + dx * len;
      const ty = by + dy * len;
      const g = ctx.createLinearGradient(bx, by, tx, ty);
      g.addColorStop(0, `rgb(${rgb} / ${(0.55 * (0.35 + e * 0.65)).toFixed(3)})`);
      g.addColorStop(1, `rgb(${rgb} / 0)`);
      ctx.strokeStyle = g;
      ctx.lineWidth = 7 * s;
      ctx.beginPath();
      ctx.moveTo(bx, by);
      ctx.lineTo(tx, ty);
      ctx.stroke();
    }
  }
}

/** Organic contour: soft orbs along the perimeter melt into an undulating
 * glow — bass swells the bottom, mids the sides, highs the top. */
function drawBlob({ ctx, c, half, s, rgb, time, bass, mid, high }: Scene): void {
  const ORBS = 12;
  for (let j = 0; j < ORBS; j++) {
    const theta = (j / ORBS) * Math.PI * 2 + 0.07 * Math.sin(time * 0.5 + j * 1.7);
    const dx = Math.cos(theta);
    const dy = Math.sin(theta);
    const wBass = Math.max(0, dy); // bottom (y down)
    const wHigh = Math.max(0, -dy); // top
    const wMid = 1 - Math.abs(dy); // sides
    const e = bass * wBass + mid * wMid + high * wHigh;
    // Slow drift term keeps the contour alive even on held notes.
    const r = (9 + e * 17 + 2 * Math.sin(theta * 3 + time * 0.9)) * s;
    if (r <= 0.5) continue;
    const ox = c + dx * (boundaryDist(half, dx, dy) + 1);
    const oy = c + dy * (boundaryDist(half, dx, dy) + 1);
    const g = ctx.createRadialGradient(ox, oy, 0, ox, oy, r);
    g.addColorStop(0, `rgb(${rgb} / ${(0.4 * (0.25 + e * 0.75)).toFixed(3)})`);
    g.addColorStop(1, `rgb(${rgb} / 0)`);
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(ox, oy, r, 0, Math.PI * 2);
    ctx.fill();
  }
}

/** Concentric breath: three rounded-rect annuli hugging the art — bass drives
 * the inner ring, mids the middle, highs an outer shimmer. */
function drawRings({ ctx, c, half, radius, s, rgb, bass, mid, high }: Scene): void {
  const rings: Array<[number, number, number]> = [
    [(4 + bass * 6) * s, 10 * s, 0.55 * bass],
    [(11 + mid * 5) * s, 12 * s, 0.35 * mid],
    [(17 + high * 5) * s, 10 * s, 0.28 * high],
  ];
  for (const [d, th, alpha] of rings) {
    if (alpha < 0.01) continue;
    // Layered strokes fake a gaussian profile without a filter pass.
    for (const [wf, af] of [
      [1, 0.5],
      [1.9, 0.24],
      [3, 0.1],
    ] as const) {
      ctx.strokeStyle = `rgb(${rgb} / ${(alpha * af).toFixed(3)})`;
      ctx.lineWidth = th * wf;
      ctx.beginPath();
      ctx.roundRect(c - half - d, c - half - d, (half + d) * 2, (half + d) * 2, radius + d);
      ctx.stroke();
    }
  }
}

const DRAW: Record<GlowVariant, (sc: Scene) => void> = {
  bars: drawBars,
  blob: drawBlob,
  rings: drawRings,
};

export function ArtGlow({
  artSize,
  pad,
  radius,
  variant,
}: {
  artSize: number;
  pad: number;
  /** Art corner radius in px — the halo hugs the rounded-rect shape. */
  radius: number;
  variant: GlowVariant;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // Read through a ref so a variant switch doesn't tear down the envelopes.
  const variantRef = useRef(variant);
  variantRef.current = variant;

  useEffect(() => {
    // No reduced-motion gate here: under reduce, reactive.ts delivers no
    // events, so the loop never starts and the art's static resting shadow
    // carries the look — and a live settings flip re-animates without remount.
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;

    const css = artSize + pad * 2;
    const half = artSize / 2;
    const c = css / 2;
    const s = artSize >= 120 ? 1.4 : 1;

    const bassEnv = new Envelope(35, 450);
    const midEnv = new Envelope(45, 600);
    const highEnv = new Envelope(25, 700);
    const levelEnv = new Envelope(45, 550);
    const specEnvs = Array.from({ length: SPECTRUM_BINS }, () => new Envelope(40, 500));

    let latest: AudioBands | null = null;
    let raf = 0;
    let running = false;
    let last = 0;
    let time = 0;
    let dprUsed = 0;

    const fit = () => {
      const dpr = window.devicePixelRatio || 1;
      if (dpr === dprUsed) return;
      dprUsed = dpr;
      // Half-res backing store: the upscale melts shapes into soft light.
      const px = Math.max(1, Math.round(css * dpr * 0.5));
      canvas.width = px;
      canvas.height = px;
      ctx.setTransform(px / css, 0, 0, px / css, 0, 0);
    };

    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      if (now - last < 30) return; // ~30fps is plenty for light
      const dt = Math.min(now - last, 100);
      last = now;
      time += dt / 1000;
      fit();

      const b = latest;
      let spec = b?.spectrum;
      if (b && (!spec || spec.length !== SPECTRUM_BINS)) {
        // Backend without fine bins — synthesize from the 3 bands.
        spec = Array.from({ length: SPECTRUM_BINS }, (_, i) => {
          const p = i / (SPECTRUM_BINS - 1);
          return p < 0.5 ? b.bass + (b.mid - b.bass) * p * 2 : b.mid + (b.high - b.mid) * (p - 0.5) * 2;
        });
      }

      const bass = bassEnv.step(b?.bass ?? 0, dt);
      const mid = midEnv.step(b?.mid ?? 0, dt);
      const high = highEnv.step(b?.high ?? 0, dt);
      const level = levelEnv.step(b?.level ?? 0, dt);
      const specNow = specEnvs.map((env, i) => env.step(spec?.[i] ?? 0, dt));

      ctx.clearRect(0, 0, css, css);
      const alpha = expressive(level);
      if (alpha >= 0.02) {
        const rgb =
          getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || FALLBACK_ACCENT;
        ctx.globalAlpha = alpha;
        DRAW[variantRef.current]({ ctx, c, half, radius, s, rgb, time, bass, mid, high, spec: specNow });
        ctx.globalAlpha = 1;
      }

      // Idle-stop once fully decayed; the next band event restarts the loop.
      const peak = Math.max(bass, mid, high, level, ...specNow);
      if (peak < IDLE_EPS && (b === null || b.level <= 0.001)) {
        running = false;
        cancelAnimationFrame(raf);
      }
    };

    const start = () => {
      if (running) return;
      running = true;
      last = performance.now();
      raf = requestAnimationFrame(frame);
    };

    // Zero payloads while idle stay idle; while running, the loop itself
    // decays to rest and stops.
    const unsub = subscribeBands((b) => {
      latest = b;
      if (b.level > 0.001) start();
    });

    return () => {
      unsub();
      running = false;
      cancelAnimationFrame(raf);
      ctx.clearRect(0, 0, css, css);
    };
  }, [artSize, pad, radius]);

  const css = artSize + pad * 2;
  return (
    <canvas
      ref={canvasRef}
      aria-hidden
      className="pointer-events-none absolute -z-10"
      style={{ left: -pad, top: -pad, width: css, height: css }}
    />
  );
}
