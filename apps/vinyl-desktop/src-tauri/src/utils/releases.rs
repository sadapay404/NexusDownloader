//! 各平台外部工具的官方发行下载地址。

use super::source::get_ytdlp_channel;

/// 获取工具的最新稳定发行页；请求完成后的重定向 URL 包含实际版本标签。
/// yt-dlp 按当前所选通道返回对应仓库地址（stable/nightly/master）。
pub fn get_tool_latest_release_url(tool: &str) -> Option<String> {
    match tool {
        "yt-dlp" => Some(get_ytdlp_latest_release_url()),
        "deno" => Some("https://github.com/denoland/deno/releases/latest".to_string()),
        "ffmpeg" => Some("https://github.com/eugeneware/ffmpeg-static/releases/latest".to_string()),
        _ => None,
    }
}

/// 当前通道下 yt-dlp 最新发行页；重定向 URL 包含实际版本标签。
pub fn get_ytdlp_latest_release_url() -> String {
    format!(
        "https://github.com/{}/releases/latest",
        get_ytdlp_channel().repository()
    )
}

/// 当前平台下 yt-dlp 可执行文件在对应通道中的资产名。
fn ytdlp_asset_name() -> &'static str {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("windows", "aarch64") => "yt-dlp_arm64.exe",
        ("windows", "x86") => "yt-dlp_x86.exe",
        ("windows", _) => "yt-dlp.exe",
        ("macos", _) => "yt-dlp_macos",
        (_, "aarch64") => "yt-dlp_linux_aarch64",
        _ => "yt-dlp_linux",
    }
}

pub fn ytdlp_release_asset() -> (&'static str, &'static str) {
    (get_ytdlp_channel().repository(), ytdlp_asset_name())
}

pub fn deno_release_asset() -> &'static str {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("windows", "aarch64") => "deno-aarch64-pc-windows-msvc.zip",
        ("windows", _) => "deno-x86_64-pc-windows-msvc.zip",
        ("macos", "aarch64") => "deno-aarch64-apple-darwin.zip",
        ("macos", _) => "deno-x86_64-apple-darwin.zip",
        (_, "aarch64") => "deno-aarch64-unknown-linux-gnu.zip",
        _ => "deno-x86_64-unknown-linux-gnu.zip",
    }
}

pub fn ffmpeg_release_assets() -> [String; 2] {
    let platform = match (std::env::consts::OS, std::env::consts::ARCH) {
        ("windows", _) => "win32-x64",
        ("macos", "aarch64") => "darwin-arm64",
        ("macos", _) => "darwin-x64",
        (_, "aarch64") => "linux-arm64",
        (_, "arm") => "linux-arm",
        _ => "linux-x64",
    };
    [format!("ffmpeg-{platform}"), format!("ffprobe-{platform}")]
}
