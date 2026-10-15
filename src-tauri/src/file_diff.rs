//! Bounded, read-only snapshots. File channels are independent of the terminal.
use std::collections::HashMap;
use std::hash::{Hash, Hasher};
use std::io::Read;
use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, Instant};

use crate::{
    error::{AppError, Result},
    file_transfer::{Control, Failure, TransferResult},
    model::{SessionKind, SessionProfile},
    session::ssh::SharedTransport,
};
use parking_lot::Mutex;
use russh_sftp::{
    client::{error::Error as SftpError, RawSftpSession},
    protocol::{FileAttributes, OpenFlags, StatusCode},
};
use serde::Serialize;

use imara_diff::{Algorithm, InternedInput, TokenSource};

const MAX_BYTES: usize = 4 * 1024 * 1024;
const MAX_LINES: usize = 50_000;
const MAX_LINE_BYTES: usize = 16 * 1024;

#[derive(Default)]
struct Requests {
    active: HashMap<String, (String, Arc<Control>)>,
    early: HashMap<String, Instant>,
}
#[derive(Clone, Default)]
pub struct FileDiffs(Arc<Mutex<Requests>>);
pub struct DiffRequest {
    id: String,
    owner: FileDiffs,
    control: Arc<Control>,
}
impl Drop for DiffRequest {
    fn drop(&mut self) {
        self.control.set(2);
        self.owner.0.lock().active.remove(&self.id);
    }
}
impl FileDiffs {
    pub fn begin(&self, session: &str, id: &str) -> Result<DiffRequest> {
        if id.is_empty()
            || id.len() > 100
            || !id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
        {
            return Err(AppError::new("invalid comparison request id"));
        }
        let mut state = self.0.lock();
        if state.active.contains_key(id) || state.active.len() >= 8 {
            return Err(AppError::new(
                "too many active comparisons or duplicate request id",
            ));
        }
        let control = Arc::new(Control::default());
        state
            .early
            .retain(|_, time| time.elapsed() < Duration::from_secs(30));
        if state.early.remove(id).is_some() {
            control.set(2);
        }
        state
            .active
            .insert(id.into(), (session.into(), control.clone()));
        Ok(DiffRequest {
            id: id.into(),
            owner: self.clone(),
            control,
        })
    }
    pub fn cancel(&self, id: &str) {
        let mut state = self.0.lock();
        if let Some((_, control)) = state.active.get(id) {
            control.set(2);
        } else if !id.is_empty() && id.len() <= 100 && state.early.len() < 128 {
            state.early.insert(id.into(), Instant::now());
        }
    }
    pub fn close_session(&self, session: &str) {
        for (owner, control) in self.0.lock().active.values() {
            if owner == session {
                control.set(2);
            }
        }
    }
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Metadata {
    pub size: u64,
    pub kind: &'static str,
    pub encoding: Option<String>,
    pub bom: bool,
    pub eol: String,
    pub final_newline: Option<bool>,
    pub lines: Option<usize>,
    pub sha256: Option<String>,
    pub preview: String,
}
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DiffRow {
    pub path: String,
    pub kind: &'static str,
    pub left_line: Option<usize>,
    pub right_line: Option<usize>,
    pub left: Option<String>,
    pub right: Option<String>,
    pub left_ending: Option<&'static str>,
    pub right_ending: Option<&'static str>,
}
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Comparison {
    pub status: &'static str,
    pub bytes_equal: Option<bool>,
    pub left: Metadata,
    pub right: Metadata,
    pub reason: Option<String>,
    pub rows: Vec<DiffRow>,
    /// Whether the rows came out of a positional fallback instead of an
    /// anchored alignment. The retired 64-line lookahead set this once its
    /// 1,000,000-comparison budget ran out; the histogram alignment always
    /// computes whole-file anchors, so nothing degrades end to end and this
    /// stays false. Kept because the serialized contract and the frontend
    /// notice reference it.
    pub alignment_simplified: bool,
}
struct Snapshot {
    size: u64,
    bytes: Option<Vec<u8>>,
}
struct Line {
    text: String,
    ending: &'static str,
    fingerprint: u64,
}
struct Text {
    meta: Metadata,
    lines: Option<Vec<Line>>,
}

fn io_failure(error: impl ToString) -> Failure {
    Failure::new("read", error, false)
}
fn read_local(path: &str, control: &Control) -> TransferResult<Snapshot> {
    control.check()?;
    let mut file = std::fs::File::open(Path::new(path))?;
    let before = file.metadata()?;
    if !before.is_file() {
        return Err(io_failure("select a regular local file"));
    }
    if before.len() > MAX_BYTES as u64 {
        return Ok(Snapshot {
            size: before.len(),
            bytes: None,
        });
    }
    let bytes = bounded_read(&mut file, control)?;
    let after = file.metadata()?;
    if before.len() != after.len() || before.modified().ok() != after.modified().ok() {
        return Err(io_failure(
            "local file changed while it was being read; compare again",
        ));
    }
    Ok(Snapshot {
        size: after.len(),
        bytes: (bytes.len() <= MAX_BYTES).then_some(bytes),
    })
}
fn bounded_read(reader: &mut impl Read, control: &Control) -> TransferResult<Vec<u8>> {
    let mut bytes = Vec::new();
    let mut buffer = [0u8; 32 * 1024];
    while bytes.len() <= MAX_BYTES {
        control.check()?;
        let take = buffer.len().min(MAX_BYTES + 1 - bytes.len());
        let n = reader.read(&mut buffer[..take])?;
        if n == 0 {
            break;
        }
        bytes.extend_from_slice(&buffer[..n]);
    }
    control.check()?;
    Ok(bytes)
}
struct SftpReader(RawSftpSession);
impl Drop for SftpReader {
    fn drop(&mut self) {
        let _ = self.0.close_session();
    }
}
async fn read_sftp(
    transport: Arc<SharedTransport>,
    path: &str,
    control: &Control,
) -> TransferResult<Snapshot> {
    control
        .run(async {
            let stream = transport.transfer_channel().await.map_err(io_failure)?;
            read_sftp_stream(stream, path, control).await
        })
        .await
}
async fn read_sftp_stream(
    stream: impl tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send + 'static,
    path: &str,
    control: &Control,
) -> TransferResult<Snapshot> {
    control
        .run(async {
            let reader = SftpReader(RawSftpSession::new(stream));
            reader.0.set_timeout(5);
            reader.0.init().await.map_err(io_failure)?;
            let before = reader.0.stat(path).await.map_err(io_failure)?.attrs;
            if before.is_dir() {
                return Err(io_failure("select a remote file, rather than a directory"));
            }
            let size = before
                .size
                .ok_or_else(|| io_failure("remote file size is unavailable"))?;
            if size > MAX_BYTES as u64 {
                return Ok(Snapshot { size, bytes: None });
            }
            let handle = reader
                .0
                .open(path, OpenFlags::READ, FileAttributes::empty())
                .await
                .map_err(io_failure)?
                .handle;
            let mut bytes = Vec::new();
            while bytes.len() <= MAX_BYTES {
                control.check()?;
                let count = (MAX_BYTES + 1 - bytes.len()).min(32 * 1024) as u32;
                match reader.0.read(&handle, bytes.len() as u64, count).await {
                    Ok(data) if !data.data.is_empty() && data.data.len() <= count as usize => {
                        bytes.extend_from_slice(&data.data)
                    }
                    Err(SftpError::Status(status)) if status.status_code == StatusCode::Eof => {
                        break
                    }
                    Ok(_) => return Err(io_failure("invalid SFTP data packet")),
                    Err(error) => return Err(io_failure(error)),
                }
            }
            let after = reader.0.fstat(&handle).await.map_err(io_failure)?.attrs;
            reader.0.close(&handle).await.map_err(io_failure)?;
            if before.size != after.size
                || before.mtime != after.mtime
                || (bytes.len() <= MAX_BYTES && bytes.len() as u64 != size)
            {
                return Err(io_failure(
                    "remote file changed while it was being read; compare again",
                ));
            }
            Ok(Snapshot {
                size,
                bytes: (bytes.len() <= MAX_BYTES).then_some(bytes),
            })
        })
        .await
}
fn read_ftp(profile: &SessionProfile, path: &str, control: &Control) -> TransferResult<Snapshot> {
    let mut connection =
        crate::session::ftp::connect_controlled(profile, Some(control)).map_err(io_failure)?;
    let ftp = &mut connection.stream;
    let _socket = control.socket(ftp.get_ref())?;
    let size = ftp.size(path).map_err(io_failure)? as u64;
    if size > MAX_BYTES as u64 {
        return Ok(Snapshot { size, bytes: None });
    }
    let mut input = ftp.retr_as_stream(path).map_err(io_failure)?;
    let socket = control.socket(input.get_ref())?;
    let bytes = bounded_read(&mut input, control)?;
    drop(socket);
    if bytes.len() > MAX_BYTES {
        return Ok(Snapshot {
            size: bytes.len() as u64,
            bytes: None,
        });
    }
    ftp.finalize_retr_stream(input).map_err(io_failure)?;
    let after = ftp.size(path).map_err(io_failure)? as u64;
    if size != after || bytes.len() as u64 != size {
        return Err(io_failure(
            "remote file changed while it was being read; compare again",
        ));
    }
    Ok(Snapshot {
        size,
        bytes: Some(bytes),
    })
}

pub async fn compare(
    request: DiffRequest,
    profile: SessionProfile,
    transport: Option<Arc<SharedTransport>>,
    local: String,
    remote: String,
) -> Result<Comparison> {
    if local.is_empty() || remote.is_empty() {
        return Err(AppError::new("select one local and one remote file"));
    }
    let control = request.control.clone();
    let encoding = profile.encoding.clone();
    let work = async {
        control.check()?;
        let local_control = control.clone();
        let left = tokio::task::spawn_blocking(move || read_local(&local, &local_control));
        let right = async {
            if profile.kind == SessionKind::Ftp {
                let remote_control = control.clone();
                tokio::task::spawn_blocking(move || read_ftp(&profile, &remote, &remote_control))
                    .await
                    .map_err(io_failure)?
            } else {
                let transport =
                    transport.ok_or_else(|| io_failure("reconnect SSH before comparing files"))?;
                read_sftp(transport, &remote, &control).await
            }
        };
        let (left, right) = tokio::try_join!(async { left.await.map_err(io_failure)? }, right)?;
        let diff_control = control.clone();
        tokio::task::spawn_blocking(move || {
            compare_snapshots(left, right, encoding.as_deref(), &diff_control)
        })
        .await
        .map_err(io_failure)?
    };
    match tokio::time::timeout(Duration::from_secs(12), control.run(work)).await {
        Ok(result) => result.map_err(AppError::from),
        Err(_) => {
            control.set(2);
            Err(AppError::new("file comparison timed out"))
        }
    }
}

fn decode(snapshot: &Snapshot, fallback: Option<&str>) -> Text {
    let mut meta = Metadata {
        size: snapshot.size,
        kind: "tooLarge",
        encoding: None,
        bom: false,
        eol: "unknown".into(),
        final_newline: None,
        lines: None,
        sha256: None,
        preview: String::new(),
    };
    let Some(bytes) = &snapshot.bytes else {
        return Text { meta, lines: None };
    };
    meta.sha256 = Some(
        ring::digest::digest(&ring::digest::SHA256, bytes)
            .as_ref()
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect(),
    );
    meta.preview = bytes
        .iter()
        .take(64)
        .map(|b| format!("{b:02x}"))
        .collect::<Vec<_>>()
        .join(" ");
    let (encoding, offset) = if bytes.starts_with(&[0xef, 0xbb, 0xbf]) {
        (encoding_rs::UTF_8, 3)
    } else if bytes.starts_with(&[0xff, 0xfe]) {
        (encoding_rs::UTF_16LE, 2)
    } else if bytes.starts_with(&[0xfe, 0xff]) {
        (encoding_rs::UTF_16BE, 2)
    } else {
        (encoding_rs::UTF_8, 0)
    };
    meta.bom = offset != 0;
    let content = &bytes[offset..];
    let decoded = encoding.decode_without_bom_handling_and_without_replacement(content);
    let (decoded, encoding) = if decoded.is_none() && offset == 0 {
        let alternate = fallback
            .and_then(|label| encoding_rs::Encoding::for_label(label.as_bytes()))
            .unwrap_or(encoding_rs::UTF_8);
        (
            alternate.decode_without_bom_handling_and_without_replacement(content),
            alternate,
        )
    } else {
        (decoded, encoding)
    };
    meta.encoding = Some(encoding.name().into());
    let Some(text) = decoded else {
        meta.kind = "undecodable";
        return Text { meta, lines: None };
    };
    if text
        .chars()
        .any(|c| c == '\0' || (c.is_control() && !matches!(c, '\n' | '\r' | '\t' | '\u{c}')))
    {
        meta.kind = "binary";
        return Text { meta, lines: None };
    }
    meta.kind = "text";
    meta.final_newline = Some(text.ends_with('\r') || text.ends_with('\n'));
    let mut lines = Vec::new();
    let mut start = 0;
    let mut i = 0;
    let data = text.as_bytes();
    let mut endings = Vec::new();
    while i < data.len() {
        let (length, ending) = match data[i] {
            b'\r' if data.get(i + 1) == Some(&b'\n') => (2, "CRLF"),
            b'\r' => (1, "CR"),
            b'\n' => (1, "LF"),
            _ => {
                i += 1;
                continue;
            }
        };
        if i - start > MAX_LINE_BYTES || lines.len() >= MAX_LINES {
            meta.kind = "textLimit";
            return Text { meta, lines: None };
        }
        let raw = text[start..i].to_string();
        if !endings.contains(&ending) {
            endings.push(ending);
        }
        lines.push(line(raw, ending));
        i += length;
        start = i;
    }
    if start < text.len() {
        if text.len() - start > MAX_LINE_BYTES || lines.len() >= MAX_LINES {
            meta.kind = "textLimit";
            return Text { meta, lines: None };
        }
        lines.push(line(text[start..].into(), "none"));
    }
    meta.lines = Some(lines.len());
    meta.eol = if endings.is_empty() {
        "none".into()
    } else {
        endings.join("+")
    };
    Text {
        meta,
        lines: Some(lines),
    }
}
fn line(text: String, ending: &'static str) -> Line {
    let mut hash = std::collections::hash_map::DefaultHasher::new();
    text.hash(&mut hash);
    ending.hash(&mut hash);
    Line {
        text,
        ending,
        fingerprint: hash.finish(),
    }
}
fn same(a: &Line, b: &Line) -> bool {
    a.fingerprint == b.fingerprint && a.ending == b.ending && a.text == b.text
}
fn row(a: Option<(&Line, usize)>, b: Option<(&Line, usize)>) -> DiffRow {
    let kind = match (a, b) {
        (Some((a, _)), Some((b, _))) if same(a, b) => "equal",
        (Some(_), Some(_)) => "modified",
        (Some(_), None) => "deleted",
        _ => "added",
    };
    DiffRow {
        path: format!(
            "{}:{}",
            a.map(|v| v.1).unwrap_or(0),
            b.map(|v| v.1).unwrap_or(0)
        ),
        kind,
        left_line: a.map(|v| v.1),
        right_line: b.map(|v| v.1),
        left: a.map(|v| v.0.text.clone()),
        right: b.map(|v| v.0.text.clone()),
        left_ending: a.map(|v| v.0.ending),
        right_ending: b.map(|v| v.0.ending),
    }
}
/// The comparison's diff tokens: one per decoded line, the line's text.
/// Text-only tokens are what keep anchors alive across a whole-file line
/// ending conversion that also inserts lines; endings are compared later,
/// through `row`'s `same`, exactly like the old alignment did.
struct LineTokens<'a>(&'a [Line]);

