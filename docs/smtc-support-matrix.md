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

## Findings that change the plan

1. **Spotify seek/position work natively over SMTC** — the widely-cited "Spotify doesn't report position" limitation is stale as of 1.2.92. The M5 Spotify Web API adapter demotes from *required for seek* to *optional* (like/unlike, richer metadata only). ±10 s, scrub, and lyric sync all work SMTC-native for Spotify.
2. **Apple Music does NOT honor seek** — `IsPlaybackPositionEnabled: false` and real seeks are silently ignored (even paused). M1 options: (a) probe the AM app's own keyboard shortcuts via focused-window automation (last-resort per plan), or (b) ship AM with a display-only progress bar and no ±10 s initially. Position/lyric sync still fine — position reports at 1 s granularity.
3. **Never trust the command bools.** AM returns `accepted: true` for seeks it ignores. Verification = re-read `GetTimelineProperties` after commanding.
4. **AM deregisters its session when playback stops.** A `prev` fired ~1 s into a track stopped playback and the session vanished from GSMTC (did not return). Session appearance/disappearance is a *normal* state transition — the widget needs an explicit "nothing playing" state and cannot resurrect a closed session via SMTC.
5. **AM metadata quirk:** `Artist` comes back as `"<artist> — <album>"` (em-dash separated) with `AlbumTitle` empty. The apple_music adapter must split on `" — "` for LRCLIB lookups and display.
6. **Spotify position is pushed ~every 5 s** — between pushes, interpolate: `position + (now − last_updated)` while status is Playing. AM position is fresh on every poll at 1 s granularity.
7. *(M1, 2026-07-06)* **AM's thumbnail `ContentType` is a comma-separated LIST** (`image/jpeg,image/jpe,image/jpg`) — commas are invalid inside a `data:` URL; take the first entry. Spotify reports a single `image/png`.
8. *(M1, 2026-07-06)* **Thumbnail `ReadAsync` may return fewer bytes than requested** — a single read can yield a truncated image that fails to decode. Read chunked until the declared size is reached (and cap the final request to the remainder).

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
progress bar (±10s buttons capability-gated off). Next candidate: UI Automation
RangeValuePattern on AM's scrubber slider (no focus needed, absolute seek) — spun off as its own task.

## Raw spike commands

```
cargo run -- list | probe <app> | playpause <app> | next <app> | prev <app> | seekrel <app> <secs> | watch <app> <secs>
```
