//! What the built-in editor asks a server to do: read and write one text
//! file.
//!
//! Everything here goes through the SSH transport a live session already
//! owns (`session::ssh::SharedTransport`), reusing its connection rather than
//! dialling a second one. The bound is deliberate: a text read stops at
//! 4 MiB.

use std::collections::HashSet;
use std::sync::Arc;
use std::time::Duration;

use russh_sftp::client::RawSftpSession;
use russh_sftp::protocol::{FileAttributes, OpenFlags, Packet, StatusCode};
use serde::{Deserialize, Serialize};

use crate::error::{AppError, ErrorCode, Result};
use crate::model::SessionProfile;
use crate::session::ssh::SharedTransport;

const TEXT_LIMIT: usize = 4 * 1024 * 1024;

#[cfg_attr(feature = "bindings", derive(specta::Type))]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextFile {
    pub path: String,
    pub content: String,
    /// SHA-256 of the exact bytes on the server, used as the write's CAS
    /// token.
    pub hash: String,
    pub size: u64,
    pub encoding: String,
    pub eol: String,
    pub bom: bool,
    pub modified_at: Option<i64>,
    pub permissions: Option<u32>,
}

#[cfg_attr(feature = "bindings", derive(specta::Type))]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextWrite {
    pub path: String,
    pub content: String,
    pub expected_hash: Option<String>,
    /// `lf`, `crlf` or `cr`; a save keeps the file's existing convention.
    #[serde(default = "default_eol")]
    pub eol: String,
    #[serde(default)]
    pub bom: bool,
    /// Replace the server's copy even though its hash is not the expected
    /// one. Only the explicit overwrite action sets this.
    #[serde(default)]
    pub force: bool,
    /// The encoding the file was read with (`UTF-8`, `GBK`, …). Saving with
    /// it preserves a non-UTF-8 source instead of silently converting it.
    #[serde(default)]
    pub encoding: Option<String>,
}

fn default_eol() -> String {
    "lf".into()
}

#[cfg_attr(feature = "bindings", derive(specta::Type))]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteOutcome {
    /// The path the file was actually written to. It can differ from the
    /// request when the parent directory was reached through a symlink.
    pub path: String,
    pub hash: String,
    pub size: u64,
    /// A copy of the previous content, kept because the replace could not be
    /// confirmed. The path exists on the server.
    #[serde(default)]
    pub backup: Option<String>,
    /// The new content still sitting under a temporary name on the server.
    #[serde(default)]
    pub temp: Option<String>,
    /// The replace could not be verified: the bytes may or may not be in
    /// place. Callers must keep their recovery material.
    #[serde(default)]
    pub uncertain: bool,
    #[serde(default)]
    pub note: String,
}

/// Per-file locks for text writes, so two saves of the same path cannot pass
/// the hash check together from separate IPC calls.
#[derive(Default)]
pub struct ProjectOps {
    writing: parking_lot::Mutex<HashSet<String>>,
}

impl ProjectOps {
    fn begin_write(&self, key: String) -> Result<WriteGuard<'_>> {
        let mut writing = self.writing.lock();
        if !writing.insert(key.clone()) {
            return Err(AppError::coded(
                ErrorCode::Conflict,
                "a save for this file is already in progress",
            ));
        }
        Ok(WriteGuard {
            ops: self,
            key,
            finished: false,
        })
    }
}

struct WriteGuard<'a> {
    ops: &'a ProjectOps,
    key: String,
    finished: bool,
}

impl Drop for WriteGuard<'_> {
    fn drop(&mut self) {
        if !self.finished {
            self.ops.writing.lock().remove(&self.key);
        }
    }
}

impl WriteGuard<'_> {
    fn finish(mut self) {
        self.ops.writing.lock().remove(&self.key);
        self.finished = true;
    }
}