impl<'a> TokenSource for LineTokens<'a> {
    type Token = &'a str;
    type Tokenizer = std::iter::Map<std::slice::Iter<'a, Line>, fn(&Line) -> &str>;

    fn tokenize(&self) -> Self::Tokenizer {
        self.0.iter().map(|line: &Line| line.text.as_str())
    }

    fn estimate_tokens(&self) -> u32 {
        self.0.len() as u32
    }
}

/// Alignment: histogram over the whole file, anchored on line text. Between
/// hunks both sides run through equal text in lockstep, and `row`'s `same`
/// check is what turns matching text with a changed line ending into a
/// `modified` pair instead of `equal`. A hunk is already bounded by anchors
/// on both of its ends; its interior is paired by position, so content edits
/// keep the two-column `modified` presentation and any surplus on one side
/// comes out as `deleted` / `added`. Every line of both files is emitted
/// exactly once, in order.
///
/// Cancellation is checked at entry and on every emitted row. The histogram
/// run itself is not interruptible: the 12 s timeout in `compare` bounds the
/// wait for a result, not a compute that is already running, and the input
/// bounds (50,000 lines per side) are what cap the work.
fn compare_snapshots(
    left: Snapshot,
    right: Snapshot,
    fallback: Option<&str>,
    control: &Control,
) -> TransferResult<Comparison> {
    control.check()?;
    let bytes_equal = left
        .bytes
        .as_ref()
        .zip(right.bytes.as_ref())
        .map(|(a, b)| a == b);
    let a = decode(&left, fallback);
    let b = decode(&right, fallback);
    let mut result = Comparison {
        status: match bytes_equal {
            Some(true) => "identical",
            Some(false) => "different",
            None => "notCompared",
        },
        bytes_equal,
        left: a.meta,
        right: b.meta,
        reason: None,
        rows: Vec::new(),
        alignment_simplified: false,
    };
    let (Some(a), Some(b)) = (a.lines, b.lines) else {
        result.reason = Some(if bytes_equal.is_none() { "A file exceeds 4 MiB; complete contents were not compared." } else { "Complete bytes were compared; a text view is unavailable (binary, unsupported encoding, or over 50,000 lines / 16 KiB per line)." }.into());
        return Ok(result);
    };
    let input = InternedInput::new(LineTokens(&a), LineTokens(&b));
    let diff = imara_diff::Diff::compute(Algorithm::Histogram, &input);
    control.check()?;
    let mut rows = Vec::new();
    let (mut i, mut j) = (0usize, 0usize);
    for hunk in diff.hunks() {
        // The equal stretch before the hunk: equal tokens, so both sides
        // advance together (the single-side loops only mop up if they ever
        // disagree, which would still keep the projection total).
        let (before, after) = (hunk.before.start as usize, hunk.after.start as usize);
        while i < before && j < after {
            control.check()?;
            rows.push(row(
                a.get(i).map(|v| (v, i + 1)),
                b.get(j).map(|v| (v, j + 1)),
            ));
            i += 1;
            j += 1;
        }
        while i < before {
            control.check()?;
            rows.push(row(Some((&a[i], i + 1)), None));
            i += 1;
        }
        while j < after {
            control.check()?;
            rows.push(row(None, Some((&b[j], j + 1))));
            j += 1;
        }
        // The hunk interior: paired by position, bounded by the anchors.
        let (before_end, after_end) = (hunk.before.end as usize, hunk.after.end as usize);
        while i < before_end && j < after_end {
            control.check()?;
            rows.push(row(Some((&a[i], i + 1)), Some((&b[j], j + 1))));
            i += 1;
            j += 1;
        }
        while i < before_end {
            control.check()?;
            rows.push(row(Some((&a[i], i + 1)), None));
            i += 1;
        }
        while j < after_end {
            control.check()?;
            rows.push(row(None, Some((&b[j], j + 1))));
            j += 1;
        }
    }
    // Hunks stop at the last change; walk whatever equal tail remains.
    while i < a.len() || j < b.len() {
        control.check()?;
        rows.push(row(
            a.get(i).map(|v| (v, i + 1)),
            b.get(j).map(|v| (v, j + 1)),
        ));
        if i < a.len() {
            i += 1;
        }
        if j < b.len() {
            j += 1;
        }
    }
    result.rows = rows;
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn compare_bytes(a: &[u8], b: &[u8], encoding: Option<&str>) -> Comparison {
        compare_snapshots(
            Snapshot {
                size: a.len() as u64,
                bytes: Some(a.into()),
            },
            Snapshot {
                size: b.len() as u64,
                bytes: Some(b.into()),
            },
            encoding,
            &Control::default(),
        )
        .unwrap()
    }

    // The six flow181_ tests below were authored independently (supervisor
    // baseline) against the old lookahead implementation on 91b962b, where
    // four of them failed on behavior (100-line insertion, 100-line deletion,
    // anchors after a 5->100 replacement, whole-file CRLF->LF with three
    // insertions) and two passed as controls (replacement stays modified,
    // projection preserves each side once, in order). Adopted as written;
    // the candidate implementation must pass all six.
    fn flow181_wire_rows(left: &str, right: &str) -> Vec<serde_json::Value> {
        serde_json::to_value(compare_bytes(left.as_bytes(), right.as_bytes(), None)).unwrap()
            ["rows"]
            .as_array()
            .unwrap()
            .clone()
    }

    #[test]
    fn flow181_large_insertion_keeps_fifty_text_anchors() {
        let common = (0..50).map(|n| format!("anchor-{n}\n")).collect::<String>();
        let inserted = (0..100).map(|n| format!("new-{n}\n")).collect::<String>();
        let rows = flow181_wire_rows(&common, &(inserted + &common));
        assert_eq!(rows.iter().filter(|r| r["kind"] == "equal").count(), 50);
        assert_eq!(rows.iter().filter(|r| r["kind"] == "added").count(), 100);
        for n in 0..50 {
            let row = rows.iter().find(|r| r["leftLine"] == n + 1).unwrap();
            assert_eq!(row["rightLine"], n + 101);
            assert_eq!(row["left"], row["right"]);
        }
    }

    #[test]
    fn flow181_large_deletion_keeps_fifty_text_anchors() {
        let common = (0..50).map(|n| format!("anchor-{n}\n")).collect::<String>();
        let deleted = (0..100).map(|n| format!("old-{n}\n")).collect::<String>();
        let rows = flow181_wire_rows(&(deleted + &common), &common);
        assert_eq!(rows.iter().filter(|r| r["kind"] == "equal").count(), 50);
        assert_eq!(rows.iter().filter(|r| r["kind"] == "deleted").count(), 100);
    }

    #[test]
    fn flow181_unbalanced_replacement_preserves_following_anchors() {
        let left = "start\nold-a\nold-b\nold-c\nold-d\nold-e\nanchor-a\nanchor-b\n";
        let right = "start\n".to_string()
            + &(0..100).map(|n| format!("new-{n}\n")).collect::<String>()
            + "anchor-a\nanchor-b\n";
        let rows = flow181_wire_rows(left, &right);
        for anchor in ["anchor-a", "anchor-b"] {
            let row = rows.iter().find(|r| r["left"] == anchor).unwrap();
            assert_eq!(row["kind"], "equal");
            assert_eq!(row["right"], anchor);
        }
    }

    #[test]
    fn flow181_eol_conversion_with_insertion_preserves_pairing() {
        let left = (0..40)
            .map(|n| format!("anchor-{n}\r\n"))
            .collect::<String>();
        let right = (0..20).map(|n| format!("anchor-{n}\n")).collect::<String>()
            + "insert-a\ninsert-b\ninsert-c\n"
            + &(20..40)
                .map(|n| format!("anchor-{n}\n"))
                .collect::<String>();
        let rows = flow181_wire_rows(&left, &right);
        for row in rows.iter().filter(|r| !r["leftLine"].is_null()) {
            assert_eq!(row["right"], row["left"]);
            assert_eq!(row["kind"], "modified");
            assert_eq!(row["leftEnding"], "CRLF");
            assert_eq!(row["rightEnding"], "LF");
        }
        assert_eq!(rows.iter().filter(|r| r["kind"] == "added").count(), 3);
    }

    #[test]
    fn flow181_content_replacement_retains_modified_pair() {
        let rows = flow181_wire_rows("alpha\n", "beta\n");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["kind"], "modified");
        assert_eq!(rows[0]["left"], "alpha");
        assert_eq!(rows[0]["right"], "beta");
    }

    #[test]
    fn flow181_projection_preserves_each_side_once_and_in_order() {
        for (left, right) in [
            ("a\r\n\r\na\nb\rfinal", "a\ninsert\n\na\r\nb\rfinal\n"),
            ("a\nb\na\n", "b\na\nb\n"),
            ("", "added\n"),
            ("removed\n", ""),
        ] {
            let rows = flow181_wire_rows(left, right);
            for (text_key, ending_key, line_key, expected) in [
                ("left", "leftEnding", "leftLine", left),
                ("right", "rightEnding", "rightLine", right),
            ] {
                let mut text = String::new();
                let mut next = 1;
                for row in rows.iter().filter(|r| !r[line_key].is_null()) {
                    assert_eq!(row[line_key], next);
                    next += 1;
                    text.push_str(row[text_key].as_str().unwrap());
                    text.push_str(match row[ending_key].as_str().unwrap() {
                        "CRLF" => "\r\n",
                        "LF" => "\n",
                        "CR" => "\r",
                        "none" => "",
                        other => panic!("unexpected ending: {other}"),
                    });
                }
                assert_eq!(text, expected);
            }
        }
    }

    #[test]
    fn duplicate_and_blank_lines_stay_anchored() {
        let rows = flow181_wire_rows("a\n\na\n\nb\n", "a\n\n\n\na\n\nb\n");
        assert_eq!(rows.iter().filter(|r| r["kind"] == "equal").count(), 5);
        assert_eq!(rows.iter().filter(|r| r["kind"] == "added").count(), 2);
        assert_eq!(rows.iter().filter(|r| r["kind"] == "deleted").count(), 0);
    }

    #[test]
    fn mixed_line_endings_and_missing_final_newline_pair_by_text() {
        let comparison = compare_bytes(b"a\r\nb\nc", b"a\nb\nc\n", None);
        assert_eq!(comparison.status, "different");
        assert_eq!(comparison.bytes_equal, Some(false));
        let kinds = comparison
            .rows
            .iter()
            .map(|row| row.kind)
            .collect::<Vec<_>>();
        assert_eq!(kinds, ["modified", "equal", "modified"]);
        assert_eq!(comparison.rows[0].left_ending, Some("CRLF"));
        assert_eq!(comparison.rows[0].right_ending, Some("LF"));
        assert_eq!(comparison.rows[2].left_ending, Some("none"));
        assert_eq!(comparison.rows[2].right_ending, Some("LF"));
    }

    #[test]
    fn cancelled_control_stops_before_aligning() {
        let control = Control::default();
        control.set(2);
        let error = compare_snapshots(
            Snapshot {
                size: 2,
                bytes: Some(b"a\n".to_vec()),
            },
            Snapshot {
                size: 2,
                bytes: Some(b"b\n".to_vec()),
            },
            None,
            &control,
        )
        .unwrap_err();
        assert_eq!(error.code, "cancelled");
    }

    #[test]
    fn large_input_stays_anchored_and_completes() {
        let left: String = (0..20_000).map(|n| format!("row-{n}\n")).collect();
        let mut right: Vec<String> = (0..20_000).map(|n| format!("row-{n}")).collect();
        right.splice(10_000..10_000, (0..200).map(|n| format!("new-{n}")));
        let right: String = right.into_iter().map(|line| line + "\n").collect();
        let started = Instant::now();
        let rows = flow181_wire_rows(&left, &right);
        // Wall-clock on this one machine, printed for the record; not a bound
        // on any other machine or input.
        println!("20k-line alignment took {:?}", started.elapsed());
        assert_eq!(rows.iter().filter(|r| r["kind"] == "equal").count(), 20_000);
        assert_eq!(rows.iter().filter(|r| r["kind"] == "added").count(), 200);
        assert_eq!(rows.iter().filter(|r| r["kind"] == "modified").count(), 0);
    }

    #[test]
    fn exact_bytes_and_line_edits_include_line_endings_and_bom() {
        assert_eq!(compare_bytes(b"", b"", None).status, "identical");
        let changed = compare_bytes(b"a\nb\nc\n", b"a\nx\nb\nc\n", None);
        assert_eq!(changed.rows.iter().filter(|r| r.kind == "added").count(), 1);
        assert_eq!(changed.rows[1].right.as_deref(), Some("x"));
        assert_eq!(
            compare_bytes(b"a\r\n", b"a\n", None).rows[0].kind,
            "modified"
        );
        assert_eq!(compare_bytes(b"a", b"a\n", None).status, "different");
        let bom = compare_bytes(b"\xef\xbb\xbfa", b"a", None);
        assert_eq!(bom.status, "different");
        assert!(bom.left.bom);
        assert!(!bom.right.bom);
    }
    #[test]
    fn utf16_gbk_binary_and_invalid_encoding_are_explicit() {
        let utf16 = compare_bytes(&[0xff, 0xfe, 0x61, 0, 0x0a, 0], b"a\n", None);
        assert_eq!(utf16.left.kind, "text");
        assert_eq!(utf16.left.encoding.as_deref(), Some("UTF-16LE"));
        let gbk = compare_bytes(&[0xd6, 0xd0], "中".as_bytes(), Some("gbk"));
        assert_eq!(gbk.rows[0].left.as_deref(), Some("中"));
        assert_eq!(gbk.status, "different");
        assert_eq!(compare_bytes(b"a\0b", b"a\0b", None).left.kind, "binary");
        assert_eq!(compare_bytes(&[0xff], b"a", None).left.kind, "undecodable");
    }
    #[test]
    fn limits_do_not_claim_truncated_content_is_equal() {
        let result = compare_snapshots(
            Snapshot {
                size: 8_000_000,
                bytes: None,
            },
            Snapshot {
                size: 8_000_000,
                bytes: None,
            },
            None,
            &Control::default(),
        )
        .unwrap();
        assert_eq!(result.bytes_equal, None);
        assert_eq!(result.status, "notCompared");
        let a = "a\n".repeat(50_001);
        assert_eq!(
            compare_bytes(a.as_bytes(), a.as_bytes(), None).left.kind,
            "textLimit"
        );
        let b = "a".repeat(16_385);
        assert_eq!(
            compare_bytes(b.as_bytes(), b.as_bytes(), None).left.kind,
            "textLimit"
        );
    }
    #[tokio::test]
    async fn cancellation_stops_backend_work_and_covers_early_cancel() {
        let manager = FileDiffs::default();
        manager.cancel("early");
        let early = manager.begin("ssh", "early").unwrap();
        assert!(early.control.check().is_err());
        drop(early);
        let active = manager.begin("ssh", "active").unwrap();
        let control = active.control.clone();
        let (stream, _stalled_peer) = tokio::io::duplex(1024);
        let waiting =
            tokio::spawn(async move { read_sftp_stream(stream, "/file", &control).await });
        tokio::task::yield_now().await;
        manager.close_session("ssh");
        assert_eq!(
            tokio::time::timeout(Duration::from_millis(100), waiting)
                .await
                .unwrap()
                .unwrap()
                .err()
                .unwrap()
                .code,
            "cancelled"
        );
        drop(active);
        assert!(manager.0.lock().active.is_empty());
    }

    #[test]
    fn result_serialization_matches_the_frontend_contract_and_local_reads_are_bounded() {
        let root = std::env::temp_dir().join(format!("edgeterm-diff-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        let path = root.join("file");
        std::fs::write(&path, b"a\r\n").unwrap();
        let snapshot = read_local(path.to_str().unwrap(), &Control::default()).unwrap();
        assert_eq!(snapshot.bytes.as_deref(), Some(&b"a\r\n"[..]));
        let json = serde_json::to_value(compare_bytes(b"a\r\n", b"a\n", None)).unwrap();
        assert_eq!(json["bytesEqual"], false);
        assert_eq!(json["rows"][0]["leftLine"], 1);
        assert_eq!(json["rows"][0]["rightEnding"], "LF");
        assert_eq!(json["left"]["finalNewline"], true);
        std::fs::OpenOptions::new()
            .write(true)
            .open(&path)
            .unwrap()
            .set_len(4_194_305)
            .unwrap();
        assert!(read_local(path.to_str().unwrap(), &Control::default())
            .unwrap()
            .bytes
            .is_none());
        assert!(read_local(root.to_str().unwrap(), &Control::default()).is_err());
        std::fs::remove_dir_all(&root).unwrap();
    }

    fn var(name: &str) -> String {
        std::env::var(name).unwrap_or_else(|_| panic!("{name} fixture must be configured"))
    }
    fn profile(ftp: bool) -> SessionProfile {
        let protocol = if ftp { "FTP" } else { "SSH" };
        let address = var(&format!("EDGETERM_REAL_{protocol}_ADDR"));
        let (host, port) = address.rsplit_once(':').unwrap();
        let mut profile: SessionProfile = serde_json::from_value(
            serde_json::json!({"name":"diff-test","kind":if ftp {"ftp"} else {"sftp"}}),
        )
        .unwrap();
        profile.host = Some(host.into());
        profile.port = Some(port.parse().unwrap());
        profile.username = Some(var(&format!("EDGETERM_REAL_{protocol}_USER")));
        if ftp {
            profile.password = Some(var("EDGETERM_REAL_FTP_PASS"));
        }
        profile
    }
    #[tokio::test]
    #[ignore = "dedicated loopback OpenSSH fixture"]
    async fn real_sftp_comparison_reads_utf16_and_preserves_both_files() {
        let root = std::env::temp_dir().join(format!("edgeterm-diff-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        let profile = profile(false);
        let transport = crate::session::ssh::test_transport(
            profile.host.as_deref().unwrap(),
            profile.port.unwrap(),
            profile.username.as_deref().unwrap(),
            &var("EDGETERM_REAL_SSH_KEY"),
            &root.join("known_hosts"),
        )
        .await;
        let remote = format!(
            "{}/diff-{}",
            var("EDGETERM_REAL_SSH_ROOT").trim_end_matches('/'),
            uuid::Uuid::new_v4()
        );
        let stream = transport.transfer_channel().await.unwrap();
        let raw = RawSftpSession::new(stream);
        raw.init().await.unwrap();
        let content = [0xff, 0xfe, 0x61, 0, 0x0d, 0, 0x0a, 0];
        let handle = raw
            .open(
                &remote,
                OpenFlags::WRITE | OpenFlags::CREATE | OpenFlags::EXCLUDE,
                FileAttributes::empty(),
            )
            .await
            .unwrap()
            .handle;
        raw.write(&handle, 0, content.to_vec()).await.unwrap();
        raw.close(&handle).await.unwrap();
        let local = root.join("file");
        std::fs::write(&local, b"a\n").unwrap();
        let request = FileDiffs::default().begin("fixture", "real-sftp").unwrap();
        let found = compare(
            request,
            profile,
            Some(transport.clone()),
            local.to_string_lossy().into(),
            remote.clone(),
        )
        .await
        .unwrap();
        assert_eq!(found.status, "different");
        assert_eq!(found.right.encoding.as_deref(), Some("UTF-16LE"));
        assert_eq!(found.rows[0].right.as_deref(), Some("a"));
        assert_eq!(found.rows[0].right_ending, Some("CRLF"));
        let rechecked = read_sftp(transport.clone(), &remote, &Control::default())
            .await
            .unwrap();
        assert_eq!(rechecked.bytes.as_deref(), Some(&content[..]));
        assert_eq!(std::fs::read(local).unwrap(), b"a\n");
        raw.remove(&remote).await.unwrap();
        raw.close_session().unwrap();
        std::fs::remove_dir_all(root).unwrap();
    }
    #[tokio::test]
    #[ignore = "dedicated loopback FTP fixture"]
    async fn real_ftp_comparison_reads_complete_content_without_writing() {
        use std::io::Write;
        let root = std::env::temp_dir().join(format!("edgeterm-diff-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        let profile = profile(true);
        let remote = format!(
            "{}/diff-{}",
            var("EDGETERM_REAL_FTP_ROOT").trim_end_matches('/'),
            uuid::Uuid::new_v4()
        );
        let mut connection = crate::session::ftp::connect(&profile).unwrap();
        let mut data = connection.stream.put_with_stream(&remote).unwrap();
        data.write_all(b"remote\r\n").unwrap();
        connection.stream.finalize_put_stream(data).unwrap();
        let local = root.join("file");
        std::fs::write(&local, b"local\n").unwrap();
        let request = FileDiffs::default().begin("fixture", "real-ftp").unwrap();
        let found = compare(
            request,
            profile.clone(),
            None,
            local.to_string_lossy().into(),
            remote.clone(),
        )
        .await
        .unwrap();
        assert_eq!(found.status, "different");
        assert_eq!(found.rows[0].right.as_deref(), Some("remote"));
        let bytes = read_ftp(&profile, &remote, &Control::default())
            .unwrap()
            .bytes
            .unwrap();
        assert_eq!(bytes, b"remote\r\n");
        assert_eq!(std::fs::read(local).unwrap(), b"local\n");
        connection.stream.rm(&remote).unwrap();
        std::fs::remove_dir_all(root).unwrap();
    }
}
