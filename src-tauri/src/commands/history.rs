//! IPC surface of the terminal cold history (A2, D14): the frontend's hot
//! window exports trimmed lines as encoded batches and pages or searches
//! them back through these commands. The store is memory-only and lives with
//! the process; `history_clear` releases a session when its tab closes, and
//! `close_session` wiring for that follows with the terminal.ts integration.
use std::time::Duration;

use tauri::State;

use crate::commands::AppState;
use crate::error::{err, Result};
use crate::session::history::{AppendOutcome, HistoryLine, HistorySearchHit, HistoryStats};

#[tauri::command]
#[cfg_attr(feature = "bindings", specta::specta)]
pub fn history_append(
    state: State<'_, AppState>,
    session_id: String,
    batch: Vec<u8>,
) -> Result<AppendOutcome> {
    state.history.append(&session_id, &batch).map_err(err)
}

#[tauri::command]
#[cfg_attr(feature = "bindings", specta::specta)]
pub fn history_read(
    state: State<'_, AppState>,
    session_id: String,
    from_abs_line: u64,
    max_lines: u32,
) -> Result<Vec<HistoryLine>> {
    state
        .history
        .read(&session_id, from_abs_line, max_lines.max(1) as usize)
        .map_err(err)
}

#[tauri::command]
#[cfg_attr(feature = "bindings", specta::specta)]
pub fn history_search(
    state: State<'_, AppState>,
    session_id: String,
    needle: String,
    limit: u32,
    budget_ms: u32,
) -> Result<Vec<HistorySearchHit>> {
    state
        .history
        .search(
            &session_id,
            &needle,
            limit.max(1) as usize,
            Duration::from_millis(u64::from(budget_ms)),
        )
        .map_err(err)
}

#[tauri::command]
#[cfg_attr(feature = "bindings", specta::specta)]
pub fn history_stats(state: State<'_, AppState>, session_id: String) -> Result<HistoryStats> {
    state.history.stats(&session_id).map_err(err)
}

#[tauri::command]
#[cfg_attr(feature = "bindings", specta::specta)]
pub fn history_clear(state: State<'_, AppState>, session_id: String) -> Result<()> {
    state.history.clear(&session_id);
    Ok(())
}
