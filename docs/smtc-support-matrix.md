# SMTC support matrix — M0 spike results

Measured 2026-07-06 on Windows 11 Pro (26200) with `spikes/smtc-spike` (windows-rs 0.61, `Windows.Media.Control`).
**Apple Music** 1.1540.23042.0 (Microsoft Store) · **Spotify** 1.2.92.147 (desktop).
Behavior is version-dependent — re-run the spike if either app updates significantly.

| Capability | Apple Music | Spotify |
|---|---|---|
| Session registers | ✅ while playing/paused | ✅ |
| Title / artist | ✅ (⚠️ artist quirk, below) | ✅ |
| Album | ⚠️ empty — packed into artist | ✅ |
| Album art (thumbnail ref) | ✅ full byte-read verified (⚠️ quirks below) | ✅ full byte-read verified |
| Position reported | ✅ 1 s granularity, fresh every poll | ✅ ms precision, pushed ~every 5 s |
| Play/pause | ✅ | ✅ |
| Next / prev | ✅ (⚠️ stop quirk, below) | ✅ flags true; playpause verified, next/prev not fired |
| **Seek** (`TryChangePlaybackPosition`) | ❌ **ignored** — playing AND paused; flag honestly reports `false` | ✅ **±10 s lands within ~50 ms, both directions** |
| FF / RW control flags | `false` | `true` |
| Play history | ✅ Pulse-logged | ✅ Pulse-logged — GSMTC has no history API; history.rs builds it from Pulse's own stream (⚠️ finding 10) |
| Queue (read/manage) | ❌ no API at all (UIA scraping rejected — see seek verdicts) | ⚠️ Web API read+append only; NO remove/reorder → Pulse-managed up-next (⚠️ finding 11) |
| Play a queued/history track now | ❌ | ⚠️ compound skip-and-requeue jump, context-preserving (⚠️ finding 11) |

## Findings that change the plan

1. **Spotify seek/position work natively over SMTC** — the widely-cited "Spotify doesn't report position" limitation is stale as of 1.2.92. The M5 Spotify Web API adapter demotes from *required for seek* to *optional* (like/unlike, richer metadata only). ±10 s, scrub, and lyric sync all work SMTC-native for Spotify.
2. **Apple Music does NOT honor seek** — `IsPlaybackPositionEnabled: false` and real seeks are silently ignored (even paused). M1 options: (a) probe the AM app's own keyboard shortcuts via focused-window automation (last-resort per plan), or (b) ship AM with a display-only progress bar and no ±10 s initially. Position/lyric sync still fine — position reports at 1 s granularity.
3. **Never trust the command bools.** AM returns `accepted: true` for seeks it ignores. Verification = re-read `GetTimelineProperties` after commanding.
4. **AM deregisters its session when playback stops.** A `prev` fired ~1 s into a track stopped playback and the session vanished from GSMTC (did not return). Session appearance/disappearance is a *normal* state transition — the widget needs an explicit "nothing playing" state and cannot resurrect a closed session via SMTC.
5. **AM metadata quirk:** `Artist` comes back as `"<artist> — <album>"` (em-dash separated) with `AlbumTitle` empty. The apple_music adapter must split on `" — "` for LRCLIB lookups and display.
6. **Spotify position is pushed ~every 5 s** — between pushes, interpolate: `position + (now − last_updated)` while status is Playing. AM position is fresh on every poll at 1 s granularity.
7. *(M1, 2026-07-06)* **AM's thumbnail `ContentType` is a comma-separated LIST** (`image/jpeg,image/jpe,image/jpg`) — commas are invalid inside a `data:` URL; take the first entry. Spotify reports a single `image/png`.
8. *(M1, 2026-07-06)* **Thumbnail `ReadAsync` may return fewer bytes than requested** — a single read can yield a truncated image that fails to decode. Read chunked until the declared size is reached (and cap the final request to the remainder).
9. *(soak, 2026-07-07)* **AM's real backward-projection jitter tail reaches ~1.5 s**, not the ≤1 s the granularity alone implies: floor quantization stacks with stamp/delivery lag. Measured from a 2,265-payload live capture — 8 of 13 tracks produced one ~1.2–1.5 s backward step. posClock's apple_music jitter band is sized 2 s with headroom above the measured tail; nothing legitimate lives under 2 s on AM (no programmatic seek, manual scrubs are larger). Same capture: LRCLIB can degrade to 7–9 s first-byte — the lyrics timeout must stay well above that.
10. *(queue/history PR 1, 2026-07-10)* **Play history is Pulse-built, not an OS/API read** — neither GSMTC nor either player exposes history. history.rs tracks the media loop's own stream: pause/resume = one entry; an AM session vanish (finding 4) followed by the same track within 10 min resumes the same entry; a raw-position restart near 0 after passing max(30 s, 60% duration) = a replay = a new entry; listens under 1 s are dropped as skip-through churn. While the window is hidden (P1 conceal) an art-free `history_probe` keeps feeding it at ~5 s cadence — the one narrow exception to "the media loop does no work while hidden."
11. *(queue/history PR 3, 2026-07-10)* **Spotify's queue API is asymmetric — Pulse manages its own up-next.** `GET /me/player/queue` reads ~20 items (user-queued + autoplay, indistinguishable); `POST /me/player/queue` appends to the END; there is NO public remove or reorder. So upnext.rs keeps Pulse's own ordered list and feeds Spotify the front item when <15 s of the current track remains — remove/reorder/insert are local. Honest limits: the chain holds only while Pulse runs and Spotify is connected (otherwise the playlist continues naturally); skips made inside the Spotify app pull Spotify's own queue and bypass Pulse's list (skips made IN PULSE are queue-aware since v0.6.4 — try_queue_skip routes them through the jump); removing a fed front item leaks that one track into Spotify's queue; foreign items queued in the Spotify app play before fed items. "Play now" is a compound jump (spotify.rs play_now): position the target in the real queue, skip to it (~150 ms apart), VERIFY the landing by re-read (finding 3 — never trust command results), re-queue everything skipped over — never `PUT play uris`, which destroys the playlist context.

