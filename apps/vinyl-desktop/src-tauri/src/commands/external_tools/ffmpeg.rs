//! FFmpeg 与 FFprobe 的探测、安装和升级。

use crate::utils;
use tauri::AppHandle;

use super::install::{install_executables, make_executable, stage_in, staged_path};
use super::release_asset::{new_managed_install, resolve_release_assets};
use super::support::{
    build_tool_status, download_to_file_with_progress, emit_tool_progress, verify_executable,
    verify_release_version,
};
use super::ToolStatus;

static INSTALLING: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

#[tauri::command]
pub async fn get_ffmpeg_status(app: AppHandle) -> Result<ToolStatus, String> {
    let ffmpeg_path = utils::get_ffmpeg_path(&app)?;
    let ffprobe_path = utils::get_ffprobe_path(&app)?;
    let managed_path = utils::get_managed_ffmpeg_path(&app)?;
    let mut status = build_tool_status("ffmpeg", ffmpeg_path, managed_path, "-version").await?;
    // Probe both executables: an existing ffprobe can still fail to run.
    let ffprobe_present = ffprobe_path.exists();
    status.installed = status.installed && ffprobe_present;
    status.runnable = status.runnable
        && ffprobe_present
        && verify_executable(&ffprobe_path, "-version").await.is_ok();
    Ok(status)
}

async fn download_ffmpeg_impl(app: AppHandle, operation: &str) -> Result<(), String> {
    let _install = INSTALLING
        .try_lock()
        .map_err(|_| "err_tool_operation_busy")?;
    let dir = utils::get_managed_ffmpeg_dir(&app)?;
    let [ffmpeg_asset, ffprobe_asset] = utils::ffmpeg_release_assets();
    let ffmpeg_name = if cfg!(target_os = "windows") {
        "ffmpeg.exe"
    } else {
        "ffmpeg"
    };
    let ffprobe_name = if cfg!(target_os = "windows") {
        "ffprobe.exe"
    } else {
        "ffprobe"
    };
    let targets = [dir.join(ffmpeg_name), dir.join(ffprobe_name)];
    let (tag, assets) = resolve_release_assets(
        "eugeneware/ffmpeg-static",
        &[&ffmpeg_asset, &ffprobe_asset],
        new_managed_install(operation, &[&targets[0], &targets[1]]),
    )
    .await?;
    let stage = stage_in(&dir)?;
    for (index, (asset, target)) in assets.iter().zip(targets.iter()).enumerate() {
        let temp = staged_path(&stage, target)?;
        download_to_file_with_progress(
            &app,
            "ffmpeg",
            operation,
            asset,
            &temp,
            index as f64 * 50.0,
            50.0,
        )
        .await?;
        make_executable(&temp)?;
        let expected_tool = if index == 0 { "ffmpeg" } else { "ffprobe" };
        verify_release_version(&temp, "-version", expected_tool, &tag).await?;
    }
    emit_tool_progress(&app, "ffmpeg", operation, "installing", None);
    install_executables(stage, &[&targets[0], &targets[1]])?;
    emit_tool_progress(&app, "ffmpeg", operation, "complete", Some(100.0));
    Ok(())
}

#[tauri::command]
pub async fn download_ffmpeg(app: AppHandle) -> Result<(), String> {
    download_ffmpeg_impl(app, "install").await
}

#[tauri::command]
pub async fn update_ffmpeg(app: AppHandle) -> Result<(), String> {
    if utils::get_tool_source("ffmpeg")? != utils::ToolSource::Managed {
        return Err("err_system_ffmpeg_update_managed_externally".to_string());
    }
    download_ffmpeg_impl(app, "update").await
}
