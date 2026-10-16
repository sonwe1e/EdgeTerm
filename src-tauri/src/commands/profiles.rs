use super::*;

#[tauri::command]
#[cfg_attr(feature = "bindings", specta::specta)]
pub fn list_profiles(state: State<'_, AppState>) -> Vec<SessionProfile> {
    state.store.list()
}

#[tauri::command]
#[cfg_attr(feature = "bindings", specta::specta)]
pub fn save_profile(state: State<'_, AppState>, profile: SessionProfile) -> Result<SessionProfile> {
    state.store.save(profile)
}

/// Saves a copy of a saved session, stored credentials included.
#[tauri::command]
#[cfg_attr(feature = "bindings", specta::specta)]
pub fn duplicate_profile(state: State<'_, AppState>, id: String) -> Result<SessionProfile> {
    state.store.duplicate(&id)
}

/// Deletes a saved session with its credentials and the Sender commands
/// scoped to it.
#[tauri::command]
#[cfg_attr(feature = "bindings", specta::specta)]
pub fn delete_profile(state: State<'_, AppState>, id: String) -> Result<()> {
    state.store.delete(&id)
}

#[tauri::command]
#[cfg_attr(feature = "bindings", specta::specta)]
pub fn list_session_groups(state: State<'_, AppState>) -> Vec<SessionGroup> {
    state.store.list_groups()
}

#[tauri::command]
#[cfg_attr(feature = "bindings", specta::specta)]
pub fn save_session_group(state: State<'_, AppState>, group: SessionGroup) -> Result<SessionGroup> {
    state.store.save_group(group)
}

/// Removes a group with everything in it: nested groups, their sessions
/// (credentials included) and the Sender commands scoped to any of them.
#[tauri::command]
#[cfg_attr(feature = "bindings", specta::specta)]
pub fn delete_session_group(state: State<'_, AppState>, id: String) -> Result<()> {
    state.store.delete_group(&id)
}

#[tauri::command]
#[cfg_attr(feature = "bindings", specta::specta)]
pub fn list_sender_commands(state: State<'_, AppState>) -> Vec<SavedCommand> {
    state.store.list_sender_commands()
}

#[tauri::command]
#[cfg_attr(feature = "bindings", specta::specta)]
pub fn save_sender_command(
    state: State<'_, AppState>,
    command: SavedCommand,
) -> Result<SavedCommand> {
    state.store.save_sender_command(command)
}

#[tauri::command]
#[cfg_attr(feature = "bindings", specta::specta)]
pub fn delete_sender_command(state: State<'_, AppState>, id: String) -> Result<()> {
    state.store.delete_sender_command(&id)
}

#[tauri::command]
#[cfg_attr(feature = "bindings", specta::specta)]
pub fn list_command_history(state: State<'_, AppState>) -> Vec<CommandHistoryEntry> {
    state.store.list_command_history()
}

#[tauri::command]
#[cfg_attr(feature = "bindings", specta::specta)]
pub fn record_command(state: State<'_, AppState>, command: String, host: String) -> Result<()> {
    state.store.record_command(&command, &host)
}

#[tauri::command]
#[cfg_attr(feature = "bindings", specta::specta)]
pub fn delete_command_history(state: State<'_, AppState>, command: String) -> Result<()> {
    state.store.delete_command_history(&command)
}

#[tauri::command]
#[cfg_attr(feature = "bindings", specta::specta)]
pub fn clear_command_history(state: State<'_, AppState>) -> Result<()> {
    state.store.clear_command_history()
}

/// Writes saved sessions, their groups, Sender tags and the frontend's
/// settings to `path` as pretty JSON. Passwords and passphrases are never
/// included, so the file needs no special permissions. The path must carry
/// the `.edgeterm` extension (the UI appends it), so every data file is
/// recognisable by name.
#[tauri::command]
#[cfg_attr(feature = "bindings", specta::specta)]
pub fn export_app_data(
    state: State<'_, AppState>,
    path: String,
    settings: crate::model::AppSettingsValue,
    exported_at: String,
) -> Result<DataSummary> {
    require_data_file_path(&path)?;
    let mut data = state.store.snapshot();
    data.exported_at = Some(exported_at);
    data.settings = Some(settings.0);
    std::fs::write(&path, serde_json::to_string_pretty(&data)?)?;
    Ok(DataSummary {
        profiles: data.profiles.len(),
        groups: data.groups.len(),
        sender_commands: data.sender_commands.len(),
        skipped_sender_commands: 0,
    })
}

/// Parses an EdgeTerm data file so the UI can show what an import would
/// bring in before anything is merged: the name must end in `.edgeterm`, the
/// contents must be JSON with the EdgeTerm marker and a known layout
/// version. Credentials in the file are dropped here so they never reach
/// the webview.
#[tauri::command]
#[cfg_attr(feature = "bindings", specta::specta)]
pub fn read_app_data(path: String) -> Result<AppData> {
    require_data_file_path(&path)?;
    let raw = std::fs::read_to_string(&path)?;
    let mut data: AppData = serde_json::from_str(&raw)
        .map_err(|error| AppError::new(format!("not an EdgeTerm data file: {error}")))?;
    store::validate_app_data(&data)?;
    data.profiles = data
        .profiles
        .into_iter()
        .map(store::redact_profile)
        .collect();
    Ok(data)
}

pub(super) fn require_data_file_path(path: &str) -> Result<()> {
    if store::is_data_file_path(Path::new(path)) {
        Ok(())
    } else {
        Err(AppError::new(format!(
            "not an EdgeTerm data file: expected a .{APP_DATA_EXTENSION} file"
        )))
    }
}

/// Merges a file returned by `read_app_data` into the store; see
/// `Store::import_data` for the rules. The frontend applies `settings` itself.
#[tauri::command]
#[cfg_attr(feature = "bindings", specta::specta)]
pub fn import_app_data(state: State<'_, AppState>, data: AppData) -> Result<DataSummary> {
    state.store.import_data(data)
}

/// The file `ssh` reads by default (`~/.ssh/config`), for the open dialog to
/// start at; it may not exist.
#[tauri::command]
#[cfg_attr(feature = "bindings", specta::specta)]
pub fn default_ssh_config_path() -> String {
    ssh_config::Context::from_environment()
        .default_config_path()
        .to_string_lossy()
        .into_owned()
}

/// Parses an OpenSSH client configuration and says which of its aliases
/// are already saved, so the dialog can offer the rest.
#[tauri::command]
#[cfg_attr(feature = "bindings", specta::specta)]
pub fn read_ssh_config(state: State<'_, AppState>, path: String) -> Result<SshConfigPreview> {
    let context = ssh_config::Context::from_environment();
    ssh_config::preview(&state.store, Path::new(&path), &context)
}

/// Saves the chosen aliases of the file as SSH sessions under `group_id`;
/// see `ssh_config::import` for what comes along and what is updated.
#[tauri::command]
#[cfg_attr(feature = "bindings", specta::specta)]
pub fn import_ssh_config(
    state: State<'_, AppState>,
    path: String,
    aliases: Vec<String>,
    group_id: Option<String>,
) -> Result<SshImportSummary> {
    let context = ssh_config::Context::from_environment();
    let entries = ssh_config::parse_file(Path::new(&path), &context)?;
    ssh_config::import(&state.store, &entries, &aliases, group_id, &context)
}
