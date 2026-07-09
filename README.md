# Pulse

An always-on-top mini music player for Windows. Reads and controls whatever is playing — Apple Music, Spotify, browsers — through the Windows system media API (GSMTC), with synced lyrics, album-art adaptive accents, audio-reactive visuals, and global hotkeys.

## Install

Grab `Pulse_x.y.z_x64-setup.exe` from the [latest release](https://github.com/thientran01/pulse/releases/latest) and run it — per-user install, no admin required. Pulse lives in the system tray; the widget docks to a corner of your screen and stays on top. Installed copies check for updates at launch and update themselves.

> The installer is currently unsigned, so Windows SmartScreen will warn on first run ("More info" → "Run anyway").

**Hotkeys:** `Ctrl+Alt+K` play/pause · `Ctrl+Alt+←/→` seek ±10s · `Ctrl+Alt+N/P` next/previous · `Ctrl+Alt+M` show/hide

**Tray menu:** Show/Hide · Reset position · Start at login (opt-in) · Quit

## Build from source

Requires Node 20+, Rust (MSVC toolchain), and the VS Build Tools.

```sh
npm install
npm run tauri dev     # run the app
npm run tauri build   # installer → src-tauri/target/release/bundle/nsis/
```

## Player support

What each player honors over GSMTC is measured, not assumed — see [docs/smtc-support-matrix.md](docs/smtc-support-matrix.md). Notably: Spotify supports seek natively; Apple Music has no working programmatic seek path at all.

## Stack

Tauri v2 (Rust) · React 19 + TypeScript + Vite · Tailwind v4 · WASAPI loopback + FFT for the audio-reactive layer · LRCLIB for synced lyrics.
