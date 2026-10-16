use std::fmt::{self, Display};

/// The machine-readable half of [`AppError`]: what went wrong, as a stable
/// identifier the front end can switch on without parsing a translated
/// message. Serialized in camelCase (`"connectionFailed"`).
///
/// `unknown` is the honest answer wherever a failure has no category yet —
/// including every legacy string error, which the TypeScript side normalizes
/// into this code before any UI sees it.
#[cfg_attr(feature = "bindings", derive(specta::Type))]
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ErrorCode {
    /// No more specific code applies; the message is the whole story.
    Unknown,
    /// Dialling, the SSH handshake or a channel on an established connection
    /// failed.
    ConnectionFailed,
    /// An operation ran past its deadline: a dial, a handshake, a subsystem
    /// request or a remote command.
    Timeout,
    /// The server refused the credentials, or accepted them only far enough
    /// to ask for a factor EdgeTerm cannot supply here.
    AuthenticationDenied,
    /// The user cancelled the operation.
    Cancelled,
    /// A file or directory operation was refused for permissions.
    PermissionDenied,
    /// The peer does not speak anything this client can or will speak.
    Unsupported,
    /// The OS credential store is unavailable (see the credential store).
    CredentialStoreUnavailable,
    /// A write reached the server, but whether it landed could not be
    /// confirmed.
    RemoteWriteUncertain,
    /// The input the operation was given is invalid or incomplete.
    InvalidInput,
}

/// A failure that can cross the IPC boundary: the human-readable `message`
/// plus the machine-readable fields the UI and the diagnostics log act on.
///
/// `Display` is the message alone, so anything that formats the error (the
/// diagnostics log, tests, `format!`) shows what a user would read, while the
/// front end receives `{ code, message, operation?, requestId? }`.
#[cfg_attr(feature = "bindings", derive(specta::Type))]
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppError {
    pub code: ErrorCode,
    pub message: String,
    /// The operation that was running when this error was raised, e.g.
    /// `open_session`; attached at the command boundary by `Request::finish`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub operation: Option<String>,
    /// The diagnostics request id correlating this failure's log lines.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
}

impl AppError {
    /// An unclassified error; the message is all there is to say.
    pub fn new(msg: impl Display) -> Self {
        Self::coded(ErrorCode::Unknown, msg)
    }

    /// An error with an explicit code.
    pub fn coded(code: ErrorCode, msg: impl Display) -> Self {
        AppError {
            code,
            message: msg.to_string(),
            operation: None,
            request_id: None,
        }
    }

    pub fn connection_failed(msg: impl Display) -> Self {
        Self::coded(ErrorCode::ConnectionFailed, msg)
    }

    pub fn timeout(msg: impl Display) -> Self {
        Self::coded(ErrorCode::Timeout, msg)
    }

    pub fn authentication_denied(msg: impl Display) -> Self {
        Self::coded(ErrorCode::AuthenticationDenied, msg)
    }

    pub fn cancelled(msg: impl Display) -> Self {
        Self::coded(ErrorCode::Cancelled, msg)
    }

    pub fn invalid_input(msg: impl Display) -> Self {
        Self::coded(ErrorCode::InvalidInput, msg)
    }

    /// Classifies a local I/O failure the way the front end can act on it.
    pub fn from_io(context: impl Display, error: &std::io::Error) -> Self {
        Self::coded(io_code(error.kind()), format!("{context}: {error}"))
    }

    /// Names the operation this error was raised from; an operation an inner
    /// layer already set wins.
    pub fn with_operation(mut self, operation: impl Into<String>) -> Self {
        self.operation.get_or_insert_with(|| operation.into());
        self
    }

    /// The diagnostics request id this failure belongs to.
    pub fn with_request_id(mut self, request_id: impl Into<String>) -> Self {
        self.request_id.get_or_insert_with(|| request_id.into());
        self
    }
}

impl Display for AppError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for AppError {}

pub type Result<T> = std::result::Result<T, AppError>;

/// `map_err(err)` adapter for any foreign error type.
pub fn err<E: Display>(e: E) -> AppError {
    AppError::new(e)
}

/// The code for a local I/O failure, by kind: what the front end would offer
/// the user (retry, fix the path, change permissions) follows from it.
pub fn io_code(kind: std::io::ErrorKind) -> ErrorCode {
    match kind {
        std::io::ErrorKind::PermissionDenied => ErrorCode::PermissionDenied,
        std::io::ErrorKind::TimedOut | std::io::ErrorKind::WouldBlock => ErrorCode::Timeout,
        std::io::ErrorKind::NotFound | std::io::ErrorKind::InvalidInput => ErrorCode::InvalidInput,
        std::io::ErrorKind::ConnectionRefused
        | std::io::ErrorKind::ConnectionReset
        | std::io::ErrorKind::ConnectionAborted
        | std::io::ErrorKind::NotConnected
        | std::io::ErrorKind::AddrNotAvailable
        | std::io::ErrorKind::AddrInUse => ErrorCode::ConnectionFailed,
        _ => ErrorCode::Unknown,
    }
}

