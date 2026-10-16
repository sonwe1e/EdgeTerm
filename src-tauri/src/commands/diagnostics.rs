use super::*;

/// Opens the diagnostics log directory in the system file manager, creating
/// it first so a fresh install opens an empty folder instead of failing.
#[tauri::command]
#[cfg_attr(feature = "bindings", specta::specta)]
pub fn open_log_directory() -> Result<()> {
    let dir = crate::diagnostics::logs_dir();
    std::fs::create_dir_all(&dir)
        .map_err(|error| AppError::from_io(format!("cannot create {}", dir.display()), &error))?;
    tauri_plugin_opener::open_path(&dir, None::<&str>).map_err(err)
}

/// Writes the diagnostics report (build header plus a bounded tail of the
/// newest log lines) to `path`, which the front end picked in the save
/// dialog. The log itself never carries credentials (see `diagnostics`), so
/// neither does the report.
#[tauri::command]
#[cfg_attr(feature = "bindings", specta::specta)]
pub fn export_diagnostics(path: String) -> Result<()> {
    let report = crate::diagnostics::report();
    std::fs::write(&path, report)
        .map_err(|error| AppError::from_io(format!("cannot write {path}"), &error))
}
