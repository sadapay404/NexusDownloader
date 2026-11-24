//! 下载任务数据模型、持久化与生命周期状态更新。

use rusqlite::{params, Connection};
use tauri::State;

use super::DatabaseState;

/// 前后端交互的下载任务数据结构
#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct DownloadTaskRecord {
    pub id: String,
    pub url: String,
    pub title: String,
    pub thumbnail: String,
    pub format_label: String,
    pub status: String,
    pub percent: f64,
    pub speed: String,
    pub eta: String,
    pub downloaded: String,
    pub total: String,
    pub file_size_bytes: Option<i64>,
    pub logs: Vec<String>,
    pub error: Option<String>,
    pub output_file: Option<String>,
    pub created_at: i64,
    pub params: serde_json::Value,
}

// 内部数据库读写辅助函数

/// 仅在应用启动时恢复被上次退出中断的任务，读取列表不应修改正在运行的任务。
pub fn recover_interrupted_tasks(conn: &Connection) -> Result<(), rusqlite::Error> {
    conn.execute(
        "UPDATE tasks SET status = 'error', error = 'err_download_interrupted', speed = '', eta = '' \
         WHERE status IN ('preparing', 'downloading', 'postprocessing', 'paused')",
        [],
    )?;
    Ok(())
}

pub fn get_all_tasks(conn: &Connection) -> Result<Vec<DownloadTaskRecord>, rusqlite::Error> {
    let mut stmt = conn.prepare(
        "SELECT id, url, title, thumbnail, format_label, status, percent, speed, eta, \
         downloaded, total, file_size_bytes, logs, error, output_file, created_at, params_json \
         FROM tasks ORDER BY created_at DESC, rowid DESC",
    )?;

    let rows = stmt.query_map([], |row| {
        let id: String = row.get(0)?;
        let url: String = row.get(1)?;
        let title: String = row.get(2)?;
        let thumbnail: String = row.get(3)?;
        let format_label: String = row.get(4)?;
        let status: String = row.get(5)?;
        let percent: f64 = row.get(6)?;
        let speed: String = row.get(7)?;
        let eta: String = row.get(8)?;
        let downloaded: String = row.get(9)?;
        let total: String = row.get(10)?;
        let file_size_bytes: Option<i64> = row.get(11)?;
        let logs_raw: String = row.get(12)?;
        let error: Option<String> = row.get(13)?;
        let output_file: Option<String> = row.get(14)?;
        let created_at: i64 = row.get(15)?;
        let params_raw: String = row.get(16)?;

        let logs: Vec<String> = serde_json::from_str(&logs_raw).unwrap_or_default();
        let params: serde_json::Value = serde_json::from_str(&params_raw)
            .unwrap_or(serde_json::Value::Object(serde_json::Map::new()));

        Ok(DownloadTaskRecord {
            id,
            url,
            title,
            thumbnail,
            format_label,
            status,
            percent,
            speed,
            eta,
            downloaded,
            total,
            file_size_bytes,
            logs,
            error,
            output_file,
            created_at,
            params,
        })
    })?;

    let mut tasks = Vec::new();
    for task_result in rows {
        tasks.push(task_result?);
    }
    Ok(tasks)
}

