//! yt-dlp/FFmpeg 输出解析与下载事件分发。

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::{path::PathBuf, time::Duration};
use tauri::{AppHandle, Emitter, Manager};

use super::artifacts::verify_outputs;
use super::model::{CancelReply, DownloadProcessInfo};
use super::parser;
use super::process_tree::ProcessTree;

/// 将秒数格式化为 HH:MM:SS
fn format_duration(secs: f64) -> String {
    let total = secs as u64;
    let h = total / 3600;
    let m = (total % 3600) / 60;
    let s = total % 60;
    if h > 0 {
        format!("{:02}:{:02}:{:02}", h, m, s)
    } else {
        format!("{:02}:{:02}", m, s)
    }
}

/// 处理 yt-dlp 的一行输出：解析进度并发送事件到前端
fn process_output_line(
    app: &AppHandle,
    task_id: &str,
    attempt: i64,
    processes: &Arc<Mutex<HashMap<String, DownloadProcessInfo>>>,
    line: &str,
) {
    if line.starts_with("ERROR:") {
        if let Ok(mut map) = processes.lock() {
            if let Some(info) = map.get_mut(task_id) {
                info.errors.record(line);
            }
        }
    }

    // 解析 --progress-template 输出的 JSON 进度
    if let Some(info) = parser::parse_progress_json(line) {
        let _ = app.emit(
            "download-progress",
            serde_json::json!({
                "id": task_id, "attempt": attempt,
                "percent": info.percent,
                "speed": info.speed,
                "eta": info.eta,
                "downloaded": info.downloaded,
                "total": info.total,
                "fragmentIndex": info.fragment_index,
                "fragmentCount": info.fragment_count,
                "status": info.status,
            }),
        );
        return; // 进度行不需要转发到日志
    }

    // 解析 ffmpeg 输出中的 time= 字段（用于时间裁剪场景的进度）
    if line.contains("time=") && line.contains("frame=") {
        if let Some(current_secs) = parser::parse_ffmpeg_time(line) {
            let clip_dur = processes
                .lock()
                .ok()
                .and_then(|map| map.get(task_id).and_then(|info| info.clip_duration));
            if let Some(duration) = clip_dur {
                let percent = (current_secs / duration * 100.0).min(100.0);
                // 解析 ffmpeg 的 speed=Nx 字段（如 "speed=2.13x"）
                let ffmpeg_speed = parser::parse_ffmpeg_speed(line);
                let _ = app.emit(
                    "download-progress",
                    serde_json::json!({
                        "id": task_id, "attempt": attempt,
                        "percent": percent,
                        "speed": ffmpeg_speed,
                        "eta": "",
                        "downloaded": format_duration(current_secs),
                        "total": format_duration(duration),
                        "status": "downloading",
                    }),
                );
            }
        }
        return; // ffmpeg 帧进度不转发到日志
    }

    // 转发日志到前端（不含进度 JSON 行，保持日志清晰）
    let _ = app.emit(
        "download-log",
        serde_json::json!({ "id": task_id, "attempt": attempt, "line": line }),
    );
}

/// 启动异步任务读取子进程输出流
/// 同时处理 \n 和 \r 作为行分隔符（ffmpeg 进度输出使用 \r）
pub(super) fn spawn_output_reader<R: tokio::io::AsyncRead + Unpin + Send + 'static>(
    app: AppHandle,
    task_id: String,
    attempt: i64,
    processes: Arc<Mutex<HashMap<String, DownloadProcessInfo>>>,
    reader: R,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        read_output_lines(reader, |line| {
            process_output_line(&app, &task_id, attempt, &processes, line)
        })
        .await;
    })
}

/// Read whole pipe chunks without scheduling one async read for every byte.
/// Keep the line bound even if a tool writes arbitrarily long output.
async fn read_output_lines<R: tokio::io::AsyncRead + Unpin>(
    mut reader: R,
    mut process: impl FnMut(&str),
) {
    use tokio::io::AsyncReadExt;
    const MAX_LINE_LEN: usize = 64 * 1024;
    let mut line = Vec::with_capacity(1024);
    let mut chunk = [0u8; 8192];
    while let Ok(count) = reader.read(&mut chunk).await {
        if count == 0 {
            break;
        }
        for &byte in &chunk[..count] {
            if byte == b'\n' || byte == b'\r' {
                emit_output_line(&line, &mut process);
                line.clear();
            } else if line.len() < MAX_LINE_LEN {
                line.push(byte);
            }
        }
    }
    emit_output_line(&line, &mut process);
}

