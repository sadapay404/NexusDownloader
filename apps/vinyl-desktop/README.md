# NexusDownloader — Vinyl Edition

Windows desktop adaptation of [imsyy/yt-dlp-gui](https://github.com/imsyy/yt-dlp-gui/tree/e3cd1df342c1dd0f543b309cf305210a588a461c), pinned to `e3cd1df342c1dd0f543b309cf305210a588a461c` under its [MIT license](LICENSE). This is a separate app from the older Qt installer and the web/API project. The original [upstream README](README.upstream.md) documents the inherited features; its release links go to the **stock upstream app**.

## On Windows

- If you installed the older Qt NexusDownloader, uninstall it in **Settings → Apps** before running the new Setup. Save media outside the installation folder. The new unsigned Setup targets Windows 10/11 x64 and creates a **NexusDownloader** shortcut in Start for the current user. WebView2 may need to be downloaded during installation.
- **Tool Manager** in Settings manages the upstream yt-dlp, JavaScript runtime and FFmpeg tools. Install missing tools if prompted. The app updater no longer points to the stock GUI, but the tool install/update commands and channels are unchanged.
- In **Standard → Review formats**, enter a URL and choose **Inspect link**. An idle Home window also inspects a valid YouTube watch, share or Shorts link from the clipboard on focus; it doesn't replace typed text or start a download by itself. Batch and Quick Download are still available, as are History and the upstream tools and settings.
- **Pending** shows the source thumbnail, title and duration. Where an exact 1080p track is offered, it is initially selected. For eligible video-and-audio items, choose a save folder, then **Continue** to start the five-second foreground countdown. Clicking a quality or **More** cancels it. **More** reveals **144p, 240p, 360p, 2K and 4K** without inventing a format the site didn't return. Portrait sources use the shorter image edge. **Formats & advanced** takes you to the original codec, audio, subtitle, clipping, remux and other controls. Playlists and audio-only tasks still use the upstream controls.
- **Downloads** shows queue state, progress, speed, ETA, logs, and the saved filename when the downloader reports a destination. Use **Open Folder** to confirm the output. Only save media you're authorized to download. A YouTube verification challenge may prevent the upstream extractor from returning formats on a particular PC or connection; the new UI doesn't circumvent it.

## Backend boundary

`UPSTREAM-SHA256SUMS` records 84 upstream files: Rust code, Cargo manifests, the browser extension, the download/format stores and launcher, and core helpers. Check from this folder with `sha256sum -c --quiet UPSTREAM-SHA256SUMS`. The fork's new code is in the Vue presentation, link intake and pending quality controls. Tauri configuration changes identity, icons, notices, and Setup, and removes stock app-update privileges. It does not replace the native download engine, tool sources, command arguments, queue, storage, or recovery behavior.

## Windows x64 build and verification

Use a Windows x64 machine/runner with WebView2, Visual Studio 2022 Build Tools (Desktop development with C++ and a Windows SDK), Node 22 and Git for Windows. From `apps/vinyl-desktop` in PowerShell:

```powershell
$env:COREPACK_ENABLE_DOWNLOAD_PROMPT = '0'
$env:RUSTUP_TOOLCHAIN = '1.100.0-x86_64-pc-windows-msvc'
rustup toolchain install $env:RUSTUP_TOOLCHAIN --profile minimal
corepack enable pnpm
pnpm install --frozen-lockfile
pnpm lint
pnpm test
pnpm build
pnpm exec playwright install chromium
pnpm test:ui
$argsForTauri = @('node_modules/@tauri-apps/cli/tauri.js', 'build', '--target', 'x86_64-pc-windows-msvc', '--bundles', 'nsis', '--ci', '--no-sign', '--', '--locked')
node @argsForTauri
```

On a **fresh disposable Windows user/VM** with English UI, run the installer verifier. It checks PE architecture/identity, legacy-install protection, per-user registration, Start shortcut ownership and MIT notice; opens the installed Tauri UI and verifies a byte-identical MP4 saved through the actual native yt-dlp path; then checks uninstallation doesn't touch that saved file. It writes a renamed deliverable + SHA‑256 only after those checks pass. This local synthetic sample is intentionally not a YouTube availability test.

```powershell
$setup = Get-ChildItem src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis -File -Filter '*_x64-setup.exe'
.\verification\windows\verify-installer.ps1 -Setup $setup.FullName -Output "$env:TEMP\NexusDownloader-Windows-x64"
```

The same build is defined in [the Windows workflow](../../.github/workflows/vinyl-windows.yml). The browser tests use emulated Tauri IPC; they do not run Rust or install the `.exe`. On the intended PC, separately test **Start → NexusDownloader**, then an authorized watch link and an authorized Short. Check that each saved file opens, has audio/video where intended, and can seek near the end. If inspection stops before formats are shown, capture the native error from the same PC and network rather than counting an inspection, playback, or fixture as a live save.
