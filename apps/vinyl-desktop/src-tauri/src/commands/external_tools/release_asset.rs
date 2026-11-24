//! Resolve a specific GitHub release once, then check its asset before execution.

use serde::Deserialize;
use std::{path::Path, time::Duration};

const RELEASE_ERROR: &str = "err_tool_release";
const INTEGRITY_ERROR: &str = "err_tool_integrity";

#[derive(Deserialize)]
struct Release {
    tag_name: String,
    draft: bool,
    assets: Vec<Asset>,
}

#[derive(Deserialize)]
struct Asset {
    name: String,
    browser_download_url: String,
    digest: Option<String>,
    size: u64,
}

pub(super) struct VerifiedAsset {
    pub url: String,
    pub size: u64,
    digest: String,
}

impl VerifiedAsset {
    pub fn check_integrity(&self, bytes: u64, digest: &str) -> Result<(), String> {
        if self.size == bytes && self.digest.eq_ignore_ascii_case(digest) {
            Ok(())
        } else {
            Err(INTEGRITY_ERROR.into())
        }
    }
}

impl Release {
    fn resolve(&self, repository: &str, names: &[&str]) -> Result<Vec<VerifiedAsset>, String> {
        let tag = &self.tag_name;
        if self.draft
            || tag.is_empty()
            || !tag
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b"._-".contains(&byte))
        {
            return Err(RELEASE_ERROR.into());
        }
        names
            .iter()
            .map(|name| {
                let asset = self
                    .assets
                    .iter()
                    .find(|asset| asset.name == *name)
                    .ok_or(RELEASE_ERROR)?;
                let url = format!("https://github.com/{repository}/releases/download/{tag}/{name}");
                if asset.browser_download_url != url
                    || asset.size == 0
                    || asset.size > 512 * 1024 * 1024
                {
                    return Err(RELEASE_ERROR.into());
                }
                let digest = asset
                    .digest
                    .as_deref()
                    .and_then(|value| value.strip_prefix("sha256:"))
                    .filter(|digest| {
                        digest.len() == 64 && digest.bytes().all(|byte| byte.is_ascii_hexdigit())
                    })
                    .ok_or(RELEASE_ERROR)?;
                Ok(VerifiedAsset {
                    url,
                    size: asset.size,
                    digest: digest.into(),
                })
            })
            .collect()
    }
}

/// Use the audited bootstrap snapshot only for a new managed Windows x64 install.
/// A reinstall or update must use current release metadata rather than downgrade.
pub(super) fn new_managed_install(operation: &str, targets: &[&Path]) -> bool {
    operation == "install"
        && !targets.is_empty()
        && targets.iter().all(|target| {
            matches!(
                std::fs::symlink_metadata(target),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound
            )
        })
}

fn windows_bootstrap_release(
    repository: &str,
    names: &[&str],
) -> Result<Option<(String, Vec<VerifiedAsset>)>, String> {
    let mut pinned: std::collections::HashMap<String, Release> =
        serde_json::from_str(include_str!("../../../windows/bootstrap-releases.json"))
            .map_err(|_| RELEASE_ERROR)?;
    let Some(release) = pinned.remove(repository) else {
        return Ok(None);
    };
    let assets = release.resolve(repository, names)?;
    Ok(Some((release.tag_name, assets)))
}

pub(super) async fn resolve_release_assets(
    repository: &str,
    names: &[&str],
    new_install: bool,
) -> Result<(String, Vec<VerifiedAsset>), String> {
    if new_install && cfg!(all(target_os = "windows", target_arch = "x86_64")) {
        if let Some(pinned) = windows_bootstrap_release(repository, names)? {
            return Ok(pinned);
        }
    }
    let client = reqwest::Client::builder()
        .https_only(true)
        .timeout(Duration::from_secs(30))
        .redirect(reqwest::redirect::Policy::none())
        .user_agent("NexusDownloader/managed-tools")
        .build()
        .map_err(|e| format!("{RELEASE_ERROR}:{e}"))?;
    let response = client
        .get(format!(
            "https://api.github.com/repos/{repository}/releases/latest"
        ))
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|e| format!("{RELEASE_ERROR}:{e}"))?
        .error_for_status()
        .map_err(|e| format!("{RELEASE_ERROR}:{e}"))?;
    let data = response
        .bytes()
        .await
        .map_err(|e| format!("{RELEASE_ERROR}:{e}"))?;
    let release: Release =
        serde_json::from_slice(&data).map_err(|e| format!("{RELEASE_ERROR}:{e}"))?;
    let assets = release.resolve(repository, names)?;
    Ok((release.tag_name, assets))
}

