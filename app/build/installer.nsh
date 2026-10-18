; Lumi's NSIS additions (electron-builder include).
; Uninstalling removes the voice engine's Python environment, which is big
; and rebuilt on demand; an update keeps it. Memory, settings, logs and the
; downloaded models stay in %APPDATA%\Lumi: they are the user's.
!macro customUnInstall
  ${ifNot} ${isUpdated}
    RMDir /r "$LOCALAPPDATA\Lumi\sidecar-env"
  ${endIf}
!macroend
