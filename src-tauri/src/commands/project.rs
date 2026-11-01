use super::*;

use crate::project::{TextFile, TextWrite, WriteOutcome};

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
