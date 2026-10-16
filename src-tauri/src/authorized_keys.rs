//! Installing a public key into a server's `authorized_keys` over SFTP: the
//! pure merge that decides what the file should look like, and the transaction
//! that applies it to the server of a connected session.
//!
//! The merge is deliberately conservative. A key that is already there is
//! never written twice, whatever comment it carries; a key that is present
//! behind restrictions (`from=`, `command=`) is left alone, because appending
//! an unrestricted copy would quietly lift the restrictions the login was
//! given. Everything else in the file — other keys, comments, options — is
//! preserved byte for byte around the appended line.
//!
//! The write itself goes through a temporary file in the same directory: the
//! new content is complete and owner-only before anything replaces the
//! original, the file is read again to catch a concurrent edit, and what
//! landed is read back before the install is reported as done.

use std::time::Duration;

use russh_sftp::client::SftpSession;
use russh_sftp::protocol::{FileAttributes, OpenFlags, StatusCode};
use serde::Serialize;
use tokio::io::AsyncWriteExt;

use crate::error::{AppError, ErrorCode, Result};

/// How long the whole install gets. The SFTP operations are small, so this
/// only bounds a server that stops answering mid-transaction.
pub const INSTALL_TIMEOUT: Duration = Duration::from_secs(30);

/// Largest `authorized_keys` that will be read and rewritten from memory.
/// Real files are kilobytes; anything bigger is not this file, and it is not
/// a login to risk by rewriting.
const MAX_AUTHORIZED_KEYS: usize = 512 * 1024;

/// What merging the key into the file did.
#[cfg_attr(feature = "bindings", derive(specta::Type))]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum InstallOutcome {
    /// The line was appended to the file.
    Added,
    /// The key is already present on a plain line; nothing was written.
    Present,
    /// The key is present, but only behind restrictions such as `from=` or
    /// `command=`. No unrestricted copy was added next to it.
    PresentRestricted,
}

/// The result of an install, in the form the setup dialog reports.
#[cfg_attr(feature = "bindings", derive(specta::Type))]
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallReport {
    /// Where the entry lives, e.g. `/home/u/.ssh/authorized_keys`.
    pub path: String,
    pub outcome: InstallOutcome,
    /// The restrictions the existing entry carries; only with
    /// [`InstallOutcome::PresentRestricted`].
    #[serde(skip_serializing_if = "Option::is_none")]
    pub options: Option<String>,
}

/// What [`merge`] decided.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Merge {
    /// One plain line already holds the key.
    Present,
    /// The only lines holding the key carry these options.
    PresentRestricted(String),
    /// The file with the new line appended.
    Appended(String),
}

/// The `authorized_keys` line for a key, with an optional trailing comment.
pub(crate) fn line_for(key_type: &str, data: &str, comment: Option<&str>) -> String {
    let mut line = format!("{key_type} {data}");
    if let Some(comment) = comment.map(str::trim).filter(|comment| !comment.is_empty()) {
        line.push(' ');
        line.push_str(comment);
    }
    line
}

/// Decides what an `authorized_keys` file should look like with `line`
/// added; see the module comment for the rules.
pub(crate) fn merge(content: &str, line: &str) -> Merge {
    let wanted = key_of(line);
    let mut restricted: Option<String> = None;
    for existing in content.lines() {
        let existing = existing.trim();
        if existing.is_empty() || existing.starts_with('#') {
            continue;
        }
        let (options, key_type, data) = match key_of(existing) {
            Some(entry) => entry,
            None => continue,
        };
        // Deduplication is by the key itself — its type and base64 data —
        // never by the comment or the options around it.
        if Some((key_type, data)) != wanted.as_ref().map(|(_, t, d)| (*t, *d)) {
            continue;
        }
        if options.is_empty() {
            return Merge::Present;
        }
        restricted.get_or_insert_with(|| options.to_string());
    }
    match restricted {
        Some(options) => Merge::PresentRestricted(options),
        None => Merge::Appended(appended(content, line)),
    }
}

/// `content` with `line` on a line of its own, using the file's existing line
/// ending and repairing a missing final newline first.
fn appended(content: &str, line: &str) -> String {
    let ending = if content.contains("\r\n") {
        "\r\n"
    } else {
        "\n"
    };
    let mut out = String::with_capacity(content.len() + line.len() + 2 * ending.len());
    out.push_str(content);
    if !content.is_empty() && !content.ends_with('\n') {
        out.push_str(ending);
    }
    out.push_str(line);
    out.push_str(ending);
    out
}

