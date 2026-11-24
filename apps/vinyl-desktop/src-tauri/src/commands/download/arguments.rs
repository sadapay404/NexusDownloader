//! yt-dlp 下载参数构建与校验。

use crate::{commands::support::append_cookie_proxy_args, utils};
use tauri::AppHandle;

use super::model::DownloadParams;

pub(super) fn requires_ffmpeg(params: &DownloadParams) -> bool {
    (params.download_mode == "default"
        && !params.no_merge
        && (!params.video_has_audio
            || params
                .audio_format
                .as_deref()
                .is_some_and(|format| !format.is_empty()))
        && (params
            .video_format
            .as_deref()
            .is_some_and(|format| !format.is_empty())
            || params.audio_format.as_deref().is_some_and(|format| {
                format.contains('+') || (params.prefer_video && !format.is_empty())
            })))
        || requires_audio_extraction(params)
        || params.embed_subs
        || params.embed_thumbnail
        || params.embed_metadata
        || params.embed_chapters
        || params.sponsorblock_remove
        || params
            .recode_format
            .as_deref()
            .is_some_and(|s| !s.is_empty())
        || params
            .remux_format
            .as_deref()
            .is_some_and(|s| !s.is_empty() && s != "auto")
        || params.start_time.is_some_and(|t| t > 0.0)
        || params.end_time.is_some()
}

fn requires_audio_extraction(params: &DownloadParams) -> bool {
    params.extract_audio
        || (params.download_mode == "audio"
            && params
                .audio_format
                .as_deref()
                .is_none_or(|format| format.is_empty()))
}

/// Match a literal extractor ID, never the selector keywords, extension aliases,
/// or fallback expressions that yt-dlp also accepts in `-f`.
fn exact_format(id: &str, selector: &str) -> Result<String, String> {
    if id.is_empty()
        || !id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"_.:-".contains(&byte))
    {
        return Err("err_invalid_format_id".into());
    }
    Ok(format!("{selector}[format_id='{id}']"))
}

pub(super) fn build_format_args(params: &DownloadParams) -> Result<Vec<String>, String> {
    let video = params.video_format.as_deref().filter(|id| !id.is_empty());
    let audio = params.audio_format.as_deref().filter(|id| !id.is_empty());
    let mut multistream = false;
    let selector = if requires_audio_extraction(params) || params.download_mode == "audio" {
        match audio {
            Some(ids) => exact_format(ids.split('+').next().unwrap_or_default(), "ba")?,
            None => "ba/b".into(), // Extraction from a combined file is intentional in audio mode.
        }
    } else if params.download_mode == "video" {
        match video {
            Some(id) => exact_format(id, "bv")?,
            None => "bv".into(),
        }
    } else {
        let video = video.map(|id| exact_format(id, "bv*")).transpose()?;
        let audio = audio
            .map(|ids| {
                ids.split('+')
                    .map(|id| exact_format(id, "ba"))
                    .collect::<Result<Vec<_>, _>>()
            })
            .transpose()?
            .unwrap_or_default();
        let joiner = if params.no_merge { "," } else { "+" };
        match (video, audio.is_empty()) {
            (Some(v), false) => {
                // Also preserve explicitly selected audio when the video has a built-in track.
                multistream = !params.no_merge;
                format!("{v}{joiner}{}", audio.join(joiner))
            }
            (Some(v), true) if params.no_merge => v,
            // Even if metadata has changed, only this exact video ID may be used.
            (Some(v), true) => format!("{v}[acodec!=none]/{v}[acodec=none]+ba"),
            (None, false) if params.prefer_video => {
                multistream = !params.no_merge;
                format!("bv*{joiner}{}", audio.join(joiner))
            }
            (None, false) => {
                multistream = !params.no_merge && audio.len() > 1;
                audio.join(joiner)
            }
            (None, true) if params.no_merge => "bv,ba".into(),
            (None, true) => return Ok(Vec::new()), // Deliberate Automatic selection.
        }
    };
    let mut args = vec!["-f".into(), selector];
    if multistream {
        args.push("--audio-multistreams".into());
    }
    Ok(args)
}

