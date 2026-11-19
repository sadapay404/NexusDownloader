param(
  [Parameter(Mandatory = $true)][string]$Setup,
  [Parameter(Mandatory = $true)][string]$Output
)

$ErrorActionPreference = 'Stop'
$AppRoot = (Resolve-Path "$PSScriptRoot\..\..").Path
$config = Get-Content -Raw (Join-Path $AppRoot 'src-tauri\tauri.conf.json') | ConvertFrom-Json
$version = $config.version
$Setup = (Resolve-Path -LiteralPath $Setup).Path
$regKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\NexusDownloader'
$install = Join-Path $env:LOCALAPPDATA 'NexusDownloader'
$binary = Join-Path $install 'NexusDownloader.exe'
$uninstaller = Join-Path $install 'uninstall.exe'
$programs = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'
$desktop = [Environment]::GetFolderPath('Desktop')
$work = Join-Path ([IO.Path]::GetTempPath()) ('nexus-vinyl-' + [guid]::NewGuid().ToString('N'))
$saved = Join-Path $work 'Saved media'
$ytdlp = Join-Path $work 'yt-dlp.exe'

function Get-PeMachine([string]$path) {
  $reader = [IO.BinaryReader]::new([IO.File]::OpenRead($path))
  try {
    if ($reader.ReadUInt16() -ne 0x5a4d) { throw "No MZ header: $path" }
    $reader.BaseStream.Position = 0x3c
    $reader.BaseStream.Position = $reader.ReadUInt32()
    if ($reader.ReadUInt32() -ne 0x4550) { throw "No PE header: $path" }
    return $reader.ReadUInt16()
  } finally { $reader.Dispose() }
}

if ((Test-Path $regKey) -or (Test-Path $install) -or (Test-Path (Join-Path $desktop 'NexusDownloader.lnk')) -or
    (Get-ChildItem -Path $programs -Recurse -Filter 'NexusDownloader.lnk')) {
  throw 'Use a disposable Windows user/runner without another NexusDownloader installation or shortcut.'
}
if ((Get-PeMachine $Setup) -notin @(0x014c, 0x8664)) { throw 'Not a supported NSIS setup PE' }
if ((Get-Item -LiteralPath $Setup).VersionInfo.ProductName -ne 'NexusDownloader') { throw 'Wrong setup identity' }
if ((Get-Item -LiteralPath $Setup).VersionInfo.ProductVersion -ne $version) { throw 'Wrong setup version' }

New-Item -ItemType Directory -Path $work | Out-Null
try {
  # The old Qt Setup and Tauri use the same uninstall registry key. Prevent a silent overwrite.
  New-Item -Path $regKey -Force | Out-Null
  try {
    New-ItemProperty -Path $regKey -Name QuietUninstallString -Value 'legacy marker' | Out-Null
    $blocked = Start-Process -FilePath $Setup -ArgumentList '/S' -PassThru -Wait
    if ($blocked.ExitCode -ne 1 -or (Test-Path $binary) -or
        (Get-ItemPropertyValue -Path $regKey -Name QuietUninstallString) -ne 'legacy marker') {
      throw 'Setup did not block the legacy installation safely'
    }
  } finally { Remove-Item -LiteralPath $regKey -Force }

  $installed = Start-Process -FilePath $Setup -ArgumentList '/S' -PassThru -Wait
  if ($installed.ExitCode -ne 0) { throw "Setup failed: $($installed.ExitCode)" }
  $info = Get-ItemProperty -Path $regKey
  if ($info.DisplayName -ne 'NexusDownloader' -or $info.DisplayVersion -ne $version -or $info.InstallLocation.Trim('"') -ne $install) {
    throw 'Wrong installed identity, version or per-user location'
  }
  if ((Get-PeMachine $binary) -ne 0x8664) { throw 'The installed application is not Windows AMD64' }
  $links = @(Get-ChildItem -Path $programs -Recurse -Filter 'NexusDownloader.lnk')
  if ($links.Count -ne 1) { throw 'Expected one NexusDownloader shortcut in Start' }
  $shortcut = (New-Object -ComObject WScript.Shell).CreateShortcut($links[0].FullName)
  if ($shortcut.TargetPath -ne $binary) { throw 'Start shortcut points to the wrong binary' }
  $license = Join-Path $install 'licenses\yt-dlp-gui-MIT.txt'
  if ((Get-FileHash -LiteralPath $license).Hash -ne (Get-FileHash -LiteralPath (Join-Path $AppRoot 'LICENSE')).Hash) {
    throw 'Upstream MIT notice was not packaged intact'
  }
  if (-not (Test-Path (Join-Path $install 'browser-extension\manifest.json'))) { throw 'Upstream browser extension missing' }
  Write-Host "Installer identity, AMD64 application, MIT notice, and Start shortcut verified."

  # Official asset used only for the offline test; never bundled by Setup.
  Invoke-WebRequest -Uri 'https://github.com/yt-dlp/yt-dlp/releases/download/2026.10.26/yt-dlp.exe' -OutFile $ytdlp
  if ((Get-FileHash -LiteralPath $ytdlp).Hash -ne 'f5389d3698ecde4ef06f4e6b1ce0294fe9ac1396228c8990b8d3416d6d177a7d') {
    throw 'Smoke-test yt-dlp does not match the pinned release hash'
  }
  node (Join-Path $PSScriptRoot 'native-download.mjs') $shortcut.TargetPath $saved $ytdlp
  if ($LASTEXITCODE -ne 0) { throw 'Native media save failed' }
  $savedFile = (Get-ChildItem -File -LiteralPath $saved).FullName
  $beforeUninstall = (Get-FileHash -LiteralPath $savedFile).Hash

  $removed = Start-Process -FilePath $uninstaller -ArgumentList '/S' -PassThru -Wait
  if ($removed.ExitCode -ne 0 -or (Test-Path $binary) -or (Test-Path $regKey) -or (Test-Path $links[0].FullName)) {
    throw 'Uninstall did not remove the app and its registration'
  }
  if ((Get-FileHash -LiteralPath $savedFile).Hash -ne $beforeUninstall) { throw 'Uninstall changed the saved media' }
  Write-Host 'Uninstall removed NexusDownloader without touching the saved MP4.'

  New-Item -ItemType Directory -Force -Path $Output | Out-Null
  $name = "NexusDownloader-$version-Windows-x64-Setup.exe"
  $deliverable = Join-Path $Output $name
  Copy-Item -LiteralPath $Setup -Destination $deliverable
  $hash = (Get-FileHash -LiteralPath $deliverable -Algorithm SHA256).Hash.ToLowerInvariant()
  Set-Content -LiteralPath "$deliverable.sha256" -Value "$hash  $name" -Encoding ascii
  Write-Host "Verified installer: $name ($hash)"
} finally {
  if (Test-Path $uninstaller) { Start-Process -FilePath $uninstaller -ArgumentList '/S' -Wait }
  Remove-Item -LiteralPath $work -Recurse -Force
}
