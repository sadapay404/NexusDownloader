//! 下载任务参数与运行时状态。

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use super::process_tree::ProcessTree;

pub(super) type CancelReply = tokio::sync::oneshot::Sender<Result<(), String>>;

/// 下载进程信息（运行时状态）
pub(super) struct DownloadProcessInfo {
    pub(super) tree: Arc<ProcessTree>,
    pub cancel_tx: tokio::sync::mpsc::Sender<CancelReply>,
    /// 时间裁剪的片段时长（秒），用于计算 ffmpeg 处理进度
    pub clip_duration: Option<f64>,
    pub errors: DownloadErrors,
}

/// Keep diagnostics bounded even for playlists with thousands of failures.
#[derive(Default)]
pub struct DownloadErrors {
    count: usize,
    recent: Vec<String>,
}

impl DownloadErrors {
    pub fn record(&mut self, line: &str) {
        self.count += 1;
        if self.recent.len() == 10 {
            self.recent.remove(0);
        }
        self.recent.push(line.to_string());
    }

    pub fn summary(&self) -> Option<String> {
        match self.count {
            0 => None,
            1 => self.recent.first().cloned(),
            count => Some(format!(
                "err_download_errors:{}\n{}",
                count,
                self.recent.join("\n")
            )),
        }
    }
}

#[cfg(test)]
mod error_tests {
    use super::DownloadErrors;

    #[test]
    fn keeps_single_errors_compatible_and_summarizes_multiple_failures() {
        let mut errors = DownloadErrors::default();
        assert_eq!(errors.summary(), None);
        errors.record("ERROR: [youtube] first: unavailable");
        assert_eq!(
            errors.summary().unwrap(),
            "ERROR: [youtube] first: unavailable"
        );
        errors.record("ERROR: [youtube] second: HTTP Error 403");
        let summary = errors.summary().unwrap();
        assert!(summary.starts_with("err_download_errors:2\n"));
        assert!(summary.contains("first: unavailable"));
        assert!(summary.contains("second: HTTP Error 403"));
    }

    #[test]
    fn counts_all_errors_but_only_keeps_the_latest_ten_details() {
        let mut errors = DownloadErrors::default();
        for index in 0..100 {
            errors.record(&format!("ERROR: video-{} failed", index));
        }
        let summary = errors.summary().unwrap();
        assert!(summary.starts_with("err_download_errors:100\n"));
        assert_eq!(summary.lines().count(), 11);
        assert!(summary.contains("video-99 failed"));
        assert!(!summary.contains("video-89 failed"));
    }
}

/// 下载状态管理（全局共享）
pub struct DownloadState {
    pub(super) processes: Arc<Mutex<HashMap<String, DownloadProcessInfo>>>,
}

impl DownloadState {
    /// At process exit there is no new work to schedule. The next cold boot
    /// records these attempts as interrupted and leaves queued work alone.
    pub(crate) fn terminate_all(&self) {
        if let Ok(processes) = self.processes.lock() {
            for info in processes.values() {
                let _ = info.tree.terminate();
            }
        }
    }
}

impl Default for DownloadState {
    fn default() -> Self {
        Self {
            processes: Arc::new(Mutex::new(HashMap::new())),
        }
    }
}

/// 下载任务参数（从前端传入）
#[derive(Default, serde::Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct DownloadParams {
    pub id: String,
    pub url: String,
    pub download_dir: String,
    pub download_mode: String,
    pub video_format: Option<String>,
    pub video_has_audio: bool,
    pub prefer_video: bool,
    pub audio_format: Option<String>,
    pub cookie_file: Option<String>,
    /// 从浏览器读取 Cookie 的浏览器名称
    pub cookie_browser: Option<String>,
    /// 代理地址
    pub proxy: Option<String>,
    /// 文件名模板
    pub output_template: Option<String>,
    /// 并发分片数
    pub concurrent_fragments: Option<u32>,
    pub embed_subs: bool,
    pub embed_thumbnail: bool,
    /// 下载封面为单独文件（--write-thumbnail），与嵌入封面相互独立
    pub write_thumbnail: bool,
    /// 下载简介为单独文件（--write-description）
    pub write_description: bool,
    pub embed_metadata: bool,
    /// 嵌入章节标记
    pub embed_chapters: bool,
    /// 移除赞助片段（SponsorBlock）
    pub sponsorblock_remove: bool,
    /// 提取音频模式（-x）
    pub extract_audio: bool,
    /// 音频转换格式（--audio-format）
    pub audio_convert_format: Option<String>,
    pub no_merge: bool,
    pub recode_format: Option<String>,
    /// 重新混流 / 合并封装格式（--remux-video / --merge-output-format）
    pub remux_format: Option<String>,
    pub limit_rate: Option<String>,
    /// 自定义 FFmpeg 后处理参数（--postprocessor-args）
    pub ffmpeg_args: Option<String>,
    /// 自定义 yt-dlp 附加参数（如 --sleep-requests、--sleep-interval）
    pub custom_args: Option<String>,
    pub subtitles: Vec<String>,
    pub start_time: Option<f64>,
    pub end_time: Option<f64>,
    /// Re-encode around cut points for precise sections; default false keeps fast cuts.
    pub force_keyframes_at_cuts: bool,
    pub no_playlist: bool,
    pub playlist_items: Option<String>,
    /// 从开始下载直播流（--live-from-start）
    pub live_from_start: bool,
}
