# Changelog

All notable changes to Palette are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Installed apps self-update at launch, so most users are always on the latest release.

## [Unreleased]

### Added

- `Playing on <device>` tag: when Spotify plays on a phone or speaker while this PC is only the controller, the card, expanded, and focus views say where the audio is — explaining a quiet waveform.
- Search's empty state now recommends: "From your history" resurfacing picks plus "Something different" Last.fm-powered discoveries, rotating through the day, with pull-to-refresh (`↑` at the top slot).
- Queue rows added from history carry the album cover, with a glyph fallback for dead art URLs.
- Uninstalling always removes the Spotify tokens from disk; play history, preferences, and caches survive unless the uninstaller's "Delete the application data" checkbox is ticked.
- A Content-Security-Policy on every window.

### Changed

- Focus mode's waveform returned to the horizon — 19 audio-reactive capsules on their own band between the identity stack and the console — and the focus queue became a room-scale content column seated in the lyric column.
- The "Launch mode" preference now actually governs which mode the widget wakes in; the "Seek amount" preference was removed (the UI buttons always hardcoded ±10s — only the hotkeys ever read it).
- Offline is now told apart from missing: lyric captions read "Lyrics unavailable — offline" vs "No synced lyrics" (offline is never cached as a miss), and instructional hints got an AA contrast lift.
- The expanded album view floats its "No synced lyrics" caption between the artist line and the wave instead of leaning the bars into it.
- A design polish pass: one-line alignment across preferences, search, and the queue; bright keycap hint glyphs in Search; and a 16-fix motion sweep.
- Hotkey seeks now spin the transport glyph, exactly like clicking the button.
- Launch got lighter: the play-history index builds in the background instead of on the launch path, and the hidden widget's click-through watcher wakes far less often.

### Fixed

- In-song silence no longer collapses and re-blooms the separator bars — a settle grace holds them while the track is still playing.
- The separator demotes a silent process capture to the device fallback instead of stranding the bars at zero. Apple Music lossless in WASAPI *exclusive* mode remains uncapturable by anything — documented, with the user-side workaround, in [docs/smtc-support-matrix.md](docs/smtc-support-matrix.md).

## [0.7.2] - 2026-07-14

The Palette release — the app is now **Palette**.

### Changed

- Renamed the app to **Palette** (installer, tray, windows); the `Ctrl+Alt+S` summon-search is now **Search**. The installer is keyed by product name, so self-updating from a "Pulse" install leaves the old entry side-by-side — uninstall "Pulse" once and re-toggle Start at login.
- Dropped "Segoe UI Variable Display" from the font stack — it rendered thin at UI sizes.
- Recomposed the focus room around the song block.
- The living separator's settle now exits outside-in and its bloom enters inside-out at every size; Search rows swap their "because you played" reason for controls on hover.
- Instrumental-break dots show only for the active break, the row collapses when it ends, and fills fade right-to-left.

### Added

- Preferences window (tray "Preferences…", with "Shortcuts / Help" jumping to hotkeys): Spotify and Last.fm connectors, rebindable global hotkeys (overrides persist; a system-reserved combo reports its failure), playback and general settings, and clearing play history.
- Onboarding: an empty-state nudge, a first-run bubble, and a right-click menu — plus honest gating: Spotify-powered features show an in-app Connect button, and "more like this" hides without a Last.fm key.
- Release logging: a rotating log file with panic capture, plus tray "Open logs"; config writes are now atomic, so a crash mid-write can't truncate settings.
- Housekeeping for the 1.0 push: MIT license, a real README, this changelog, and a CI build+test workflow.

### Fixed

- The media loop could wedge inside an unanswered Windows media read, freezing now-playing while the controls stayed alive — narrowed locking, per-call timeouts, and a watchdog.
- The recurring UI-thread "Application Hang": blocking media reads moved off the main thread at the hotkey and tray entry points, with a liveness watchdog.
- A React render throw can no longer strand the widget — an error boundary and global handlers catch it.
- The history feed could latch stuck after a failed fetch.

## [0.7.1] - 2026-07-13

### Changed

- Play history and up-next surfaces now show music only — podcasts, videos, and other non-music sessions are filtered out.
- The audio-reactive waveform is scoped to the app that is actually playing, so it no longer reacts to Discord voice or game sound effects.

### Added

- Flexible docking: place the widget freely anywhere on screen, with a corner magnet, edge rails, and a dedicated fullscreen seat that clears game HUDs and the taskbar.
- Corner-change glide: moving the widget to a different corner animates its layout to the new seat.

## [0.7.0] - 2026-07-12

The "hands + room" arc.

### Added

- Summon palette (`Ctrl+Alt+S`): a search-and-play command palette — Enter plays now, Shift+Enter queues to up-next, and from silence it starts playback outright.
- Focus mode: a fullscreen now-playing takeover ("Expand to focus") with room-scale lyrics and visualizer views.
- More-like-this: Last.fm similar tracks feed the up-next list.
- Instrumental-break countdown: five accent dots mark instrumental gaps in the lyrics view.