/// 构建 yt-dlp 下载参数
pub(super) fn build_download_args(
    app: &AppHandle,
    params: &DownloadParams,
    output_token: &str,
) -> Result<Vec<String>, String> {
    validate_time_range(params.start_time, params.end_time)?;
    if !matches!(params.download_mode.as_str(), "default" | "audio" | "video") {
        return Err("err_invalid_download_mode".into());
    }
    crate::utils::validate_media_url(&params.url)?;
    let mut args: Vec<String> = vec![
        "--newline".to_string(),
        "--ignore-config".to_string(),  // 忽略用户系统配置，防止干扰 GUI
        "--color".to_string(), "never".to_string(),  // 禁用 ANSI 颜色转义序列
        // 使用 --progress-template 输出结构化进度
        // download 模板：下载阶段的进度（包含 fragment 信息以支持 HLS/DASH/直播流）
        "--progress-template".to_string(),
        r#"download:PROGRESS_JSON:{"percent":"%(progress._percent_str|0%)s","speed":"%(progress._speed_str|)s","eta":"%(progress._eta_str|)s","downloaded":"%(progress._downloaded_bytes_str|)s","total":"%(progress._total_bytes_str|)s","fragmentIndex":"%(progress.fragment_index|0)s","fragmentCount":"%(progress.fragment_count|0)s","status":"downloading"}"#.to_string(),
        // postprocess 模板：后处理阶段（合并/嵌入等），前端据此区分下载与后处理
        "--progress-template".to_string(),
        r#"postprocess:PROGRESS_JSON:{"status":"postprocessing"}"#.to_string(),
        // 进度输出间隔，避免高频刷屏
        "--progress-delta".to_string(),
        "1".to_string(),
    ];

    // JS 运行时（Deno）
    args.extend(utils::build_js_runtime_args(app));
    args.extend(utils::build_ffmpeg_location_args(app));
    args.extend(utils::build_plugin_args(app));
    // YouTube PO Token / visitor_data（如设置）
    args.extend(utils::build_youtube_extractor_args());

    // 格式选择
    args.extend(build_format_args(params)?);

    // 代理
    if let Some(ref proxy) = params.proxy {
        if !proxy.is_empty() {
            args.push("--proxy".to_string());
            args.push(proxy.clone());
        }
    }

    append_output_args(&mut args, params, output_token)?;
    args.extend([
        "--no-overwrites".into(),
        "--abort-on-unavailable-fragments".into(),
    ]);

    // 并发分片下载
    if let Some(n) = params.concurrent_fragments {
        if n > 1 {
            args.push("--concurrent-fragments".to_string());
            args.push(n.to_string());
        }
    }

    // Cookie 和浏览器 Cookie
    append_cookie_proxy_args(
        &mut args,
        params.cookie_file.as_deref(),
        params.cookie_browser.as_deref(),
        None, // 代理在上方已单独处理
    );

    // 额外选项
    if params.embed_subs {
        args.push("--embed-subs".to_string());
    }
    if params.embed_thumbnail {
        args.push("--embed-thumbnail".to_string());
    }
    // 封面存为单独文件（与 -o 同名模板不同扩展名），与嵌入封面可同时使用
    if params.write_thumbnail {
        args.push("--write-thumbnail".to_string());
    }
    // 简介存为单独的 .description 文件（同样跟随 -o 命名模板）
    if params.write_description {
        args.push("--write-description".to_string());
    }
    if params.embed_metadata {
        args.push("--embed-metadata".to_string());
    }
    // 嵌入章节标记
    if params.embed_chapters {
        args.push("--embed-chapters".to_string());
    }
    // SponsorBlock：移除赞助片段
    if params.sponsorblock_remove {
        args.push("--sponsorblock-remove".to_string());
        args.push("all".to_string());
    }
    // 提取音频模式
    if requires_audio_extraction(params) {
        args.push("-x".to_string());
        if let Some(ref fmt) = params.audio_convert_format {
            if !fmt.is_empty() {
                args.push("--audio-format".to_string());
                args.push(fmt.clone());
            }
        }
    }
    if let Some(ref fmt) = params.recode_format {
        if !fmt.is_empty() {
            args.push("--recode-video".to_string());
            args.push(fmt.clone());
        }
    }
    // 重新混流 / 合并封装格式（无需二次编码，解决 Issue #51, #33, #30）
    if let Some(ref remux) = params.remux_format {
        if !remux.is_empty() && remux != "auto" {
            args.push("--remux-video".to_string());
            args.push(remux.clone());
            args.push("--merge-output-format".to_string());
            args.push(remux.clone());
        }
    }
    if let Some(ref rate) = params.limit_rate {
        if !rate.is_empty() {
            args.push("-r".to_string());
            args.push(rate.clone());
        }
    }
    // 自定义 FFmpeg 后处理参数
    if let Some(ref ffmpeg_args) = params.ffmpeg_args {
        if !ffmpeg_args.is_empty() {
            args.push("--postprocessor-args".to_string());
            args.push(format!("FFmpeg:{}", ffmpeg_args));
        }
    }
    args.extend(utils::parse_media_options(
        params.custom_args.as_deref().unwrap_or_default(),
    )?);

    // 字幕
    append_subtitle_args(&mut args, &params.subtitles);

    // 时间范围裁剪（仅在有实际裁剪范围时添加，避免 *0-inf 触发不必要的 ffmpeg 处理）
    // 前端已将 time picker 值转换为秒数
    append_time_range_args(&mut args, params);

    // 播放列表
    if params.no_playlist {
        args.push("--no-playlist".to_string());
    } else if let Some(ref items) = params.playlist_items {
        if !items.is_empty() {
            args.push("--playlist-items".to_string());
            args.push(items.clone());
        }
    }

    // 直播流：从开始下载（实验性，仅 YouTube/Twitch/TVer/mellow-fan）
    if params.live_from_start {
        args.push("--live-from-start".to_string());
    }

    Ok(args)
}