pub fn upsert_task_internal(
    conn: &Connection,
    task: &DownloadTaskRecord,
) -> Result<(), rusqlite::Error> {
    let logs_json = serde_json::to_string(&task.logs).unwrap_or_else(|_| "[]".to_string());
    let params_json = serde_json::to_string(&task.params).unwrap_or_else(|_| "{}".to_string());

    conn.execute(
        r#"
        INSERT INTO tasks (
            id, url, title, thumbnail, format_label, status, percent, speed, eta,
            downloaded, total, file_size_bytes, logs, error, output_file, created_at, params_json
        ) VALUES (
            ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17
        ) ON CONFLICT(id) DO UPDATE SET
            url = excluded.url,
            title = excluded.title,
            thumbnail = excluded.thumbnail,
            format_label = excluded.format_label,
            status = excluded.status,
            percent = excluded.percent,
            speed = excluded.speed,
            eta = excluded.eta,
            downloaded = excluded.downloaded,
            total = excluded.total,
            file_size_bytes = excluded.file_size_bytes,
            logs = excluded.logs,
            error = excluded.error,
            output_file = excluded.output_file,
            created_at = excluded.created_at,
            params_json = excluded.params_json
        "#,
        params![
            task.id,
            task.url,
            task.title,
            task.thumbnail,
            task.format_label,
            task.status,
            task.percent,
            task.speed,
            task.eta,
            task.downloaded,
            task.total,
            task.file_size_bytes,
            logs_json,
            task.error,
            task.output_file,
            task.created_at,
            params_json,
        ],
    )?;

    Ok(())
}

/// Claim a durable queued row and return the enqueue identity for this attempt.
pub fn mark_task_downloading(state: &DatabaseState, id: &str) -> Result<i64, String> {
    let mut conn = state.conn.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let attempt = tx
        .query_row(
            "UPDATE tasks SET status = 'downloading', error = NULL \
         WHERE id = ?1 AND status = 'queued' RETURNING created_at",
            [id],
            |row| row.get(0),
        )
        .map_err(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => "err_task_not_queued".into(),
            other => other.to_string(),
        })?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(attempt)
}

fn write_terminal(
    state: &DatabaseState,
    sql: &str,
    parameters: impl rusqlite::Params,
) -> Result<(), String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    match conn.execute(sql, parameters).map_err(|e| e.to_string())? {
        1 => Ok(()),
        _ => Err("err_task_not_found".into()),
    }
}

pub fn mark_task_completed(
    state: &DatabaseState,
    id: &str,
    attempt: i64,
    output_file: &str,
    file_size_bytes: i64,
) -> Result<(), String> {
    write_terminal(
        state,
        "UPDATE tasks SET status = 'completed', percent = 100, speed = '', eta = '', \
         output_file = ?3, file_size_bytes = ?4, error = NULL \
         WHERE id = ?1 AND created_at = ?2 AND status = 'downloading'",
        params![id, attempt, output_file, file_size_bytes],
    )
}

pub fn mark_task_error(
    state: &DatabaseState,
    id: &str,
    attempt: i64,
    error_msg: &str,
) -> Result<(), String> {
    write_terminal(
        state,
        "UPDATE tasks SET status = 'error', speed = '', eta = '', error = ?3 \
         WHERE id = ?1 AND created_at = ?2 AND status = 'downloading'",
        params![id, attempt, error_msg],
    )
}

pub fn mark_task_cancelled(state: &DatabaseState, id: &str, attempt: i64) -> Result<(), String> {
    write_terminal(
        state,
        "UPDATE tasks SET status = 'cancelled', speed = '', eta = '' \
         WHERE id = ?1 AND created_at = ?2 AND status = 'downloading'",
        params![id, attempt],
    )
}

// 暴露给前端调用的 Tauri 命令

/// 获取所有持久化任务列表
#[tauri::command]
pub fn db_get_tasks(state: State<'_, DatabaseState>) -> Result<Vec<DownloadTaskRecord>, String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    get_all_tasks(&conn).map_err(|e| e.to_string())
}

/// 创建或更新单个任务
#[tauri::command]
pub fn db_upsert_task(
    state: State<'_, DatabaseState>,
    task: DownloadTaskRecord,
) -> Result<(), String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    upsert_task_internal(&conn, &task).map_err(|e| e.to_string())
}

/// 批量创建或更新任务（常用于老版本任务数据平滑迁移）
pub fn upsert_tasks_batch(
    conn: &mut Connection,
    tasks: &[DownloadTaskRecord],
) -> Result<(), rusqlite::Error> {
    if tasks.is_empty() {
        return Ok(());
    }
    let tx = conn.transaction()?;
    for task in tasks {
        upsert_task_internal(&tx, task)?;
    }
    tx.commit()?;
    Ok(())
}

