/*
 * Motion tokens — JS mirror of the @theme values in index.css, for `motion`
 * (framer-motion) transitions and any inline style that can't read CSS vars.
 * Keep in sync with index.css; there is deliberately no third copy.
 */
export const EASE = {
  out: [0.16, 1, 0.3, 1],
  inOut: [0.65, 0, 0.35, 1],
} as const;

/** Durations in ms — everything under 300ms. 5 exists for the seek spin:
 * a full revolution needs more room than a state morph. */
export const DUR = { 1: 90, 2: 140, 3: 200, 4: 220, 5: 260 } as const;
