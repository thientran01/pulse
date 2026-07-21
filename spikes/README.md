# spikes/ — feasibility probes

Before Palette built anything on top of Windows' media and presence APIs, it needed to know
what those APIs *actually* report — not what the docs claim. These crates are the
throwaway instruments that measured it.

Each is a **standalone `cargo run` crate**, not part of the app build. Each pins its own
`[workspace]`, so they compile independently of `src-tauri/` — you run them by hand, watch
the raw signals stream, and read the verdict off the terminal. The committed deliverable of
a spike is its measured verdict (a matrix doc in [`../docs/`](../docs), or checkboxes on its
PR); the crate is just how those numbers were gathered. Windows-only (MSVC toolchain).

## `smtc-spike/` → [`../docs/smtc-support-matrix.md`](../docs/smtc-support-matrix.md)

Probes the Windows System Media Transport Controls (GSMTC / `Windows.Media.Control`) to see
what Apple Music and Spotify honor over it: session registration, title/artist/album, album
art byte-reads, reported position, play/pause, next/prev, and — the load-bearing question —
**seek**. It also exercises the Apple Music seek *fallbacks* (`WM_APPCOMMAND`, synthesized
Ctrl/Alt+arrow keystrokes, UIA `RangeValue.SetValue` on the scrubber), each of which
fail-silently or skip the track.

This is where the matrix's headline verdicts come from: **Spotify seek/position work
natively over SMTC** (so the Web API is only needed for like/unlike), and **Apple Music has
no working programmatic seek path** — SMTC accepts the command, returns `true`, and does
nothing. Hence the standing rule: never trust an SMTC command bool; verify by re-reading the
timeline.

```sh
cd spikes/smtc-spike
cargo run -- list                    # enumerate active GSMTC sessions (AUMIDs)
cargo run -- probe applemusic        # dump metadata / control flags / timeline for a session
cargo run -- seekrel spotify -10     # attempt a -10s seek, then re-read to see if it moved
cargo run -- watch applemusic 10     # 10s: does the reported position actually advance?
# (also: playpause / next / prev <app-match>; <app-match> = substring of the AUMID)
```

Needs the target player running. `<app-match>` matches against the session's
`SourceAppUserModelId` (e.g. `applemusic`, `spotify`).

## `presence-spike/` → [`../docs/presence-signal-matrix.md`](../docs/presence-signal-matrix.md)

Prints a 1 Hz line of every raw signal the presence engine could consume: the foreground
window (hwnd → pid → exe → title/class), its rect versus its monitor rect versus the
monitor's work-area rect (the fullscreen-vs-maximized test), `SHQueryUserNotificationState`
(QUNS), and `GetLastInputInfo` idle seconds.

Its measurements are the basis for the **hide-on-fullscreen courtesy conceal**: the
rect-covers-the-monitor test is the load-bearing detector for borderless/browser fullscreen,
while `QUNS_BUSY` turned out to fire during ordinary alt-tabbing — so it can corroborate but
can never trigger the conceal alone. (The idle signal fed the since-removed AFK behaviors;
it's still printed as measured history.)

```sh
cd spikes/presence-spike
cargo run              # 1Hz table of raw presence signals until Ctrl+C
cargo run -- changes   # print only when the derived verdict changes (best for passive capture)
```

Leave `changes` printing in a terminal, run each real scenario (fullscreen video, a game, a
maximized window) for ~30s, and read the verdict lines — that's how the matrix's ⏳ rows get
filled.

## `web-surface/` → the hosted-web tier of the Surfaces concept

The first probe of the parked **Palette Surfaces** idea (a palette of always-on-top
surfaces; concept + decisions live in the vault, `Ideas/Palette Surfaces.md`). A minimal
tao + wry window hosting a real site in WebView2 — always-on-top, native decorations,
its own persistent WebView2 profile, and a remembered seat (position/size restored across
runs from `%APPDATA%\palette-web-surface-spike\seat.txt`).

The questions it exists to answer, each a live check: does **Netflix DRM playback** work in
WebView2; does **login persist** in an app-owned profile; does always-on-top hold over
**borderless-fullscreen games**. Unlike the other two spikes it is also directly *usable* —
a working Netflix miniplayer while you game.

```sh
cd spikes/web-surface
cargo run                              # Netflix, 560×345, always-on-top
cargo run -- https://youtube.com       # any other site
```

Deleting `%APPDATA%\palette-web-surface-spike\` is the full reset (profile + seat).