/// The code for a `russh` failure: negotiation the server cannot meet is
/// `unsupported`, deadlines are `timeout`, local I/O reads by kind, and
/// everything else — the stream died, the peer disconnected, a request was
/// refused — is a connection failure.
pub fn russh_code(error: &russh::Error) -> ErrorCode {
    match error {
        russh::Error::NoCommonAlgo { .. } => ErrorCode::Unsupported,
        russh::Error::Elapsed(_) => ErrorCode::Timeout,
        russh::Error::CouldNotReadKey => ErrorCode::InvalidInput,
        russh::Error::IO(error) => io_code(error.kind()),
        _ => ErrorCode::ConnectionFailed,
    }
}

/// The code for a key-file failure: an unreadable path or one this client
/// cannot parse is bad input, an unreadable file is a permissions problem,
/// and the rest — an encrypted key without a passphrase, unsupported key
/// material — is input the user can still fix.
pub fn key_code(error: &russh::keys::Error) -> ErrorCode {
    match error {
        russh::keys::Error::IO(error) => io_code(error.kind()),
        russh::keys::Error::CouldNotReadKey
        | russh::keys::Error::UnsupportedKeyType { .. }
        | russh::keys::Error::KeyIsEncrypted
        | russh::keys::Error::KeyIsCorrupt
        | russh::keys::Error::UnknownAlgorithm(_) => ErrorCode::InvalidInput,
        _ => ErrorCode::Unknown,
    }
}

impl From<std::io::Error> for AppError {
    fn from(e: std::io::Error) -> Self {
        AppError::coded(io_code(e.kind()), e)
    }
}

impl From<russh::Error> for AppError {
    fn from(e: russh::Error) -> Self {
        AppError::coded(russh_code(&e), e)
    }
}

impl From<russh::keys::Error> for AppError {
    fn from(e: russh::keys::Error) -> Self {
        AppError::coded(key_code(&e), e)
    }
}

macro_rules! from_display {
    ($($t:ty),* $(,)?) => {
        $(impl From<$t> for AppError {
            fn from(e: $t) -> Self { AppError::new(e) }
        })*
    };
}

from_display!(
    std::num::ParseIntError,
    serde_json::Error,
    russh_sftp::client::error::Error,
    suppaftp::FtpError,
    serialport::Error,
);

impl From<String> for AppError {
    fn from(e: String) -> Self {
        AppError::new(e)
    }
}

impl From<&str> for AppError {
    fn from(e: &str) -> Self {
        AppError::new(e)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serializes_as_an_object_with_camel_case_codes() {
        let error = AppError::connection_failed("cannot reach host:22")
            .with_operation("open_session")
            .with_request_id("6d1b3f8a");
        let json = serde_json::to_value(&error).unwrap();
        assert_eq!(
            json,
            serde_json::json!({
                "code": "connectionFailed",
                "message": "cannot reach host:22",
                "operation": "open_session",
                "requestId": "6d1b3f8a",
            })
        );

        // What a bare error carries: no fields it does not know.
        let json = serde_json::to_value(AppError::new("boom")).unwrap();
        assert_eq!(json["code"], "unknown");
        assert_eq!(json["message"], "boom");
        assert!(json.get("operation").is_none());
        assert!(json.get("requestId").is_none());
    }

    #[test]
    fn display_and_error_message_stay_the_plain_message() {
        let error = AppError::cancelled("authentication for alice was cancelled");
        assert_eq!(
            error.to_string(),
            "authentication for alice was cancelled".to_string()
        );
        assert!(error.to_string().contains("was cancelled"));
    }

    #[test]
    fn an_inner_operation_is_not_overwritten() {
        let error = AppError::new("boom")
            .with_operation("write_remote_key")
            .with_operation("open_session");
        assert_eq!(error.operation.as_deref(), Some("write_remote_key"));
    }

    #[test]
    fn io_errors_classify_by_kind() {
        let error: AppError =
            std::io::Error::new(std::io::ErrorKind::PermissionDenied, "denied").into();
        assert_eq!(error.code, ErrorCode::PermissionDenied);
        let error: AppError =
            std::io::Error::new(std::io::ErrorKind::ConnectionRefused, "refused").into();
        assert_eq!(error.code, ErrorCode::ConnectionFailed);
        let error = AppError::from_io(
            "cannot load C:\\keys\\id_ed25519",
            &std::io::Error::new(std::io::ErrorKind::NotFound, "missing"),
        );
        assert_eq!(error.code, ErrorCode::InvalidInput);
        assert!(error.to_string().starts_with("cannot load"));
    }

    #[tokio::test]
    async fn russh_errors_classify_negotiation_deadline_and_transport() {
        let no_common = russh::Error::NoCommonAlgo {
            kind: russh::AlgorithmKind::Kex,
            ours: vec!["curve25519-sha256".into()],
            theirs: vec!["diffie-hellman-group1-sha1".into()],
        };
        assert_eq!(AppError::from(no_common).code, ErrorCode::Unsupported);

        // `Elapsed` has no public constructor; a real timed-out future makes one.
        let elapsed = tokio::time::timeout(
            std::time::Duration::from_millis(1),
            std::future::pending::<()>(),
        )
        .await
        .unwrap_err();
        assert_eq!(
            AppError::from(russh::Error::Elapsed(elapsed)).code,
            ErrorCode::Timeout
        );

        let io = russh::Error::IO(std::io::Error::new(
            std::io::ErrorKind::ConnectionAborted,
            "reset",
        ));
        assert_eq!(AppError::from(io).code, ErrorCode::ConnectionFailed);
    }
}
