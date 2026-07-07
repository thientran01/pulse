# Pulse

A Raycast/Linear-grade mini music player for Windows. Always-on-top widget that reads and controls whatever is playing (Apple Music, Spotify, browsers) through the Windows system media API (GSMTC), with synced lyrics, album-art adaptive accents, audio-reactive visuals, and ±10s seek. Built because Apple Music's miniplayer minimizes on every click and feels dead. Personal project; portfolio /lab candidate.

Full plan: `C:\Users\Thien\.claude\plans\i-want-to-start-buzzing-wreath.md` (milestones M0–M5).

## Stack

- **Tauri v2** — Rust backend, frameless/transparent/always-on-top window
- **React 19 + TypeScript + Vite 7** frontend, **Tailwind v4** (CSS-first config), **motion** for layout morphs
- Rust side: `win-gsmtc` (GSMTC session watcher), WASAPI loopback + FFT (M4), LRCLIB lyrics fetch (M3), Spotify Web API adapter (M5)

## Architecture

```
src-tauri/src/
  media.rs      GSMTC poller → now-playing events + transport/seek commands + art cache
                (M1 state — splits into media_core/ + adapters/ when M5 adds Spotify Web API)
  audio/        (M4) WASAPI loopback → FFT → ~30Hz band-energy events (suspends when hidden)
  lyrics/       (M3) LRCLIB lookup + disk cache
src/            React widget: pill ↔ card ↔ expanded size modes (M2; expanded = big-art
                view — the lyrics panel arrives in M3) + palette.ts accent extraction
```

Design rule: chrome stays neutral (house semantic tokens); the album-art palette is the **accent layer only** — progress fills, art glow, the **ambient shell glow** (blessed 2026-07-06: the card's outer accent glow is the surface M4's audio-reactive glow drives; it counts toward the accent budget in every mode), and the current lyric line (M3). Accent never colors text or chrome surfaces. Motion uses EASE/DUR tokens — `/emil-pass` binds to them.

## Global hotkeys (M1 defaults, constants in src-tauri/src/lib.rs)

- `Ctrl+Alt+K` play/pause (Space variant was taken system-wide on this machine)
- `Ctrl+Alt+←/→` seek ∓10s (current session; the hotkey always fires the SMTC call — Apple Music silently ignores it, only the UI buttons are capability-gated)
- `Ctrl+Alt+N/P` next/previous track
- `Ctrl+Alt+M` show/hide the widget

Commands route to the OS "current" media session, which Windows re-points to
whichever app played most recently (pause AM while Spotify plays → next command
hits Spotify). The card shows the controlled app's name for this reason.

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
- **Apple Music silently ignores seek** (returns `true`, does nothing, playing or paused) and reports position at 1s granularity. Never trust SMTC command bools — verify by re-reading the timeline.
- Apple Music packs `"<artist> — <album>"` into the Artist field (AlbumTitle empty) and **deregisters its session when playback stops** — treat session disappearance as a normal state.
- Repo deliberately lives OFF OneDrive (`C:\Users\Thien\Projects\pulse`) — Vite misbehaves under OneDrive sync.
