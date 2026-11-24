//! Create a tracked process tree and a private completion manifest per attempt.

use crate::utils;
use std::{path::Path, process::Stdio, sync::Arc};
use tauri::{AppHandle, Manager};
use tokio::sync::mpsc;

use super::{
    arguments::{build_download_args, requires_ffmpeg},
    model::{DownloadParams, DownloadProcessInfo, DownloadState},
    output::{spawn_completion_handler, spawn_output_reader},
    process_tree::ProcessTree,
};

#[tauri::command]
pub async fn start_download(
    app: AppHandle,
    state: tauri::State<'_, DownloadState>,
    params: DownloadParams,
) -> Result<(), String> {
    let ytdlp_path = utils::get_ytdlp_path(&app)?;
    if !ytdlp_path.is_file() {
        return Err("err_ytdlp_not_installed".to_string());
    }
    if requires_ffmpeg(&params) {
        let status = crate::commands::get_ffmpeg_status(app.clone()).await?;
        if !status.installed || !status.runnable {
            return Err("err_ffmpeg_required_for_merge".to_string());
        }
    }
    let output_dir = Path::new(&params.download_dir);
    if !output_dir.is_absolute() || !output_dir.is_dir() {
        return Err("err_invalid_download_dir".into());
    }
    let destination = output_dir
        .canonicalize()
        .map_err(|_| "err_invalid_download_dir")?;
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("err_app_data_dir:{e}"))?;
    std::fs::create_dir_all(&app_data).map_err(|e| format!("err_app_data_dir:{e}"))?;
    // The random manifest basename is also the filename namespace. Do not reuse
    // a manifest or namespace after a crash, retry, or explicit re-download.
    let manifest = tempfile::Builder::new()
        .prefix("nx-")
        .rand_bytes(12)
        .tempfile_in(app_data)
        .map_err(|e| format!("err_create_file:{e}"))?
        .into_temp_path();
    let token = manifest
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or("err_create_output_manifest")?
        .to_string();
    let mut args = build_download_args(&app, &params, &token)?;
    args.extend([
        "--print-to-file".into(),
        "after_move:%(filepath)j".into(),
        manifest_template(&manifest)?,
        "--".into(),
        params.url.clone(),
    ]);
    let mut cmd = tokio::process::Command::new(&ytdlp_path);
    cmd.args(args)
        .env("PYTHONUTF8", "1")
        .env("PYTHONIOENCODING", "utf-8")
        .kill_on_drop(true)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let task_id = params.id;
    let clip_duration = match (params.start_time, params.end_time) {
        (Some(s), Some(e)) => Some(e - s),
        (None, Some(e)) => Some(e),
        _ => None,
    };
    let (cancel_tx, cancel_rx) = mpsc::channel(1);
    let processes = state.processes.clone();
    let (child, tree, stdout, stderr, attempt) = {
        let mut map = processes.lock().map_err(|e| e.to_string())?;
        if map.contains_key(&task_id) {
            return Err("err_download_already_running".into());
        }
        // Commit before spawning so a crash never replays an already-started task.
        use crate::db::tasks::{mark_task_downloading, mark_task_error};
        let db = app.state::<crate::db::DatabaseState>();
        let attempt = mark_task_downloading(&db, &task_id)?;
        let mut spawn = || -> Result<_, String> {
            let (mut child, tree) =
                ProcessTree::spawn(&mut cmd).map_err(|e| format!("err_start_download:{e}"))?;
            let stdout = child.stdout.take().ok_or("err_capture_stdout")?;
            let stderr = child.stderr.take().ok_or("err_capture_stderr")?;
            Ok((child, Arc::new(tree), stdout, stderr))
        };
        let (child, tree, stdout, stderr) = match spawn() {
            Ok(handles) => handles,
            Err(error) => {
                mark_task_error(&db, &task_id, attempt, &error)
                    .map_err(|detail| format!("err_download_history_write:{detail}"))?;
                return Err(error);
            }
        };
        map.insert(
            task_id.clone(),
            DownloadProcessInfo {
                cancel_tx,
                tree: tree.clone(),
                clip_duration,
                errors: Default::default(),
            },
        );
        (child, tree, stdout, stderr, attempt)
    };
    let stdout_reader = spawn_output_reader(
        app.clone(),
        task_id.clone(),
        attempt,
        processes.clone(),
        stdout,
    );
    let stderr_reader = spawn_output_reader(
        app.clone(),
        task_id.clone(),
        attempt,
        processes.clone(),
        stderr,
    );

    spawn_completion_handler(
        app,
        task_id,
        attempt,
        processes,
        child,
        tree,
        cancel_rx,
        manifest,
        destination,
        token,
        [stdout_reader, stderr_reader],
    );
    Ok(())
}

// --print-to-file uses yt-dlp output-template path expansion, not a raw path.
fn manifest_template(path: &Path) -> Result<String, String> {
    let path = path.to_str().ok_or("err_create_output_manifest")?;
    if path.contains('$') {
        return Err("err_create_output_manifest".into());
    }
    Ok(path.replace('%', "%%"))
}
