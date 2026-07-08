/*
 * Dev-only morph sequencer (the article's "build a sequencer during
 * development" advice): `npm run dev` → http://localhost:1420/?lab
 * Runs in a plain browser — imports nothing from the Tauri backend, so every
 * transition pair can be exercised without a running player.
 */
import { useEffect, useState } from "react";
import { motion, useReducedMotion } from "motion/react";
import { DUR, EASE } from "../lib/tokens";
import { ICONS, type MorphName } from "./geometry";
import { MorphIcon } from "./MorphIcon";
import { PlayerMark, type PlayerId } from "./badges";
import { useSeekTick } from "./useSeekTick";

const NAMES = Object.keys(ICONS) as MorphName[];
const SIZES = [13, 16, 18, 22, 48] as const;
const PLAYERS: PlayerId[] = ["spotify", "apple_music", "other"];
const INOUT = [...EASE.inOut] as [number, number, number, number];

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-sm font-medium text-muted">{title}</h2>
      {children}
    </section>
  );
}

/** Any→any stage: click a glyph to morph the stage to it; cycle steps
 * through the whole set so every unplanned pair gets seen at least once. */
function Sequencer() {
  const [glyph, setGlyph] = useState<MorphName>("play");
  const [cycling, setCycling] = useState(false);
  useEffect(() => {
    if (!cycling) return;
    const t = window.setInterval(
      () => setGlyph((g) => NAMES[(NAMES.indexOf(g) + 1) % NAMES.length]),
      900,
    );
    return () => window.clearInterval(t);
  }, [cycling]);
  return (
    <div className="flex items-center gap-8">
      <div className="grid h-40 w-40 shrink-0 place-items-center rounded-xl border border-border/10 bg-surface-2 text-fg">
        <MorphIcon name={glyph} size={112} />
      </div>
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap gap-1">
          {NAMES.map((n) => (
            <button
              key={n}
              type="button"
              onClick={() => setGlyph(n)}
              className={`flex items-center gap-1.5 rounded-md px-2 py-1 text-xs transition-colors duration-2 ease-out-tk hover:bg-fg/10 ${
                n === glyph ? "bg-fg/10 text-fg" : "text-muted"
              }`}
            >
              <MorphIcon name={n} size={14} />
              {n}
            </button>
          ))}
        </div>
        <label className="flex w-fit cursor-pointer items-center gap-2 text-xs text-muted">
          <input type="checkbox" checked={cycling} onChange={(e) => setCycling(e.target.checked)} />
          auto-cycle (900ms)
        </label>
      </div>
    </div>
  );
}

/** The marquee toggle at product size and magnified. */
function PlayPauseDemo() {
  const [playing, setPlaying] = useState(false);
  const name = playing ? "pause" : "play";
  return (
    <div className="flex items-center gap-6">
      {[18, 64].map((s) => (
        <button
          key={s}
          type="button"
          aria-label={playing ? "Pause" : "Play"}
          onClick={() => setPlaying((p) => !p)}
          className="grid place-items-center rounded-md p-2 text-fg transition-colors duration-2 ease-out-tk hover:bg-fg/10 active:scale-95"
        >
          <MorphIcon name={name} size={s} dur={DUR[2]} ease={EASE.out} />
        </button>
      ))}
      <span className="text-xs text-muted">140ms EASE.out, fired on press</span>
    </div>
  );
}

function SeekDemo({ dir }: { dir: -1 | 1 }) {
  const { scope, tick } = useSeekTick(dir);
  return (
    <button
      type="button"
      aria-label={dir < 0 ? "Seek tick back" : "Seek tick forward"}
      onPointerDown={() => void tick()}
      className="grid h-8 w-8 place-items-center rounded-md text-fg transition-colors duration-2 ease-out-tk hover:bg-fg/10"
    >
      <span ref={scope} className="grid place-items-center will-change-transform">
        <MorphIcon name={dir < 0 ? "seekBack" : "seekFwd"} size={17} />
      </span>
    </button>
  );
}