/// The options, key type and base64 data of one `authorized_keys` line.
/// `None` for a comment, a blank line, or a line that carries no key.
fn key_of(line: &str) -> Option<(&str, &str, &str)> {
    let fields = fields_of(line);
    if fields.len() < 2 {
        return None;
    }
    let (index, key_type) = fields
        .iter()
        .enumerate()
        .find(|(_, field)| is_key_type(field))?;
    let data = *fields.get(index + 1)?;
    // The key type is the line's first field, or the second behind the
    // options; anything else is not a line this understands.
    let options = match index {
        0 => "",
        1 => fields[0],
        _ => return None,
    };
    Some((options, key_type, data))
}

/// Whether a field names a key algorithm. The list is open ended on purpose:
/// the merge only ever compares it with the key being installed.
fn is_key_type(field: &str) -> bool {
    field.starts_with("ssh-") || field.starts_with("ecdsa-") || field.starts_with("sk-")
}

/// Splits an `authorized_keys` line the way its parser does: whitespace
/// separates fields, except inside the double quotes of an option value, so
/// `command="echo hello world"` is one field and not three.
fn fields_of(line: &str) -> Vec<&str> {
    let bytes = line.as_bytes();
    let mut fields = Vec::new();
    let mut start = None;
    let mut quoted = false;
    let mut index = 0;
    while index < bytes.len() {
        let byte = bytes[index];
        if byte == b'\\' && quoted && index + 1 < bytes.len() {
            // An escaped byte inside quotes belongs to the field either way.
            index += 2;
            continue;
        }
        if byte == b'"' {
            quoted = !quoted;
        } else if (byte == b' ' || byte == b'\t') && !quoted {
            if let Some(begin) = start.take() {
                fields.push(&line[begin..index]);
            }
            index += 1;
            continue;
        }
        // Only start a field at a character boundary, never inside one.
        if byte & 0xc0 != 0x80 && start.is_none() {
            start = Some(index);
        }
        index += 1;
    }
    if let Some(begin) = start {
        fields.push(&line[begin..]);
    }
    fields
}

/// Applies the merge to the server behind `sftp`: ensures `~/.ssh`, reads the
/// current file, appends the key when it is missing, and verifies what
/// landed. `home` is the login user's home directory, as the SFTP session
/// resolved it.
pub async fn install(
    sftp: &SftpSession,
    home: &str,
    key_type: &str,
    data: &str,
    comment: Option<&str>,
) -> Result<InstallReport> {
    if key_type.is_empty() || data.is_empty() {
        return Err(AppError::invalid_input(
            "the public key is missing its type or data",
        ));
    }
    if comment.is_some_and(|comment| comment.contains('\n') || comment.contains('\r')) {
        return Err(AppError::invalid_input(
            "a key comment cannot contain a line break",
        ));
    }
    let home = home.trim_end_matches('/');
    let dir = format!("{home}/.ssh");
    let path = format!("{dir}/authorized_keys");

    let home_meta = sftp
        .metadata(home)
        .await
        .map_err(|error| sftp_error(format!("cannot read {home} over SFTP"), &error))?;
    ensure_dir(sftp, &dir, &home_meta).await?;

    // A symlinked `authorized_keys` is someone pointing the login's trust
    // file elsewhere; replacing it through the link is not this tool's call.
    let existing = match sftp.symlink_metadata(&path).await {
        Ok(meta) => {
            if meta.is_symlink() {
                return Err(AppError::new(format!(
                    "{path} is a symlink; refusing to install through it"
                )));
            }
            if meta.is_dir() {
                return Err(AppError::new(format!("{path} exists but is not a file")));
            }
            check_owner(&meta, &home_meta, &path)?;
            let content = sftp
                .read(&path)
                .await
                .map_err(|error| sftp_error(format!("cannot read {path}"), &error))?;
            if content.len() > MAX_AUTHORIZED_KEYS {
                return Err(AppError::invalid_input(format!(
                    "{path} is larger than {} KiB; refusing to rewrite it",
                    MAX_AUTHORIZED_KEYS / 1024
                )));
            }
            Some(content)
        }
        Err(error) if is_missing(&error) => None,
        Err(error) => return Err(sftp_error(format!("cannot read {path}"), &error)),
    };

    let text = match &existing {
        None => String::new(),
        Some(bytes) => String::from_utf8(bytes.clone()).map_err(|_| {
            AppError::invalid_input(format!("{path} is not UTF-8 text; install the key by hand"))
        })?,
    };
    let line = line_for(key_type, data, comment);
    match merge(&text, &line) {
        Merge::Present => Ok(InstallReport {
            path,
            outcome: InstallOutcome::Present,
            options: None,
        }),
        Merge::PresentRestricted(options) => Ok(InstallReport {
            path,
            outcome: InstallOutcome::PresentRestricted,
            options: Some(options),
        }),
        Merge::Appended(merged) => {
            replace(sftp, &dir, &path, &merged, existing.as_deref()).await?;
            Ok(InstallReport {
                path,
                outcome: InstallOutcome::Added,
                options: None,
            })
        }
    }
}

