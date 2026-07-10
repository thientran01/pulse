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
                release (Moved-debounce + GetAsyncKeyState — no drag-end event exists;
                glide stays native EASE.out — pure moves never shake). The window
                NEVER RESIZES after launch: born at WINDOW_MAX (tauri.conf =
                MODE_SIZES.expanded, keep in sync), docked once; every mode change
                is the shell's 200ms EASE.inOut CSS glide inside it. NEVER resize
                the native window for animation — WebView2's composited frame lags
                the rect one frame, so per-frame animation shakes (measured v0.5.0)
                and even a single snap blinks (measured PR #51). The oversized
                window's gutter is kept from eating clicks by spawn_hit_watcher:
                cursor-polled whole-window click-through (set_ignore_cursor_events)
                gated on the frontend-reported hit rect (set_hit_size, the mode's
                footprint at the docked corner). Docked corner is pushed to the
                webview ("dock-corner" event + dock_corner seed command); corner
                derived from the window-state-restored position, never stored
  lyrics.rs     LRCLIB get→search fallback, disk cache (bounded, app-data) + session miss set
  presence.rs   presence engine: own 1s watcher
                thread sensing fullscreen foreground content (rect-vs-monitor —
                widget-monitor scoped — OR'd with SHQueryUserNotificationState's
                D3D/presentation states, which are GLOBAL; hysteresis-settled
                2s in / 1s out, self/shell excluded) and input idleness
                (GetLastInputInfo; away at 180s, 15s in debug builds) → settled
                "presence" events (diff-suppressed + presence_state seed) plus a
                raw "presence-debug" stream while the dev overlay subscribes.
                docs/presence-signal-matrix.md is the source of truth for what
                Windows reports per scenario — no behavior ships on an
                unmeasured signal. QUNS_BUSY is NOT a fullscreen signal (the
                alt-tab switcher fires it). Actions live behind lib.rs's
                VisIntent + apply_visibility (see the Presence design
                paragraph): P1 conceal, P2 resting pulse, P3 ambient AFK
                grow, P4 working quiet — all four clauses shipped
  audio.rs      WASAPI loopback (cpal input stream on the output device) → FFT →
                smoothed auto-gained band energies at ~30Hz; capture runs ONLY
                while visible AND playing (stream dropped otherwise)
src/            React widget: pill ↔ card ↔ expanded modes; lib/posClock.ts is the ONE
                owner of playback position (monotonic per track while playing — raw pairs
                in, display clock out; all seek/pause/jitter filtering lives there);
                expanded = karaoke lyrics view (click-line-to-seek — clicks land
                VOCAL_LEAD_MS before the line so the clicked line is the one that
                highlights) with big-art fallback, plus a hover-revealed top-right
                view toggle (mic ⇄ note; disabled crossed-out mic on a lyrics
                miss) that lets art win over available lyrics — persisted as
                pulse.expandedView; palette.ts accent extraction.
                Per-player timing constants (posClock JITTER_BAND_MS, lrc
                VOCAL_LEAD_MS) mirror docs/smtc-support-matrix.md — update both
                together. Browser mock: npm run dev → /?am replays Apple Music's
                pathological emit profile (1s-floored positions, pause-era stamp on
                resume, can_seek=false) for posClock repro without a live
                player; /?nothing forces the no-session resting state
src/icons/      morphing icon system (benji.org/morphing-icons-with-claude, generalized):
                every icon = 3 strokes × 2 cubics with identical command skeletons, so
                any icon morphs into any other by tweening d strings — geometry.ts is
                the data (stroke ORDER is the correspondence map; prev is deliberately
                order-swapped, don't re-sort), MorphIcon.tsx renders + morphs (slot
                registry carries the FROM glyph across App's mode-keyed remounts).
                Mode buttons: expand/contract corner brackets stepping the
                pill↔card↔expanded ladder from ONE anchored cluster at the
                bottom-right corner (rendered once in the app root, outside the
                mode-keyed remount — docked bottom-right it holds the same
                screen pixels in every mode; end buttons disable in place, never
                unmount) — action verbs, not container pictograms (v1
                pill/card/lyrics pictograms read as abstract shapes at 13px) and
                never a direction chevron. Dev sequencer: npm run dev → /?lab
```

Design rule: chrome stays neutral (house semantic tokens); the album-art palette is the **accent layer only** — progress fills, the **living separator** (src/Waveform.tsx — a colorless muted middot that blooms into Apple-style accent capsules while music plays and settles back on pause; the ONLY audio-reactive surface — one living instance per view, riding the TITLE line everywhere (the capsules are a now-playing pulse — they belong to the song), sized to its container (pill: `sm` inline between title·artist; card + expanded lyrics header: `md` trailing the title, bars-only while playing, 10px gap = ml-1 over the built-in mx-1.5, with the artist/album lines on a static `SeparatorDot` — an md separator overpowered the 12px line, 2026-07-10; expanded big-art: standalone `lg` hero, nine capsules, constant footprint so the art never moves, metadata line on a static `SeparatorDot`); supersedes the art-halo direction and the shell glow blessed 2026-07-06), and the current-lyric **marker** (the lyric line's text stays fg — extracted accents only guarantee 3:1, below the 4.5:1 text floor). No glow anywhere: the card shell shadow is neutral black and non-reactive (lift only), the art carries no shadow. The art never moves; nothing moves *ambiently* except the separator's bars and the resting pulse (the no-session breathing dot, Presence clause 2) — interactive icon glyphs may morph in response to input (press, mode change), per src/icons/. Accent never colors text or chrome surfaces. Motion uses EASE/DUR tokens — `/emil-pass` binds to them. Transitions earn continuity by content identity: arrival choreography (the expanded view's lyric cascade) is reserved for content the user actually waited on; on a track change the outgoing view exits fast and plain — stale art/lyrics never get choreographed continuity, and chrome (transport/progress/mode cluster) holds still by living outside the swap.

**Presence (the companion layer):** the widget senses device context — fullscreen foreground content and input idleness (src-tauri/src/presence.rs) — and may act on it ONLY in the licensed ways below. **(1) Courtesy conceal (P1):** settled fullscreen content hides the native window and restores it after; visibility is intent-composed (`VisIntent` in lib.rs) — a manual hide is sticky across episodes, a manual show (hotkey/tray/reset/relaunch) snoozes the conceal for the current episode, and **every show/hide flows through `apply_visibility`, never raw hide()/show()** (grep rule). The tray "Companion mode" check item is the persisted master switch for presence ACTIONS (sensing continues). **(2) The resting pulse (P2):** with no media session, ONE muted dot breathes — the separator's resting middot with nothing to separate (`.resting-pulse`, index.css) — opacity-only, 8s period on `--ease-in-out-tk`, collapsed to a static dot by the global reduced-motion kill, no accent (no art ⇒ the accent layer is absent by design). The "nothing moves ambiently except the separator's bars" rule now reads "…except the separator's bars and the resting pulse." **(3) The ambient AFK grow (P3):** away (180s of input silence; 15s in debug builds) while music plays promotes `effectiveMode` to expanded (`presenceOverride` in App.tsx, layered over the persisted `mode`, which NEVER changes and is never persisted from an override) — the arrival is the plain crossfade and a lyric resolve during ambient never earns the cascade (`plainArrival`); ANY input returns it to the user's mode fast and plain (backend flips active within one 1s tick), conceal always wins (`!concealed` in the trigger), `stepMode` steps from the EFFECTIVE mode (a press during ambient does exactly what its label says, persists like any explicit choice, and disarms re-fire until a fresh active period), and a re-fire otherwise needs a full new away period. Every mode consumer (shell size, AnimatePresence key, ModeContent, content branches, ModeCluster, hit rect) keys on `effectiveMode` — a consumer left on `mode` desyncs the shell from the click-through rect, the worst failure class in this app. **(4) Working quiet (P4):** sustained input duty (≥60% of the last 120s saw input; 20s window in debug builds) with a media session loaded shrinks a louder-than-pill mode to the pill via the same override slot — it never applies while the cursor is on the widget (the change must not happen under the user's eye; it waits for hot=false), and ONE manual overrule (stepMode during the override) suppresses it until a REAL away period re-arms it. Exit is the duty decaying below the bar (~1min of lighter input) — the widget grows back to the user's mode. Precedence: conceal > working quiet > ambient grow (user states are mutually exclusive; conceal gates both). Presence never resizes or moves the native window, never touches accent or color, is hysteresis-gated at every threshold (no flapping), and manual input always wins. docs/presence-signal-matrix.md is the source of truth for what Windows actually reports — check it before trusting a detection path.

**Presence (the companion layer):** the widget senses device context — fullscreen foreground content and input idleness (src-tauri/src/presence.rs) — and may act on it ONLY in the licensed ways below (clauses land with their milestones; P2–P4 pending). **(1) Courtesy conceal (P1):** settled fullscreen content hides the native window and restores it after; visibility is intent-composed (`VisIntent` in lib.rs) — a manual hide is sticky across episodes, a manual show (hotkey/tray/reset/relaunch) snoozes the conceal for the current episode, and **every show/hide flows through `apply_visibility`, never raw hide()/show()** (grep rule). The tray "Companion mode" check item is the persisted master switch for presence ACTIONS (sensing continues). Presence never resizes or moves the native window, never touches accent or color, is hysteresis-gated at every threshold (no flapping), and manual input always wins. docs/presence-signal-matrix.md is the source of truth for what Windows actually reports — check it before trusting a detection path.

## Global hotkeys (M1 defaults, constants in src-tauri/src/lib.rs)

- `Ctrl+Alt+K` play/pause (Space variant was taken system-wide on this machine)
- `Ctrl+Alt+←/→` seek ∓10s (current session; the hotkey always fires the SMTC call — Apple Music silently ignores it, only the UI buttons are capability-gated)
- `Ctrl+Alt+N/P` next/previous track
- `Ctrl+Alt+M` show/hide the widget

Commands route to the OS "current" media session, which Windows re-points to
whichever app played most recently (pause AM while Spotify plays → next command
hits Spotify). The controlled-app brand icon (PlayerBadge) was removed in the
anchored-cluster redesign (2026-07-08, Thien's call) — the seek-unsupported
tooltip still names the app, but no persistent surface shows which app is
being controlled.

## Commands

- `npm run tauri dev` — run the app (requires Rust MSVC toolchain + VS Build Tools, both installed)
- `npm run tauri build` — release build → NSIS per-user installer at `src-tauri/target/release/bundle/nsis/Pulse_<version>_x64-setup.exe` (unsigned; SmartScreen warns on other machines). Needs `TAURI_SIGNING_PRIVATE_KEY="$(cat ~/.tauri/pulse.key)"` in the env now that updater artifacts are signed — without it the bundler errors after compiling (the `_PATH` variant does NOT work despite `tauri signer generate`'s help text — measured 2026-07-08).
- `npm run dev` — frontend only (no Tauri window, limited use)

Installed app: single-instance (relaunching surfaces the running widget), tray has an opt-in "Start at login" toggle (tauri-plugin-autostart, HKCU Run key — registers the current exe's path, so toggling from a dev build points it at the dev exe) and a "Companion mode" check item (presence-action master switch, persisted to app-data settings.json; dev builds add "Simulate fullscreen (10s)" for conceal testing). Tray "Check for updates" runs the update flow on demand (label narrates Checking…/Installing…/Up to date). App icon source: five living-separator capsules on a dark rounded square; regenerate the set with `npx tauri icon <1024px.png>`.

Releases: bump `version` in tauri.conf.json (+ Cargo.toml/package.json to match), merge, then `git tag vX.Y.Z && git push origin vX.Y.Z` — the release.yml workflow builds, signs the updater artifacts, and publishes a GitHub Release with latest.json. Installed apps self-update at launch (release builds only; `#[cfg(not(debug_assertions))]`). Updater keypair: `~/.tauri/pulse.key` (private, empty password, mirrored in the repo's `TAURI_SIGNING_PRIVATE_KEY` secret — LOSING IT ORPHANS ALL INSTALLS) / pubkey pinned in tauri.conf.json.

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
