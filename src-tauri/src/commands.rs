use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use std::path::Path;
use std::sync::Arc;
use std::time::UNIX_EPOCH;
use tauri::{
    ipc::{Channel, InvokeResponseBody},
    AppHandle, State,
};
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};
use tokio::sync::mpsc;

use crate::error::{err, AppError, Result};
use crate::file_promise::{self, PromisedDragEvent};
use crate::fonts::{self, FontFamily};
use crate::fs_local;
use crate::model::{
    AppData, CommandHistoryEntry, DataSummary, DirListing, LocalCopySummary, OpenSessionOutcome,
    SavedCommand, SerialPortDesc, SessionGroup, SessionInfo, SessionKind, SessionProfile, Theme,
    ZmodemFileInfo, APP_DATA_EXTENSION,
};
use crate::remote_edit::RemoteEdits;
use crate::session::auth::{AuthPrompter, AuthPrompts};
use crate::session::recording::{self, Recorder};
use crate::session::ssh::{ConnectOutcome, SftpConnectOutcome, SshTransports};
use crate::session::{
    self, SessionCommand, SessionHandle, SessionManager, SftpRequest, SftpResponse,
    TransferProgress,
};
use crate::ssh_config::{self, SshConfigPreview, SshImportSummary};
use crate::store::{self, Store};

pub struct AppState {
    pub sessions: SessionManager,
    pub outputs: session::output::OutputStreams,
    pub store: Store,
    pub remote_edits: RemoteEdits,
    /// Authentication challenges a connecting session is waiting on; see
    /// `answer_auth_prompt`.
    pub auth_prompts: AuthPrompts,
    pub file_transfers: crate::file_transfer::Transfers,
    pub file_diffs: crate::file_diff::FileDiffs,
    pub resource_monitor: crate::resource_monitor::ResourceMonitor,
    pub workspaces: crate::workspace::WorkspaceStore,
    /// Unsaved editor content, kept on disk rather than in a webview cache.
    pub drafts: crate::drafts::DraftStore,
    pub project_ops: crate::project::ProjectOps,
    pub key_checks: crate::key_check::KeyChecks,
    pub port_forwards: crate::port_forward::Forwards,
    /// The authenticated SSH transports open sessions run on, so another
    /// session can be opened on one instead of authenticating again; see
    /// `open_session`'s `reuse_session_id`.
    pub ssh_transports: SshTransports,
}

// --- profiles ---------------------------------------------------------------

// --- session groups ---------------------------------------------------------

// --- sender commands -------------------------------------------------------

// --- command history --------------------------------------------------------

// --- data export / import ---------------------------------------------------

// --- OpenSSH config import --------------------------------------------------

// --- sessions ---------------------------------------------------------------

// --- local file streaming for ZMODEM / XMODEM -------------------------------

// --- remote filesystem ------------------------------------------------------

// --- interrupted-transfer recovery -------------------------------------------

// --- local filesystem -------------------------------------------------------

// --- dragging files out of the window ---------------------------------------

// --- serial -----------------------------------------------------------------

// --- helpers ----------------------------------------------------------------

mod profiles;
pub use profiles::*;
mod sessions;
pub use sessions::*;
mod keys;
pub use keys::*;
mod binary_transfer;
pub use binary_transfer::*;
mod transfers;
pub use transfers::*;
mod forwarding;
pub use forwarding::*;
mod inspection;
pub use inspection::*;
mod local_files;
pub use local_files::*;
mod desktop;
pub use desktop::*;
mod diagnostics;
pub use diagnostics::*;
mod remote_edit;
pub use remote_edit::*;
mod file_drag;
pub use file_drag::*;
mod responses;
use responses::*;
mod workspaces;
pub use workspaces::*;
mod drafts;
pub use drafts::*;
mod project;
pub use project::*;