/// 批量创建或更新任务命令（常用于老版本任务数据平滑迁移）
#[tauri::command]
pub fn db_upsert_tasks_batch(
    state: State<'_, DatabaseState>,
    tasks: Vec<DownloadTaskRecord>,
) -> Result<(), String> {
    let mut conn = state.conn.lock().map_err(|e| e.to_string())?;
    upsert_tasks_batch(&mut conn, &tasks).map_err(|e| e.to_string())
}

/// 删除单个任务
#[tauri::command]
pub fn db_delete_task(state: State<'_, DatabaseState>, id: String) -> Result<(), String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM tasks WHERE id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// 批量删除指定 ID 的任务
#[tauri::command]
pub fn db_delete_tasks(state: State<'_, DatabaseState>, ids: Vec<String>) -> Result<(), String> {
    if ids.is_empty() {
        return Ok(());
    }
    let mut conn = state.conn.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    for id in ids {
        tx.execute("DELETE FROM tasks WHERE id = ?1", params![id])
            .map_err(|e| e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn database_with_tasks() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::schema::run_migrations(&conn).unwrap();
        for status in [
            "preparing",
            "queued",
            "downloading",
            "postprocessing",
            "paused",
            "completed",
            "error",
            "cancelled",
        ] {
            upsert_task_internal(
                &conn,
                &DownloadTaskRecord {
                    id: status.to_string(),
                    status: status.to_string(),
                    speed: "1 MiB/s".to_string(),
                    eta: "00:10".to_string(),
                    error: Some("original error".to_string()),
                    ..Default::default()
                },
            )
            .unwrap();
        }
        conn
    }

    #[test]
    fn only_a_durable_queued_row_can_claim_a_download_slot() {
        let state = DatabaseState {
            conn: std::sync::Mutex::new(database_with_tasks()),
            db_path: ":memory:".into(),
        };
        assert!(mark_task_downloading(&state, "missing").is_err());
        assert!(mark_task_downloading(&state, "cancelled").is_err());
        let attempt = mark_task_downloading(&state, "queued").unwrap();
        assert!(mark_task_downloading(&state, "queued").is_err());
        assert!(mark_task_cancelled(&state, "queued", attempt - 1).is_err());
        mark_task_completed(&state, "queued", attempt, "/test/result.mp4", 32).unwrap();
        assert!(mark_task_error(&state, "queued", attempt, "late event").is_err());
        let conn = state.conn.lock().unwrap();
        let row = get_all_tasks(&conn)
            .unwrap()
            .into_iter()
            .find(|task| task.id == "queued")
            .unwrap();
        assert_eq!(row.status, "completed");
        assert_eq!(row.file_size_bytes, Some(32));
    }

    #[test]
    fn reading_task_list_never_interrupts_active_downloads() {
        let conn = database_with_tasks();
        for _ in 0..2 {
            for task in get_all_tasks(&conn).unwrap() {
                assert_eq!(task.status, task.id);
                assert_eq!(task.speed, "1 MiB/s");
                assert_eq!(task.eta, "00:10");
                assert_eq!(task.error.as_deref(), Some("original error"));
            }
        }
    }

    #[test]
    fn startup_recovery_preserves_waiting_tasks_and_only_interrupts_started_work() {
        let conn = database_with_tasks();
        recover_interrupted_tasks(&conn).unwrap();
        // Running recovery again is harmless, including for existing error details.
        recover_interrupted_tasks(&conn).unwrap();
        for task in get_all_tasks(&conn).unwrap() {
            if matches!(
                task.id.as_str(),
                "completed" | "error" | "cancelled" | "queued"
            ) {
                assert_eq!(task.status, task.id);
                assert_eq!(task.error.as_deref(), Some("original error"));
            } else {
                assert_eq!(task.status, "error");
                assert_eq!(task.error.as_deref(), Some("err_download_interrupted"));
                assert!(task.speed.is_empty());
                assert!(task.eta.is_empty());
            }
        }
    }
}
