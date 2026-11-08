use super::*;

use crate::project::{LogWindow, TextFile, TextWrite, WriteOutcome};

#[tauri::command]
#[cfg_attr(feature = "bindings", specta::specta)]
pub async fn project_read_text(
    state: State<'_, AppState>,
    id: Option<String>,
    path: String,
) -> Result<TextFile> {
    if let Some(id) = id {
        crate::project::read_text(&state, &id, &path).await
    } else {
        tokio::task::spawn_blocking(move || crate::local_text::read(&path))
            .await
            .map_err(AppError::new)?
    }
}

/// Read a 256 KiB window from a local or connected SSH text file. The window
/// is identified by byte offsets, so large files are not downloaded whole.
#[tauri::command]
#[cfg_attr(feature = "bindings", specta::specta)]
pub async fn project_read_log_window(
    state: State<'_, AppState>,
    id: Option<String>,
    path: String,
    anchor: Option<u64>,
    before: bool,
    encoding: Option<String>,
) -> Result<LogWindow> {
    if let Some(id) = id {
        crate::project::read_log_window(&state, &id, &path, anchor, before, encoding.as_deref())
            .await
    } else {
        tokio::task::spawn_blocking(move || {
            crate::local_text::read_log_window(&path, anchor, before, encoding.as_deref())
        })
        .await
        .map_err(AppError::new)?
    }
}

/// Saves one text file, refusing when the server's copy no longer matches
/// `expectedHash`. The returned hash becomes the next save's baseline.
#[tauri::command]
#[cfg_attr(feature = "bindings", specta::specta)]
pub async fn project_write_text(
    state: State<'_, AppState>,
    id: Option<String>,
    request: TextWrite,
) -> Result<WriteOutcome> {
    if let Some(id) = id {
        crate::project::write_text(&state, &state.project_ops, &id, request).await
    } else {
        tokio::task::spawn_blocking(move || crate::local_text::write(request))
            .await
            .map_err(AppError::new)?
    }
}