/// Ensures `dir` exists as a real directory owned like the home directory,
/// and tightens it to owner-only — what sshd's own checks and every
/// `ssh-copy-id` expect.
async fn ensure_dir(sftp: &SftpSession, dir: &str, home: &FileAttributes) -> Result<()> {
    let perms = {
        let mut attrs = FileAttributes::default();
        attrs.permissions = Some(0o700);
        attrs
    };
    match sftp.symlink_metadata(dir).await {
        Ok(meta) => {
            if meta.is_symlink() {
                return Err(AppError::new(format!(
                    "{dir} is a symlink; refusing to install through it"
                )));
            }
            if !meta.is_dir() {
                return Err(AppError::new(format!(
                    "{dir} exists but is not a directory"
                )));
            }
            check_owner(&meta, home, dir)?;
            if meta.permissions.map(|mode| mode & 0o777) != Some(0o700) {
                sftp.set_metadata(dir, perms).await.map_err(|error| {
                    sftp_error(format!("cannot set the permissions of {dir}"), &error)
                })?;
            }
        }
        Err(error) if is_missing(&error) => {
            sftp.create_dir(dir).await.map_err(|error| {
                sftp_error(format!("cannot create {dir} on the server"), &error)
            })?;
            sftp.set_metadata(dir, perms).await.map_err(|error| {
                sftp_error(format!("cannot set the permissions of {dir}"), &error)
            })?;
        }
        Err(error) => return Err(sftp_error(format!("cannot read {dir}"), &error)),
    }
    Ok(())
}

/// The file (and the directory it sits in) must belong to the login the
/// session is on. A key installed into another user's file would be a login
/// handed to that user, not this one.
fn check_owner(meta: &FileAttributes, home: &FileAttributes, path: &str) -> Result<()> {
    if let (Some(owner), Some(home_owner)) = (meta.uid, home.uid) {
        if owner != home_owner {
            return Err(AppError::new(format!(
                "{path} is owned by another user; install the key by hand"
            )));
        }
    }
    Ok(())
}

