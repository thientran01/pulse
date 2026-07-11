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
  lyrics.rs     LRCLIB get→search fallback, disk cache (bounded, app-data) + session
                miss set; candidate picking prefers ORIGINAL-SCRIPT synced entries
                (hangul/CJK/kana) over romanized uploads — a Latin-only exact hit
                waits UPGRADE_GRACE (3s, usually ~0: the search raced alongside)
                for the search to offer the upgrade; script preference stays
                BELOW synced-ness (hangul plain-only never beats romanized synced)
  history.rs    play-history: logs every track Pulse displays (player-agnostic —
                GSMTC has no history API) to append-only app-data/history.jsonl,
                no cap, paginated via an in-memory line index (history_page +
                "history-appended" seed/event pair). Fed from the media loop:
                visible rides emit_now's return; hidden probes ~5s via
                media::history_probe (art-free, no emit — the ONE exception to
                "no work while hidden", so conceal-hidden listens still log).
                ms_listened = wall-clock playing spans, NOT position projection
                (that rule guards the UI clock). Dedupe: pause/resume = one
                entry; AM session vanish + same track back within 10min resumes
                it; raw-position restart past the bar = replay = new entry;
                <1s listens dropped as skip churn; RunEvent::Exit flushes.
                Thumbs: bounded app-data/thumbs cache (96px JPEG) — the
                FRONTEND downscales once per art revision (useHistoryThumb;
                rev bumps overwrite, so a stale first capture heals)
  spotify.rs    Spotify Web API adapter (the app's first OAuth): PKCE +
                loopback redirect (127.0.0.1:43117/callback — the dashboard
                app must register EXACTLY that URI; SPOTIFY_CLIENT_ID const,
                public under PKCE — set 2026-07-10). Tokens in their own
                app-data/spotify_tokens.json (NOT clobber-write settings.json);
                refresh on demand <60s to expiry, single-flighted
                (refresh_gate) with rotation persisted. Tokens are destroyed
                ONLY on proof the session is dead (400-class token-endpoint
                answer, or a FRESH token still 401ing) — transport failures,
                5xx, and 403s (ambiguous: scope OR Premium-required) never
                are. "spotify-status" event + spotify_status seed. Scopes
                request read+modify up front so PR 3's play-now/feeder needs
                no re-consent. Queue read (spotify_queue) has a 5s response
                cache; ureq blocking in spawn_blocking per the lyrics.rs
                discipline; art comes as small remote URLs the webview loads
                directly. Tray item "Connect Spotify" ⇄ "Disconnect Spotify"
                doubles as state + flow narration — spotify.rs owns the
                narrator, so EVERY state transition re-syncs the label
                (frontend disconnects and background clears included); one
                consent flow at a time (in-flight guard). play_now = the
                context-preserving jump (position target in the real queue,
                skip to it, VERIFY the landing by re-read — never trust
                command results, matrix finding 3 — re-queue everything
                skipped over; never `PUT play uris`, which kills the
                playlist context). History enrichment: every settled track
                change on a connected session fetches currently-playing
                (enrich_now, one in-flight) and stamps the uri onto
                history's candidate — THE path that makes history rows
                actionable; un-enriched rows (older entries, AM listens)
                resolve on demand via spotify_resolve_uri (search, cached
                per key frontend-side)
  upnext.rs     Pulse-managed up-next: Spotify's API can't remove/reorder
                queue items, so Pulse keeps its OWN ordered list
                (app-data/upnext.json, "upnext-changed" + upnext_list seed;
                add/remove/move are local ops) and FEEDS Spotify one track
                when <15s of the current track remains (coarse raw-pair
                estimate — same never-reaches-the-UI carve-out as history's
                ms_listened; feed HTTP on the blocking pool, never the media
                loop thread). Fed marker persisted (no restart double-feed);
                fed item popped when it starts playing (loose title/artist
                match, with same-key restart detection so repeat-one and a
                re-queued current track behave); a change that BYPASSES a
                pending fed item keeps it armed and fires one reconcile
                read (still queued at Spotify → keep waiting; consumed
                where Pulse couldn't see → drop + unmark, feeder moves on)
                — the fed marker never floats free of ground truth. A next
                pressed IN PULSE (transport / Ctrl+Alt+N) is QUEUE-AWARE:
                upnext::try_queue_skip runs the play_now jump on the front
                (falling back to plain GSMTC next when it can't act), so a
                mid-song skip lands on the queued item instead of the
                playlist — the one transition feed-late missed; the
                "spotify-jump" event arms the pill's announcement
                suppression for it. Fed-pop
                bookkeeping and HISTORY ingestion both suspend while a
                play_now jump flickers through intermediates. Honest limits
                (matrix finding 11): chain holds only while Pulse runs +
                Spotify connected; skips inside the Spotify app bypass the
                list; removing a fed front leaks that one track to
                Spotify's queue
  presence.rs   fullscreen sensing + the courtesy conceal: own 1s watcher
                thread sensing settled fullscreen foreground content
                (rect-vs-monitor — widget-monitor scoped — OR'd with
                SHQueryUserNotificationState's GLOBAL D3D/presentation
                states; hysteresis 2s in / 1s out, self/shell excluded) →
                settled "presence" events (diff-suppressed + presence_state
                seed) plus a raw "presence-debug" stream while the dev
                overlay subscribes. The ONE action (conceal) flows through
                lib.rs's VisIntent + apply_visibility (see the Presence
                design paragraph). Idle sensing + the idle-driven behaviors
                (P3/P4) were REMOVED 2026-07-11 — see the design paragraph;
                don't re-propose. QUNS_BUSY is NOT a fullscreen signal (the
                alt-tab switcher fires it; fullscreen browser video fires it
                too — the rect method carries that case).
                docs/presence-signal-matrix.md is the source of truth for
                what Windows reports per scenario
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
                player; /?nothing forces the no-session resting state;
                /?spotify=off forces the queue gate, ?jump=partial the jump
                failure caption
src/Queue.tsx   the 11a queue & history UI: Pulse's up-next list + the
                "Earlier" history feed, TWO garments off ONE queueOpen bit —
                a 312px popover floating above the pill/card (corner-aware:
                opens away from the docked side; rides the mode resize on
                the shell's 200ms EASE.inOut; max-height from the REAL
                440px window: pill 330 / card 296) and an always-mounted
                content surface inside expanded (200ms in with the .98
                exhale, 140ms opacity out, visibility deferred — scroll and
                feed survive closing; chrome + toggles never move). The
                garment follows effectiveMode, so continuity across the
                ladder is free. WHILE THE POPOVER IS OPEN THE HIT RECT
                UNIONS ITS BOX (App's footprint effect) — a consumer that
                forgets this puts clicks through to the desktop, the worst
                failure class. Rows: 44px, hover-revealed actions
                (history: play-now/+, uri-gated on enrichment; queue:
                grip/×), pointer reorder with ±26px live swap, history→queue
                ghost-chip drag (history itself never reorders), accent/16
                flash + 1.6s aria-live toast, keyboard ↑/↓/Delete/Enter.
                play_now suppresses the pill announcement for intermediates
                (isAnnounceSuppressed) — the target announces once. The
                queue toggle left the bracket cluster (2026-07-11: brackets
                = container verbs, queue = content surface): card/expanded
                seat it bottom-left (QueueSeat, left-[7px] bottom-[4px] —
                mirrors the cluster and holds pixels across card⇄expanded);
                the pill seats it in the hover scrim beside play/pause
                ([queue][play/pause] on the cluster's gap-1 rhythm, ending
                108px from the shell right edge — the pill's bottom-left IS
                the album art). The cluster stays [collapse][expand]. The
                expanded note seat stays the ONLY lyrics entry and exits
                the queue surface to lyrics
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

Design rule: chrome stays neutral (house semantic tokens); the album-art palette is the **accent layer only** — progress fills, the **living separator** (src/Waveform.tsx — a colorless muted middot that blooms into Apple-style accent capsules while music plays and settles back on pause; the ONLY audio-reactive surface — one living instance per view, riding the TITLE line everywhere (the capsules are a now-playing pulse — they belong to the song), sized to its container (pill: `sm` inline between title·artist, where a track change while playing runs the **announcement** — the ladder collapses to the lone dot with the old song's color draining at the bottom, re-multiplies gray on the bloom cadence, and ignites LAST (in the incoming album's accent when the palette has resolved; AM art can lag ~10s, and the standard retint sweep recolors late arrivals); the keyed title/artist fade in up front (`.title-in`, mount-gated so a mode switch into the pill never replays it; `__mockNext()` drives it from console in preview) — separator vocabulary responding to a content event, not a new ambient license; card + expanded lyrics header: `md` trailing the title, bars-only while playing, 10px gap = ml-1 over the built-in mx-1.5, with the artist/album lines on a static `SeparatorDot` — an md separator overpowered the 12px line, 2026-07-10; expanded big-art: standalone `lg` hero, nine capsules, constant footprint so the art never moves, metadata line on a static `SeparatorDot`); supersedes the art-halo direction and the shell glow blessed 2026-07-06), and the current-lyric **marker** (the lyric line's text stays fg — extracted accents only guarantee 3:1, below the 4.5:1 text floor), plus the 11a queue feedback (the newly-queued row flash `accent/15` and the drop-zone glow `border-accent/55 bg-accent/5` — transient content feedback, handoff-licensed 2026-07-10, NOT a new ambient or chrome license). No glow anywhere: the card shell shadow is neutral black and non-reactive (lift only), the art carries no shadow. The art never moves; nothing moves *ambiently* except the separator's bars and the resting pulse (the no-session breathing dot) — interactive icon glyphs may morph in response to input (press, mode change), per src/icons/. Accent never colors text or chrome surfaces. Motion uses EASE/DUR tokens — `/emil-pass` binds to them. Transitions earn continuity by content identity: arrival choreography (the expanded view's lyric cascade) is reserved for content the user actually waited on; on a track change the outgoing view exits fast and plain — stale art/lyrics never get choreographed continuity, and chrome (transport/progress/mode cluster) holds still by living outside the swap.

**Presence (the courtesy layer):** the widget senses ONE thing — settled fullscreen foreground content (src-tauri/src/presence.rs) — and takes ONE action: the courtesy conceal. Fullscreen content on the widget's monitor (rect-vs-monitor, OR'd with SHQueryUserNotificationState's GLOBAL D3D/presentation states; hysteresis 2s in / 1s out) hides the native window; the episode ending restores it exactly as it was. Visibility is intent-composed (`VisIntent` in lib.rs) — a manual hide is sticky across episodes, a manual show (hotkey/tray/reset/relaunch) snoozes the conceal for the current episode, and **every show/hide flows through `apply_visibility`, never raw hide()/show()** (grep rule). The tray "Hide on fullscreen" check item (id/settings key still `companion`) is the persisted switch for the action (sensing continues). The resting pulse (the no-session breathing dot, `.resting-pulse`) stays — it reacts to the MUSIC being absent, not to the user. **The idle-driven behaviors (P3 ambient AFK grow, P4 working quiet) were REMOVED 2026-07-11 after two weeks of soak:** behaviors that guess at attention from idle timers (away thresholds, input duty) fought manual intent hard enough to need latches on latches; the conceal acts on a fact and never misfired. Do not re-propose idle-driven mode changes — PRs #57–#59 hold the machinery and the lessons if this is ever revisited. Presence never resizes or moves the native window, never touches accent or color, and manual input always wins. docs/presence-signal-matrix.md is the source of truth for what Windows actually reports — check it before trusting a detection path.


## Global hotkeys (M1 defaults, constants in src-tauri/src/lib.rs)

- `Ctrl+Alt+K` play/pause (Space variant was taken system-wide on this machine)
- `Ctrl+Alt+←/→` seek ∓10s (current session; the hotkey always fires the SMTC call — Apple Music silently ignores it, only the UI buttons are capability-gated)
- `Ctrl+Alt+N/P` next/previous track (next is queue-aware: lands on the up-next front when one exists)
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

Installed app: single-instance (relaunching surfaces the running widget), tray has an opt-in "Start at login" toggle (tauri-plugin-autostart, HKCU Run key — registers the current exe's path, so toggling from a dev build points it at the dev exe) and a "Hide on fullscreen" check item (the conceal switch, persisted to app-data settings.json under the legacy `companion` key; dev builds add "Simulate fullscreen (10s)" for conceal testing). Tray "Connect Spotify" ⇄ "Disconnect Spotify" runs the Web API OAuth (spotify.rs — label doubles as connection state and flow narration). Tray "Check for updates" runs the update flow on demand (label narrates Checking…/Installing…/Up to date). App icon source: five living-separator capsules on a dark rounded square; regenerate the set with `npx tauri icon <1024px.png>`.

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
