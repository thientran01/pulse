import { useRef } from "react";
import { useAnimate, useReducedMotion } from "motion/react";
import { DUR, EASE } from "../lib/tokens";

const IN_OUT = [...EASE.inOut] as [number, number, number, number];

/** Skip press feedback: the glyph travels out the side it points at while a
 * pixel-identical ghost follows it in from the other side — one continuous
 * pass-through inside the button's mask, the track itself flicking past.
 * A directional cousin of the seek spin: full committed travel per press
 * (the ±12° seek kick taught that a partial gesture reads as a nervous
 * twitch, not the verb). EASE.inOut for the same reason as the spin — the
 * launch is slow enough for the eye to lock direction. DUR[3], not the
 * spin's DUR[5]: the extra room exists because a revolution sweeps ~4× the
 * distance of this 16px pass — at equal duration the flick would crawl. The end frame is the
 * ghost centered, pixel-identical to rest, so the strip snaps back to 0
 * invisibly (the spin's N·360 normalize). Mashing re-launches from wherever
 * the glyph visually is: rewinding the strip one width is frame-identical
 * (the ghosts are exact copies one width away), so repeated presses read as
 * flicking through tracks, never a pop.
 *
 * The scope element must be a strip of THREE copies of the glyph — ghosts
 * parked at ±width — inside an overflow-hidden box of exactly `width`, or
 * the wrap frames stop being identical and the mash pops. */
export function useSkipFlick(dir: -1 | 1, width: number) {
  const [scope, animate] = useAnimate();
  const reduced = useReducedMotion() ?? false;
  const seq = useRef(0);

  const tick = async () => {
    if (reduced || !scope.current) return;
    const el = scope.current as HTMLElement;
    const id = ++seq.current;
    const t = getComputedStyle(el).transform;
    const cur = t === "none" ? 0 : new DOMMatrixReadOnly(t).m41;
    // Past center → rewind one width (frame-identical) so the pass runs
    // full-length; before center (a mash caught the re-entry) → continue
    // from where the glyph is, sweeping it through center and out.
    const from = dir * cur > 0.5 ? cur - dir * width : cur;
    await animate(el, { x: [from, dir * width] }, { duration: DUR[3] / 1000, ease: IN_OUT });
    if (id !== seq.current) return; // a newer press owns the strip now
    await animate(el, { x: 0 }, { duration: 0 });
  };

  return { scope, tick };
}
