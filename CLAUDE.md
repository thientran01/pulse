# Pulse

A Raycast/Linear-grade mini music player for Windows. Always-on-top widget that reads and controls whatever is playing (Apple Music, Spotify, browsers) through the Windows system media API (GSMTC), with synced lyrics, album-art adaptive accents, audio-reactive visuals, and ±10s seek. Built because Apple Music's miniplayer minimizes on every click and feels dead. Personal project; portfolio /lab candidate.

Full plan: `C:\Users\Thien\.claude\plans\i-want-to-start-buzzing-wreath.md` (milestones M0–M5).

## Stack

- **Tauri v2** — Rust backend, frameless/transparent/always-on-top window
- **React 19 + TypeScript + Vite 7** frontend, **Tailwind v4** (CSS-first config), **motion** for layout morphs
- Rust side: hand-rolled GSMTC poller (media.rs), LRCLIB lyrics with disk cache (lyrics.rs), WASAPI loopback + FFT audio-reactive core (audio.rs), Spotify Web API adapter (M5, pending — demoted to like/unlike only)

## Architecture

```
src-tauri/src/
  media.rs      GSMTC watcher → now-playing events + transport/seek commands + art cache;
                change events (SessionWatch) wake a 500ms heartbeat poll, so track/art/
                status changes land in ~50ms. Emits carry the RAW (position_ms,
                position_at_ms=LastUpdatedTime) pair + seq — Rust never projects a
                UI-visible position; the frontend owns the clock. Emits are
                diff-suppressed and unchanged heartbeat ticks skip the snapshot, so a
                payload arrives only when the player's data actually moved
                (splits into media_core/ + adapters/ when M5 adds Spotify Web API)
  dock.rs       corner docking: window lives in one of the 4 work-area corners (12px
                margin, above the taskbar); free drag snaps to the nearest corner on
                release (Moved-debounce + GetAsyncKeyState — no drag-end event exists);
                mode resizes grow/shrink out of the docked corner (200ms EASE.inOut —
                on-screen morph; the snap glide keeps EASE.out, momentum inheritance;
                size+origin per frame in one SetWindowPos); corner derived from the
                window-state-restored position, never stored
  lyrics.rs     LRCLIB get→search fallback, disk cache (bounded, app-data) + session miss set
  audio.rs      WASAPI loopback (cpal input stream on the output device) → FFT →
                smoothed auto-gained band energies at ~30Hz; capture runs ONLY
                while visible AND playing (stream dropped otherwise)
src/            React widget: pill ↔ card ↔ expanded modes; lib/posClock.ts is the ONE
                owner of playback position (monotonic per track while playing — raw pairs
                in, display clock out; all seek/pause/jitter filtering lives there);
                expanded = karaoke lyrics view
                (click-line-to-seek) with big-art fallback; palette.ts accent extraction
src/icons/      morphing icon system (benji.org/morphing-icons-with-claude, generalized):
                every icon = 3 strokes × 2 cubics with identical command skeletons, so
                any icon morphs into any other by tweening d strings — geometry.ts is
                the data (stroke ORDER is the correspondence map; prev is deliberately
                order-swapped, don't re-sort), MorphIcon.tsx renders + morphs (slot
                registry carries the FROM glyph across App's mode-keyed remounts).
                Mode buttons: expand/contract corner brackets for the size ladder +
                a mic for the lyrics view — action verbs, not container pictograms
                (v1 pill/card/lyrics pictograms read as abstract shapes at 13px) and
                never a direction chevron. Dev sequencer: npm run dev → /?lab
```

Design rule: chrome stays neutral (house semantic tokens); the album-art palette is the **accent layer only** — progress fills, the **living separator** (src/Waveform.tsx — a colorless muted middot between artist and album that blooms into five Apple-style accent capsules while music plays and settles back on pause; replaces the em dash in every mode; the ONLY audio-reactive surface; supersedes the art-halo direction and the shell glow blessed 2026-07-06), and the current-lyric **marker** (the lyric line's text stays fg — extracted accents only guarantee 3:1, below the 4.5:1 text floor). No glow anywhere: the card shell shadow is neutral black and non-reactive (lift only), the art carries no shadow. The art never moves; nothing moves *ambiently* except the separator's bars — interactive icon glyphs may morph in response to input (press, mode change), per src/icons/. Accent never colors text or chrome surfaces. Motion uses EASE/DUR tokens — `/emil-pass` binds to them.

## Global hotkeys (M1 defaults, constants in src-tauri/src/lib.rs)

- `Ctrl+Alt+K` play/pause (Space variant was taken system-wide on this machine)
- `Ctrl+Alt+←/→` seek ∓10s (current session; the hotkey always fires the SMTC call — Apple Music silently ignores it, only the UI buttons are capability-gated)
- `Ctrl+Alt+N/P` next/previous track
- `Ctrl+Alt+M` show/hide the widget

Commands route to the OS "current" media session, which Windows re-points to
whichever app played most recently (pause AM while Spotify plays → next command
hits Spotify). The card shows the controlled app's brand icon (name in the
tooltip/aria-label) for this reason.

## Commands

- `npm run tauri dev` — run the app (requires Rust MSVC toolchain + VS Build Tools, both installed)
- `npm run tauri build` — release build
- `npm run dev` — frontend only (no Tauri window, limited use)

## Workflow

- PRs off `feature/*` branches, self-review + `/quick-review`; never commit to main.
- M0 support matrix (`docs/smtc-support-matrix.md`) is the source of truth for what Apple Music / Spotify honor over GSMTC — check it before assuming seek/position works.

## Gotchas (measured 2026-07-06, M0+M1 — details in docs/smtc-support-matrix.md)

- Thumbnail streams: AM's ContentType is a comma-separated list (invalid in a `data:` URL — take the first entry) and `ReadAsync` can return partial data (read chunked to the declared size).

- **Spotify seek/position work natively over SMTC** (as of 1.2.92) — the Web API adapter is only needed for like/unlike. Position is pushed ~every 5s; interpolate between pushes.
- **Apple Music has NO working programmatic seek path** (spiked exhaustively 2026-07-06): SMTC seek returns `true` and does nothing; synthesized accelerators are swallowed or skip tracks; UIA RangeValue.SetValue on both scrubbers is fail-silent/reverted (seek is wired to the drag gesture, not the value). Position still reports at 1s granularity. Never trust SMTC command bools — verify by re-reading the timeline.
- Apple Music packs `"<artist> — <album>"` into the Artist field (AlbumTitle empty) and **deregisters its session when playback stops** — treat session disappearance as a normal state.
- **GSMTC updates title/artist BEFORE the player attaches the new thumbnail** (worst on Apple Music) — the first art read after a track change can capture the previous track's image. media.rs distrusts that first read: for ~10s after a key change it re-reads and fingerprints the thumbnail each poll, bumping the art_id revision (`"{key}:{rev}"`) when the bytes change so the frontend re-fetches.
- Repo deliberately lives OFF OneDrive (`C:\Users\Thien\Projects\pulse`) — Vite misbehaves under OneDrive sync.