/// Replaces `path` with `merged`, leaving the original untouched if anything
/// at all goes wrong: a temporary file carries the new content, the original
/// is read once more to catch a concurrent edit, and the result is read back
/// before the install is reported.
async fn replace(
    sftp: &SftpSession,
    dir: &str,
    path: &str,
    merged: &str,
    before: Option<&[u8]>,
) -> Result<()> {
    let temp = format!("{dir}/.authorized_keys.edgeterm-{}", uuid::Uuid::new_v4());
    let mut attrs = FileAttributes::default();
    attrs.permissions = Some(0o600);
    let mut file = sftp
        .open_with_flags_and_attributes(
            temp.clone(),
            OpenFlags::CREATE | OpenFlags::WRITE | OpenFlags::EXCLUDE,
            attrs.clone(),
        )
        .await
        .map_err(|error| {
            sftp_error(
                format!("cannot create a temporary file next to {path}"),
                &error,
            )
        })?;
    if let Err(error) = file.write_all(merged.as_bytes()).await {
        let _ = sftp.remove_file(&temp).await;
        return Err(AppError::from_io(
            format!("cannot write {temp} on the server"),
            &error,
        ));
    }
    if let Err(error) = file.shutdown().await {
        let _ = sftp.remove_file(&temp).await;
        return Err(AppError::from_io(
            format!("cannot finish {temp} on the server"),
            &error,
        ));
    }
    // The create mode is a hint some servers ignore; the file that replaces
    // an `authorized_keys` must be owner-only either way.
    if let Err(error) = sftp.set_metadata(&temp, attrs.clone()).await {
        let _ = sftp.remove_file(&temp).await;
        return Err(sftp_error(
            format!("cannot set the permissions of {temp}"),
            &error,
        ));
    }
    match unchanged(sftp, path, before).await {
        Ok(true) => {}
        Ok(false) => {
            let _ = sftp.remove_file(&temp).await;
            return Err(AppError::new(format!(
                "{path} changed on the server while the key was being installed; \
                 nothing was written, retry"
            )));
        }
        Err(error) => {
            let _ = sftp.remove_file(&temp).await;
            return Err(error);
        }
    }
    if let Err(error) = sftp.rename(&temp, path).await {
        let _ = sftp.remove_file(&temp).await;
        return Err(sftp_error(format!("cannot replace {path}"), &error));
    }
    if let Err(error) = sftp.set_metadata(path, attrs).await {
        // The content is in place; say so rather than implying nothing was
        // installed.
        return Err(sftp_error(
            format!("{path} was installed, but its permissions could not be set"),
            &error,
        ));
    }
    let landed = sftp
        .read(path)
        .await
        .map_err(|error| sftp_error(format!("cannot confirm {path} after writing it"), &error))?;
    if landed != merged.as_bytes() {
        return Err(AppError::coded(
            ErrorCode::RemoteWriteUncertain,
            format!("{path} does not read back as what was installed; check it by hand"),
        ));
    }
    Ok(())
}

/// Whether `path` still holds exactly the bytes that were read at the start;
/// a file that was absent must still be absent.
async fn unchanged(sftp: &SftpSession, path: &str, before: Option<&[u8]>) -> Result<bool> {
    match sftp.read(path).await {
        Ok(now) => Ok(before == Some(now.as_slice())),
        Err(error) if is_missing(&error) => Ok(before.is_none()),
        Err(error) => Err(sftp_error(format!("cannot read {path} again"), &error)),
    }
}

fn is_missing(error: &russh_sftp::client::error::Error) -> bool {
    matches!(
        error,
        russh_sftp::client::error::Error::Status(status)
            if status.status_code == StatusCode::NoSuchFile
    )
}

