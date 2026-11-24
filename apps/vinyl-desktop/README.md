# NexusDownloader — Vinyl Edition

Windows desktop adaptation of [imsyy/yt-dlp-gui](https://github.com/imsyy/yt-dlp-gui/tree/e3cd1df342c1dd0f543b309cf305210a588a461c), pinned to `e3cd1df342c1dd0f543b309cf305210a588a461c` under its [MIT license](LICENSE). This is a separate app from the older Qt installer and the web/API project. The original [upstream README](README.upstream.md) documents the inherited features; its release links go to the **stock upstream app**. The [NexusDownloader repository](https://github.com/sadapay404/NexusDownloader) is separate from those resources.

## On Windows

- If you installed the older Qt NexusDownloader, uninstall it in **Settings → Apps** before running the new Setup. Save media outside the installation folder. The new unsigned Setup targets Windows 10/11 x64 and creates a **NexusDownloader** shortcut in Start for the current user. WebView2 may need to be downloaded during installation.
- **Tool Manager** in Settings manages the upstream yt-dlp, JavaScript runtime and FFmpeg tools. Install missing tools if prompted. The app has no built-in app updater. For managed tool installations and updates, it selects an exact upstream GitHub release asset, compares its size and SHA-256 with the release metadata, and checks the reported version before replacing the existing binary. This is an integrity check against the release repository, not an independent signature. If setup interrupts link inspection, return Home and use **Retry link**.
- In **Standard → Review formats**, enter a URL and choose **Inspect link**. An idle Home window also inspects a valid YouTube watch, share or Shorts link from the clipboard on focus; it doesn't replace typed text or start a download by itself. Batch and Quick Download are still available, as are History and the upstream tools and settings.
- **Pending** shows the source thumbnail, title and duration. Where an exact 1080p track is offered, it is initially selected. For eligible video-and-audio items, choose a save folder, then **Continue** to start the five-second foreground countdown. Clicking a quality or **More** cancels it. **More** reveals **144p, 240p, 360p, 2K and 4K** without inventing a format the site didn't return. Portrait sources use the shorter image edge. **Formats & advanced** takes you to the original codec, audio, subtitle, clipping, remux and other controls. Playlists and audio-only tasks still use the advanced controls. Pending selections are restored on restart without restarting any countdown. A format that disappeared must be reselected explicitly. Capped Quick Download uses the same portrait-aware tier and stops if the cap cannot be met.
- If tool settings did not apply, use **Retry tool settings** after correcting them in Settings. Waiting tasks stay queued and resume only after the tool configuration succeeds; already-running tasks are not stopped.
- **Downloads** keeps copies from separate attempts instead of reusing or overwriting an earlier save. It marks a task saved only after verifying a nonempty, readable output in the chosen folder. Waiting tasks resume oldest-first after startup applies your tool settings; already-started tasks are marked interrupted. If a saved file is unavailable, the history entry stays. Only save media you're authorized to download. A YouTube verification challenge may prevent the upstream extractor from returning formats on a particular PC or connection; the new UI doesn't circumvent it.

## Backend boundary

The app still uses yt-dlp for extraction and FFmpeg for media processing. The fork now owns download arguments, output verification, process-tree cancellation, managed install verification, and durable queue/recovery behavior. Output templates are relative to the selected folder. Filenames include an attempt suffix so that a retry cannot reuse an unrelated `.part` or final file. Unsupported custom yt-dlp options are rejected rather than allowed to change the selected format or bypass output verification.

`UPSTREAM-SHA256SUMS` preserves the original 84-file baseline. `FORK-SHA256SUMS` records the modified and added fork files. `node scripts/verification/verify-source.mjs` checks the combined set; when changing a covered file, review and update its fork hash rather than rewriting the upstream baseline. This detects source drift; it is not a signing mechanism.

## Windows x64 build and verification

Use a Windows x64 machine/runner with WebView2, Visual Studio 2022 Build Tools (Desktop development with C++ and a Windows SDK), Node 22 and Git for Windows. From `apps/vinyl-desktop` in PowerShell:

```powershell
$env:COREPACK_ENABLE_DOWNLOAD_PROMPT = '0'
$env:RUSTUP_TOOLCHAIN = '1.100.0-x86_64-pc-windows-msvc'
rustup toolchain install $env:RUSTUP_TOOLCHAIN --profile minimal
corepack enable pnpm
pnpm install --frozen-lockfile
node scripts/verification/verify-source.mjs
pnpm audit --prod
pnpm audit
pnpm lint
pnpm test
pnpm build
pnpm exec playwright install chromium
pnpm test:ui
cargo test --locked --manifest-path src-tauri/Cargo.toml --lib
$argsForTauri = @('node_modules/@tauri-apps/cli/tauri.js', 'build', '--target', 'x86_64-pc-windows-msvc', '--bundles', 'nsis', '--ci', '--no-sign', '--', '--locked')
node @argsForTauri
```

On a **fresh disposable Windows user/VM** with English UI, run the installer verifier. It checks PE architecture/identity, legacy-install protection, per-user registration, Start shortcut ownership and MIT notice; opens the installed Tauri UI and checks a byte-identical save, keep-both behavior when the media changes, a stale format ID, rejection of simulation mode, and a real in-flight transfer cancellation; then checks uninstallation leaves both saves intact. It writes a renamed deliverable + SHA‑256 only after those checks pass. This local synthetic sample is intentionally not a YouTube availability test.

```powershell
$setup = Get-ChildItem src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis -File -Filter '*_x64-setup.exe'
.\verification\windows\verify-installer.ps1 -Setup $setup.FullName -Output "$env:TEMP\NexusDownloader-Windows-x64"
```

The [Windows workflow](../../.github/workflows/vinyl-windows.yml) gates packaging on both the renderer and the locked Rust tests. Select `native_soak` in a manual workflow run to verify the SHA-256 of that run's Setup, then exercise the installed app for at least 60 elapsed minutes with repeated checksum-verified saves and stops. For the same test on a disposable Windows VM, add `-NativeSoakMinutes 60` to the verifier command. That verifier uses a pinned yt-dlp executable and a local synthetic source. A separate Windows job launches the packaged app without executable overrides, installs the managed tools, saves a synthetic MP4 and verifies the video and audio streams of a separate-stream FFmpeg merge. These tests do not validate a live site. Playwright's separate renderer suite mocks Tauri IPC.

## Before distributing a new Setup

The remediation updates the Vue/Vite toolchain and patches the locked Rust TLS, HTTP, SQLite, ZIP, Tokio, and URL dependencies. The Rust advisory review is target-specific: the inherited Linux GTK stack still contains `glib` 0.18 (RUSTSEC-2024-0429), and the lockfile retains upstream maintenance notices. Do not treat a passing frontend audit as a native dependency or tool-signing review.

The [original 0.2.0 audit](../../artifacts/NexusDownloader-0.2.0-release-audit.md) and its Setup are historical. A source change or an unsigned build is not a release sign-off. For the candidate on Windows x64:

1. Pass the native workflow and soak. On a separate fresh standard-user Windows VM, start from the Start shortcut with no test overrides. Verify managed yt-dlp, Deno and FFmpeg/FFprobe installation and retry after a network interruption. Verify a failed update leaves the prior binaries usable.
2. Save an authorized watch video and an authorized Short from the intended network. Check playback, apparent quality, exact dimensions, and sound. Change quality for the same link in the same folder, include a separate-stream merge, and cancel during both transfer and FFmpeg work. Check restart with waiting tasks, an unavailable drive, long/Unicode paths, and minimum-size keyboard navigation at Windows scaling settings.
3. Verify interactive Qt migration or clean removal, same-edition upgrade and uninstall without damage to saved files. Review signing and SmartScreen on actual first launch. Track installed tool versions and any dependency findings for the Windows target. Test Windows 10 separately before advertising it.
