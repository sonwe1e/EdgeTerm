use super::*;

/// Filer's one-shot image read. Raw IPC avoids base64 inflation and does not
/// allocate an editable local copy or install any upload watcher.
#[tauri::command]
pub async fn preview_image_file(
    state: State<'_, AppState>,
    id: Option<String>,
    path: String,
) -> Result<tauri::ipc::Response> {
    Ok(tauri::ipc::Response::new(
        crate::image_preview::read(&state, id, path).await?,
    ))
}
