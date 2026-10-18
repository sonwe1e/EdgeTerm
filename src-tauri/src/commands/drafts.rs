use super::*;

use crate::drafts::{Draft, DraftList};

#[tauri::command]
#[cfg_attr(feature = "bindings", specta::specta)]
pub fn draft_save(state: State<'_, AppState>, draft: Draft) -> Result<Draft> {
    state.drafts.save(draft)
}

#[tauri::command]
#[cfg_attr(feature = "bindings", specta::specta)]
pub fn draft_load(state: State<'_, AppState>, doc_id: String) -> Result<Option<Draft>> {
    state.drafts.get(&doc_id)
}

#[tauri::command]
#[cfg_attr(feature = "bindings", specta::specta)]
pub fn draft_list(state: State<'_, AppState>) -> Result<DraftList> {
    state.drafts.list()
}

#[tauri::command]
#[cfg_attr(feature = "bindings", specta::specta)]
pub fn draft_delete(state: State<'_, AppState>, doc_id: String) -> Result<()> {
    state.drafts.remove(&doc_id)
}
