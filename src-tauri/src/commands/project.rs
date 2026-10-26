use super::*;

use crate::project::{
    DiffText, FileList, FileStat, GitState, LogChunk, ProjectProbe, RunLaunch, RunObservation,
    SearchResult, StartRunRequest, TextFile, TextWrite, WriteOutcome,
};

#[tauri::command]
#[cfg_attr(feature = "bindings", specta::specta)]
pub async fn project_probe(
    state: State<'_, AppState>,
    id: String,
    root: String,
) -> Result<ProjectProbe> {
    crate::project::probe(&state, &id, &root).await
}

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

#[tauri::command]
#[cfg_attr(feature = "bindings", specta::specta)]
pub async fn project_file_stat(
    state: State<'_, AppState>,
    id: String,
    path: String,
) -> Result<FileStat> {
    crate::project::stat_file(&state, &id, &path).await
}

#[tauri::command]
#[cfg_attr(feature = "bindings", specta::specta)]
pub async fn project_list_files(
    state: State<'_, AppState>,
    id: String,
    root: String,
) -> Result<FileList> {
    crate::project::list_files(&state, &id, &root).await
}

#[tauri::command]
#[cfg_attr(feature = "bindings", specta::specta)]
pub async fn project_search(
    state: State<'_, AppState>,
    id: String,
    root: String,
    query: String,
) -> Result<SearchResult> {
    crate::project::search(&state, &id, &root, &query).await
}

#[tauri::command]
#[cfg_attr(feature = "bindings", specta::specta)]
pub async fn project_git_state(
    state: State<'_, AppState>,
    id: String,
    root: String,
) -> Result<GitState> {
    crate::project::git_state(&state, &id, &root).await
}

#[tauri::command]
#[cfg_attr(feature = "bindings", specta::specta)]
pub async fn project_git_diff(
    state: State<'_, AppState>,
    id: String,
    root: String,
    path: Option<String>,
) -> Result<DiffText> {
    crate::project::git_diff(&state, &id, &root, path.as_deref()).await
}

#[tauri::command]
#[cfg_attr(feature = "bindings", specta::specta)]
pub async fn project_read_log(
    state: State<'_, AppState>,
    id: String,
    path: String,
    offset: u64,
) -> Result<LogChunk> {
    crate::project::read_log(&state, &id, &path, offset).await
}

#[tauri::command]
#[cfg_attr(feature = "bindings", specta::specta)]
pub async fn project_start_run(
    state: State<'_, AppState>,
    id: String,
    request: StartRunRequest,
) -> Result<RunLaunch> {
    crate::project::start_run(&state, &id, request).await
}

#[tauri::command]
#[cfg_attr(feature = "bindings", specta::specta)]
pub async fn project_run_status(
    state: State<'_, AppState>,
    id: String,
    run: crate::workspace::RunRecord,
) -> Result<RunObservation> {
    crate::project::run_status(&state, &id, &run).await
}

#[tauri::command]
#[cfg_attr(feature = "bindings", specta::specta)]
pub async fn project_stop_run(
    state: State<'_, AppState>,
    id: String,
    run: crate::workspace::RunRecord,
) -> Result<()> {
    crate::project::stop_run(&state, &id, &run).await
}

/// Compares the same file across two project directories, including two
/// servers. The result is the Filer's existing bounded comparison.
#[tauri::command]
#[cfg_attr(feature = "bindings", specta::specta)]
pub async fn project_compare(
    state: State<'_, AppState>,
    left_id: String,
    left_path: String,
    right_id: String,
    right_path: String,
) -> Result<crate::file_diff::Comparison> {
    crate::project::compare(&state, &left_id, &left_path, &right_id, &right_path).await
}
