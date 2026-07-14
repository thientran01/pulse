# Palette

A Raycast/Linear-grade mini music player for Windows. Apple Music's own miniplayer minimizes on every click and feels dead — so Palette is an always-on-top widget that never minimizes and controls whatever's playing.

It reads and controls any player that speaks the Windows system media API (GSMTC) — Apple Music, Spotify, browsers — with synced lyrics, album-art adaptive theming, audio-reactive visuals, and ±10s seek.

## Features

- **Universal now-playing read/control** over GSMTC — Apple Music, Spotify, and browser players, no per-app integration
- **Morphing modes** — a pill that expands to a card and then to a full expanded view, each a continuous layout morph
- **Synced lyrics** from [LRCLIB](https://lrclib.net) with whole-line karaoke highlight, click-a-line-to-seek, and an instrumental-break countdown
- **Album-art adaptive accent theming** — the cover's palette drives progress fills and accents while chrome stays neutral
- **The audio-reactive "living separator"** — process-scoped WASAPI loopback + FFT drives capsules that bloom to the song (scoped to the playing app, so it rides the music, not your whole device mix)
- **±10s seek** where the player supports it (Spotify natively; see player support below)
- **Four-corner docking** with free placement — drag anywhere, a corner magnet snaps it home, and it stays out of the way
- **Fullscreen focus-mode takeover** — a room-scale now-playing view with lyrics or the visualizer
- **Search** (`Ctrl+Alt+S`) — search and play, queue, or resurface tracks from history
- **Managed up-next queue + play history** — a Palette-kept queue and a full log of everything it displayed
- **"More like this"** discovery from the current track
- **Hide on fullscreen** — a courtesy conceal that ducks the widget out of games and fullscreen video, then restores it exactly
- **Global hotkeys** for transport, seek, show/hide, and search
- **Self-updating installer** — installed copies check for updates at launch and update themselves

## Install

Grab `Palette_x.y.z_x64-setup.exe` from the [latest release](https://github.com/thientran01/palette/releases/latest) and run it. Per-user install, no admin required. Palette lives in the system tray; the widget docks to a corner of your screen and stays on top.

The installer is unsigned, so on first run Windows SmartScreen shows a **"Windows protected your PC"** dialog. To run it:

1. Click **More info**.
2. Click **Run anyway**.

That's a one-time prompt — SmartScreen won't warn again once the app is installed.

## Hotkeys

| Shortcut | Action |
|---|---|
| `Ctrl+Alt+K` | Play / pause |
| `Ctrl+Alt+←` / `Ctrl+Alt+→` | Seek −10s / +10s |
| `Ctrl+Alt+N` / `Ctrl+Alt+P` | Next / previous track |
| `Ctrl+Alt+M` | Show / hide the widget |
| `Ctrl+Alt+S` | Summon search |

Transport commands route to whatever Windows considers the current media session — which it re-points to whichever app played most recently.

## Tray menu

Show / Hide · Reset position · Start at login · Hide on fullscreen · Connect Spotify · Check for updates · Quit

## Player support

What each player actually honors over GSMTC is **measured, not assumed** — the results live in [docs/smtc-support-matrix.md](docs/smtc-support-matrix.md). The headlines:

- **Spotify** supports seek natively over SMTC — ±10s lands in ~50ms, both directions.
- **Apple Music** has no working programmatic seek path (SMTC seek is silently ignored, keyboard accelerators are swallowed, UIA value writes revert). Palette ships AM with a display-only progress bar and the seek buttons gated off. Position and lyric sync still work.

## Spotify & Last.fm (optional)

The core widget works for **everyone, with zero setup** — now-playing, play/pause, next/previous, seek where the player supports it, synced lyrics, and the audio-reactive visuals all run straight off GSMTC.

A few power features are Spotify-powered and opt-in. Connect Spotify from the tray to unlock:

- Search's play-now and queue actions,
- the managed up-next queue,
- "more like this" discovery,
- play-now from history.

Two honest caveats:

- The Spotify app is in **Development Mode**, so connecting is currently limited to accounts the developer has allow-listed.
- **"More like this"** additionally needs your own [Last.fm API key](https://www.last.fm/api/account/create).

Everything above is an optional power tier layered on top — the base player never needs any of it.

## Build from source

Requires Node 20+, Rust (MSVC toolchain), and the VS Build Tools.

```sh
npm install
npm run tauri dev     # run the app
npm run tauri build   # installer → src-tauri/target/release/bundle/nsis/
```

## Stack

Tauri v2 (Rust) · React 19 + TypeScript + Vite · Tailwind v4 · WASAPI loopback + FFT for the audio-reactive layer · LRCLIB for synced lyrics.

## Screenshots

<!-- TODO: hero screenshot (expanded lyrics view) + a short GIF of the pill↔card↔expanded ladder — added with the screenshots task -->