fn emit_output_line(line: &[u8], process: &mut impl FnMut(&str)) {
    if !line.is_empty() {
        let text = String::from_utf8_lossy(line);
        let text = text.trim();
        if !text.is_empty() {
            process(text);
        }
    }
}

#[cfg(test)]
mod line_reader_tests {
    use super::read_output_lines;

    fn read_lines(bytes: &[u8]) -> Vec<String> {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let mut lines = Vec::new();
        runtime.block_on(read_output_lines(bytes, |line| {
            lines.push(line.to_string())
        }));
        lines
    }

    #[test]
    fn handles_ffmpeg_carriage_returns_crlf_and_unterminated_errors() {
        assert_eq!(
            read_lines(b"\r\n progress 1\rprogress 2\r\n\n  \nERROR: final error"),
            ["progress 1", "progress 2", "ERROR: final error"]
        );
    }

    #[test]
    fn preserves_unicode_across_chunk_boundaries() {
        let text = format!("{}中文🙂\nnext", "x".repeat(8191));
        assert_eq!(
            read_lines(text.as_bytes()),
            [text.split('\n').next().unwrap(), "next"]
        );
    }

    #[test]
    fn bounds_long_lines_without_losing_the_following_error() {
        let text = format!("{}\nERROR: retained\n", "x".repeat(100_000));
        let lines = read_lines(text.as_bytes());
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[0].len(), 64 * 1024);
        assert_eq!(lines[1], "ERROR: retained");
        assert_eq!(
            read_lines(b"invalid \xff\xfe\nvalid"),
            ["invalid ��", "valid"]
        );
    }
}

/// Control and completion share one owner. A stop request cannot race a
/// terminal write, and a failed stop cannot make a live job look cancelled.
#[allow(clippy::too_many_arguments)]
pub(super) fn spawn_completion_handler(
    app: AppHandle,
    task_id: String,
    attempt: i64,
    processes: Arc<Mutex<HashMap<String, DownloadProcessInfo>>>,
    mut child: tokio::process::Child,
    tree: Arc<ProcessTree>,
    mut cancel_rx: tokio::sync::mpsc::Receiver<CancelReply>,
    manifest: tempfile::TempPath,
    destination: PathBuf,
    token: String,
    output_readers: [tokio::task::JoinHandle<()>; 2],
) {
    tokio::spawn(async move {
        let mut cancellation = None;
        let status = loop {
            tokio::select! {
                biased;
                status = child.wait() => break status,
                Some(reply) = cancel_rx.recv() => match tree.terminate() {
                    Ok(()) => { cancellation = Some(reply); break child.wait().await; }
                    Err(error) => { let _ = reply.send(Err(format!("err_kill_process:{error}"))); }
                },
            }
        };
        cancel_rx.close();
        tree.settle().await;
        drain_output_readers(output_readers, Duration::from_secs(5)).await;
        let retire = || {
            if let Ok(mut map) = processes.lock() {
                map.remove(&task_id);
            }
        };
        let db = app.state::<crate::db::DatabaseState>();
        use crate::db::tasks::{mark_task_cancelled, mark_task_completed, mark_task_error};

        if let Some(reply) = cancellation {
            let saved = mark_task_cancelled(&db, &task_id, attempt);
            retire();
            match saved {
                Ok(()) => {
                    let _ = app.emit(
                        "download-cancelled",
                        serde_json::json!({ "id": task_id, "attempt": attempt }),
                    );
                    let _ = reply.send(Ok(()));
                }
                Err(error) => {
                    let detail = format!("err_download_history_write:{error}");
                    emit_error(&app, &task_id, attempt, &detail);
                    let _ = reply.send(Err(detail));
                }
            }
            return;
        }

        let errors = processes
            .lock()
            .ok()
            .and_then(|map| map.get(&task_id).and_then(|info| info.errors.summary()));
        let result = match (errors, status) {
            (Some(error), _) => Err(error),
            (None, Ok(status)) if status.success() => {
                verify_outputs(&manifest, &destination, &token)
            }
            (None, Ok(status)) => Err(format!("err_exit_code:{}", status.code().unwrap_or(-1))),
            (None, Err(error)) => Err(error.to_string()),
        }
        .and_then(|(path, bytes)| {
            mark_task_completed(&db, &task_id, attempt, &path, bytes)
                .map_err(|error| format!("err_download_history_write:{error}"))?;
            Ok((path, bytes))
        });
        match result {
            Ok((output_file, size)) => {
                retire();
                let _ = app.emit(
                    "download-complete",
                    serde_json::json!({
                        "id": task_id, "attempt": attempt, "outputFile": output_file, "fileSizeBytes": size
                    }),
                );
            }
            Err(error) => {
                let error = match mark_task_error(&db, &task_id, attempt, &error) {
                    Ok(()) => error,
                    Err(detail) => format!("err_download_history_write:{detail}\n{error}"),
                };
                retire();
                emit_error(&app, &task_id, attempt, &error);
            }
        }
    });
}