fn transport_of(
    state: &crate::commands::AppState,
    id: &str,
) -> Result<(SessionProfile, Arc<SharedTransport>)> {
    let profile = state
        .file_transfers
        .profile_of(id)
        .ok_or_else(|| AppError::new("connect to the server before using this project"))?;
    if !profile.is_ssh_transport() {
        return Err(AppError::invalid_input(
            "project work requires an SSH or SFTP session",
        ));
    }
    let transport = state
        .ssh_transports
        .get(id)
        .ok_or_else(|| AppError::new("SSH connection is unavailable"))?;
    Ok((profile, transport))
}

pub fn require_session(
    state: &crate::commands::AppState,
    id: &str,
) -> Result<(SessionProfile, Arc<SharedTransport>)> {
    transport_of(state, id)
}

fn validate_path(path: &str) -> Result<&str> {
    let path = path.trim();
    if path.is_empty() {
        return Err(AppError::invalid_input("the file path is empty"));
    }
    if path.len() > 4096 {
        return Err(AppError::invalid_input("the file path is too long"));
    }
    if path.chars().any(|c| c == '\0' || c == '\n' || c == '\r') {
        return Err(AppError::invalid_input(
            "the file path contains an unsupported character",
        ));
    }
    Ok(path)
}

pub(crate) fn sha256_hex(bytes: &[u8]) -> String {
    ring::digest::digest(&ring::digest::SHA256, bytes)
        .as_ref()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

pub(crate) fn eol_of(text: &str) -> &'static str {
    let crlf = text.matches("\r\n").count();
    let bare_lf = text.matches('\n').count().saturating_sub(crlf);
    let cr = text.matches('\r').count().saturating_sub(crlf);
    if crlf > bare_lf && crlf >= cr {
        "crlf"
    } else if cr > bare_lf && cr > crlf {
        "cr"
    } else {
        "lf"
    }
}

pub(crate) fn apply_eol(content: &str, eol: &str) -> String {
    // Work in LF first: the editor buffer never keeps CR, and a file saved
    // back as CRLF must not end up with doubled carriage returns.
    let normalized = content.replace("\r\n", "\n").replace('\r', "\n");
    match eol {
        "crlf" => normalized.replace('\n', "\r\n"),
        "cr" => normalized.replace('\n', "\r"),
        _ => normalized,
    }
}

// --- SFTP ---------------------------------------------------------------

/// Why a replacement could not be completed, and what the server holds now.
struct ReplaceRefused {
    /// Every attempt's reason, joined for the caller's error message.
    reasons: String,
    /// The previous content was moved back onto the path, so the recovery copy
    /// named in the save request no longer exists.
    restored: bool,
}

impl ReplaceRefused {
    fn kept(reasons: String) -> Self {
        Self::with(reasons, false)
    }

    fn with(reasons: String, restored: bool) -> Self {
        Self { reasons, restored }
    }
}

/// What the server holds after a refused replacement, in one sentence.
///
/// A restore consumed the backup: when the rewrite after it also failed, the
/// path holds the old bytes, a partial copy of the new ones, or anything in
/// between. The sentence must not promise the previous content is still there.
fn recovery_note(replacing: bool, restored: bool, path: &str, temp: &str, backup: &str) -> String {
    if !replacing {
        return format!("the new content is at {temp}");
    }
    if restored {
        return format!(
            "the previous content was moved back to {path}, but the rewrite after it failed, \
             so {path} may hold partial new content; the new content is at {temp}"
        );
    }
    format!("the new content is at {temp} and the previous content at {backup}")
}

struct Sftp {
    raw: RawSftpSession,
    /// The OpenSSH `posix-rename@openssh.com` extension, when the server
    /// announces it. It is the only SFTP operation that replaces an existing
    /// file atomically: v3 RENAME must refuse an existing target, and servers
    /// differ in how strictly they enforce that.
    posix_rename: bool,
}

