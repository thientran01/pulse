# Free placement: edge snap only, no corner magnet, no fullscreen seat

**Date:** 2026-07-21
**Branch:** `feature/edge-snap-no-corner-magnet`
**Lens:** design call (placement feel). Live drag test is the verdict.
**Supersedes:** the placement half of PR #80 (merged 2026-07-12, mock/review-only — this is the first live verdict on it).

## The complaint

Thien, live on 0.7.3, with screenshots:

> I dragged palette to this position, but when i let go, it will snap to the corner because its close to that corner. I dont want it to snap to that corner. I just want it to align with the nearest edge. Which is the left edge and stay at that Y level. I still want it to be flexible and place it anywhere on the screen. If I want it in the center of the screen [...] i should be able to do that without it snapping to a corner. Only if palette is close to an edge, it should snap.

Plus: the reachable space differs while a fullscreen app is up, and he wants no fullscreen special-casing at all.

## The rule

On drag release, **each axis independently**:

1. Within `RAIL_PX` (24) of an edge line → snap that axis to the line.
2. Otherwise → the axis keeps exactly the position it was dropped at.
3. Always clamp so the **visible widget** stays fully on-screen.

The docked `Corner` is still derived (it drives the shell seat, the mode-glide
growth direction, the queue popover direction, and the click-through hit-rect
anchor) — it just stops *pulling*. `MAGNET_PX` and its branch are deleted.

### Edge lines