pub(super) fn check_reported_version(tool: &str, tag: &str, output: &str) -> Result<(), String> {
    let first_line = output.lines().next().unwrap_or_default();
    let version = match tool {
        "yt-dlp" => Some(first_line),
        "deno" => first_line.strip_prefix("deno "),
        "ffmpeg" => first_line.strip_prefix("ffmpeg version "),
        "ffprobe" => first_line.strip_prefix("ffprobe version "),
        _ => None,
    }
    .and_then(|line| line.split_whitespace().next());
    let expected = tag.trim_start_matches(['v', 'b']);
    if version.is_some_and(|value| {
        value == expected
            || (matches!(tool, "ffmpeg" | "ffprobe")
                && value
                    .strip_prefix(expected)
                    .is_some_and(|suffix| suffix.starts_with('-')))
    }) {
        Ok(())
    } else {
        Err(format!("err_tool_version:{tool}, expected {tag}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use sha2::Digest;

    #[test]
    fn rejects_unverified_incomplete_and_mismatched_assets() {
        let digest = format!("{:x}", sha2::Sha256::digest(b"verified data"));
        let mut release = Release {
            tag_name: "v1.2.3".into(),
            draft: false,
            assets: vec![Asset {
                name: "tool.zip".into(),
                browser_download_url:
                    "https://github.com/test/tool/releases/download/v1.2.3/tool.zip".into(),
                size: 13,
                digest: Some(format!("sha256:{digest}")),
            }],
        };
        let assets = release.resolve("test/tool", &["tool.zip"]).unwrap();
        assert!(assets[0].check_integrity(13, &digest).is_ok());
        assert!(assets[0].check_integrity(12, &digest).is_err());
        assert!(assets[0].check_integrity(13, &"0".repeat(64)).is_err());
        assert!(release
            .resolve("test/tool", &["tool.zip", "other.zip"])
            .is_err());
        assert!(release.resolve("other/tool", &["tool.zip"]).is_err());
        release.assets[0].digest = None;
        assert!(release.resolve("test/tool", &["tool.zip"]).is_err());
    }

    #[test]
    fn bootstrap_is_pinned_to_exact_official_assets_and_never_to_a_different_channel() {
        let (tag, assets) = windows_bootstrap_release("yt-dlp/yt-dlp", &["yt-dlp.exe"])
            .unwrap()
            .unwrap();
        assert_eq!(
            assets[0].url,
            format!("https://github.com/yt-dlp/yt-dlp/releases/download/{tag}/yt-dlp.exe")
        );
        assert!(assets[0]
            .check_integrity(assets[0].size, &assets[0].digest)
            .is_ok());
        assert!(
            windows_bootstrap_release("yt-dlp/yt-dlp-nightly-builds", &["yt-dlp.exe"])
                .unwrap()
                .is_none()
        );
        assert!(
            windows_bootstrap_release("denoland/deno", &["deno-x86_64-pc-windows-msvc.zip"])
                .unwrap()
                .is_some()
        );
        assert!(windows_bootstrap_release(
            "eugeneware/ffmpeg-static",
            &["ffmpeg-win32-x64", "ffprobe-win32-x64"]
        )
        .unwrap()
        .is_some());
        assert!(
            windows_bootstrap_release("eugeneware/ffmpeg-static", &["ffmpeg-linux-x64"]).is_err()
        );
    }

    #[test]
    fn existing_or_partially_installed_tools_do_not_use_the_bootstrap_snapshot() {
        let dir = tempfile::tempdir().unwrap();
        let ffmpeg = dir.path().join("ffmpeg.exe");
        let ffprobe = dir.path().join("ffprobe.exe");
        let paths = [ffmpeg.as_path(), ffprobe.as_path()];
        assert!(new_managed_install("install", &paths));
        assert!(!new_managed_install("update", &paths));
        std::fs::write(&ffmpeg, b"existing version").unwrap();
        assert!(!new_managed_install("install", &paths));
    }

    #[test]
    fn validates_the_version_and_tool_identity() {
        assert!(check_reported_version("yt-dlp", "2026.10.26", "2026.10.26\n").is_ok());
        assert!(check_reported_version("deno", "v2.9.8", "deno 2.9.8 (stable)\nv8 1").is_ok());
        assert!(
            check_reported_version("ffmpeg", "b6.1.1", "ffmpeg version 6.1.1-static build").is_ok()
        );
        assert!(
            check_reported_version("ffprobe", "b6.1.1", "ffmpeg version 6.1.1-static build")
                .is_err()
        );
        assert!(check_reported_version("yt-dlp", "2026.10.26", "2026.10.25").is_err());
    }
}