fn append_time_range_args(args: &mut Vec<String>, params: &DownloadParams) {
    let has_start = params.start_time.is_some_and(|time| time > 0.0);
    if !has_start && params.end_time.is_none() {
        return;
    }
    let start = params.start_time.unwrap_or(0.0);
    let end = params
        .end_time
        .map(|time| time.to_string())
        .unwrap_or_else(|| "inf".to_string());
    args.extend(["--download-sections".to_string(), format!("*{start}-{end}")]);
    if params.force_keyframes_at_cuts {
        args.push("--force-keyframes-at-cuts".to_string());
    }
}

fn validate_time_range(start: Option<f64>, end: Option<f64>) -> Result<(), String> {
    let start = start.unwrap_or(0.0);
    if !start.is_finite() || start < 0.0 || end.is_some_and(|end| !end.is_finite() || end <= start)
    {
        return Err("Invalid time range: the end must be after a non-negative start".into());
    }
    Ok(())
}

#[cfg(test)]
mod time_range_tests {
    use super::{append_time_range_args, validate_time_range, DownloadParams};

    #[test]
    fn rejects_invalid_ranges_before_starting_ffmpeg() {
        assert!(validate_time_range(Some(60.0), Some(60.0)).is_err());
        assert!(validate_time_range(Some(-1.0), None).is_err());
        assert!(validate_time_range(Some(f64::NAN), None).is_err());
        assert!(validate_time_range(None, Some(f64::INFINITY)).is_err());
        assert!(validate_time_range(None, Some(20.0)).is_ok());
        assert!(validate_time_range(Some(60.0), None).is_ok());
    }

    #[test]
    fn precise_cuts_are_opt_in_and_only_apply_to_actual_sections() {
        let mut params = DownloadParams {
            start_time: Some(10.0),
            end_time: Some(30.0),
            ..Default::default()
        };
        let mut args = Vec::new();
        append_time_range_args(&mut args, &params);
        assert_eq!(args, ["--download-sections", "*10-30"]);
        params.force_keyframes_at_cuts = true;
        args.clear();
        append_time_range_args(&mut args, &params);
        assert_eq!(
            args,
            ["--download-sections", "*10-30", "--force-keyframes-at-cuts"]
        );

        params.end_time = None;
        args.clear();
        append_time_range_args(&mut args, &params);
        assert_eq!(
            args,
            [
                "--download-sections",
                "*10-inf",
                "--force-keyframes-at-cuts"
            ]
        );
        params.start_time = Some(0.0);
        args.clear();
        append_time_range_args(&mut args, &params);
        assert!(args.is_empty());
        params.start_time = None;
        append_time_range_args(&mut args, &params);
        assert!(args.is_empty());
        params.end_time = Some(20.0);
        append_time_range_args(&mut args, &params);
        assert_eq!(
            args,
            ["--download-sections", "*0-20", "--force-keyframes-at-cuts"]
        );
    }