### Changed

- The expanded view now crossfades three peer layers — lyrics, album, and queue — under a fixed now-playing header.

## [0.6.4] - 2026-07-11

### Changed

- Queue-aware skip: pressing next (transport or `Ctrl+Alt+N`) lands on the up-next front when one exists, instead of the player's own next track.

## [0.6.3] - 2026-07-11

### Changed

- Re-seated the queue toggle out of the mode-bracket cluster — bottom-left in card/expanded, and in the pill's hover scrim beside play/pause.

## [0.6.2] - 2026-07-10

### Fixed

- Spotify writes failed with HTTP 411 — POST requests now send a `Content-Length` header, which Spotify's edge requires.

## [0.6.1] - 2026-07-10

### Fixed

- History rows are now actionable — track enrichment and on-demand search resolution wire up play-now and add-to-queue.

## [0.6.0] - 2026-07-10

Queue, history, Spotify, and the presence layer.

### Added

- Up-next queue and play history, surfaced through the "11a" queue & history UI (a corner-aware popover and an in-expanded peer layer).
- Spotify connection via OAuth (PKCE + loopback redirect) from the tray — queue read and play-history enrichment.
- Courtesy conceal: the widget auto-hides while fullscreen content owns its monitor and restores exactly when the episode ends (tray "Hide on fullscreen"); manual intent always wins.
- Resting pulse: a breathing dot for the no-session state, plus a track-change announcement in the living separator.

### Changed

- Lyrics picker prefers original-script (hangul/CJK/kana) synced entries over romanized uploads.
- The shell is now opaque — translucency without blur read as a hole.
- Icon press feedback: a skip pass-through flick and a mode-bracket verb pulse.

## [0.5.1] - 2026-07-09

### Changed

- The window never resizes: it is born at maximum size and every mode change is a CSS glide inside it, with cursor-polled click-through keeping the oversized gutter from eating desktop clicks. Removes per-frame animation shake from resizing the native window.

## [0.5.0] - 2026-07-09

### Changed

- Mode resizing finally feels native — a fixed content plane, frame pacing, and opacity-only enters (also folds in the earlier mock window frame and the animation-spec gap pass).

## [0.4.1] - 2026-07-09

### Changed

- Aligned the anchored mode-control cluster with every mode's transport centerline.

## [0.4.0] - 2026-07-08

### Added

- Expanded view toggle: show album art over lyrics on demand, with a nine-bar living-separator hero.

### Changed

- Dropped the "Now" label from the lyrics return-to-now chip.

## [0.3.0] - 2026-07-08

### Added

- Anchored mode controls: a fixed bottom-right collapse/expand bracket cluster stepping pill ↔ card ↔ expanded.

### Changed

- Tuned the living separator tighter to the music.

## [0.2.2] - 2026-07-08

### Added

- The expanded art view promotes the living separator to a seven-bar hero.

### Fixed

- Cut lyric first-appearance latency with a parallel fetch ladder and latest-wins resolution.

## [0.2.1] - 2026-07-08

### Added

- Tray "Check for updates" with in-label progress feedback.
- Lyrics browsing: a "Now" chip, magnetic re-latch, and a 2s idle resume.

## [0.2.0] - 2026-07-08

First public release.

### Added

- The always-on-top mini player (pill ↔ card ↔ expanded) controlling whatever is playing on Windows through the system media API (GSMTC): Apple Music, Spotify, and browsers.
- Synced lyrics (LRCLIB with disk cache), album-art adaptive accents, an audio-reactive "living separator", corner docking, morphing icons, and a monotonic position clock owning playback time.
- Ships as a per-user NSIS installer — single-instance, opt-in start-at-login — with a GitHub Releases auto-update pipeline and an in-app updater.

[Unreleased]: https://github.com/thientran01/palette/compare/v0.7.2...HEAD
[0.7.2]: https://github.com/thientran01/palette/compare/v0.7.1...v0.7.2
[0.7.1]: https://github.com/thientran01/palette/compare/v0.7.0...v0.7.1
[0.7.0]: https://github.com/thientran01/palette/compare/v0.6.4...v0.7.0
[0.6.4]: https://github.com/thientran01/palette/compare/v0.6.3...v0.6.4
[0.6.3]: https://github.com/thientran01/palette/compare/v0.6.2...v0.6.3
[0.6.2]: https://github.com/thientran01/palette/compare/v0.6.1...v0.6.2
[0.6.1]: https://github.com/thientran01/palette/compare/v0.6.0...v0.6.1
[0.6.0]: https://github.com/thientran01/palette/compare/v0.5.1...v0.6.0
[0.5.1]: https://github.com/thientran01/palette/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/thientran01/palette/compare/v0.4.1...v0.5.0
[0.4.1]: https://github.com/thientran01/palette/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/thientran01/palette/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/thientran01/palette/compare/v0.2.2...v0.3.0
[0.2.2]: https://github.com/thientran01/palette/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/thientran01/palette/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/thientran01/palette/releases/tag/v0.2.0
