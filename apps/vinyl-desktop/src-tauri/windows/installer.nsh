; Preserve Tauri's installer; guard only the shared legacy Qt uninstall entry.
!macro NSIS_HOOK_PREINSTALL
  ReadRegStr $R9 SHCTX "${UNINSTKEY}" "QuietUninstallString"
  ${If} $R9 != ""
    MessageBox MB_OK|MB_ICONEXCLAMATION "Uninstall the older NexusDownloader from Settings > Apps before installing this edition. Your saved videos are not part of the app." /SD IDOK
    SetErrorLevel 1
    Abort
  ${EndIf}
!macroend
