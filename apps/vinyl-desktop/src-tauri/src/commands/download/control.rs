//! Request cancellation; only the worker that owns the process tree confirms it.

use std::time::Duration;
use tokio::sync::oneshot;

use super::model::DownloadState;

#[tauri::command]
pub async fn cancel_download(
    state: tauri::State<'_, DownloadState>,
    id: String,
) -> Result<(), String> {
    let cancel_tx = state
        .processes
        .lock()
        .map_err(|e| e.to_string())?
        .get(&id)
        .ok_or("err_task_not_found")?
        .cancel_tx
        .clone();
    let (response, confirmation) = oneshot::channel();
    cancel_tx
        .try_send(response)
        .map_err(|_| "err_cancel_not_confirmed")?;
    tokio::time::timeout(Duration::from_secs(15), confirmation)
        .await
        .map_err(|_| "err_cancel_not_confirmed")?
        .map_err(|_| "err_cancel_not_confirmed")?
}
