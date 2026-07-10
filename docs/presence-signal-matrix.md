# Presence signal matrix — P0 sensing spike

What Windows actually reports about the user's context, per scenario — the source of truth
for every presence-engine detection path (conceal, AFK, working). **No behavior ships on a
signal until its row here is measured.** Instrument: `spikes/presence-spike` (1Hz table of
foreground exe / window-rect-vs-monitor-vs-work-area / `SHQueryUserNotificationState` /
`GetLastInputInfo`); `presence-spike changes` prints transitions only.

Started 2026-07-09 on Windows 11 Pro (26200), single 2560×1440 monitor (48px taskbar),
windows-rs 0.61. Behavior is OS-version-dependent — re-run the spike after major Windows
updates. Rows marked ⏳ still need a live session (games/fullscreen video/multi-monitor
can't be driven from a headless session — run the spike alongside real usage).

## Signal model under test

- **Rect method:** fullscreen ⇔ window rect covers the MONITOR rect; maximized ⇔ covers
  only the WORK-AREA rect (taskbar-height difference). Catches borderless fullscreen.
- **QUNS method:** `RUNNING_D3D_FULL_SCREEN` (exclusive fullscreen) and
  `PRESENTATION_MODE` (PowerPoint-style) as global signals.
- **Idle:** `GetLastInputInfo` tick delta at 1s polling.

| Scenario | Rect verdict | QUNS | Idle | Verdict for the engine |
|---|---|---|---|---|
| Normal windowed app (Spotify) | ✅ `windowed` — rect well inside work area | `ACCEPTS_NOTIFICATIONS(5)` | counts correctly | ✅ measured 2026-07-09 |
| Alt-Tab task switcher held open | `maximized` (spans work area exactly) | ⚠️ **`BUSY(2)`** | 0 | ✅ measured 2026-07-09 — **finding 1** |
| Maximized normal window | ⏳ expect `maximized` (= work area, NOT monitor) | ⏳ | — | hypothesis consistent with the task-switcher row; confirm with a maximized browser |
| Bare desktop foreground (`Progman`/`WorkerW`) | ⏳ expect monitor-covering — engine excludes shell classes preemptively | ⏳ | — | confirm the exclusion is actually needed |
| Exclusive-fullscreen game | ⏳ | ⏳ expect `RUNNING_D3D_FULL_SCREEN(3)` | — | |
| Borderless-windowed game | ⏳ expect `fullscreen` rect | ⏳ likely `ACCEPTS_NOTIFICATIONS` | — | the case the rect method exists for |
| YouTube fullscreen (Chrome, Edge) | ⏳ expect `fullscreen` rect | ⏳ | — | |
| VLC / Movies & TV fullscreen | ⏳ | ⏳ | — | |
| PowerPoint slideshow | ⏳ | ⏳ expect `PRESENTATION_MODE(4)` | — | |
| Zoom/Teams screen-share + fullscreen call | ⏳ | ⏳ `BUSY`? `PRESENTATION_MODE`? | — | decides whether calls conceal |
| Fullscreen on the OTHER monitor | ⏳ | ⏳ does QUNS fire globally? | — | multi-monitor scoping — widget must NOT conceal |
| Lock screen / UAC secure desktop | ⏳ expect `GetForegroundWindow` → null | ⏳ | ⏳ | engine already HOLDS state on null — confirm null actually happens |
| Idle while gaming (controller only) | — | — | ⏳ expect **blind to XInput** | AFK/working must never gate conceal |
| Auto-hidden taskbar | ⏳ work area == monitor rect ⇒ `maximized` reads as `fullscreen`? | — | — | known caveat of the rect method |

## Findings that change the plan

1. **`QUNS_BUSY` fires during plain Alt-Tabbing** (the task-switcher overlay reports it,
   measured first spike run). BUSY is therefore NOT in the engine's fullscreen predicate —
   a bare `BUSY ⇒ conceal` would flicker the widget on every window switch. If a real
   scenario needs BUSY (screen-share?), it must ride behind the 2s enter-hysteresis and
   earn its row here first.
2. **The work-area hypothesis holds on this machine so far**: work area = monitor minus
   the 48px taskbar, and a work-area-spanning window correctly reads `maximized`, not
   `fullscreen`. The auto-hidden-taskbar caveat row is still open.
3. **The desktop shell and the widget itself are excluded by class/pid in presence.rs**
   (`Progman`/`WorkerW`/`Shell_TrayWnd`, own pid) — a monitor-spanning shell window must
   never read as fullscreen content. Preemptive; confirm with the bare-desktop row.

## How to fill the ⏳ rows

```
cd spikes/presence-spike && cargo run -- changes
```

Leave it printing in a terminal, run each scenario for ~30s, note the verdict lines.
In-app equivalents: `eprintln!` transitions in the `npm run tauri dev` console, or the
dev overlay (localStorage `pulse.presenceOverlay = "1"`, reload; browser mock: `?presence`
with `?fs` / `?away` to force states).
