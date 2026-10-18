use super::*;

use crate::workspace::{Experiment, RunRecord, RunUpdate, Workspace, WorkspaceData};

#[tauri::command]
#[cfg_attr(feature = "bindings", specta::specta)]
pub fn list_workspace_data(state: State<'_, AppState>) -> WorkspaceData {
    state.workspaces.snapshot()
}

#[tauri::command]
#[cfg_attr(feature = "bindings", specta::specta)]
pub fn save_workspace(state: State<'_, AppState>, workspace: Workspace) -> Result<Workspace> {
    state.workspaces.save_workspace(workspace)
}

/// Removes a project with its experiments and runs; the returned snapshot
/// lets the front end drop every affected view in one update.
#[tauri::command]
#[cfg_attr(feature = "bindings", specta::specta)]
pub fn delete_workspace(state: State<'_, AppState>, id: String) -> Result<WorkspaceData> {
    let data = state.workspaces.delete_workspace(&id)?;
    // A draft whose project is gone has no tab left to restore it into. The
    // removal is best effort: the project record is already gone, and a
    // leftover draft file is recoverable by hand.
    let _ = state.drafts.remove_workspace(&id);
    Ok(data)
}

#[tauri::command]
#[cfg_attr(feature = "bindings", specta::specta)]
pub fn save_experiment(state: State<'_, AppState>, experiment: Experiment) -> Result<Experiment> {
    state.workspaces.save_experiment(experiment)
}

#[tauri::command]
#[cfg_attr(feature = "bindings", specta::specta)]
pub fn delete_experiment(state: State<'_, AppState>, id: String) -> Result<WorkspaceData> {
    state.workspaces.delete_experiment(&id)
}

#[tauri::command]
#[cfg_attr(feature = "bindings", specta::specta)]
pub fn record_run(state: State<'_, AppState>, run: RunRecord) -> Result<RunRecord> {
    state.workspaces.record_run(run)
}

#[tauri::command]
#[cfg_attr(feature = "bindings", specta::specta)]
pub fn update_run(state: State<'_, AppState>, update: RunUpdate) -> Result<RunRecord> {
    state.workspaces.update_run(update)
}

#[tauri::command]
#[cfg_attr(feature = "bindings", specta::specta)]
pub fn delete_run(state: State<'_, AppState>, id: String) -> Result<WorkspaceData> {
    state.workspaces.delete_run(&id)
}
