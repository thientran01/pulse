/*
 * Morphing icon geometry — benji.org/morphing-icons-with-claude, generalized.
 * Every icon is exactly 3 strokes; every stroke is one path with the identical
 * command skeleton "M x,y C … C …" (7 coordinate pairs), so motion tweens any
 * icon into any other by interpolating the numbers in place — no flubber.
 * ViewBox 16, strokeWidth 1.75, round caps/joins; straight lines are degenerate
 * cubics (control points at exactly 1/3 and 2/3, so straight→straight tweens
 * stay straight at every frame).
 *
 * Stroke order IS the correspondence map: stroke i always tweens to stroke i.
 * Roles: 0 = spine (structural anchor), 1 = action (the verb), 2 = detail.
 * EXCEPTION: `prev` stores its two vertical lines in swapped order (0 = stop
 * bar, 2 = flat edge) so play/pause/next → prev tweens pair near neighbors
 * instead of crossing the canvas — do NOT re-sort it to match the others.
 *
 * Dead strokes are zero-length points (opacity 0) parked ON visible geometry
 * of their own icon, placed where the stroke should appear to bud from when
 * it's born in a morph. They must stay mounted and opacity-hidden: a
 * zero-length path with round caps paints a dot if ever visible.
 */

export type MorphName =
  | "play"
  | "pause"
  | "prev"
  | "next"
  | "seekBack"
  | "seekFwd"
  | "expand"
  | "contract"
  | "mic"
  | "micOff"
  | "note";

export type Stroke = { d: string; o: 0 | 1 };

/** 1.75 (was 1.5): the set read too sharp/thin at product sizes. Anything
 * with tight interior clearances (seek head, mic head, contract gap) was
 * re-proportioned for this weight — check those before bumping it again. */
export const STROKE_WIDTH = 1.75;

