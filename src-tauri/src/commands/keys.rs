use super::*;

use crate::authorized_keys::{self, InstallOutcome, InstallReport, INSTALL_TIMEOUT};
use crate::diagnostics::Request;
use crate::ssh_keys::KeySummary;
use russh_sftp::client::SftpSession;

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

/// Installs the public half of a local private key into the server behind a
/// connected SSH session's `authorized_keys`, over the session's own SFTP
/// subsystem. The key is deduplicated by type and data, existing content is
/// preserved, and no unrestricted copy is added when the key is already
/// present behind restrictions. Verification that the login now works is a
/// separate step; see `verify_public_key_login`.
#[tauri::command]
#[cfg_attr(feature = "bindings", specta::specta)]
pub async fn install_public_key(
    state: State<'_, AppState>,
    session_id: String,
    private_key_path: String,
    passphrase: Option<String>,
    comment: Option<String>,
) -> Result<InstallReport> {
    let request = Request::begin("install_public_key").with_session(&session_id);
    let result = install_public_key_inner(
        &state,
        &session_id,
        &private_key_path,
        passphrase,
        comment,
        &request,
    )
    .await;
    request.finish(result)
}

async fn install_public_key_inner(
    state: &AppState,
    session_id: &str,
    private_key_path: &str,
    passphrase: Option<String>,
    comment: Option<String>,
    request: &Request,
) -> Result<InstallReport> {
    // The private key is a local file; reading and parsing it stays off the
    // async runtime.
    let path = private_key_path.to_string();
    let summary = tauri::async_runtime::spawn_blocking(move || {
        crate::ssh_keys::inspect_private_key(&path, passphrase.as_deref())
    })
    .await
    .map_err(err)??;
    let Some((key_type, data)) = summary.public_key.split_once(' ') else {
        return Err(AppError::new("the public key line is malformed"));
    };
    request.info(
        "key",
        format!("using {} {}", summary.key_type, summary.fingerprint),
    );

    let transport = state
        .ssh_transports
        .get(session_id)
        .ok_or_else(|| AppError::new("the session is not connected over SSH any more"))?;
    let sftp = SftpSession::new(transport.transfer_channel().await?)
        .await
        .map_err(|error| {
            AppError::connection_failed(format!("the server refused the sftp subsystem: {error}"))
        })?;
    let home = sftp.canonicalize(".").await.map_err(|error| {
        AppError::connection_failed(format!(
            "cannot find the login's home directory over SFTP: {error}"
        ))
    })?;
    let report = tokio::time::timeout(
        INSTALL_TIMEOUT,
        authorized_keys::install(&sftp, &home, key_type, data, comment.as_deref()),
    )
    .await
    .map_err(|_| {
        AppError::timeout(format!(
            "the server did not finish installing the key within {}s",
            INSTALL_TIMEOUT.as_secs()
        ))
    })??;
    match report.outcome {
        InstallOutcome::Added => {
            request.info("install", format!("added the key to {}", report.path))
        }
        InstallOutcome::Present => {
            request.info("install", format!("the key is already in {}", report.path))
        }
        InstallOutcome::PresentRestricted => request.warn(
            "install",
            format!(
                "{} holds this key only with restrictions; no unrestricted copy was added",
                report.path
            ),
        ),
    }
    Ok(report)
}
