/*
 * Motion tokens — JS mirror of the @theme values in index.css, for `motion`
 * (framer-motion) transitions and any inline style that can't read CSS vars.
 * Keep in sync with index.css; there is deliberately no third copy.
 */
export const EASE = {
  out: [0.16, 1, 0.3, 1],
  inOut: [0.65, 0, 0.35, 1],
} as const;

export const EASE_CSS = {
  out: "cubic-bezier(0.16,1,0.3,1)",
  inOut: "cubic-bezier(0.65,0,0.35,1)",
  hover: "ease",
} as const;

/** Durations in ms — everything under 300ms. */
export const DUR = { 1: 90, 2: 140, 3: 200, 4: 220 } as const;
