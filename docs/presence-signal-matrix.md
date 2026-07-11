# Presence signal matrix — P0 sensing spike

What Windows actually reports about the user's context, per scenario — the source of truth
for every presence-engine detection path. **No behavior ships on a signal until its row
here is measured.** Instrument: `spikes/presence-spike` (1Hz table of foreground exe /
window-rect-vs-monitor-vs-work-area / `SHQueryUserNotificationState` / `GetLastInputInfo`);
`presence-spike changes` prints transitions only.

> **2026-07-11:** the idle-driven behaviors (AFK grow, working quiet) were removed after
> soak — the shipped engine consumes ONLY the fullscreen rows. The idle/controller rows
> below are kept as measured history (the spike still prints idle), useful if idle-driven
> ideas are ever revisited; read CLAUDE.md's Presence paragraph before doing that.

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
| **Fullscreen browser video (Netflix in Chrome, live session)** | ✅ **`fullscreen`** — rect == monitor rect exactly | ⚠️ **`BUSY(2)`**, sustained for minutes | counted 34→63s during watching, reset on input | ✅ measured 2026-07-09 — **finding 4**: the rect method alone carries the flagship conceal case; BUSY is corroboration, never required |
| Maximized normal window (Chrome, Claude, Edge) | ✅ `maximized` — rect = work area ±8px border overhang, NOT monitor | `ACCEPTS_NOTIFICATIONS(5)` | — | ✅ measured 2026-07-09 on three real apps — no false fullscreen |
| Minimized window still foreground (transient) | ✅ `windowed` (rect at -32000) | `ACCEPTS_NOTIFICATIONS(5)` | — | ✅ measured 2026-07-09 — harmless |
| Taskbar foreground (`Shell_TrayWnd`) | ✅ excluded by shell-class filter | — | — | ✅ measured 2026-07-09 |
| Bare desktop foreground (`Progman`/`WorkerW`) | ⏳ expect monitor-covering — engine excludes shell classes preemptively | ⏳ | — | confirm the exclusion is actually needed |
| Exclusive-fullscreen game | ⏳ | ⏳ expect `RUNNING_D3D_FULL_SCREEN(3)` | — | |
| Borderless-windowed game | ⏳ expect `fullscreen` rect (Netflix row makes this near-certain) | ⏳ | — | |
| PowerPoint slideshow | ⏳ | ⏳ expect `PRESENTATION_MODE(4)` | — | |
| Zoom/Teams screen-share + fullscreen call | ⏳ | ⏳ `BUSY`? `PRESENTATION_MODE`? | — | decides whether calls conceal |
| Fullscreen on the OTHER monitor | **N/A on this hardware** — single 27" 2560×1440 monitor | — | — | scoping code stays (rect method widget-monitor gated; QUNS global); re-measure if a second monitor ever lands |
| Lock screen / UAC secure desktop | ⏳ expect `GetForegroundWindow` → null | ⏳ | ⏳ | engine already HOLDS state (and resets hysteresis credit) on null — confirm null actually happens |
| Idle while gaming (controller only) | — | — | ⏳ expect **blind to XInput** | AFK/working must never gate conceal |
| Auto-hidden taskbar | ⏳ work area == monitor rect ⇒ `maximized` reads as `fullscreen`? | — | — | known caveat of the rect method (taskbar is standard 48px on this machine) |

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
   never read as fullscreen content. `Shell_TrayWnd` exclusion confirmed live; the
   bare-desktop (`Progman`) row is still preemptive.
4. **Fullscreen browser video reports `QUNS_BUSY`, not a fullscreen QUNS state**
   (measured against a real Netflix session, 2026-07-09). Two consequences: (a) the
   rect method is the load-bearing detector for browser/borderless fullscreen — QUNS 3/4
   likely only cover exclusive D3D and presentation mode; (b) finding 1 stands — BUSY
   still can't join the predicate alone (alt-tab fires it too), but BUSY+`rect_fullscreen`
   co-occurring is the normal browser-video signature, not an anomaly.
5. **Measurement etiquette (self-note): foreground scenarios are user-visible.** The
   2026-07-09 synthetic runs (maximized window, MinimizeAll, Edge F11) executed while a
   live Netflix session had the screen and stole its foreground/fullscreen. Real usage
   plus `presence-spike changes` produces the same rows without the disruption — prefer
   passive capture for everything except rows that never occur naturally.

## How to fill the ⏳ rows

```
cd spikes/presence-spike && cargo run -- changes
```

Leave it printing in a terminal, run each scenario for ~30s, note the verdict lines.
In-app equivalents: `eprintln!` transitions in the `npm run tauri dev` console, or the
dev overlay (localStorage `pulse.presenceOverlay = "1"`, reload; browser mock: `?presence`
with `?fs` to force the fullscreen/concealed state).
