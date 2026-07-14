# Changelog

All notable changes to Palette are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Installed apps self-update at launch, so most users are always on the latest release.

## [Unreleased]

### Changed

- Renamed the app to **Palette**; the `Ctrl+Alt+S` summon-search is now **Search**.

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

[Unreleased]: https://github.com/thientran01/palette/compare/v0.7.1...HEAD
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
