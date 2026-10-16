use super::*;

use crate::authorized_keys::{self, InstallOutcome, InstallReport, INSTALL_TIMEOUT};
use crate::diagnostics::Request;
use crate::model::AuthKind;
use crate::session::ssh::{KeyCheck, KeyCheckOutcome, SharedTransport};
use crate::ssh_keys::KeySummary;
use russh_sftp::client::SftpSession;
use serde::Serialize;

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
    let summary = key_summary(private_key_path, passphrase).await?;
    let transport = state
        .ssh_transports
        .get(session_id)
        .ok_or_else(|| AppError::new("the session is not connected over SSH any more"))?;
    install_into_session(&transport, &summary, comment, request).await
}

/// Reads the private key file off the async runtime: its public
/// `authorized_keys` line, key type and fingerprint. An encrypted key needs
/// the passphrase that opens it.
async fn key_summary(path: &str, passphrase: Option<String>) -> Result<KeySummary> {
    let path = path.to_string();
    tauri::async_runtime::spawn_blocking(move || {
        crate::ssh_keys::inspect_private_key(&path, passphrase.as_deref())
    })
    .await
    .map_err(err)?
}

/// Writes the key's public half into the server's `authorized_keys` over the
/// transport's own SFTP subsystem; see `authorized_keys::install` for the
/// merge rules.
async fn install_into_session(
    transport: &SharedTransport,
    summary: &KeySummary,
    comment: Option<String>,
    request: &Request,
) -> Result<InstallReport> {
    let Some((key_type, data)) = summary.public_key.split_once(' ') else {
        return Err(AppError::new("the public key line is malformed"));
    };
    request.info(
        "key",
        format!("using {} {}", summary.key_type, summary.fingerprint),
    );

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

/// Checks that the profile's public key logs in by dialling the target on a
/// fresh connection of its own — never on the session's connection, and never
/// through the automatic pool — with the session's own jump path. The flow is
/// public-key only: no password, no agent, no prompt, no fallback, and a
/// server that wants more is reported rather than asked. The check ends on
/// its own timeout, when `cancel_key_check` marks the request id, or when the
/// session closes.
#[tauri::command]
#[cfg_attr(feature = "bindings", specta::specta)]
pub async fn verify_public_key_login(
    state: State<'_, AppState>,
    session_id: String,
    request_id: String,
    profile: SessionProfile,
) -> Result<KeyCheck> {
    let request = Request::begin("verify_public_key_login").with_session(&session_id);
    let result =
        verify_public_key_login_inner(&state, &session_id, &request_id, profile, &request).await;
    request.finish(result)
}

async fn verify_public_key_login_inner(
    state: &AppState,
    session_id: &str,
    request_id: &str,
    profile: SessionProfile,
    request: &Request,
) -> Result<KeyCheck> {
    // Register before looking the transport up: closing the session can then
    // either stop this check or make it fail cleanly before it dials.
    let checking = state.key_checks.begin(session_id, request_id)?;
    let transport = state
        .ssh_transports
        .get(session_id)
        .ok_or_else(|| AppError::new("the session is not connected over SSH any more"))?;
    state
        .key_checks
        .check(checking, transport, profile, request)
        .await
}

/// Stops the check running under `request_id`, if any. A Cancel that arrives
/// before its request does is remembered, so a fast dialog still stops it.
#[tauri::command]
#[cfg_attr(feature = "bindings", specta::specta)]
pub fn cancel_key_check(state: State<'_, AppState>, request_id: String) {
    state.key_checks.cancel(&request_id);
}

/// What [`configure_public_key_login`] did, step by step. The pieces are kept
/// apart so the caller can say what is true even when the flow stopped
/// part-way: a key that was installed but not verified must not read as
/// "nothing happened".
#[cfg_attr(feature = "bindings", derive(specta::Type))]
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeySetup {
    /// What the install did, including where the entry lives.
    pub install: InstallReport,
    /// What the independent check concluded.
    pub check: KeyCheck,
    /// Whether the saved session was updated. Only a check that proved the
    /// key alone logs in sets this.
    pub saved: bool,
}

/// Sets up public-key login for a saved session in one step: install the
/// key's public half over the live session's SFTP, prove on a fresh
/// connection that the key alone logs in, and only then switch the saved
/// session to it. Stopping before the proof — a refusal, another factor, a
/// timeout, a host-key decision, a cancel — leaves the saved session exactly
/// as it was, while the result still reports the install, so "installed but
/// not verified" is told apart from "nothing happened".
#[tauri::command]
#[cfg_attr(feature = "bindings", specta::specta)]
#[allow(clippy::too_many_arguments)]
pub async fn configure_public_key_login(
    state: State<'_, AppState>,
    session_id: String,
    request_id: String,
    profile_id: String,
    private_key_path: String,
    passphrase: Option<String>,
    comment: Option<String>,
) -> Result<KeySetup> {
    let request = Request::begin("configure_public_key_login").with_session(&session_id);
    let result = configure_public_key_login_inner(
        &state,
        &session_id,
        &request_id,
        &profile_id,
        &private_key_path,
        passphrase,
        comment,
        &request,
    )
    .await;
    request.finish(result)
}

#[allow(clippy::too_many_arguments)]
async fn configure_public_key_login_inner(
    state: &AppState,
    session_id: &str,
    request_id: &str,
    profile_id: &str,
    private_key_path: &str,
    passphrase: Option<String>,
    comment: Option<String>,
    request: &Request,
) -> Result<KeySetup> {
    // Register before anything is read or written: a cancel that lands while
    // the key is being installed still stops the check that follows, and
    // closing the session stops the whole flow.
    let checking = state.key_checks.begin(session_id, request_id)?;

    // The session being set up is the stored one plus the new login — not a
    // copy from the dialog: the action adds an authentication method, it
    // does not roll back edits made elsewhere since the session opened.
    let stored = state
        .store
        .get(profile_id)?
        .ok_or_else(|| AppError::new("the session profile no longer exists"))?;
    let profile = with_key_login(stored, private_key_path, passphrase);

    let transport = state
        .ssh_transports
        .get(session_id)
        .ok_or_else(|| AppError::new("the session is not connected over SSH any more"))?;
    // Refuse a stale profile before writing anything: the stored target may
    // have been edited since this session opened, and the check runs against
    // the session's own path, not against the edited name.
    crate::session::ssh::require_same_login(&transport, &profile)?;

    let summary = key_summary(private_key_path, profile.passphrase.clone()).await?;
    let install = install_into_session(&transport, &summary, comment, request).await?;

    let check = state
        .key_checks
        .check(checking, transport, profile.clone(), request)
        .await?;
    let saved = update_if_verified(&state.store, profile, &check)?;
    if saved {
        request.info("save", format!("{profile_id} now logs in with the key"));
    } else {
        request.warn(
            "save",
            format!("{profile_id} was not changed: the key was not proven to log in"),
        );
    }
    Ok(KeySetup {
        install,
        check,
        saved,
    })
}

/// The login the setup aims at: the stored profile with the key on top. A
/// passphrase typed in the dialog wins; when none was typed, one already
/// stored for this same key is kept — the webview never saw it to retype —
/// while a different key starts without one.
fn with_key_login(
    mut stored: SessionProfile,
    private_key_path: &str,
    passphrase: Option<String>,
) -> SessionProfile {
    let same_key = stored.private_key_path.as_deref() == Some(private_key_path);
    stored.auth = Some(AuthKind::PublicKey);
    stored.private_key_path = Some(private_key_path.to_string());
    if let Some(given) = passphrase.filter(|passphrase| !passphrase.is_empty()) {
        stored.passphrase = Some(given);
    } else if !same_key {
        stored.passphrase = None;
    }
    stored
}

/// The last step, kept on its own so the rule stays visible and testable: the
/// stored session changes only with a proof in hand — a check that found the
/// key alone logs in. Everything else leaves it exactly as it was, even
/// though the key may already be installed.
fn update_if_verified(
    store: &crate::store::Store,
    profile: SessionProfile,
    check: &KeyCheck,
) -> Result<bool> {
    if check.outcome != KeyCheckOutcome::Ready {
        return Ok(false);
    }
    store.save(profile).map_err(|error| {
        AppError::new(format!(
            "the key is installed and verified, but the session could not be saved: {error}"
        ))
    })?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::SessionKind;

    fn check(outcome: KeyCheckOutcome) -> KeyCheck {
        KeyCheck {
            outcome,
            message: format!("{outcome:?}"),
            change: None,
        }
    }

    /// The one rule this flow exists for: the saved session is switched to
    /// the key only when the check proved the key alone logs in. Every other
    /// answer leaves it exactly as it was — even though the key may already
    /// be installed on the server by the time the answer arrived.
    #[test]
    fn the_saved_session_changes_only_after_the_key_is_proven() {
        let dir = std::env::temp_dir().join(format!("edgeterm-keys-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let store = crate::store::Store::load_from_test(dir.join("profiles.json"));

        let mut profile = crate::tests::profile(SessionKind::Ssh);
        profile.host = Some("host.example".into());
        profile.username = Some("ops".into());
        profile.auth = Some(AuthKind::Password);
        profile.password = Some("secret".into());
        let saved = store.save(profile).unwrap();

        let mut candidate = saved.clone();
        candidate.auth = Some(AuthKind::PublicKey);
        candidate.private_key_path = Some("C:\\keys\\id_ed25519".into());
        candidate.passphrase = Some("phrase".into());

        for outcome in [
            KeyCheckOutcome::Denied,
            KeyCheckOutcome::AdditionalFactor,
            KeyCheckOutcome::KeyUnusable,
            KeyCheckOutcome::NotRequired,
            KeyCheckOutcome::Unreachable,
            KeyCheckOutcome::Timeout,
            KeyCheckOutcome::HostKeyChanged,
            KeyCheckOutcome::Cancelled,
        ] {
            assert!(
                !update_if_verified(&store, candidate.clone(), &check(outcome)).unwrap(),
                "{outcome:?} must not change the saved session"
            );
            let stored = store.get(&saved.id).unwrap().unwrap();
            assert_eq!(stored.auth, Some(AuthKind::Password), "{outcome:?}");
            assert_eq!(stored.private_key_path, None, "{outcome:?}");
            assert_eq!(stored.password.as_deref(), Some("secret"), "{outcome:?}");
            assert_eq!(stored.passphrase, None, "{outcome:?}");
        }

        assert!(update_if_verified(&store, candidate, &check(KeyCheckOutcome::Ready)).unwrap());
        let stored = store.get(&saved.id).unwrap().unwrap();
        assert_eq!(stored.auth, Some(AuthKind::PublicKey));
        assert_eq!(
            stored.private_key_path.as_deref(),
            Some("C:\\keys\\id_ed25519")
        );
        assert_eq!(
            stored.passphrase.as_deref(),
            Some("phrase"),
            "the passphrase has to survive for the login to work"
        );
        assert_eq!(
            stored.password, None,
            "the password the key replaces goes with the switch"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    /// What the session is switched *to*: the key login the dialog asked
    /// for, on top of the stored profile. The passphrase rules matter most:
    /// the webview never sees a stored one, so re-running the setup for the
    /// same key must not silently drop it, and a different key must not
    /// inherit it.
    #[test]
    fn the_new_login_carries_the_right_passphrase() {
        let mut stored = crate::tests::profile(SessionKind::Ssh);
        stored.auth = Some(AuthKind::Password);
        stored.password = Some("secret".into());

        let fresh = with_key_login(stored.clone(), "/keys/id_ed25519", None);
        assert_eq!(fresh.auth, Some(AuthKind::PublicKey));
        assert_eq!(fresh.private_key_path.as_deref(), Some("/keys/id_ed25519"));
        assert_eq!(fresh.passphrase, None, "nothing typed, nothing stored");

        let typed = with_key_login(stored, "/keys/id_ed25519", Some("typed".into()));
        assert_eq!(typed.passphrase.as_deref(), Some("typed"));

        let mut same = crate::tests::profile(SessionKind::Ssh);
        same.auth = Some(AuthKind::PublicKey);
        same.private_key_path = Some("/keys/id_ed25519".into());
        same.passphrase = Some("stored".into());
        let kept = with_key_login(same.clone(), "/keys/id_ed25519", None);
        assert_eq!(
            kept.passphrase.as_deref(),
            Some("stored"),
            "a passphrase stored for this same key is kept"
        );

        let other = with_key_login(same, "/keys/other", None);
        assert_eq!(other.passphrase, None, "another key starts without one");
    }
}
