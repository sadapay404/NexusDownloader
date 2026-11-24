param(
  [Parameter(Mandatory = $true)][string]$Setup,
  [Parameter(Mandatory = $true)][string]$Check
)

$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted') {
  throw 'This check and its scoped WebView2 policy require a disposable GitHub-hosted runner'
}
$regKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\NexusDownloader'
$install = Join-Path $env:LOCALAPPDATA 'NexusDownloader'
$appData = Join-Path $env:APPDATA 'com.nexusdownloader.desktop'
if ((Test-Path -LiteralPath $regKey) -or (Test-Path -LiteralPath $install) -or (Test-Path -LiteralPath $appData)) {
  throw 'Expected a fresh app installation and uninitialized Windows app data'
}
$policy = 'HKLM:\Software\Policies\Microsoft\Edge\WebView2\AdditionalBrowserArguments'
$bin = 'NexusDownloader.exe'
$listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
try { $listener.Start(); $port = $listener.LocalEndpoint.Port } finally { $listener.Stop() }
$work = Join-Path $env:RUNNER_TEMP ('vinyl-clean-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory $work | Out-Null
$wrotePolicy = $false
$madeKey = $false
try {
  $installed = Start-Process -FilePath $Setup -ArgumentList '/S' -PassThru -Wait
  if ($installed.ExitCode -ne 0) { throw "Setup exited with $($installed.ExitCode)" }
  $programs = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'
  $shortcut = @(Get-ChildItem $programs -Recurse -Filter 'NexusDownloader.lnk')
  if ($shortcut.Count -ne 1) { throw 'Expected a single NexusDownloader Start shortcut' }
  $target = (New-Object -ComObject WScript.Shell).CreateShortcut($shortcut[0].FullName)
  if ($target.TargetPath -ne (Join-Path $install $bin) -or $target.Arguments) {
    throw 'Unexpected arguments or app identity in the installed Start shortcut'
  }
  if (-not (Test-Path -LiteralPath $policy)) {
    New-Item -Path $policy -Force | Out-Null
    $madeKey = $true
  }
  if ((Get-Item -LiteralPath $policy).GetValueNames() -contains $bin) { throw 'Refusing to overwrite an existing WebView2 policy' }
  New-ItemProperty -LiteralPath $policy -Name $bin -PropertyType String -Value "--remote-debugging-port=$port" | Out-Null
  $wrotePolicy = $true
  node $Check $target.TargetPath $work $port 2>&1 | Tee-Object -Variable details
  if ($LASTEXITCODE -ne 0) { throw (($details | Select-Object -First 24) -join "`n") }
} finally {
  if ($wrotePolicy) { Remove-ItemProperty -LiteralPath $policy -Name $bin }
  if ($madeKey -and (Get-Item -LiteralPath $policy).ValueCount -eq 0) { Remove-Item -LiteralPath $policy }
  $uninstaller = Join-Path $install 'uninstall.exe'
  if (Test-Path -LiteralPath $uninstaller) { Start-Process -FilePath $uninstaller -ArgumentList '/S' -Wait }
  Remove-Item -LiteralPath $work -Recurse -Force
}