impl Sftp {
    async fn open(transport: Arc<SharedTransport>) -> Result<Self> {
        let stream = transport
            .transfer_channel()
            .await
            .map_err(|error| AppError::connection_failed(error.to_string()))?;
        let raw = RawSftpSession::new(stream);
        raw.set_timeout(20);
        let version = raw
            .init()
            .await
            .map_err(|error| AppError::connection_failed(error.to_string()))?;
        let posix_rename = version
            .extensions
            .get("posix-rename@openssh.com")
            .is_some_and(|value| value == "1");
        Ok(Self { raw, posix_rename })
    }

    async fn read(
        &self,
        path: &str,
        limit: usize,
    ) -> Result<(Vec<u8>, u64, Option<i64>, Option<u32>)> {
        let before = self
            .raw
            .stat(path)
            .await
            .map_err(|error| AppError::invalid_input(format!("{path}: {error}")))?
            .attrs;
        if before.is_dir() {
            return Err(AppError::invalid_input("select a file, not a directory"));
        }
        let size = before.size.unwrap_or(0);
        if size > limit as u64 {
            return Err(AppError::invalid_input(format!(
                "the file is {size} bytes, above the {limit}-byte editor limit"
            )));
        }
        let handle = self
            .raw
            .open(path, OpenFlags::READ, FileAttributes::empty())
            .await
            .map_err(|error| AppError::invalid_input(format!("{path}: {error}")))?
            .handle;
        let mut bytes = Vec::with_capacity(size as usize);
        while bytes.len() < size as usize {
            let count = (size as usize - bytes.len()).min(64 * 1024) as u32;
            match self.raw.read(&handle, bytes.len() as u64, count).await {
                Ok(data) if !data.data.is_empty() => bytes.extend_from_slice(&data.data),
                Err(russh_sftp::client::error::Error::Status(status))
                    if status.status_code == StatusCode::Eof =>
                {
                    break
                }
                Ok(_) => break,
                Err(error) => {
                    let _ = self.raw.close(&handle).await;
                    return Err(AppError::new(format!("reading {path}: {error}")));
                }
            }
        }
        let after = self.raw.fstat(&handle).await.map(|attrs| attrs.attrs).ok();
        let _ = self.raw.close(&handle).await;
        if let Some(after) = after {
            let size_changed = after.size != before.size;
            let mtime_changed =
                after.mtime.is_some() && before.mtime.is_some() && after.mtime != before.mtime;
            if size_changed || mtime_changed {
                return Err(AppError::coded(
                    ErrorCode::Conflict,
                    "the file changed while it was being read; reopen it",
                ));
            }
        }
        Ok((
            bytes,
            size,
            before.mtime.map(|time| time as i64 * 1000),
            before.permissions,
        ))
    }

    async fn write(&self, path: &str, bytes: &[u8], permissions: Option<u32>) -> Result<()> {
        let handle = self
            .raw
            .open(
                path,
                OpenFlags::WRITE | OpenFlags::CREATE | OpenFlags::TRUNCATE,
                FileAttributes {
                    permissions: permissions.map(|mode| mode & 0o777),
                    ..Default::default()
                },
            )
            .await
            .map_err(|error| AppError::new(format!("creating {path}: {error}")))?
            .handle;
        let mut offset = 0u64;
        while offset < bytes.len() as u64 {
            let end = (offset as usize + 64 * 1024).min(bytes.len());
            let chunk = bytes[offset as usize..end].to_vec();
            if let Err(error) = self.raw.write(&handle, offset, chunk).await {
                let _ = self.raw.close(&handle).await;
                return Err(AppError::new(format!("writing {path}: {error}")));
            }
            offset = end as u64;
        }
        self.raw
            .close(&handle)
            .await
            .map_err(|error| AppError::new(format!("closing {path}: {error}")))?;
        Ok(())
    }

