use super::*;

use crate::ssh_keys::KeySummary;

/// Reads a private key file for the public-key login setup: its type, the
/// public `authorized_keys` line, and the SHA-256 fingerprint. An encrypted
/// file needs its passphrase.
#[tauri::command]
#[cfg_attr(feature = "bindings", specta::specta)]
pub async fn inspect_private_key(path: String, passphrase: Option<String>) -> Result<KeySummary> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::ssh_keys::inspect_private_key(&path, passphrase.as_deref())
    })
    .await
    .map_err(err)?
}

/// Creates a new Ed25519 key at `path` (which must not exist yet), with
/// owner-only permissions and an optional passphrase.
#[tauri::command]
#[cfg_attr(feature = "bindings", specta::specta)]
pub async fn generate_private_key(path: String, passphrase: Option<String>) -> Result<KeySummary> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::ssh_keys::generate_private_key(&path, passphrase.as_deref())
    })
    .await
    .map_err(err)?
}