Per axis, the candidate lines are the `MARGIN_LOGICAL` (12px) insets of **both**
the work area and the full monitor rect, on both sides. Nearest candidate within
`RAIL_PX` wins; ties are impossible in practice (the two rects differ by the
taskbar's thickness, ~48px).

- Left / right / top: the two rects coincide (unless the taskbar is on that
  side), so there is effectively one line.
- Bottom (typical taskbar): two lines ~48px apart — *above the taskbar* and
  *flush with the true screen bottom*. Drop near the taskbar's top edge → tidies
  above it (the familiar seat). Drag it genuinely to the bottom → sits flush over
  the taskbar.

This is what removes fullscreen special-casing: the flush line already exists on
the desktop, so during a fullscreen game a near-bottom drop lands flush without
anyone sensing anything. Same rule everywhere.

## Settle in footprint space

`settle_target` currently places the **window**: it clamps the 380×440
`WINDOW_MAX` box on-screen and rails the window's edges. It is rewritten to place
the **visible footprint** (`hit_size` anchored at the docked corner), deriving the
window origin last:

```
window_origin = footprint_origin − corner_offset(corner, window_size, footprint_size)
```

Consequences:

- **The corner flip stops teleporting.** Today a free drop leaves the window
  where it was released and only re-derives the corner — but the shell is
  corner-anchored *inside* the fixed window, so the flip re-seats the visible
  widget by `WINDOW_MAX − MODE_SIZE`: **80×392px in pill, 0×302 in card, 0×0 in
  expanded**. Crossing the screen midline in pill mode throws the widget ~392px.
  (Expanded fills the window, which is why the reported symptom was only the
  magnet — both of Thien's screenshots were expanded.) Absorbing the corner
  change into the window origin makes the widget land exactly where it was
  dropped, which is the precondition for "place it anywhere" meaning anything in
  pill and card.
- **Reach improves.** The window may hang off-screen (it is transparent and
  click-through out there); only the visible footprint is clamped. Previously the
  380×440 box was what had to fit.
- Rails snap the edge the user is actually aiming at.

The disconnected-monitor heal is now purely the clamp — `MAGNET_PX`'s second job
as the snapped-vs-free classifier disappears with it.

### The corner has to be persisted

Deriving the window origin from the corner means the *inverse* is needed at
launch, and it isn't recoverable: window-state restores the WINDOW's rect, the
widget sits at one of four corners inside it, and the rect alone cannot say
which. Re-deriving the corner from the window's center puts it in the wrong
quadrant across a ~200px band around each midline — the two centers sit ~196px
apart in pill mode — and the shell then seats at the far end of the window: a
392px jump on **every launch**, with autostart on.

So `settings.json` gains **`"dockCorner"`**, written whenever the corner changes
(off-thread — `set_corner` is reachable from the main thread via the sync
`set_window_size` command). `set_window_size` also takes the launch mode's box,
and the two together locate the widget exactly. No seeded corner (fresh install,
or the first launch after this change) falls back to treating the whole window as
the widget — the pre-change behavior — rather than guessing and teleporting on the
upgrade; rails are skipped in that one case, since railing the window's far edges
would move the widget onto a line it isn't at.

This contradicts the old "corner derived, never stored" rule. That rule held only
because the window rect *was* the placement; once the widget's position and the
window's diverge, the corner is the missing bit and storing it is the honest fix.

### Placement box ≠ interactive box

`set_hit_size`'s rect is a UNION: it swells to cover the queue popover and goes
whole-window under a transient overlay. That is right for click-through and wrong
for placement — compensating a corner flip with it moves the window by a distance
the shell's FLIP never travels, so a drag released with the queue open teleports
by the difference. The frontend therefore reports **two** corner-anchored boxes:
the interactive union, and the mode's own `MODE_SIZES` box. `footprint_rect`
feeds the click-through gate; `placement_rect` feeds every placement decision.

## Deletions

Palette never repositions itself in response to another app again. Removed
entirely:

| Item | Where |
| --- | --- |
| `MAGNET_PX` + the magnet branch | `dock.rs` |
| `Space`, `space_rect`'s space parameter | `dock.rs` |
| `FsSeat`, `Dock::fs_seat`, settings key `fsSeat` | `dock.rs` |
| `Dock::desktop_return`, settings key `desktopReturn` | `dock.rs` |
| `Dock::want_fs`, `Dock::seated_fs`, `Dock::seat_gate`, `Dock::launch_pos` | `dock.rs` |
| `sync_seat`, `set_fullscreen_context` | `dock.rs` |
| the `sync_seat` call in `apply_visibility` | `lib.rs` |
| `fs_mon_raw` / `fs_mon_settled` / `mon_disagree_ms` (the monitor-scoped verdict — its only consumer was the seat) | `presence.rs` |

`dock::init` survives: it seeds `"dockCorner"` and nulls the two dead keys.
`reset_position` (tray) survives as the escape hatch and now homes the footprint
to the work-area bottom-right. Presence keeps its one action, the courtesy
conceal, and stops touching position.

**Accepted upgrade cost:** a 0.7.3 install that quit *during* a fullscreen
episode has the in-game position persisted as its window rect, and the
`desktopReturn` consumer that used to correct for it is gone. That one launch
lands at the in-game spot; one drag fixes it permanently. Not worth keeping the
machinery alive for.

## Risk: the compensated corner flip

A corner flip must still happen when the widget crosses a screen midline — the
shell has to be anchored to the corner nearest the screen edge or a mode
expansion grows off-screen. With compensation, the native window glide and the
frontend's shell FLIP now run **exactly opposite** and must cancel to zero.

Both are already 200ms with `EASE.out` (`dock.rs` `SNAP_MS` / `ease_out` vs
`tokens.ts` `DUR[3]` / `EASE.out = [0.16, 1, 0.3, 1]` — same numbers), and PR #53
live-proved they ride together. But "reads as coordinated" is a weaker bar than
"cancels to zero": if their clocks skew a frame, a wobble appears on release, and
`EASE.out` is front-loaded enough that a 16ms skew is worth ~30–80px at peak
velocity. No new code hedges this — it needs the live app.

Mitigation ladder if it wobbles live, cheapest first:

1. Ship and look at it.
2. `EASE.inOut` for compensated flips only — halves peak velocity.
3. Decouple: keep the corner sticky through free drops and drive popover
   direction off the live window position instead.

## Verification

**Unit** (the settle math is pure — new `#[cfg(test)]` module in `dock.rs`, 9
tests): free drop stands on both axes; near-left snaps X and leaves Y untouched
(Thien's screenshot 1); no corner magnet at 60px off both seat lines; the bottom
axis picks the nearer of the two lines; a drop past the screen edge clamps the
footprint fully on-screen; corner derivation follows the footprint center, not
the window center; `corner_offset` equals `App.tsx`'s `SHELL_SEAT` geometry for
every corner and mode (the cross-language invariant the compensation rests on);
the quit→relaunch round-trip reproduces the exact placement and is idempotent;
the window clamp saves a short display and is inert above ~832px.

**Static:** `cargo check`, `cargo clippy`, `tsc --noEmit`, `npm run build`.

**Live drag checks** (only the real app can answer these — the mock has no
dock-corner events, and native-motion verdicts have failed the mock three times
historically):

1. Drop mid-screen in **pill** mode → stays put. *(the teleport test)*
2. Drop just either side of the screen midline in **pill** mode → no jump, no
   wobble. *(the compensated-flip test — the one thing most likely to need the
   mitigation ladder)*
3. Drop near each edge → that axis tidies to 12px, the other axis holds.
4. Drop low over the taskbar → stands flush, does not get pulled up.
5. Alt-tab into a fullscreen game → the widget does not move at all.
6. Quit and relaunch **in pill mode, parked near the middle of the screen** →
   comes back in the same spot. *(the persisted-corner test — the one the
   review found, and the one that fires daily under autostart)*
7. Open the queue popover, drag across a midline, release → no teleport.
8. Queue popover still opens away from the nearest edge; expanding pill →
   expanded near a screen edge still grows inward and stays on-screen.
