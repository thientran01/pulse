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
; $UpdateMode guard: an UNINSTALL wipes credentials, an UPGRADE never does.
; The self-updater launches the uninstaller with /UPDATE ($UpdateMode = 1),
; and the generated template guards its own destructive steps (shortcuts,
; autostart, app-data) with this exact construct — an unguarded Delete here
; silently disconnected Spotify on update-mode uninstall runs. The hook is
; inserted inside the uninstall Section, where LogicLib and $UpdateMode are
; both in scope.
!macro NSIS_HOOK_POSTUNINSTALL
  ${If} $UpdateMode <> 1
    Delete "$APPDATA\com.thien.pulse\spotify_tokens.json"
  ${EndIf}
!macroend