/** Mock of App's mode ladder: same key={mode} remount, same layoutId slots,
 * same destination-named buttons — verifies the glide + cross-remount glyph
 * morph without a Tauri window. */
function ModeDemo() {
  const [mode, setMode] = useState<"pill" | "card" | "expanded">("card");
  const reduced = useReducedMotion() ?? false;
  const layoutT = {
    layout: { duration: reduced ? 0 : DUR[3] / 1000, ease: INOUT },
    // Keep whileTap's scale on the tokens, not motion's default spring.
    scale: { duration: reduced ? 0 : DUR[1] / 1000, ease: [...EASE.out] as [number, number, number, number] },
  };
  const btn = (to: MorphName, slot: string, onClick: () => void, label: string) => (
    <motion.button
      key={slot}
      type="button"
      layoutId={slot}
      transition={layoutT}
      whileTap={{ scale: reduced ? 1 : 0.95 }}
      onClick={onClick}
      aria-label={label}
      title={label}
      className="grid h-7 w-7 place-items-center rounded-md text-muted transition-colors duration-2 ease-out-tk hover:bg-fg/10 hover:text-fg"
    >
      <MorphIcon name={to} size={13} slot={slot} dur={DUR[3]} ease={EASE.inOut} />
    </motion.button>
  );
  const size = { pill: [300, 48], card: [380, 170], expanded: [380, 240] }[mode];
  return (
    <motion.div
      key={mode}
      animate={{ width: size[0], height: size[1] }}
      initial={false}
      transition={{ duration: reduced ? 0 : DUR[3] / 1000, ease: INOUT }}
      className="flex flex-col rounded-xl border border-border/10 bg-surface-2 p-2"
    >
      <div className="flex items-center justify-end gap-1">
        <span className="mr-auto pl-1 text-xs text-muted">{mode}</span>
        {mode === "pill" && btn("expand", "mode-secondary", () => setMode("card"), "Expand to card")}
        {mode === "card" && btn("contract", "mode-secondary", () => setMode("pill"), "Collapse to pill")}
        {mode === "card" && btn("mic", "mode-primary", () => setMode("expanded"), "Show lyrics")}
        {mode === "expanded" && btn("contract", "mode-primary", () => setMode("card"), "Back to card")}
      </div>
    </motion.div>
  );
}

export function IconLab() {
  return (
    <main className="min-h-screen bg-surface p-8 text-fg">
      <div className="flex max-w-3xl flex-col gap-10">
        <header>
          <h1 className="text-lg font-medium">Pulse icon lab</h1>
          <p className="text-xs text-muted">
            3 strokes × 2 cubics per glyph — any icon morphs into any other.
          </p>
        </header>
        <Section title="Sequencer — any → any (200ms EASE.inOut)">
          <Sequencer />
        </Section>
        <Section title="Play ↔ pause">
          <PlayPauseDemo />
        </Section>
        <Section title="Seek spin — one revolution per press, accumulates on mash">
          <div className="flex items-center gap-1">
            <SeekDemo dir={-1} />
            <SeekDemo dir={1} />
          </div>
        </Section>
        <Section title="Mode ladder — destination-named buttons, layoutId glide + slot morph">
          <ModeDemo />
        </Section>
        <Section title="At size">
          <div className="flex flex-col gap-2">
            {NAMES.map((n) => (
              <div key={n} className="flex items-center gap-4">
                <span className="w-20 text-xs text-muted">{n}</span>
                {SIZES.map((s) => (
                  <span key={s} className="grid w-14 place-items-center text-fg">
                    <MorphIcon name={n} size={s} />
                  </span>
                ))}
              </div>
            ))}
          </div>
        </Section>
        <Section title="Badges (static, muted)">
          <div className="flex items-center gap-6 text-muted">
            {PLAYERS.map((p) => (
              <span key={p} className="flex items-center gap-3">
                <PlayerMark player={p} size={14} />
                <PlayerMark player={p} size={28} />
                <span className="text-xs">{p}</span>
              </span>
            ))}
          </div>
        </Section>
      </div>
    </main>
  );
}