## Apple Music seek fallbacks tested (2026-07-06, M1)

All measured with `smtc-spike amseek` / `amappcmd` (focus-flick via AttachThreadInput + modifier-tap
SetForegroundWindow grant — the flick itself works; `set_foreground=true`):

| Approach | Result |
|---|---|
| `WM_APPCOMMAND` MEDIA_FAST_FORWARD / REWIND to the AM window | ❌ returns 0, unhandled |
| Synthesize Ctrl+←/→ | ❌ that's **prev/next track** (skips the song!) |
| Synthesize Ctrl+Shift+←/→ | ❌ also track skip |
| Synthesize Alt+Ctrl+←/→ (Apple's documented in-song seek) | ❌ swallowed / ≤1s effect, even with KEYEVENTF_EXTENDEDKEY and a Ctrl-tap (not Alt-tap) foreground grant |

**Verdict:** keystroke injection is unusable for AM seek. M1 ships AM with a display-only
progress bar (±10s buttons capability-gated off).

## UIA scrubber-slider fallback tested (2026-07-06, post-v1 spike)

Both AM windows expose their scrubber via UIA with a writable RangeValuePattern
(`smtc-spike uialist` / `uiaseek2`, AM 1.1540):

| Window | Slider | Range | RangeValue.SetValue result |
|---|---|---|---|
| "Apple Music" (main) | `LCDScrubber` | 0..duration s | ✅ returns S_OK → ❌ **silently ignored** (slider keeps advancing with playback, SMTC unmoved) |
| "MiniPlayer" | `Scrubber` | 0..duration s | ✅ returns S_OK → thumb **visually moves**, then **snaps back ~1s later**; SMTC never moves |

AM's seek is wired to the pointer **drag gesture**, not the slider's value property —
programmatic value writes are reverted by the app's own re-sync.

**Final verdict: Apple Music on Windows has no working programmatic seek path.**
SMTC `TryChangePlaybackPosition` ignored · synthesized keyboard accelerators swallowed
or track-skip · UIA RangeValue fail-silent/revert. The only remaining route is real
pointer emulation on a visible window (steals the cursor — rejected by design).
`can_seek` stays false for AM until Apple fixes their SMTC handler; re-run
`smtc-spike seekrel applemusic -10` after AM updates to check.

## How the frontend consumes these timelines (PRs #15–#18, #22, #23)

The per-player timing quirks above land in exactly two frontend tables — keep them in
sync with this matrix if a player update changes its push profile:

| Constant | Where | apple_music | spotify | Meaning |
|---|---|---|---|---|
| `JITTER_BAND_MS` | `src/lib/posClock.ts` | 2000 | 400 | Backward deltas under this are quantization jitter — held, not adopted (AM sized from the #22 soak's measured ~1.5s tail, finding 9) |
| `VOCAL_LEAD_MS` | `src/lib/lrc.ts` | 0* | 50* | Lyric highlight leads the reported position by this much |

\* AM starts at 0 because the #22 soak showed its clock rides ~0.5–1s HOT
(freeze-at-max + the 2s band ratchet the display above the floored reports) — the ride
already acts as the lead. Both values are untuned: measure against real vocals and
update this table with the finals.

The backend emits raw `(position_ms, position_at_ms)` pairs and never projects;
`posClock.ts` is the one monotonic display clock. AM's 1s-floored positions are why a
fresh pair projects behind the running clock (~1s from quantization alone; ~1.5s with
stamp/delivery lag, finding 9) — reproduce the quantization component in a plain
browser with `npm run dev` → `/?am` (mock switches to the AM profile: floored positions,
irregular push cadence, pause-era stamp on resume, `can_seek: false`).

## Raw spike commands

```
cargo run -- list | probe <app> | playpause <app> | next <app> | prev <app> | seekrel <app> <secs> | watch <app> <secs>
```
