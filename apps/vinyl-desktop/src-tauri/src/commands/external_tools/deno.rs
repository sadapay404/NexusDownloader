//! Deno 的探测、安装和升级。

#[cfg(target_os = "windows")]
use crate::commands::CREATE_NO_WINDOW;
use crate::utils;
use tauri::AppHandle;

use super::install::{install_executables, make_executable, stage_in, staged_path};
use super::release_asset::{new_managed_install, resolve_release_assets};
use super::support::{
    build_tool_status, download_to_file_with_progress, emit_tool_progress, verify_release_version,
};
use super::ToolStatus;

/// 获取 Deno 安装状态和版本
static INSTALLING: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

#[tauri::command]
pub async fn get_deno_status(app: AppHandle) -> Result<ToolStatus, String> {
    let deno_path = utils::get_deno_path(&app)?;
    let managed_path = utils::get_managed_deno_path(&app)?;
    build_tool_status("deno", deno_path, managed_path, "--version").await
}

async fn download_deno_impl(app: AppHandle, operation: &str) -> Result<(), String> {
    let _install = INSTALLING
        .try_lock()
        .map_err(|_| "err_tool_operation_busy")?;
    emit_tool_progress(&app, "deno", operation, "downloading", Some(0.0));
    let deno_path = utils::get_managed_deno_path(&app)?;
    let stage = stage_in(deno_path.parent().ok_or("err_invalid_executable_path")?)?;
    let temp_path = staged_path(&stage, &deno_path)?;
    let zip_path = stage.path().join("download.zip");

    let (tag, assets) = resolve_release_assets(
        "denoland/deno",
        &[utils::deno_release_asset()],
        new_managed_install(operation, &[&deno_path]),
    )
    .await?;
    download_to_file_with_progress(&app, "deno", operation, &assets[0], &zip_path, 0.0, 100.0)
        .await?;

    emit_tool_progress(&app, "deno", operation, "installing", None);

    // 先解压到临时文件，验证成功后才替换现有 Deno。
    let zip_path_clone = zip_path.clone();
    let temp_path_clone = temp_path.clone();
    let deno_bin_name = if cfg!(target_os = "windows") {
        "deno.exe"
    } else {
        "deno"
    };

    // Keep the staging directory alive in the blocking task, even if its caller drops.
    let stage = tokio::task::spawn_blocking(move || {
        use std::io::Read;
        const MAX_EXECUTABLE_SIZE: u64 = 512 * 1024 * 1024;
        let file = std::fs::File::open(zip_path_clone).map_err(|e| format!("err_open_zip:{e}"))?;
        let mut archive = zip::ZipArchive::new(file).map_err(|e| format!("err_read_zip:{e}"))?;
        let entry = archive
            .by_name(deno_bin_name)
            .map_err(|_| format!("err_not_found_in_zip:{deno_bin_name}"))?;
        let expected = entry.size();
        if !entry.is_file() || expected == 0 || expected > MAX_EXECUTABLE_SIZE {
            return Err("err_tool_integrity".into());
        }
        let mut outfile = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(temp_path_clone)
            .map_err(|e| format!("err_create_file:{e}"))?;
        let actual = std::io::copy(&mut entry.take(expected + 1), &mut outfile)
            .map_err(|e| format!("err_extract_deno:{e}"))?;
        if actual != expected {
            return Err("err_tool_integrity".into());
        }
        outfile
            .sync_all()
            .map_err(|e| format!("err_flush_file:{e}"))?;
        Ok::<_, String>(stage)
    })
    .await
    .map_err(|e| format!("err_task:{e}"))??;
    make_executable(&temp_path)?;
    verify_release_version(&temp_path, "--version", "deno", &tag).await?;
    install_executables(stage, &[&deno_path])?;
    emit_tool_progress(&app, "deno", operation, "complete", Some(100.0));

    Ok(())
}

/// 下载 Deno 可执行文件（从 zip 解压）
#[tauri::command]
pub async fn download_deno(app: AppHandle) -> Result<(), String> {
    download_deno_impl(app, "install").await
}

#[tauri::command]
pub async fn update_deno(app: AppHandle) -> Result<String, String> {
    if utils::get_tool_source("deno")? == utils::ToolSource::Managed {
        download_deno_impl(app, "update").await?;
        return Ok("Updated managed Deno".to_string());
    }

    let deno_path = utils::get_deno_path(&app)?;
    if !deno_path.exists() {
        return Err("err_deno_not_installed".to_string());
    }
    emit_tool_progress(&app, "deno", "update", "updating", None);
    let mut cmd = tokio::process::Command::new(&deno_path);
    cmd.arg("upgrade");
    #[cfg(target_os = "windows")]
    cmd.creation_flags(CREATE_NO_WINDOW);
    let output = cmd
        .output()
        .await
        .map_err(|e| format!("err_update_deno:{}", e))?;
    if !output.status.success() {
        return Err(format!(
            "err_update_deno:{}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    emit_tool_progress(&app, "deno", "update", "complete", Some(100.0));
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}
