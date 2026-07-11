import { useAnimate, useReducedMotion } from "motion/react";
import { DUR, EASE } from "../lib/tokens";

const OUT = [...EASE.out] as [number, number, number, number];
const IN_OUT = [...EASE.inOut] as [number, number, number, number];

/** Mode-bracket press feedback: the glyph pulses in the direction of its
 * verb — expand's corner brackets burst apart, contract's pull together —
 * then settles back while the shell does the real glide. Scale on the glyph
 * wrapper IS the bracket separation (the two strokes are symmetric about
 * center), so no extra geometry poses. Fast attack (EASE.out to the peak),
 * settled return (EASE.inOut) — the press registers instantly, the recovery
 * is calm. Rides inside the button's own 90ms 0.95 press scale; for expand
 * the two oppose deliberately: the chrome dips while the verb grows. */
export function useBracketPulse(verb: "expand" | "contract") {
  const [scope, animate] = useAnimate();
  const reduced = useReducedMotion() ?? false;
  const peak = verb === "expand" ? 1.2 : 0.8;

  const pulse = () => {
    if (reduced || !scope.current) return;
    void animate(
      scope.current,
      { scale: [1, peak, 1] },
      { duration: DUR[3] / 1000, times: [0, 0.4, 1], ease: [OUT, IN_OUT] },
    );
  };

  return { scope, pulse };
}
