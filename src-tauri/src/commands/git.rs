use super::*;
use crate::git::{
    GitAction, GitCommit, GitDiffTarget, GitPatch, GitStatus, GitTarget, GitWorktree,
};

#[tauri::command]
#[cfg_attr(feature = "bindings", specta::specta)]
pub async fn git_status(
    state: State<'_, AppState>,
    target: GitTarget,
) -> Result<Option<GitStatus>> {
    GitWorktree::new(&state, target)?.status().await
}

#[tauri::command]
#[cfg_attr(feature = "bindings", specta::specta)]
pub async fn git_diff(
    state: State<'_, AppState>,
    target: GitTarget,
    diff: GitDiffTarget,
) -> Result<GitPatch> {
    GitWorktree::new(&state, target)?.diff(diff).await
}

#[tauri::command]
#[cfg_attr(feature = "bindings", specta::specta)]
pub async fn git_history(
    state: State<'_, AppState>,
    target: GitTarget,
    head: String,
) -> Result<Vec<GitCommit>> {
    GitWorktree::new(&state, target)?.history(&head).await
}

#[tauri::command]
#[cfg_attr(feature = "bindings", specta::specta)]
pub async fn git_branches(state: State<'_, AppState>, target: GitTarget) -> Result<Vec<String>> {
    GitWorktree::new(&state, target)?.branches().await
}

#[tauri::command]
#[cfg_attr(feature = "bindings", specta::specta)]
pub async fn git_mutate(
    state: State<'_, AppState>,
    target: GitTarget,
    action: GitAction,
) -> Result<()> {
    GitWorktree::new(&state, target)?.mutate(action).await
}
