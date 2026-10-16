use std::borrow::Cow;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use parking_lot::Mutex;
use russh::client::{
    self, AuthResult, GexParams, Handle, KeyboardInteractiveAuthResponse, Msg, Prompt,
};
use russh::keys::agent::client::{AgentClient, AgentStream};
use russh::keys::known_hosts::{
    check_known_hosts_path, known_host_keys_path, learn_known_hosts_path,
};
use russh::keys::{Algorithm, HashAlg, PrivateKeyWithHashAlg, PublicKey};
use russh::{
    cipher, kex, mac, AlgorithmKind, Channel, ChannelMsg, MethodKind, MethodSet, Names, Preferred,
};
use russh_sftp::client::SftpSession;
use russh_sftp::protocol::OpenFlags;
use tauri::AppHandle;
use tokio::io::AsyncWriteExt;
use tokio::sync::mpsc::UnboundedReceiver;

use super::auth::{AuthPrompter, Challenge};
use super::recording::Recorder;
use super::{
    emit_state, join_remote, locale, sort_entries, OutputPump, SessionCommand, SftpRequest,
    SftpResponse,
};
use crate::diagnostics::Request;
use crate::error::{key_code, russh_code, AppError, Result};
use crate::model::{
    AuthKind, AuthPromptField, DirListing, FileEntry, HostKeyChange, LegacyAlgorithms,
    SessionProfile,
};

mod sftp;
pub use sftp::*;
mod authentication;
use authentication::*;
mod algorithms;
use algorithms::*;
mod host_keys;
pub use host_keys::*;
mod transport;
pub use transport::*;
mod shell;
pub use shell::*;
mod verify;
pub use verify::*;
#[cfg(test)]
mod tests;
