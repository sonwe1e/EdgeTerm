use super::*;

#[tauri::command]
#[cfg_attr(feature = "bindings", specta::specta)]
pub fn start_port_forward(
    state: State<'_, AppState>,
    id: String,
    spec: crate::port_forward::Spec,
) -> Result<crate::port_forward::Snapshot> {
    let profile = state
        .file_transfers
        .profile_of(&id)
        .ok_or_else(|| AppError::new("connect to SSH before forwarding"))?;
    if !profile.is_ssh_transport() {
        return Err(AppError::new("port forwarding requires SSH"));
    }
    let transport = state
        .ssh_transports
        .get(&id)
        .ok_or_else(|| AppError::new("SSH connection is unavailable"))?;
    let row = state
        .port_forwards
        .start(&id, profile.address(), transport, spec)?;
    // If the owner closed between validation and registration, cancel its new job.
    if state.file_transfers.profile_of(&id).is_none() {
        state.port_forwards.close_session(&id);
    }
    Ok(row)
}

#[tauri::command]
#[cfg_attr(feature = "bindings", specta::specta)]
pub fn list_port_forwards(state: State<'_, AppState>) -> Vec<crate::port_forward::Snapshot> {
    state.port_forwards.list()
}

#[tauri::command]
#[cfg_attr(feature = "bindings", specta::specta)]
pub async fn stop_port_forward(state: State<'_, AppState>, id: String) -> Result<()> {
    state.port_forwards.stop(&id).await
}

#[tauri::command]
#[cfg_attr(feature = "bindings", specta::specta)]
pub fn remove_port_forward(state: State<'_, AppState>, id: String) -> Result<()> {
    state.port_forwards.remove(&id)
}

#[tauri::command]
#[cfg_attr(feature = "bindings", specta::specta)]
pub async fn discover_listening_ports(
    state: State<'_, AppState>,
    id: String,
    request_id: String,
) -> Result<crate::port_forward::Discovery> {
    let request = state.port_forwards.begin_scan(&id, &request_id)?;
    let profile = state
        .file_transfers
        .profile_of(&id)
        .ok_or_else(|| AppError::new("connect to SSH before discovering ports"))?;
    if !profile.is_ssh_transport() {
        return Err(AppError::new("port discovery requires SSH"));
    }
    let transport = state
        .ssh_transports
        .get(&id)
        .ok_or_else(|| AppError::new("SSH connection is unavailable"))?;
    crate::port_forward::discover(request, transport).await
}

#[tauri::command]
#[cfg_attr(feature = "bindings", specta::specta)]
pub fn cancel_port_discovery(state: State<'_, AppState>, request_id: String) {
    state.port_forwards.cancel_scan(&request_id);
}