    #[test]
    fn legacy_params_default_to_fast_cuts_and_camel_case_enables_precise_cuts() {
        let legacy: DownloadParams = serde_json::from_value(serde_json::json!({
            "startTime": 10,
            "endTime": 30
        }))
        .unwrap();
        assert!(!legacy.force_keyframes_at_cuts);
        let mut args = Vec::new();
        append_time_range_args(&mut args, &legacy);
        assert_eq!(args, ["--download-sections", "*10-30"]);

        let precise: DownloadParams = serde_json::from_value(serde_json::json!({
            "forceKeyframesAtCuts": true,
            "endTime": 30
        }))
        .unwrap();
        assert!(precise.force_keyframes_at_cuts);
        args.clear();
        append_time_range_args(&mut args, &precise);
        assert_eq!(
            args,
            ["--download-sections", "*0-30", "--force-keyframes-at-cuts"]
        );
    }
}

/// Keep paths inside the chosen destination. Every attempt has a fresh token;
/// playlists and no-merge streams also get distinct names even for a constant template.
pub(super) fn append_output_args(
    args: &mut Vec<String>,
    params: &DownloadParams,
    token: &str,
) -> Result<(), String> {
    let template = params
        .output_template
        .as_deref()
        .filter(|s| !s.is_empty())
        .unwrap_or("%(title).160B [%(id)s].%(ext)s");
    // Ignore template keys when checking separators (slice syntax uses ':').
    let mut shape = String::new();
    let mut chars = template.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch == '%' && chars.peek() == Some(&'%') {
            chars.next();
            shape.push('x');
        } else if ch == '%' && chars.peek() == Some(&'(') {
            if !chars.by_ref().any(|ch| ch == ')') {
                return Err("err_output_template_relative".into());
            }
            shape.push('x');
        } else {
            shape.push(ch);
        }
    }
    if shape.starts_with('~')
        || shape.contains([':', '$', '%'])
        || shape
            .split(['/', '\\'])
            .any(|part| part.chars().all(|ch| ch == '.' || ch.is_whitespace()))
    {
        return Err("err_output_template_relative".into());
    }
    let template = if template == "%(title).200s [%(id)s].%(ext)s" {
        "%(title).160B [%(id)s].%(ext)s"
    } else {
        template
    };
    let base = template.strip_suffix(".%(ext)s").unwrap_or(template);
    let position = if params.no_playlist && !params.no_merge {
        ""
    } else {
        "%(autonumber)05d-"
    };
    let dir = if cfg!(windows) {
        // ntpath.expandvars decodes %% and $$ once when yt-dlp resolves --paths.
        params.download_dir.replace('%', "%%").replace('$', "$$")
    } else {
        // posixpath.expandvars has no literal escape for '$'. Don't write to
        // a different folder when a path happens to contain a variable name.
        if params.download_dir.contains('$') {
            return Err("err_download_dir_expansion".into());
        }
        params.download_dir.clone()
    };
    if dir.trim() != dir {
        return Err("err_download_dir_expansion".into());
    }
    args.extend([
        "--paths".to_string(),
        format!("home:{dir}"),
        "-o".to_string(),
        format!("{base} [{position}%(format_id).24s {token}].%(ext)s"),
    ]);
    Ok(())
}

#[cfg(test)]
mod output_arg_tests {
    use super::{append_output_args, DownloadParams};

    #[test]
    fn isolates_jobs_and_entries_even_with_the_same_custom_template() {
        let params = DownloadParams {
            download_dir: r"E:\Downloads".into(),
            output_template: Some("Album/Track.%(ext)s".into()),
            no_merge: true,
            ..Default::default()
        };
        let mut first = Vec::new();
        let mut second = Vec::new();
        append_output_args(&mut first, &params, "job-1").unwrap();
        append_output_args(&mut second, &params, "job-2").unwrap();
        assert_eq!(
            first,
            [
                "--paths",
                r"home:E:\Downloads",
                "-o",
                "Album/Track [%(autonumber)05d-%(format_id).24s job-1].%(ext)s"
            ]
        );
        assert_ne!(first, second);
    }

    #[test]
    fn rejects_paths_that_can_escape_the_destination() {
        for template in [
            "-",
            "/absolute/file",
            r"C:\absolute\file",
            "album/../file",
            r"..\file",
        ] {
            let params = DownloadParams {
                output_template: Some(template.into()),
                ..Default::default()
            };
            // '-' becomes a regular filename with a suffix, never stdout.
            assert_eq!(
                append_output_args(&mut vec![], &params, "job").is_ok(),
                template == "-"
            );
        }
    }
}