    /// Puts the complete copy at `temp` in place of `path`.
    ///
    /// A server that enforces v3 RENAME's no-overwrite rule refuses the plain
    /// rename this save used to rely on, which made writing an existing file
    /// fail with "could not be replaced". The ladder below keeps the atomic
    /// path first and opens a gap only when the server offers nothing better.
    /// `backup` already holds the previous content, so a failure leaves both
    /// versions on the server for the caller to report.
    async fn replace(
        &self,
        temp: &str,
        path: &str,
        backup: &str,
        replacing: bool,
        bytes: &[u8],
        permissions: Option<u32>,
    ) -> std::result::Result<(), ReplaceRefused> {
        if !replacing {
            // A new file: RENAME's no-overwrite contract is exactly right, and
            // a target that appeared meanwhile must not be replaced.
            return self
                .raw
                .rename(temp, path)
                .await
                .map(|_| ())
                .map_err(|error| ReplaceRefused::kept(format!("rename: {error}")));
        }
        let mut refused = Vec::new();
        if self.posix_rename {
            match self.extended_rename(temp, path).await {
                Ok(()) => return Ok(()),
                Err(error) => refused.push(format!("posix-rename: {error}")),
            }
        }
        // A server without the extension may still replace through v3 RENAME;
        // OpenSSH on Unix does, and trying costs one round trip.
        match self.raw.rename(temp, path).await {
            Ok(_) => return Ok(()),
            Err(error) => refused.push(format!("rename: {error}")),
        }
        // Move the old file out of the way first. Its bytes are already at
        // `backup`, so the gap this opens is recoverable: the restore below
        // runs before anything else when the second half fails.
        let mut restored = false;
        match self.raw.remove(path).await {
            Ok(_) => match self.raw.rename(temp, path).await {
                Ok(_) => return Ok(()),
                Err(error) => {
                    refused.push(format!("replace: {error}"));
                    match self.raw.rename(backup, path).await {
                        // The old content is back on the path and the copy at
                        // `backup` went with it; the rewrite below starts from
                        // what that restore put there.
                        Ok(_) => restored = true,
                        Err(error) => {
                            refused.push(format!("restore: {error}"));
                            return Err(ReplaceRefused::kept(refused.join("; ")));
                        }
                    }
                }
            },
            Err(error) => refused.push(format!("remove: {error}")),
        }
        // A server may refuse every rename and still write the file itself.
        if let Err(error) = self.write(path, bytes, permissions).await {
            refused.push(format!("write: {error}"));
            return Err(ReplaceRefused::with(refused.join("; "), restored));
        }
        // A rewrite in place is not atomic, so the landed bytes are read back
        // instead of trusting the close; the uploaded copy is then redundant.
        match self.read(path, TEXT_LIMIT).await {
            Ok((landed, ..)) if landed == bytes => {
                let _ = self.raw.remove(temp).await;
                Ok(())
            }
            Ok(_) => {
                refused.push("write: the file reads back with different content".into());
                Err(ReplaceRefused::with(refused.join("; "), restored))
            }
            Err(error) => {
                refused.push(format!("verify: {}", error.message));
                Err(ReplaceRefused::with(refused.join("; "), restored))
            }
        }
    }

    /// The OpenSSH extended request that renames over an existing file.
    async fn extended_rename(
        &self,
        from: &str,
        to: &str,
    ) -> std::result::Result<(), russh_sftp::client::error::Error> {
        let mut data = Vec::new();
        for path in [from, to] {
            data.extend_from_slice(&(path.len() as u32).to_be_bytes());
            data.extend_from_slice(path.as_bytes());
        }
        match self.raw.extended("posix-rename@openssh.com", data).await? {
            Packet::Status(status) if status.status_code == StatusCode::Ok => Ok(()),
            Packet::Status(status) => Err(russh_sftp::client::error::Error::Status(status)),
            _ => Err(russh_sftp::client::error::Error::UnexpectedPacket),
        }
    }
}

impl Drop for Sftp {
    fn drop(&mut self) {
        let _ = self.raw.close_session();
    }
}

async fn sftp_for(transport: Arc<SharedTransport>) -> Result<Sftp> {
    tokio::time::timeout(Duration::from_secs(20), Sftp::open(transport))
        .await
        .map_err(|_| AppError::timeout("opening the SFTP channel timed out"))?
}

