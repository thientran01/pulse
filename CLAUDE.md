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
  media_core/   GSMTC watcher → NowPlaying events + play_pause/next/prev/seek commands
  adapters/     spotify.rs (Web API: position/seek/like) · apple_music.rs (quirks)
  audio/        WASAPI loopback → FFT → ~30Hz band-energy events (suspends when hidden)
  lyrics/       LRCLIB lookup + disk cache
src/            React widget: pill ↔ card ↔ expanded-lyrics modes
```

Design rule: chrome stays neutral (house semantic tokens); the album-art palette is the **accent layer only** (glow, progress fill, current lyric line). Motion uses EASE/DUR tokens — `/emil-pass` binds to them.

## Commands

- `npm run tauri dev` — run the app (requires Rust MSVC toolchain + VS Build Tools, both installed)
- `npm run tauri build` — release build
- `npm run dev` — frontend only (no Tauri window, limited use)

## Workflow

- PRs off `feature/*` branches, self-review + `/quick-review`; never commit to main.
- M0 support matrix (`docs/smtc-support-matrix.md`) is the source of truth for what Apple Music / Spotify honor over GSMTC — check it before assuming seek/position works.

## Gotchas (M0-verified 2026-07-06 — details in docs/smtc-support-matrix.md)

- **Spotify seek/position work natively over SMTC** (as of 1.2.92) — the Web API adapter is only needed for like/unlike. Position is pushed ~every 5s; interpolate between pushes.
- **Apple Music silently ignores seek** (returns `true`, does nothing, playing or paused) and reports position at 1s granularity. Never trust SMTC command bools — verify by re-reading the timeline.
- Apple Music packs `"<artist> — <album>"` into the Artist field (AlbumTitle empty) and **deregisters its session when playback stops** — treat session disappearance as a normal state.
- Repo deliberately lives OFF OneDrive (`C:\Users\Thien\Projects\pulse`) — Vite misbehaves under OneDrive sync.