/// 将前端的 `sub:<lang>` / `auto:<lang>` 选择转换为 yt-dlp 参数。
/// `--sub-langs` 对普通和自动字幕共用，因此语言只需去重后传递一次。
fn append_subtitle_args(args: &mut Vec<String>, selections: &[String]) {
    let mut write_manual = false;
    let mut write_auto = false;
    let mut languages: Vec<&str> = Vec::new();

    for selection in selections {
        let language = match selection.split_once(':') {
            Some(("sub", language)) => {
                write_manual = true;
                language
            }
            Some(("auto", language)) => {
                write_auto = true;
                language
            }
            // 兼容旧版本持久化的无前缀字幕值。
            _ => {
                write_manual = true;
                selection.as_str()
            }
        };
        if !language.is_empty() && !languages.contains(&language) {
            languages.push(language);
        }
    }

    if languages.is_empty() {
        return;
    }
    if write_manual {
        args.push("--write-subs".to_string());
    }
    if write_auto {
        args.push("--write-auto-subs".to_string());
    }
    args.push("--sub-langs".to_string());
    args.push(languages.join(","));
}

#[cfg(test)]
mod subtitle_arg_tests {
    use super::append_subtitle_args;

    #[test]
    fn manual_subtitles_strip_source_prefix() {
        let mut args = Vec::new();
        append_subtitle_args(&mut args, &["sub:en".to_string()]);
        assert_eq!(args, ["--write-subs", "--sub-langs", "en"]);
    }

    #[test]
    fn automatic_subtitles_enable_auto_caption_download() {
        let mut args = Vec::new();
        append_subtitle_args(&mut args, &["auto:zh-Hans".to_string()]);
        assert_eq!(args, ["--write-auto-subs", "--sub-langs", "zh-Hans"]);
    }

    #[test]
    fn mixed_subtitles_enable_both_sources_and_deduplicate_languages() {
        let mut args = Vec::new();
        append_subtitle_args(
            &mut args,
            &[
                "sub:en".to_string(),
                "auto:ja".to_string(),
                "auto:en".to_string(),
            ],
        );
        assert_eq!(
            args,
            ["--write-subs", "--write-auto-subs", "--sub-langs", "en,ja"]
        );
    }
}

#[cfg(test)]
mod format_tests {
    use super::{build_format_args, requires_audio_extraction, requires_ffmpeg, DownloadParams};

    fn params() -> DownloadParams {
        DownloadParams {
            download_mode: "default".into(),
            video_format: Some("137".into()),
            audio_format: Some("140".into()),
            ..Default::default()
        }
    }

    fn selector(value: &DownloadParams) -> Vec<String> {
        build_format_args(value).unwrap()
    }

    #[test]
    fn no_silent_substitution_even_for_playlists() {
        let mut value = params();
        value.audio_format = None;
        value.playlist_items = Some("1,2".into());
        assert_eq!(
            selector(&value),
            [
                "-f",
                "bv*[format_id='137'][acodec!=none]/bv*[format_id='137'][acodec=none]+ba"
            ]
        );
        assert!(requires_ffmpeg(&value));
        value.video_has_audio = true;
        assert!(!requires_ffmpeg(&value));
        value.video_format = Some("137/best".into());
        assert!(build_format_args(&value).is_err());
        value.video_format = Some("best".into());
        assert!(selector(&value)[1].contains("[format_id='best']"));
    }

    #[test]
    fn separate_streams_and_multiple_audio_tracks_are_exact() {
        let mut value = params();
        assert!(requires_ffmpeg(&value));
        value.audio_format = Some("140-en+140-es".into());
        assert_eq!(
            selector(&value),
            [
                "-f",
                "bv*[format_id='137']+ba[format_id='140-en']+ba[format_id='140-es']",
                "--audio-multistreams"
            ]
        );
        value.no_merge = true;
        assert!(!requires_ffmpeg(&value));
        assert_eq!(
            selector(&value),
            [
                "-f",
                "bv*[format_id='137'],ba[format_id='140-en'],ba[format_id='140-es']"
            ]
        );
    }

    #[test]
    fn explicit_video_only_and_audio_extraction_do_not_switch_to_other_formats() {
        let mut value = params();
        value.download_mode = "video".into();
        assert_eq!(selector(&value), ["-f", "bv[format_id='137']"]);
        value.extract_audio = true;
        assert!(requires_ffmpeg(&value));
        assert_eq!(selector(&value), ["-f", "ba[format_id='140']"]);
        value.download_mode = "audio".into();
        value.extract_audio = false;
        value.audio_format = None;
        assert!(requires_audio_extraction(&value));
        assert_eq!(selector(&value), ["-f", "ba/b"]);
    }
}
