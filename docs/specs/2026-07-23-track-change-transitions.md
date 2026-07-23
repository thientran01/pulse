# Track-change transitions: the interlude never moves the surface

**Date:** 2026-07-23 · **Approved by:** Thien (brainstorm session) · **Scope:** one PR

## Problem

On a track change with the lyrics view seated, `useLyrics` flips to `"loading"`
(one render late — even a disk-cache hit costs an IPC round trip), `lyricsLive`
goes false, and the expanded view's surface router immediately falls to the
album view. The 190px cover starts its 200ms fade-in, then yanks back out when
the new track's lyrics resolve a few frames later — a full-size art flash on
every lyrics→lyrics track change. The focus room has the identical seam
(its split⇄centered swap keys on `lyricsLive`).

Root cause framing: the fetch interlude is mapped to a **destination** view
(album / centered fallback) instead of being its own state. The house doctrine
says track-change *exits* are fast and plain — it never said the *fallback*
should arrive before the verdict is in.

## Design (approved)

**Core rule: the interlude never moves the surface — only verdicts do.**
On a track change, the surface router holds whatever surface is seated until
the new track's lyrics fetch returns a verdict (synced / none / offline), or a
grace window (`HOLD_GRACE_MS = 2500`) expires on a slow fetch.

### Data model

`LyricsState`'s terminal states all stamp the track key they answer for
(`none`/`offline` gain `key`, matching `synced`). A derived
`lyricsVerdictOf(np, lyrics)` returns `"pending" | "synced" | "none" |
"offline"` — a stale state (previous track's verdict) reads as `"pending"`,
which also closes the pre-existing one-render gap where the old verdict
leaked onto the new track. Captions read the verdict, never the raw status,
so a stale "No synced lyrics" can no longer show against a new track.

### Expanded view (App.tsx)

- `seat` = the non-queue surface (`"lyrics" | "album"`). While
  `verdict === "pending"` and within grace **and the user's view pref is
  lyrics**, `seat` holds its previous value (ref). Otherwise it resolves as
  today (`showLyrics ? "lyrics" : "album"`). `active` = queue ? queue : seat.
- During a lyrics-seat hold the body is quiet: old lines keep their instant
  unmount (exit fast and plain), the fixed header + waveform announcement
  narrate the new track, and "Finding lyrics…" fades in centered in the body
  on the existing 400ms-delay pattern. Cache hits resolve before it shows.
- `artShownAt` (the earned-cascade clock) stamps only while `seat ===
  "album"` — a held blank body is not "looking at art", so a fast
  lyrics→lyrics change stays plain and a post-grace album seat still earns
  the cascade on late resolve. `celebrate`/`SNAP_WINDOW_MS` unchanged.
- View pref = art: no hold, unchanged behavior.

### Focus room (Focus.tsx)

Same rule on the split⇄centered swap: while pending-within-grace the
composition holds (a held split keeps the identity column + a blank lyric
column; the per-track key still crossfades old split → new split, 200ms
plain). Verdict none / grace expiry falls to centered; the caption plumbing
(verdict-driven) already narrates. The once-per-takeover entrance logic is
untouched.

### Art crossfade

`Art` (App.tsx — header 44px + album 190px seats) crossfades on URL identity
change: outgoing cover fades under the incoming over ~140ms (DUR[2]),
opacity only — the art never moves. Covers album→album track changes,
pref=art changes, and media.rs rev-bump heals. Focus's `IdentityStack` art
gets the same treatment if it shares the component; otherwise deferred to
its own seat.

## Cases covered

| Transition | Result |
|---|---|
| lyrics → lyrics, fast (cache) | zero album frames; lines swap plain |
| lyrics → lyrics, slow | hold + 400ms caption → album at 2.5s grace → earned cascade on resolve |
| lyrics → miss/offline | hold until verdict → one deliberate album fade-in with honest caption |
| miss → lyrics | album seated (hold is a no-op) → existing cascade |
| miss → miss / view=art | seat unchanged + art crossfade |
| queue open | queue wins; on close, seat resolves by the same rule |
| play_now jump flicker | surface holds through intermediates (improves) |

## Verification

- Mock harness (PR #30): `?lyrics=80` — track change must show zero album
  frames; `?lyrics=4000` — caption at 400ms, album at 2.5s, cascade on
  resolve; `?lyrics=none` — hold → verdict → album.
- `tsc --noEmit` + `/designeng` pass on the diff (Thien's ask) + `/quick-review`.
- Real bar: Thien's live feel-check.

## Known accepted risks

- A fetch resolving right at the grace boundary can catch the album mid-fade
  (rare; lands in the existing designed arrival path).
- Old lines vanish in one frame (current behavior, doctrine-clean). If it
  reads abrupt live, a 140ms fade-out of the outgoing panel is the one knob
  to revisit — deliberately not designed in now (ghost-pairing guard).