// --- commands -----------------------------------------------------------

pub async fn read_text(
    state: &crate::commands::AppState,
    id: &str,
    path: &str,
) -> Result<TextFile> {
    let path = validate_path(path)?;
    let (profile, transport) = transport_of(state, id)?;
    let sftp = sftp_for(transport).await?;
    let (bytes, size, modified_at, permissions) = sftp.read(path, TEXT_LIMIT).await?;
    let bom = bytes.starts_with(&[0xef, 0xbb, 0xbf]);
    let content = &bytes[if bom { 3 } else { 0 }..];
    if content.contains(&0) {
        return Err(AppError::invalid_input(
            "the file looks binary; the built-in editor only opens text",
        ));
    }
    let decoded = match std::str::from_utf8(content) {
        Ok(text) => (text.to_string(), "UTF-8".to_string()),
        Err(_) => {
            let fallback = profile
                .encoding
                .as_deref()
                .and_then(|label| encoding_rs::Encoding::for_label(label.as_bytes()));
            let Some(encoding) = fallback else {
                return Err(AppError::invalid_input(
                    "the file is not valid UTF-8; set the session encoding or edit it externally",
                ));
            };
            let Some(text) = encoding.decode_without_bom_handling_and_without_replacement(content)
            else {
                return Err(AppError::invalid_input(
                    "the file cannot be decoded with the session's encoding",
                ));
            };
            (text.into_owned(), encoding.name().to_string())
        }
    };
    Ok(TextFile {
        path: path.to_string(),
        eol: eol_of(&decoded.0).to_string(),
        content: decoded.0,
        encoding: decoded.1,
        hash: sha256_hex(&bytes),
        size,
        bom,
        modified_at,
        permissions,
    })
}

/// Read a bounded binary preview through the existing authenticated SSH
/// transport. Unlike an external-editor copy, this never creates a watched
/// local file and therefore cannot upload anything back to the server.
pub(crate) async fn read_preview_bytes(
    state: &crate::commands::AppState,
    id: &str,
    path: &str,
    limit: usize,
) -> Result<Vec<u8>> {
    let path = validate_path(path)?;
    let (_, transport) = transport_of(state, id)?;
    tokio::time::timeout(Duration::from_secs(45), async {
        let sftp = sftp_for(transport).await?;
        let (bytes, size, ..) = sftp.read(path, limit).await?;
        if bytes.len() > limit {
            return Err(AppError::invalid_input("the image exceeds the preview size limit"));
        }
        if bytes.len() as u64 != size {
            return Err(AppError::coded(
                ErrorCode::Conflict,
                "the image was truncated while it was being read; retry preview",
            ));
        }
        Ok(bytes)
    })
    .await
    .map_err(|_| AppError::timeout("the image preview read timed out"))?
}

/// A save is serialized per *file*, not per session: two sessions logged in
/// as the same user on the same host write the same file, so the key is the
/// connection identity plus the canonical path. Using the tab id here would
/// let two windows (or two sessions to one host) pass the hash check at the
/// same time and replace each other's content.
fn write_lock_key(profile: &SessionProfile, target: &str) -> String {
    format!(
        "{}@{}:{}::{}",
        profile.username.clone().unwrap_or_default(),
        profile.host.clone().unwrap_or_default(),
        profile.port.unwrap_or(22),
        target
    )
}

/// Textual normalization for lock keys and messages: collapse repeated and
/// trailing slashes and resolve `.`/`..` segments. The server side
/// `realpath` of the parent directory is preferred; this is the fallback when
/// it cannot be asked.
fn normalize_remote_path(path: &str) -> String {
    let absolute = path.starts_with('/');
    let mut parts: Vec<&str> = Vec::new();
    for part in path.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            other => parts.push(other),
        }
    }
    let joined = parts.join("/");
    if absolute {
        format!("/{joined}")
    } else if joined.is_empty() {
        ".".into()
    } else {
        joined
    }
}