/// Classifies an SFTP failure the way the dialog acts on it.
fn sftp_error(
    context: impl std::fmt::Display,
    error: &russh_sftp::client::error::Error,
) -> AppError {
    let message = format!("{context}: {error}");
    match error {
        russh_sftp::client::error::Error::Status(status) => match status.status_code {
            StatusCode::PermissionDenied => AppError::coded(ErrorCode::PermissionDenied, message),
            StatusCode::NoSuchFile => AppError::coded(ErrorCode::InvalidInput, message),
            _ => AppError::connection_failed(message),
        },
        _ => AppError::connection_failed(message),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key_line(comment: Option<&str>) -> String {
        line_for(
            "ssh-ed25519",
            "AAAAC3NzaC1lZDI1NTE5AAAAIIcCiNIPQD3zMS3LgYoVYM8VShLj/4dvS3+yBaPqfGSr",
            comment,
        )
    }

    fn appended(merged: &Merge) -> &str {
        match merged {
            Merge::Appended(content) => content,
            other => panic!("expected an append, got {other:?}"),
        }
    }

    #[test]
    fn an_empty_file_gets_the_line_and_a_final_newline() {
        let line = key_line(None);
        let merged = merge("", &line);
        assert_eq!(appended(&merged), format!("{line}\n"));
    }

    #[test]
    fn a_file_without_a_final_newline_is_repaired_before_the_line() {
        let line = key_line(None);
        let merged = merge("# keep me\nssh-rsa AAAA other", &line);
        assert_eq!(
            appended(&merged),
            format!("# keep me\nssh-rsa AAAA other\n{line}\n")
        );
    }

    #[test]
    fn an_existing_final_newline_is_used_as_is() {
        let line = key_line(None);
        let merged = merge("# keep me\n", &line);
        assert_eq!(appended(&merged), format!("# keep me\n{line}\n"));
    }

    #[test]
    fn a_crlf_file_gets_a_crlf_line() {
        let line = key_line(None);
        let merged = merge("# keep me\r\n", &line);
        assert_eq!(appended(&merged), format!("# keep me\r\n{line}\r\n"));
    }

    #[test]
    fn the_same_key_with_another_comment_is_already_there() {
        let content = format!("{}\n", key_line(Some("old laptop")));
        assert_eq!(
            merge(&content, &key_line(Some("new laptop"))),
            Merge::Present
        );
    }

    #[test]
    fn a_key_behind_options_is_left_alone() {
        let line = key_line(None);
        let fields = fields_of(&line);
        let content = format!(
            "from=\"10.0.0.1\",command=\"uptime\" {} {}\n",
            fields[0], fields[1]
        );
        assert_eq!(
            merge(&content, &line),
            Merge::PresentRestricted("from=\"10.0.0.1\",command=\"uptime\"".to_string())
        );
    }

    #[test]
    fn a_bare_option_before_the_key_is_recognized() {
        let line = key_line(None);
        let fields = fields_of(&line);
        let content = format!("cert-authority {} {}\n", fields[0], fields[1]);
        assert_eq!(
            merge(&content, &line),
            Merge::PresentRestricted("cert-authority".to_string())
        );
    }

    #[test]
    fn a_quoted_option_may_contain_spaces_and_the_key_text() {
        let line = key_line(None);
        let content = format!("command=\"/bin/echo {} \"\n", fields_of(&line).join(" "));
        // The whole quoted command is one field, so it is not a key entry.
        assert!(matches!(merge(&content, &line), Merge::Appended(_)));
    }

    #[test]
    fn a_comment_holding_the_key_is_not_an_entry() {
        let line = key_line(None);
        let merged = merge(&format!("# {line}\n"), &line);
        assert_eq!(appended(&merged), format!("# {line}\n{line}\n"));
    }

    #[test]
    fn only_the_same_type_and_data_match() {
        let line = key_line(None);
        let other = line_for(
            "ssh-rsa",
            fields_of(&line)[1],
            Some("same data, other type"),
        );
        assert!(matches!(
            merge(&format!("{other}\n"), &line),
            Merge::Appended(_)
        ));

        // A longer key that begins with the same bytes is a different key.
        let fields = fields_of(&line);
        let longer = line_for(fields[0], &format!("{}AA", fields[1]), None);
        assert!(matches!(
            merge(&format!("{longer}\n"), &line),
            Merge::Appended(_)
        ));
    }

    #[test]
    fn tabs_and_extra_spaces_do_not_hide_an_entry() {
        let line = key_line(Some("me"));
        let fields = fields_of(&line);
        let content = format!("\t{}   {}\t# padded\n", fields[0], fields[1]);
        assert_eq!(merge(&content, &line), Merge::Present);
    }

    #[test]
    fn a_plain_entry_wins_over_a_restricted_one() {
        let line = key_line(None);
        let fields = fields_of(&line);
        let content = format!(
            "from=\"10.0.0.1\" {} {}\n{} {}\n",
            fields[0], fields[1], fields[0], fields[1]
        );
        assert_eq!(merge(&content, &line), Merge::Present);
    }

    #[test]
    fn an_owner_that_differs_from_home_is_refused() {
        let mut home = FileAttributes::default();
        home.uid = Some(1000);
        let mut file = FileAttributes::default();
        file.uid = Some(0);
        let error = check_owner(&file, &home, "/home/u/.ssh").expect_err("owned by root");
        assert!(error.to_string().contains("owned by another user"));

        // Without an owner from the server there is nothing to judge.
        check_owner(&FileAttributes::default(), &home, "/home/u/.ssh").expect("unknown owner");
    }

    #[test]
    fn fields_respect_quotes_and_escapes() {
        assert_eq!(
            fields_of(r#"command="a b",no-pty ssh-ed25519 AAAA c"#),
            vec![r#"command="a b",no-pty"#, "ssh-ed25519", "AAAA", "c"]
        );
        assert_eq!(
            fields_of(r#"command="say \"hi\" now" ssh-ed25519 AAAA"#).len(),
            3
        );
        assert_eq!(
            fields_of("  \t ssh-ed25519\tAAAA  "),
            vec!["ssh-ed25519", "AAAA"]
        );
    }
}
