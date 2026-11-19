; MUI calls this before the maintenance page can offer to run an old uninstaller.
!define MUI_CUSTOMFUNCTION_GUIINIT NexusRejectLegacyQt
Function NexusRejectLegacyQt
  ReadRegStr $R9 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\NexusDownloader" "QuietUninstallString"
  ${If} $R9 != ""
    MessageBox MB_OK|MB_ICONEXCLAMATION "Uninstall the older NexusDownloader from Settings > Apps before installing this edition. Keep your media outside the installation folder." /SD IDOK
    SetErrorLevel 1
    Quit
  ${EndIf}
FunctionEnd

; Silent installs do not receive .onGUIInit.
!macro NSIS_HOOK_PREINSTALL
  Call NexusRejectLegacyQt
!macroend