/// The path the write actually targets. The parent directory is resolved on
/// the server, so a file reached through a symlinked directory gets the same
/// lock key and the same reported path as one reached directly. The file name
/// itself is not resolved when the file does not exist yet.
async fn canonical_target(sftp: &Sftp, path: &str) -> String {
    let (parent, name) = match path.rsplit_once('/') {
        Some((parent, name)) if !name.is_empty() => {
            (if parent.is_empty() { "/" } else { parent }, name)
        }
        _ => return normalize_remote_path(path),
    };
    match sftp.raw.realpath(parent).await {
        Ok(response) => match response.files.first() {
            Some(file) => {
                let dir = file.filename.trim_end_matches('/');
                if dir.is_empty() {
                    format!("/{name}")
                } else {
                    format!("{dir}/{name}")
                }
            }
            None => normalize_remote_path(path),
        },
        Err(_) => normalize_remote_path(path),
    }
}

pub async fn write_text(
    state: &crate::commands::AppState,
    ops: &ProjectOps,
    id: &str,
    request: TextWrite,
) -> Result<WriteOutcome> {
    let requested = validate_path(&request.path)?.to_string();
    let (profile, transport) = transport_of(state, id)?;
    let sftp = sftp_for(transport).await?;

    // Resolve before locking so two spellings of one file share a key.
    let path = canonical_target(&sftp, &requested).await;
    let guard = ops.begin_write(write_lock_key(&profile, &path))?;

    // Only "no such file" means this is a new file. A permission or transport
    // error must not be read as absence and then overwrite the target.
    let existing = match sftp.raw.stat(&path).await {
        Ok(_) => Some(sftp.read(&path, TEXT_LIMIT).await?.0),
        Err(russh_sftp::client::error::Error::Status(status))
            if status.status_code == StatusCode::NoSuchFile =>
        {
            None
        }
        Err(error) => return Err(AppError::new(format!("{path}: {error}"))),
    };
    let current_hash = existing.as_deref().map(sha256_hex);
    match (&request.expected_hash, &current_hash) {
        _ if request.force => {}
        (Some(expected), Some(actual)) if expected != actual => {
            return Err(AppError::coded(
                ErrorCode::Conflict,
                "the file changed on the server since it was opened; reload or overwrite explicitly",
            ));
        }
        (Some(_), None) => {
            return Err(AppError::coded(
                ErrorCode::Conflict,
                "the file was removed on the server since it was opened",
            ));
        }
        (None, Some(_)) => {
            return Err(AppError::coded(
                ErrorCode::Conflict,
                "a file already exists at this path",
            ));
        }
        _ => {}
    }

    let text = apply_eol(&request.content, &request.eol);
    let encoding = request
        .encoding
        .as_deref()
        .and_then(|label| encoding_rs::Encoding::for_label(label.as_bytes()))
        .unwrap_or(encoding_rs::UTF_8);
    let (encoded, _, had_errors) = encoding.encode(&text);
    if had_errors {
        return Err(AppError::invalid_input(format!(
            "some characters cannot be written as {}; change the file encoding or the text",
            encoding.name()
        )));
    }
    let mut bytes = Vec::new();
    if request.bom && encoding == encoding_rs::UTF_8 {
        bytes.extend_from_slice(&[0xef, 0xbb, 0xbf]);
    }
    bytes.extend_from_slice(&encoded);
    let hash = sha256_hex(&bytes);
    let size = bytes.len() as u64;

    let (parent, name) = match path.rsplit_once('/') {
        Some((parent, name)) if !name.is_empty() => (parent, name),
        _ => return Err(AppError::invalid_input("the file needs a parent directory")),
    };
    // Hidden siblings with a random suffix: two saves of similarly named
    // files in one directory cannot collide, and a leftover file says what it
    // belongs to and which save produced it.
    let nonce = uuid::Uuid::new_v4().simple().to_string();
    let nonce = &nonce[..12];
    let temp = format!("{parent}/.{name}.edgeterm-{nonce}.tmp");
    let backup = format!("{parent}/.{name}.edgeterm-{nonce}.bak");
    let permissions = sftp
        .raw
        .stat(&path)
        .await
        .ok()
        .and_then(|entry| entry.attrs.permissions);

    // A copy of the previous content, written from the bytes already read.
    // It is removed once the replace is confirmed; on any failure it stays
    // beside the file and its path is reported.
    if let Some(previous) = &existing {
        if let Err(error) = sftp.write(&backup, previous, permissions).await {
            return Err(AppError::new(format!(
                "the previous content could not be kept at {backup}: {error}"
            )));
        }
    }
    if let Err(error) = sftp.write(&temp, &bytes, permissions).await {
        let _ = sftp.raw.remove(&temp).await;
        if existing.is_some() {
            let _ = sftp.raw.remove(&backup).await;
        }
        return Err(error);
    }

    // Re-read the target immediately before replacing it. This narrows the
    // gap between the hash check and the rename to one round trip, and it is
    // what makes two EdgeTerm saves of one file safe. It is *not* a
    // conditional rename: a program writing between this read and the rename
    // below still wins, because SFTP has no compare-and-swap and POSIX rename
    // is atomic but unconditional.
    let now = match sftp.raw.stat(&path).await {
        Ok(_) => Some(sftp.read(&path, TEXT_LIMIT).await?.0),
        Err(russh_sftp::client::error::Error::Status(status))
            if status.status_code == StatusCode::NoSuchFile =>
        {
            None
        }
        Err(error) => {
            let _ = sftp.raw.remove(&temp).await;
            return Err(AppError::coded(
                ErrorCode::RemoteWriteUncertain,
                format!(
                    "the target could not be re-read before replacing it ({error}); \
                     the new content is at {temp} and the previous content at {backup}"
                ),
            ));
        }
    };
    if now.as_deref().map(sha256_hex) != current_hash {
        let _ = sftp.raw.remove(&temp).await;
        if existing.is_some() {
            let _ = sftp.raw.remove(&backup).await;
        }
        return Err(AppError::coded(
            ErrorCode::Conflict,
            "the file changed while it was being saved; nothing was replaced, reopen it",
        ));
    }

    if let Err(refused) = sftp
        .replace(
            &temp,
            &path,
            &backup,
            existing.is_some(),
            &bytes,
            permissions,
        )
        .await
    {
        // The new bytes stay at `temp`; where the previous ones are depends on
        // how far the ladder got, so the message names what is really on the
        // server instead of a recovery copy that may have moved back.
        let recovery = recovery_note(existing.is_some(), refused.restored, &path, &temp, &backup);
        return Err(AppError::coded(
            ErrorCode::RemoteWriteUncertain,
            format!(
                "{path} could not be replaced ({}); {recovery}",
                refused.reasons
            ),
        ));
    }

    // The replacement is done. Confirm the size, then retire the backup.
    let verified = match sftp.raw.stat(&path).await {
        Ok(entry) => entry.attrs.size == Some(size),
        Err(_) => false,
    };
    if !verified {
        guard.finish();
        return Ok(WriteOutcome {
            path,
            hash,
            size,
            backup: existing.as_ref().map(|_| backup),
            temp: None,
            uncertain: true,
            note: "the replace went through, but the new size could not be confirmed; reload before editing again"
                .into(),
        });
    }
    if existing.is_some() {
        let _ = sftp.raw.remove(&backup).await;
    }
    guard.finish();
    Ok(WriteOutcome {
        path,
        hash,
        size,
        backup: None,
        temp: None,
        uncertain: false,
        note: String::new(),
    })
}

