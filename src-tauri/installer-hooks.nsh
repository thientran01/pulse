; Palette — custom NSIS installer hooks.
;
; POSTUNINSTALL: remove the Spotify OAuth tokens so an uninstall never leaves
; credentials behind on disk (1.0 readiness-audit item). Deliberately scoped
; to the tokens ONLY — play history, preferences, and caches survive an
; uninstall→reinstall, which is the friendlier default for user data. Deleting
; a file that was never written (the user never connected Spotify) is a silent
; no-op in NSIS. $APPDATA is Roaming; Tauri stores app-data under the app
; identifier folder (com.thien.pulse).
;
; $UpdateMode guard: an UNINSTALL wipes credentials, an UPGRADE never does —
; defensive parity with the generated template, which guards its own
; destructive steps (shortcuts, autostart, app-data) with this exact
; construct. Parity, not a live-symptom fix: in the CURRENT template a
; self-update never executes this Section at all (PageLeaveReinstall jumps
; past reinst_uninstall when $UpdateMode = 1), so the guard only matters if a
; future bundler starts running the uninstaller during updates. Known
; residual it can NOT close: an interactive manual-installer upgrade's
; "Uninstall before installing" (the upgrading default) execs the installed
; uninstaller WITHOUT /UPDATE — that flow, and the documented one-time manual
; uninstall of the old side-by-side "Pulse" entry, still wipe the shared
; $APPDATA\com.thien.pulse tokens. The hook is inserted inside the uninstall
; Section, where LogicLib and $UpdateMode are both in scope (un.onInit parses
; /UPDATE first; unset "" compares as 0, so plain uninstalls still delete).
!macro NSIS_HOOK_POSTUNINSTALL
  ${If} $UpdateMode <> 1
    Delete "$APPDATA\com.thien.pulse\spotify_tokens.json"
  ${EndIf}
!macroend
