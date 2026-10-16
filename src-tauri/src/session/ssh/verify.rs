use super::*;

use serde::Serialize;

use crate::error::ErrorCode;
use crate::file_transfer::Control;

/// How long a public-key check gets for the whole dial and login, when
/// nothing else asks: long enough for a slow network and a server that
/// re-keys, short enough that a dialog cannot sit on a stalled handshake.
pub const KEY_CHECK_TIMEOUT: Duration = Duration::from_secs(20);

/// What one public-key check concluded, in the form the setup dialog
/// reports. Only [`KeyCheckOutcome::Ready`] proves the key alone logs in.
#[cfg_attr(feature = "bindings", derive(specta::Type))]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum KeyCheckOutcome {
    /// The server accepted the connection with the key, and nothing else.
    Ready,
    /// The key was accepted, but the account also needs another factor
    /// (a one-time code, a push). A session can answer that interactively;
    /// a check cannot, so the login is not proven to work from the key
    /// alone.
    AdditionalFactor,
    /// The server refused the key.
    Denied,
    /// The key itself could not be used: unreadable, encrypted with a wrong
    /// passphrase, or no key path in the profile at all. The server never
    /// got to judge it.
    KeyUnusable,
    /// The server accepts this login without any authentication, so the key
    /// could not be exercised. Nothing needs to be configured.
    NotRequired,
    /// The target could not be reached: the dial, the tunnel through the
    /// session's jump hosts, or the handshake failed.
    Unreachable,
    /// The check ran past its deadline.
    Timeout,
    /// The host presented a key that differs from the one on file. Nothing
    /// was checked; the user decides on the host key first.
    HostKeyChanged,
    /// The check was cancelled, by the user or by closing the session.
    Cancelled,
}

/// A check's conclusion with the detail the dialog shows next to it.
#[cfg_attr(feature = "bindings", derive(specta::Type))]
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyCheck {
    pub outcome: KeyCheckOutcome,
    /// A human-readable line about this outcome; never a key or a secret.
    pub message: String,
    /// The host-key decision to put to the user, when the outcome is
    /// `hostKeyChanged`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub change: Option<HostKeyChange>,
}

impl KeyCheck {
    fn new(outcome: KeyCheckOutcome, message: impl Into<String>) -> Self {
        Self {
            outcome,
            message: message.into(),
            change: None,
        }
    }

    /// Classifies an authentication or dial failure by what it means for the
    /// key, rather than surfacing it as an error: a refused key is the
    /// answer to the question that was asked.
    pub(super) fn from_error(error: AppError) -> Self {
        let outcome = match error.code {
            ErrorCode::AdditionalFactorRequired => KeyCheckOutcome::AdditionalFactor,
            ErrorCode::AuthenticationDenied => KeyCheckOutcome::Denied,
            ErrorCode::Cancelled => KeyCheckOutcome::Cancelled,
            ErrorCode::Timeout => KeyCheckOutcome::Timeout,
            // Locally unusable key material, not the server's answer: the
            // key-loading failures `authenticate` reports as bad input.
            ErrorCode::InvalidInput | ErrorCode::PermissionDenied => KeyCheckOutcome::KeyUnusable,
            _ => KeyCheckOutcome::Unreachable,
        };
        Self::new(outcome, error.message)
    }
}

/// Refuses a profile that is not the login the live session runs, before
/// anything is dialled or written. The check tunnels through the session's
/// own hops, so a profile for another machine's account — a stored host
/// edited since this session opened, a jump chain that changed — would be
/// checked against the wrong server.
pub fn require_same_login(live: &SharedTransport, profile: &SessionProfile) -> Result<()> {
    live.carries(profile)
}

/// Checks that `profile`'s public key logs in, on a connection of its own.
///
/// The live transport is the path, never the connection checked: the fresh
/// handshake to the target tunnels through the session's own jump hosts, so
/// no jump host is authenticated or prompted for a second time, and the
/// login is exercised on a connection nothing is reusing — not the session
/// itself and not the automatic pool. The flow is public-key only: no
/// password, no agent, no prompt, no fallback. `timeout` and `control` bound
/// it; `known_hosts` overrides the user's own file (fixture tests only).
pub async fn key_check(
    live: &SharedTransport,
    profile: &SessionProfile,
    request: &Request,
    control: &Control,
    timeout: Duration,
    known_hosts: Option<PathBuf>,
) -> Result<KeyCheck> {
    // The session has to be the machine the profile names, and still up;
    // otherwise this would check a key against the wrong server.
    require_same_login(live, profile)?;
    let address = profile.address();
    let username = profile.username.clone().unwrap_or_default();

    request.info(
        "check",
        format!("checking the public-key login for {username}@{address} on a fresh connection"),
    );
    // The last hop of the session is the path to the target. Tunnelling
    // through the live hops (rather than dialling the jump chain again)
    // keeps the path exactly the one the session already uses.
    let via = live
        .hops
        .as_ref()
        .and_then(|hops| hops.0.last())
        .map(|(handle, label)| Via {
            handle,
            label: label.clone(),
        });
    let prompter = AuthPrompter::background();
    let dial = Dial {
        flow: AuthFlow::PublicKeyOnly,
        known_hosts: known_hosts.as_deref(),
    };
    let attempt = connect_hop(profile, via.as_ref(), &prompter, dial, request);
    tokio::select! {
        biased;
        _ = control.stopped() => Ok(KeyCheck::new(
            KeyCheckOutcome::Cancelled,
            "the public-key check was cancelled",
        )),
        outcome = tokio::time::timeout(timeout, attempt) => match outcome {
            Err(_) => Ok(KeyCheck::new(
                KeyCheckOutcome::Timeout,
                format!(
                    "{address} did not answer the public-key check within {}s",
                    timeout.as_secs()
                ),
            )),
            Ok(Err(error)) => Ok(KeyCheck::from_error(error)),
            Ok(Ok(HopOutcome::HostKeyChanged(change))) => {
                let mut check = KeyCheck::new(
                    KeyCheckOutcome::HostKeyChanged,
                    format!("{address} presented a changed host key; the key was not checked"),
                );
                check.change = Some(change);
                Ok(check)
            }
            Ok(Ok(HopOutcome::Ready { handle, auth, .. })) => {
                // The check is done with the connection it opened; the
                // session keeps running on its own.
                let _ = handle
                    .disconnect(russh::Disconnect::ByApplication, "", "en")
                    .await;
                Ok(match auth {
                    AuthOutcome::Authenticated => {
                        request.info(
                            "check",
                            format!("{address} accepted the public key for {username}"),
                        );
                        KeyCheck::new(
                            KeyCheckOutcome::Ready,
                            format!("{address} accepted the key for {username}"),
                        )
                    }
                    AuthOutcome::NoneRequired => KeyCheck::new(
                        KeyCheckOutcome::NotRequired,
                        format!("{address} accepts this login without authentication; the key was not exercised"),
                    ),
                })
            }
        },
    }
}
