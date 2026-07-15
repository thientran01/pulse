; Palette — custom NSIS installer hooks.
;
; POSTUNINSTALL: remove the Spotify OAuth tokens so an uninstall never leaves
; credentials behind on disk (1.0 readiness-audit item). Deliberately scoped
; to the tokens ONLY — play history, preferences, and caches survive an
; uninstall→reinstall, which is the friendlier default for user data. Deleting
; a file that was never written (the user never connected Spotify) is a silent
; no-op in NSIS. $APPDATA is Roaming; Tauri stores app-data under the app
; identifier folder (com.thien.pulse).
!macro NSIS_HOOK_POSTUNINSTALL
  Delete "$APPDATA\com.thien.pulse\spotify_tokens.json"
!macroend
