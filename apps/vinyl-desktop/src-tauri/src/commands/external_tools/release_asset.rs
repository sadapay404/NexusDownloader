//! Resolve a specific GitHub release once, then check its asset before execution.

use serde::Deserialize;
use std::time::Duration;

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

pub(super) async fn resolve_release_assets(
    repository: &str,
    names: &[&str],
) -> Result<(String, Vec<VerifiedAsset>), String> {
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