/// A wire-protocol fixture for the editor save's replacement ladder.
#[cfg(test)]
mod sftp_replace_tests;

#[cfg(test)]
mod tests {
    use super::*;

    fn profile(host: &str, port: u16, username: &str) -> SessionProfile {
        SessionProfile {
            id: uuid::Uuid::new_v4().to_string(),
            name: "lab".into(),
            kind: crate::model::SessionKind::Ssh,
            color: None,
            group_id: None,
            encoding: None,
            locale: None,
            backspace: None,
            record: false,
            record_dir: None,
            shell: None,
            cwd: None,
            host: Some(host.into()),
            port: Some(port),
            username: Some(username.into()),
            auth: None,
            password: None,
            private_key_path: None,
            passphrase: None,
            jump_profile_id: None,
            forwards: Vec::new(),
            port_name: None,
            baud_rate: None,
            data_bits: None,
            stop_bits: None,
            parity: None,
            flow_control: None,
        }
    }

    #[test]
    fn the_write_lock_follows_the_file_not_the_session() {
        // Two sessions on one host, one file: one key, so their saves cannot
        // interleave.
        let first = profile("gpu-01", 22, "lab");
        let mut second = profile("gpu-01", 22, "lab");
        second.id = uuid::Uuid::new_v4().to_string();
        assert_eq!(
            write_lock_key(&first, "/data/vfi/src/train.py"),
            write_lock_key(&second, "/data/vfi/src/train.py")
        );

        // The same path on another endpoint, or another file, is a different
        // file.
        assert_ne!(
            write_lock_key(&first, "/data/vfi/src/train.py"),
            write_lock_key(&profile("gpu-01", 2222, "lab"), "/data/vfi/src/train.py")
        );
        assert_ne!(
            write_lock_key(&first, "/data/vfi/src/train.py"),
            write_lock_key(&first, "/data/vfi/src/model.py")
        );
    }