fn emit_error(app: &AppHandle, id: &str, attempt: i64, error: &str) {
    let _ = app.emit(
        "download-error",
        serde_json::json!({ "id": id, "attempt": attempt, "error": error }),
    );
}

/// A descendant can inherit a pipe after yt-dlp exits. Bound the shared drain
/// period so those inherited handles cannot hold a finished task's slot forever.
async fn drain_output_readers(
    mut readers: [tokio::task::JoinHandle<()>; 2],
    limit: std::time::Duration,
) {
    let mut drained = [false; 2];
    let _ = tokio::time::timeout(limit, async {
        for (index, reader) in readers.iter_mut().enumerate() {
            let _ = reader.await;
            drained[index] = true;
        }
    })
    .await;
    for (index, reader) in readers.iter().enumerate() {
        if !drained[index] {
            reader.abort();
        }
    }
    for (index, reader) in readers.into_iter().enumerate() {
        if !drained[index] {
            let _ = reader.await;
        }
    }
}

#[cfg(test)]
mod drain_tests {
    use super::{drain_output_readers, read_output_lines};
    use std::sync::{Arc, Mutex};
    use std::time::Duration;

    use tokio::io::AsyncWriteExt;

    #[test]
    fn inherited_pipe_does_not_block_completion_or_leave_a_reader_running() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        runtime.block_on(async {
            let (reader, mut inherited_writer) = tokio::io::duplex(256);
            inherited_writer
                .write_all(b"ERROR: buffered error\n")
                .await
                .unwrap();
            let lines = Arc::new(Mutex::new(Vec::new()));
            let recorded = Arc::clone(&lines);
            let stuck = tokio::spawn(async move {
                read_output_lines(reader, |line| {
                    recorded.lock().unwrap().push(line.to_string())
                })
                .await;
            });
            let abort_stuck = stuck.abort_handle();
            let finished = tokio::spawn(async {});
            tokio::time::timeout(
                Duration::from_secs(2),
                drain_output_readers([stuck, finished], Duration::from_millis(30)),
            )
            .await
            .unwrap();
            assert!(abort_stuck.is_finished());
            assert_eq!(*lines.lock().unwrap(), ["ERROR: buffered error"]);
            // The inherited writer is deliberately kept alive past completion.
            assert!(inherited_writer.write_all(b"late output\n").await.is_err());
        });
    }

    #[test]
    fn normal_readers_are_fully_drained_before_returning() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        runtime.block_on(async {
            let lines = Arc::new(Mutex::new(Vec::new()));
            let readers = ["stdout tail", "ERROR: stderr tail"].map(|text| {
                let recorded = Arc::clone(&lines);
                tokio::spawn(async move {
                    tokio::task::yield_now().await;
                    read_output_lines(text.as_bytes(), |line| {
                        recorded.lock().unwrap().push(line.to_string())
                    })
                    .await;
                })
            });
            drain_output_readers(readers, Duration::from_secs(2)).await;
            let mut result = lines.lock().unwrap().clone();
            result.sort();
            assert_eq!(result, ["ERROR: stderr tail", "stdout tail"]);
        });
    }
}