export const ICONS: Record<MorphName, [Stroke, Stroke, Stroke]> = {
  // Outline triangle; centroid (not bbox) centered so it isn't left-heavy.
  // Stroke 0 is byte-identical to pause's left bar — the play↔pause morph
  // has a perfectly static welded anchor and the toggle is stroke 1 alone.
  play: [
    { d: "M 5.4,3.4 C 5.4,4.9 5.4,6.5 5.4,8.0 C 5.4,9.5 5.4,11.1 5.4,12.6", o: 1 },
    { d: "M 5.4,3.4 C 7.9,4.9 10.5,6.5 13.0,8.0 C 10.5,9.5 7.9,11.1 5.4,12.6", o: 1 },
    { d: "M 13.0,8.0 C 13.0,8.0 13.0,8.0 13.0,8.0 C 13.0,8.0 13.0,8.0 13.0,8.0", o: 0 },
  ],
  pause: [
    { d: "M 5.4,3.4 C 5.4,4.9 5.4,6.5 5.4,8.0 C 5.4,9.5 5.4,11.1 5.4,12.6", o: 1 },
    { d: "M 10.6,3.4 C 10.6,4.9 10.6,6.5 10.6,8.0 C 10.6,9.5 10.6,11.1 10.6,12.6", o: 1 },
    { d: "M 10.6,8.0 C 10.6,8.0 10.6,8.0 10.6,8.0 C 10.6,8.0 10.6,8.0 10.6,8.0", o: 0 },
  ],
  // 180° rotation twins with next; subordinate 7.2 height so the skips don't
  // outweigh play/pause; chevron apex welded onto the stop bar (round-cap T).
  prev: [
    { d: "M 3.8,4.4 C 3.8,5.6 3.8,6.8 3.8,8.0 C 3.8,9.2 3.8,10.4 3.8,11.6", o: 1 },
    { d: "M 12.0,4.4 C 9.3,5.6 6.5,6.8 3.8,8.0 C 6.5,9.2 9.3,10.4 12.0,11.6", o: 1 },
    { d: "M 12.0,4.4 C 12.0,5.6 12.0,6.8 12.0,8.0 C 12.0,9.2 12.0,10.4 12.0,11.6", o: 1 },
  ],
  next: [
    { d: "M 4.0,4.4 C 4.0,5.6 4.0,6.8 4.0,8.0 C 4.0,9.2 4.0,10.4 4.0,11.6", o: 1 },
    { d: "M 4.0,4.4 C 6.7,5.6 9.5,6.8 12.2,8.0 C 9.5,9.2 6.7,10.4 4.0,11.6", o: 1 },
    { d: "M 12.2,4.4 C 12.2,5.6 12.2,6.8 12.2,8.0 C 12.2,9.2 12.2,10.4 12.2,11.6", o: 1 },
  ],
  // 260° arc (center (8,8.2), r 4.7) ending at 12 o'clock where the tangent
  // is horizontal; arrowhead tip welds there, pointing along travel
  // (counterclockwise = rewind). No numeral — tooltip + time jump carry ±10s.
  // Head construction (v2): the chevron straddles the arc terminal RADIALLY —
  // vertex forward of the arc end (in the gap, pointing along travel), wing
  // tips bracketing the terminal above/below. Reads as a solid triangle
  // capping the arc. v1 welded the chevron tip to the terminal with wings
  // sweeping backward along the path — the inner wing hugged the arc body
  // and the head never read as an arrow (Thien's live feedback).
  seekBack: [
    { d: "M 3.4,9.0 C 4.1,13.0 9.0,14.3 11.6,11.2 C 14.2,8.1 12.0,3.5 8.0,3.5", o: 1 },
    { d: "M 8.0,1.8 C 7.4,2.4 6.7,2.9 6.1,3.5 C 6.7,4.1 7.4,4.6 8.0,5.2", o: 1 },
    { d: "M 6.1,3.5 C 6.1,3.5 6.1,3.5 6.1,3.5 C 6.1,3.5 6.1,3.5 6.1,3.5", o: 0 },
  ],
  // Exact horizontal mirror (x → 16−x) of seekBack.
  seekFwd: [
    { d: "M 12.6,9.0 C 11.9,13.0 7.0,14.3 4.4,11.2 C 1.8,8.1 4.0,3.5 8.0,3.5", o: 1 },
    { d: "M 8.0,1.8 C 8.6,2.4 9.3,2.9 9.9,3.5 C 9.3,4.1 8.6,4.6 8.0,5.2", o: 1 },
    { d: "M 9.9,3.5 C 9.9,3.5 9.9,3.5 9.9,3.5 C 9.9,3.5 9.9,3.5 9.9,3.5", o: 0 },
  ],
  // Size-ladder pair (v2 — the v1 pill/card/lyrics container pictograms read
  // as abstract shapes at 13px): the fullscreen-bracket idiom. expand = two
  // corner brackets on the NE/SW diagonal, corners OUT; contract = the same
  // brackets flipped in place, corners pointing at the center with shorter
  // legs receding outward. Contract's corners must stay well apart —
  // (10,6)/(6,10), non-overlapping leg ranges — or the four axis-aligned
  // legs visually compose into a plus sign (the failure of a first draft
  // whose inner corners sat at (9.2,6.8)/(6.8,9.2)).
  expand: [
    { d: "M 8.6,3.2 C 10.0,3.2 11.4,3.2 12.8,3.2 C 12.8,4.6 12.8,6.0 12.8,7.4", o: 1 },
    { d: "M 7.4,12.8 C 6.0,12.8 4.6,12.8 3.2,12.8 C 3.2,11.4 3.2,10.0 3.2,8.6", o: 1 },
    { d: "M 12.8,3.2 C 12.8,3.2 12.8,3.2 12.8,3.2 C 12.8,3.2 12.8,3.2 12.8,3.2", o: 0 },
  ],
  contract: [
    { d: "M 10.0,3.0 C 10.0,4.0 10.0,5.0 10.0,6.0 C 11.0,6.0 12.0,6.0 13.0,6.0", o: 1 },
    { d: "M 6.0,13.0 C 6.0,12.0 6.0,11.0 6.0,10.0 C 5.0,10.0 4.0,10.0 3.0,10.0", o: 1 },
    { d: "M 10.0,6.0 C 10.0,6.0 10.0,6.0 10.0,6.0 C 10.0,6.0 10.0,6.0 10.0,6.0", o: 0 },
  ],
  // Lyrics view = karaoke = mic (the Spotify-trained association). Head is a
  // closed 2-cubic ellipse (same construction as note's head) — wide enough
  // to stay HOLLOW at 13px (a narrower head sealed shut into a lollipop) —
  // stand is a half-circle arc, stem drops from the arc. All 3 strokes live.
  mic: [
    { d: "M 8.0,3.2 C 10.9,3.2 10.9,8.2 8.0,8.2 C 5.1,8.2 5.1,3.2 8.0,3.2", o: 1 },
    { d: "M 4.6,7.2 C 4.6,9.1 6.1,10.6 8.0,10.6 C 9.9,10.6 11.4,9.1 11.4,7.2", o: 1 },
    { d: "M 8.0,10.6 C 8.0,11.0 8.0,11.4 8.0,11.8 C 8.0,12.2 8.0,12.6 8.0,13.0", o: 1 },
  ],
  // mic crossed out — the expanded view-toggle's "no synced lyrics" state.
  // Head and stand are byte-identical to mic's, so the loading→miss morph is
  // a single event: the stem (stroke 2) sweeps out into the corner-to-corner
  // slash. The stem is the sacrifice the 3-stroke budget demands — head +
  // stand + slash still read as a muted mic at 13px.
  micOff: [
    { d: "M 8.0,3.2 C 10.9,3.2 10.9,8.2 8.0,8.2 C 5.1,8.2 5.1,3.2 8.0,3.2", o: 1 },
    { d: "M 4.6,7.2 C 4.6,9.1 6.1,10.6 8.0,10.6 C 9.9,10.6 11.4,9.1 11.4,7.2", o: 1 },
    { d: "M 3.2,3.2 C 4.8,4.8 6.4,6.4 8.0,8.0 C 9.6,9.6 11.2,11.2 12.8,12.8", o: 1 },
  ],
  // Eighth note: stem = spine (maps rigidly onto play's left edge), flag =
  // action (curl opens into the apex chevron), notehead = detail (two 180°
  // cubics; melts into play's parked apex).
  note: [
    { d: "M 7.7,11.8 C 7.7,10.3 7.7,8.7 7.7,7.2 C 7.7,5.7 7.7,4.1 7.7,2.6", o: 1 },
    { d: "M 7.7,2.6 C 10.2,3.0 11.2,4.0 11.4,5.6 C 11.5,6.6 11.0,7.5 10.2,8.2", o: 1 },
    { d: "M 7.7,11.8 C 7.7,14.3 3.9,14.3 3.9,11.8 C 3.9,9.3 7.7,9.3 7.7,11.8", o: 1 },
  ],
};