    #[test]
    fn path_spellings_share_one_lock_key() {
        assert_eq!(normalize_remote_path("/data//vfi/./src/"), "/data/vfi/src");
        assert_eq!(
            normalize_remote_path("/data/vfi/../vfi/src"),
            "/data/vfi/src"
        );
        assert_eq!(normalize_remote_path("/"), "/");
    }

    #[test]
    fn two_saves_of_one_file_cannot_both_hold_the_lock() {
        let ops = ProjectOps::default();
        let key = write_lock_key(&profile("gpu-01", 22, "lab"), "/data/vfi/a.py");
        let first = ops.begin_write(key.clone()).unwrap();
        let conflict = ops
            .begin_write(key.clone())
            .err()
            .expect("second write is refused");
        assert_eq!(conflict.code, ErrorCode::Conflict);
        drop(first);
        assert!(ops.begin_write(key).is_ok(), "the lock is released on drop");
    }

    #[test]
    fn eol_detection_and_normalisation_round_trip() {
        assert_eq!(eol_of("a\nb\n"), "lf");
        assert_eq!(eol_of("a\r\nb\r\n"), "crlf");
        assert_eq!(eol_of("a\rb\r"), "cr");
        assert_eq!(apply_eol("a\r\nb", "lf"), "a\nb");
        assert_eq!(apply_eol("a\nb", "crlf"), "a\r\nb");
        assert_eq!(apply_eol("a\r\nb", "crlf"), "a\r\nb");
    }

    #[test]
    fn invalid_paths_are_refused_before_they_reach_a_shell() {
        assert!(validate_path("").is_err());
        assert!(validate_path("a\nb").is_err());
        assert!(validate_path("a\0b").is_err());
        assert_eq!(validate_path(" /data/a.py ").unwrap(), "/data/a.py");
    }

    #[test]
    fn concurrent_saves_of_one_path_are_refused() {
        let ops = ProjectOps::default();
        let guard = ops.begin_write("session:/a.py".into()).unwrap();
        let second = ops.begin_write("session:/a.py".into());
        assert!(second.is_err());
        guard.finish();
        assert!(ops.begin_write("session:/a.py".into()).is_ok());
    }
}
