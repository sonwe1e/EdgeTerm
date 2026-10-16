//! Optional tar streaming for folder uploads (roadmap B12).
//!
//! Off by default, and off is the only path anything else in the engine
//! takes. When it is on and the batch is a single folder upload, the whole
//! tree is packed locally into a ustar archive and streamed into `tar -xf -`
//! on the server over one exec channel, instead of opening, writing and
//! committing every file over SFTP.
//!
//! What this mode can promise, and what it cannot (R2 — the UI text and these
//! comments are the whole contract):
//!
//! | | |
//! |---|---|
//! | Replaces | the remote tar extraction; nothing is committed per file |
//! | Scope | one folder upload into a target directory that is absent or empty |
//! | Conflict detection | none. `tar -k` refuses to overwrite, and only when the remote tar supports it; otherwise the mode refuses to run at all |
//! | Resume | none. A retry starts the whole folder again |
//! | Atomicity | none. Cancelling leaves every file tar had already extracted |
//! | Progress | locally packed bytes and files, not what reached the server's disk |
//! | Journal | "in progress" and "finished" only; no per-file checkpoints |
//!
//! The remote needs a POSIX shell and `tar`. A Windows OpenSSH server whose
//! shell is cmd or PowerShell is refused with an error rather than attempted.
//!
//! File names are written as UTF-8 inside PAX extended headers, so a server
//! whose locale is not UTF-8 stores them mangled. That is a documented
//! boundary of this first version, not something the probe rules out.

use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, UNIX_EPOCH};

use russh::client::Msg;
use russh::{Channel, ChannelMsg};
use tokio::io::{AsyncReadExt, AsyncWrite, AsyncWriteExt};

use super::{Control, Failure, Item, Job, TransferResult};
use crate::diagnostics::Request;
use crate::model::SessionKind;
use crate::session::auth::AuthPrompter;
use crate::session::ssh::{connect_sftp, SftpConnectOutcome, SharedTransport};
use crate::session::transfer::{plan_local_upload_checked, UploadJob};

#[cfg(test)]
#[path = "tar_tests.rs"]
mod tests;

/// How long the remote gets to finish extracting once the archive is in.
/// `tar` on a slow disk can outlast a generous channel timeout, so this only
/// bounds a remote that stopped talking altogether.
const EXTRACT_SETTLE: Duration = Duration::from_secs(60);
/// How much of a local file is packed per read.
const PACK_BUFFER: usize = 256 * 1024;

/// One 512-byte tar block.
const BLOCK: usize = 512;
/// The record size `tar` writes by default; the archive is padded to it.
const RECORD: usize = 10 * BLOCK;
/// How many bytes a ustar `name` field holds.
const NAME_LIMIT: usize = 100;
/// The ustar magic and version every header carries.
const MAGIC: &[u8; 6] = b"ustar\0";
const VERSION: &[u8; 2] = b"00";
const ZERO: [u8; RECORD] = [0; RECORD];
/// The largest value a 12-byte octal field holds (0o77777777777).
pub const USTAR_MAX_SIZE: u64 = 0o7_7777_7777_77;

// --- the archive ------------------------------------------------------------

/// What an archive entry is.
#[derive(Clone, Copy, PartialEq, Eq)]
enum EntryKind {
    File,
    Directory,
    /// A PAX extended header (typeflag `x`), which carries the records a
    /// ustar header cannot hold.
    Extended,
}

impl EntryKind {
    fn typeflag(self) -> u8 {
        match self {
            EntryKind::File => b'0',
            EntryKind::Directory => b'5',
            EntryKind::Extended => b'x',
        }
    }
}

/// A minimal ustar writer: 512-byte headers, and a PAX extended header in
/// front of an entry whose name does not fit a ustar field, is not ASCII, or
/// whose size is above the octal limit.
struct UstarWriter<W> {
    sink: W,
    /// Body bytes of the entry being written.
    body: u64,
    /// Body bytes of that entry that have not arrived yet.
    pending: u64,
    /// Every byte written so far, headers and padding included.
    total: u64,
    /// The job's rate budget and stop signal; `None` in the unit tests.
    /// Every byte of the archive — headers, PAX records, bodies, padding
    /// and the trailing blocks — goes through it, so a tree of empty files
    /// is paced as much as one large file.
    gate: Option<(Arc<super::Pacer>, Arc<Control>)>,
}

impl<W: AsyncWrite + Unpin> UstarWriter<W> {
    fn new(sink: W) -> Self {
        Self {
            sink,
            body: 0,
            pending: 0,
            total: 0,
            gate: None,
        }
    }

    fn paced(sink: W, job: &Job) -> Self {
        Self {
            gate: job.pacer.clone().map(|pacer| (pacer, job.control.clone())),
            ..Self::new(sink)
        }
    }

    /// Charges `bytes` against the rate budget immediately before they go
    /// on the wire. Every byte of the archive — headers, PAX records,
    /// bodies, padding and the trailing blocks — goes through here, so a
    /// tree of empty files is paced as much as one large file. An
    /// interrupted charge takes nothing; bytes already written stay paid.
    async fn send(&mut self, bytes: &[u8]) -> TransferResult<()> {
        if let Some((pacer, control)) = &self.gate {
            super::paced(pacer, control, bytes.len() as u64).await?;
        }
        self.sink.write_all(bytes).await.map_err(Failure::from)
    }

    /// Writes a directory entry. Its mode and mtime are the local
    /// directory's, so an empty folder survives the round trip.
    async fn directory(&mut self, name: &str, mode: u32, mtime: u64) -> TransferResult<()> {
        self.entry(&format!("{name}/"), EntryKind::Directory, 0, mode, mtime)
            .await
    }

    /// Writes the header of a regular-file entry; its `size` bytes of content
    /// follow through [`UstarWriter::write`].
    async fn file(&mut self, name: &str, size: u64, mode: u32, mtime: u64) -> TransferResult<()> {
        self.entry(name, EntryKind::File, size, mode, mtime).await
    }

    async fn entry(
        &mut self,
        name: &str,
        kind: EntryKind,
        size: u64,
        mode: u32,
        mtime: u64,
    ) -> TransferResult<()> {
        if self.pending != 0 {
            return Err(Failure::local(
                "the previous archive entry was never finished",
            ));
        }
        let header = header_bytes(name, kind, size, mode, mtime)?;
        self.send(&header).await?;
        self.total += header.len() as u64;
        self.body = 0;
        self.pending = if kind == EntryKind::File { size } else { 0 };
        if self.pending == 0 {
            self.pad().await?;
        }
        Ok(())
    }

    /// Appends content bytes of the entry [`UstarWriter::file`] opened.
    async fn write(&mut self, bytes: &[u8]) -> TransferResult<()> {
        if bytes.len() as u64 > self.pending {
            return Err(Failure::local(
                "archive entry is longer than its header declares",
            ));
        }
        self.send(bytes).await?;
        self.total += bytes.len() as u64;
        self.body += bytes.len() as u64;
        self.pending -= bytes.len() as u64;
        if self.pending == 0 {
            self.pad().await?;
        }
        Ok(())
    }

    /// Pads the entry just written to a whole block.
    async fn pad(&mut self) -> TransferResult<()> {
        let slack = (BLOCK - (self.body as usize % BLOCK)) % BLOCK;
        if slack > 0 {
            self.send(&ZERO[..slack]).await?;
            self.total += slack as u64;
        }
        self.body = 0;
        Ok(())
    }

    /// Ends the archive: two zero blocks, then the rest of the record `tar`
    /// writes by default. A reader stops at the two zero blocks either way.
    async fn finish(mut self) -> TransferResult<()> {
        if self.pending != 0 {
            return Err(Failure::local("the last archive entry was never finished"));
        }
        self.send(&ZERO[..2 * BLOCK]).await?;
        self.total += 2 * BLOCK as u64;
        let slack = (RECORD - (self.total as usize % RECORD)) % RECORD;
        if slack > 0 {
            self.send(&ZERO[..slack]).await?;
        }
        self.sink.flush().await.map_err(Failure::from)?;
        Ok(())
    }
}

/// The bytes one entry's headers occupy, always a whole number of blocks: a
/// PAX extended header first when the ustar fields cannot hold the entry,
/// then the ustar header itself.
fn header_bytes(
    name: &str,
    kind: EntryKind,
    size: u64,
    mode: u32,
    mtime: u64,
) -> TransferResult<Vec<u8>> {
    let mut records = Vec::new();
    // A name that does not fit, or that is not ASCII, goes in whole: the ustar
    // `prefix` field can carry neither, and a truncated name would be
    // extracted under the wrong name on a server that ignores PAX.
    if name.len() >= NAME_LIMIT || !name.is_ascii() {
        records.push(("path".to_string(), name.to_string()));
    }
    if size > USTAR_MAX_SIZE {
        records.push(("size".to_string(), size.to_string()));
    }
    let mut out = Vec::new();
    if !records.is_empty() {
        let mut body = Vec::new();
        for (key, value) in &records {
            body.extend_from_slice(&pax_record(key, value));
        }
        let extended = ustar_header("PaxHeaders", EntryKind::Extended, body.len() as u64, 0, 0)?;
        out.extend_from_slice(&extended);
        out.extend_from_slice(&body);
        pad_bytes(&mut out);
    }
    // A size above the octal limit is carried by the PAX record; the ustar
    // field holds zero rather than a value no reader could trust.
    let stored = if size > USTAR_MAX_SIZE { 0 } else { size };
    out.extend_from_slice(&ustar_header(name, kind, stored, mode, mtime)?);
    Ok(out)
}

/// One `"<length> <key>=<value>\n"` PAX record. The length counts the whole
/// record, its own digits included, so it is solved until the digit count
/// stops moving.
fn pax_record(key: &str, value: &str) -> Vec<u8> {
    let fixed = 1 + key.len() + 1 + value.len() + 1;
    let mut length = fixed;
    loop {
        let next = length.to_string().len() + fixed;
        if next == length {
            break;
        }
        length = next;
    }
    format!("{length} {key}={value}\n").into_bytes()
}

/// Builds one 512-byte ustar header. A `name` that does not fit is stored as
/// a prefix cut at a character boundary: a PAX record already carries it in
/// full, and readers take it from there.
fn ustar_header(
    name: &str,
    kind: EntryKind,
    size: u64,
    mode: u32,
    mtime: u64,
) -> TransferResult<[u8; BLOCK]> {
    let mut block = [0u8; BLOCK];
    let bytes = name.as_bytes();
    if bytes.len() >= NAME_LIMIT {
        let mut end = NAME_LIMIT - 1;
        while !name.is_char_boundary(end) {
            end -= 1;
        }
        block[..end].copy_from_slice(&bytes[..end]);
    } else {
        block[..bytes.len()].copy_from_slice(bytes);
    }
    if !octal(&mut block[100..108], u64::from(mode))
        || !octal(&mut block[108..116], 0)
        || !octal(&mut block[116..124], 0)
        || !octal(&mut block[124..136], size)
        || !octal(&mut block[136..148], mtime)
    {
        return Err(Failure::local("archive entry does not fit a ustar field"));
    }
    block[156] = kind.typeflag();
    block[257..263].copy_from_slice(MAGIC);
    block[263..265].copy_from_slice(VERSION);
    // The checksum is taken with its own field read as eight spaces.
    block[148..156].copy_from_slice(&[b' '; 8]);
    let sum: u32 = block.iter().map(|byte| u32::from(*byte)).sum();
    let text = format!("{sum:06o}");
    block[148..154].copy_from_slice(text.as_bytes());
    block[154] = 0;
    block[155] = b' ';
    Ok(block)
}

/// Writes `value` as NUL-terminated octal into `field`. `false` when it does
/// not fit, which is the caller's cue to use a PAX record instead.
fn octal(field: &mut [u8], value: u64) -> bool {
    let digits = field.len() - 1;
    let text = format!("{value:0digits$o}");
    if text.len() > digits {
        return false;
    }
    field[..digits].copy_from_slice(text.as_bytes());
    field[digits] = 0;
    true
}

/// Pads `bytes` to a whole block.
fn pad_bytes(bytes: &mut Vec<u8>) {
    let slack = (BLOCK - (bytes.len() % BLOCK)) % BLOCK;
    bytes.extend_from_slice(&ZERO[..slack]);
}

/// The permission bits a local path carries, for its archive entry. Windows
/// has no mode, so a read-only file is 0444 and everything else is 0644.
#[cfg(unix)]
fn mode_of(metadata: &std::fs::Metadata) -> u32 {
    use std::os::unix::fs::PermissionsExt;
    metadata.permissions().mode() & 0o7777
}
#[cfg(not(unix))]
fn mode_of(metadata: &std::fs::Metadata) -> u32 {
    if metadata.permissions().readonly() {
        0o444
    } else {
        0o644
    }
}

/// The modification time of a local path as whole seconds since the epoch, or
/// 0 when the platform cannot say. A time beyond what a 12-byte octal field
/// holds is clamped rather than dropped.
fn mtime_of(metadata: &std::fs::Metadata) -> u64 {
    metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|since| since.as_secs().min(USTAR_MAX_SIZE))
        .unwrap_or(0)
}

// --- the remote probe -------------------------------------------------------

/// Prefix of every line the probe script prints, so anything a login shell's
/// rc file writes cannot be mistaken for an answer.
const MARKER: &str = "EDGETERM-TAR";

/// What shell the command ran in.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Shell {
    Posix,
    Windows,
    Unknown,
}

/// The state of the destination directory on the server.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Target {
    /// There is nothing there yet.
    Absent,
    /// There, and empty.
    Empty,
    /// There, and holding something.
    NonEmpty,
    /// There, but it is not a directory.
    NotADirectory,
    /// There, and this login cannot list it.
    Unreadable,
}

/// What the probe answered.
#[derive(Clone, Debug)]
pub struct Probe {
    /// Where `command -v tar` found tar, or `None` when there is none.
    pub tar: Option<String>,
    /// Whether the remote tar refuses to overwrite an existing file.
    pub keep_old_files: bool,
    pub shell: Shell,
    pub target: Target,
}

/// Why the run falls back to the per-file SFTP path.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Reason {
    /// The server has no tar.
    NoTar,
    /// The target is not empty and this is a retry, so whatever the previous
    /// attempt extracted is left for the per-file path to reconcile by
    /// signature rather than being extracted over again.
    PartialTarget,
}

/// What the run may do with what the probe answered.
#[derive(Clone, PartialEq, Eq, Debug)]
pub enum Decision {
    /// Stream the folder into the remote tar at `tar`.
    Stream { tar: String },
    /// Do not stream; use the per-file path, for `reason`.
    PerFile { reason: Reason },
}

/// Reads the probe script's answer out of what the exec channel returned.
///
/// Every answer is one marker line; anything else — a login banner, a shell
/// warning — is ignored. A command that produced no marker line at all is a
/// failure, not an empty answer: that is what a server with no POSIX shell
/// looks like.
pub fn parse_probe(stdout: &str, stderr: &str, exit_status: Option<u32>) -> TransferResult<Probe> {
    let mut probe = Probe {
        tar: None,
        keep_old_files: false,
        shell: Shell::Unknown,
        target: Target::Absent,
    };
    let mut answered = false;
    for line in stdout.lines() {
        let Some(rest) = line.strip_prefix(MARKER) else {
            continue;
        };
        match rest.as_bytes().first() {
            // The path `command -v tar` found.
            Some(b' ') => {
                let path = rest[1..].trim();
                answered = true;
                if !path.is_empty() && path != "none" {
                    probe.tar = Some(path.to_string());
                }
            }
            Some(b'-') => {
                let Some((key, value)) = rest[1..].split_once(' ') else {
                    continue;
                };
                answered = true;
                match (key, value) {
                    ("KEEP", "yes") => probe.keep_old_files = true,
                    ("KEEP", "no") => {}
                    ("SHELL", "posix") => probe.shell = Shell::Posix,
                    ("SHELL", "windows") => probe.shell = Shell::Windows,
                    ("SHELL", "unknown") => {}
                    ("TARGET", "absent") => probe.target = Target::Absent,
                    ("TARGET", "0") => probe.target = Target::Empty,
                    ("TARGET", "1") => probe.target = Target::NonEmpty,
                    ("TARGET", "file") => probe.target = Target::NotADirectory,
                    ("TARGET", "unreadable") => probe.target = Target::Unreadable,
                    _ => {}
                }
            }
            _ => {}
        }
    }
    if !answered {
        let detail = stderr.trim();
        let status = match exit_status {
            Some(code) => format!(" and exited with status {code}"),
            None => " and closed the channel without a status".to_string(),
        };
        let detail = if detail.is_empty() {
            String::new()
        } else {
            format!(" ({detail})")
        };
        return Err(Failure::new(
            "unsupported",
            format!(
                "the server did not answer the tar probe{status}{detail}; tar streaming needs a POSIX shell, and a Windows OpenSSH server whose shell is cmd or PowerShell has none"
            ),
            false,
        ));
    }
    Ok(probe)
}

/// Turns what the probe answered into what the run may do. `attempt` is the
/// job's attempt number, so a retry that finds its own partial extraction in
/// the target can hand the folder to the per-file path instead of refusing.
///
/// Everything here refuses rather than guesses: a target that already holds
/// something is never extracted over, and a tar that cannot be told to keep
/// old files is never used without it.
pub fn decide(probe: &Probe, attempt: usize) -> TransferResult<Decision> {
    if probe.shell == Shell::Windows {
        return Err(Failure::new(
            "unsupported",
            "the server's shell is Windows (cmd or PowerShell); tar streaming needs a POSIX shell, so this folder upload uses the per-file path",
            false,
        ));
    }
    match probe.target {
        Target::NonEmpty if attempt > 1 => {
            return Ok(Decision::PerFile {
                reason: Reason::PartialTarget,
            })
        }
        Target::NonEmpty => {
            return Err(Failure::conflict(
                "the target directory is not empty; tar streaming never extracts over existing files — clear it, or turn tar streaming off",
            ))
        }
        Target::NotADirectory => {
            return Err(Failure::conflict(
                "the target exists and is not a directory; tar streaming can only extract into a folder",
            ))
        }
        Target::Unreadable => {
            return Err(Failure::conflict(
                "the target directory cannot be listed, so it cannot be shown to be empty; tar streaming never extracts into a folder it cannot check",
            ))
        }
        Target::Absent | Target::Empty => {}
    }
    let Some(tar) = probe.tar.clone() else {
        return Ok(Decision::PerFile {
            reason: Reason::NoTar,
        });
    };
    if !probe.keep_old_files {
        return Err(Failure::new(
            "unsupported",
            format!(
                "{tar} cannot be told to keep existing files, so tar streaming cannot promise it will not overwrite; turn it off, or use a tar with -k / --keep-old-files"
            ),
            false,
        ));
    }
    Ok(Decision::Stream { tar })
}

/// The probe script. It is fed to `sh` on stdin, the way
/// `session::ssh::remote_cwd` asks for a working directory, so the user's
/// login shell never has to parse it. Four marker lines come back: where tar
/// is, whether it can keep old files, what shell this is, and whether the
/// destination directory is free.
fn probe_script(directory: &str) -> String {
    let dir = quote(directory);
    format!(
        r#"if command -v tar >/dev/null 2>&1; then
  printf 'EDGETERM-TAR %s\n' "$(command -v tar)"
  if tar --help 2>/dev/null | grep -q -- '--keep-old-files'; then
    printf 'EDGETERM-TAR-KEEP yes\n'
  else
    printf 'EDGETERM-TAR-KEEP no\n'
  fi
else
  printf 'EDGETERM-TAR none\n'
fi
case "$(uname -s 2>/dev/null)" in
  MINGW*|MSYS*|CYGWIN*|Windows*) printf 'EDGETERM-TAR-SHELL windows\n' ;;
  '') printf 'EDGETERM-TAR-SHELL unknown\n' ;;
  *) printf 'EDGETERM-TAR-SHELL posix\n' ;;
esac
if [ -d {dir} ]; then
  if [ ! -r {dir} ] || [ ! -x {dir} ]; then
    printf 'EDGETERM-TAR-TARGET unreadable\n'
  else
    found=0
    for entry in {dir}/* {dir}/.[!.]* {dir}/..?*; do
      if [ -e "$entry" ] || [ -L "$entry" ]; then found=1; break; fi
    done
    printf 'EDGETERM-TAR-TARGET %s\n' "$found"
  fi
elif [ -e {dir} ] || [ -L {dir} ]; then
  printf 'EDGETERM-TAR-TARGET file\n'
else
  printf 'EDGETERM-TAR-TARGET absent\n'
fi
"#
    )
}

/// Wraps a value in single quotes for a POSIX shell, escaping the ones it
/// already holds. A remote path is untrusted input for the script that runs
/// on the server, exactly as it is for the sftp path.
fn quote(value: &str) -> String {
    let mut out = String::with_capacity(value.len() + 2);
    out.push('\'');
    for character in value.chars() {
        if character == '\'' {
            out.push_str("'\\''");
        } else {
            out.push(character);
        }
    }
    out.push('\'');
    out
}

// --- the run ----------------------------------------------------------------

/// Whether `run_job` sends this job down the tar path. FTP has no exec
/// channel to run a remote tar on, so it never does.
pub fn wants_tar(job: &Job) -> bool {
    job.options.tar && job.profile.kind != SessionKind::Ftp
}

/// The one folder upload tar streaming covers, or a refusal naming what the
/// batch actually is.
fn single_directory_upload(job: &Job) -> TransferResult<&Item> {
    let [item] = job.items.as_slice() else {
        return Err(Failure::local(format!(
            "tar streaming uploads one folder at a time; this batch has {} items",
            job.items.len()
        )));
    };
    if !item.upload {
        return Err(Failure::local(
            "tar streaming uploads only; this batch downloads",
        ));
    }
    if !item.directory && !Path::new(&item.local).is_dir() {
        return Err(Failure::local(format!(
            "tar streaming uploads a folder; {} is not one",
            item.local
        )));
    }
    Ok(item)
}

/// The transport the job runs on, the way `sftp::Remote::connect` obtains it:
/// the one the session already holds, or a freshly authenticated one.
async fn connect(job: &Arc<Job>) -> TransferResult<Arc<SharedTransport>> {
    job.control.check()?;
    job.phase("connecting");
    let existing = job.transport.lock().clone();
    let transport = match existing {
        Some(transport) => transport,
        None => {
            let prompt = AuthPrompter::background();
            let request = Request::begin("transfer_connect")
                .with_session(&job.session_id)
                .with_transfer(&job.id);
            let conn = job
                .control
                .run(async {
                    connect_sftp(&job.profile, &job.jumps, &prompt, &request)
                        .await
                        .map_err(Failure::connection)
                })
                .await?;
            match conn {
                SftpConnectOutcome::Ready(conn) => conn.transport(),
                SftpConnectOutcome::HostKeyChanged(_) => {
                    return Err(Failure::new(
                        "hostKey",
                        "host key changed; reconnect the session and review its host key before retrying",
                        false,
                    ))
                }
            }
        }
    };
    *job.transport.lock() = Some(transport.clone());
    Ok(transport)
}

/// Streams one folder into a remote `tar`.
pub async fn run(job: &Arc<Job>) -> TransferResult<()> {
    let item = single_directory_upload(job)?;
    let transport = connect(job).await?;
    job.phase("probing remote tar");
    let mut channel = command_channel(&transport).await?;
    let probe = {
        let script = probe_script(&item.remote);
        let answer = run_script(&job.control, &mut channel, &script).await;
        // The probe has its own channel; a plain channel is not closed on
        // drop, so leaving it open would leak a server-side session.
        let _ = channel.close().await;
        let answer = answer?;
        parse_probe(
            &String::from_utf8_lossy(&answer.stdout),
            &String::from_utf8_lossy(&answer.stderr),
            answer.exit_status,
        )?
    };
    let attempt = job.snapshot.lock().attempt;
    match decide(&probe, attempt)? {
        // A fallback, not a failure: say so in the phase and let the per-file
        // path do the work.
        Decision::PerFile { reason } => {
            job.phase(match reason {
                Reason::NoTar => "per-file mode: the server has no tar",
                Reason::PartialTarget => {
                    "per-file mode: the target already holds what the last attempt extracted"
                }
            });
            return super::sftp::run(job).await;
        }
        Decision::Stream { tar } => {
            stream(job, &transport, &tar, Path::new(&item.local), &item.remote).await
        }
    }
}

/// Extracts the archive on the server and feeds it from its own task, so a
/// folder larger than a channel window is packed while the remote is still
/// reading.
async fn stream(
    job: &Arc<Job>,
    transport: &SharedTransport,
    tar: &str,
    root: &Path,
    dest: &str,
) -> TransferResult<()> {
    job.phase("tar streaming");
    let mut channel = command_channel(transport).await?;
    // `-k` keeps an existing file rather than replacing it, which is the only
    // thing standing between this mode and silently overwriting a target the
    // probe called free a moment ago.
    let command = format!(
        "mkdir -p -- {dir} && exec {tar} -xkf - -C {dir}",
        dir = quote(dest),
    );
    channel
        .exec(true, command)
        .await
        .map_err(Failure::network)?;
    // `make_writer` clones the channel's sender, so it neither borrows the
    // channel nor needs the `Channel` that `wait` does.
    let sink = channel.make_writer();
    let mut packer = {
        let job = job.clone();
        let root = root.to_path_buf();
        let dest = dest.to_string();
        tokio::spawn(async move { pack(sink, &job, &root, &dest).await })
    };
    // The archive is packed while the remote reads it, so the remote's answer
    // is only bounded once the archive is in: a large folder takes as long to
    // pack as it takes, and that is not the remote's fault.
    let (answer, packed) = tokio::select! {
        biased;
        packed = &mut packer => {
            let packed = packed.unwrap_or_else(|_| {
                Err(Failure::local("packing ended before the archive was sent"))
            });
            let answer =
                tokio::time::timeout(EXTRACT_SETTLE, read_command(&job.control, &mut channel)).await;
            (answer, packed)
        }
        answer = read_command(&job.control, &mut channel) => {
            // A pause or a cancel outranks whatever the remote said; the
            // packer is stopped along with the channel below.
            let packed = match &answer {
                Err(e) if e.stopped() => Err(e.clone()),
                _ => Err(Failure::local(
                    "the remote stopped reading before the archive was sent",
                )),
            };
            (Ok(answer), packed)
        }
    };
    // A plain channel is not closed on drop; leaving it open would leak a
    // server-side session on every attempt. Closing it is also what ends the
    // remote tar when the user cancelled: it loses its input and stops, and
    // every file it had already extracted stays on the server.
    let _ = channel.close().await;
    packer.abort();
    // A pause or a cancel the user asked for outranks whatever the remote said.
    if packed.as_ref().err().is_some_and(Failure::stopped) {
        return packed;
    }
    match answer {
        Ok(Ok(answer)) if answer.exit_status == Some(0) => packed,
        Ok(Ok(answer)) => Err(Failure::new("remote", remote_message(&answer), false)),
        Ok(Err(e)) => Err(e),
        Err(_) => Err(Failure::new(
            "timeout",
            "the remote tar did not finish extracting in time; the files it had already extracted stay on the server",
            false,
        )),
    }
}

/// What to tell the user about a remote command that did not succeed. Only the
/// tail of its output is kept: tar's cause is the last thing it writes.
fn remote_message(answer: &Command) -> String {
    let detail = String::from_utf8_lossy(&answer.stderr);
    let detail = detail.trim();
    let detail = if detail.len() > 400 {
        &detail[detail.len() - 400..]
    } else {
        detail
    };
    let detail = if detail.is_empty() {
        String::new()
    } else {
        format!(" ({detail})")
    };
    match answer.exit_status {
        Some(code) => format!("the remote tar exited with status {code}{detail}"),
        None => format!("the remote tar closed the channel before finishing{detail}"),
    }
}

/// Packs the folder into `sink` as a ustar archive.
///
/// Progress is reported by locally packed bytes and files. It says nothing
/// about what the server has on disk: tar may still be extracting, and a file
/// counted here is not a file committed there.
async fn pack<W: AsyncWrite + Unpin>(
    mut sink: W,
    job: &Arc<Job>,
    root: &Path,
    dest: &str,
) -> TransferResult<()> {
    let control = job.control.clone();
    let plan_root = root.to_path_buf();
    let plan_dest = dest.to_string();
    let plan = tokio::task::spawn_blocking(move || {
        plan_local_upload_checked(&plan_root, &plan_dest, || {
            control.check().map_err(Into::into)
        })
    })
    .await
    .map_err(Failure::local)?
    .map_err(Failure::local)?;
    // Progress keys are the per-file items the plan produced, so the Transfers
    // panel counts the same files the per-file path would.
    let keys: Vec<(String, u64)> = plan
        .files
        .iter()
        .map(|file| (file_key(job, file), file.size))
        .collect();
    for (key, size) in &keys {
        job.progress(key, 0, *size, false);
    }
    let mut writer = UstarWriter::paced(&mut sink, job);
    // The destination directory itself is `tar -C`'s target, not an entry;
    // every other directory is written so an empty folder and its mode
    // survive. Parents come before their children in the plan.
    for directory in &plan.directories {
        job.control.check()?;
        let Some(name) = archive_name(directory, &dest)? else {
            continue;
        };
        // The plan names remote paths; the local folder is the same relative
        // path under the root that was uploaded.
        let metadata = std::fs::metadata(root.join(&name));
        let (mode, mtime) = match &metadata {
            Ok(metadata) => (mode_of(metadata), mtime_of(metadata)),
            // A folder that vanished mid-pack has no mode worth keeping; the
            // files under it will fail on their own if they are gone too.
            Err(_) => (0o755, 0),
        };
        writer.directory(&name, mode, mtime).await?;
    }
    for (file, (key, size)) in plan.files.iter().zip(&keys) {
        job.control.check()?;
        let Some(name) = archive_name(&file.remote, &dest)? else {
            continue;
        };
        let mut source = tokio::fs::File::open(&file.local)
            .await
            .map_err(Failure::local)?;
        let metadata = source.metadata().await.map_err(Failure::local)?;
        if metadata.len() != *size {
            return Err(Failure::conflict(format!(
                "{} changed size while it was being packed",
                file.local.display()
            )));
        }
        writer
            .file(&name, *size, mode_of(&metadata), mtime_of(&metadata))
            .await?;
        let mut packed_bytes = 0u64;
        let mut buffer = vec![0u8; PACK_BUFFER];
        while packed_bytes < *size {
            let read = source.read(&mut buffer).await.map_err(Failure::local)?;
            if read == 0 {
                break;
            }
            let take = read.min((*size - packed_bytes) as usize);
            writer.write(&buffer[..take]).await?;
            packed_bytes += take as u64;
            job.progress(key, packed_bytes, *size, false);
        }
        if packed_bytes != *size {
            return Err(Failure::conflict(format!(
                "{} changed while it was being packed",
                file.local.display()
            )));
        }
        job.progress(key, *size, *size, true);
    }
    writer.finish().await?;
    // The end of the archive is what tells the remote tar it has everything.
    sink.shutdown().await.map_err(Failure::from)?;
    Ok(())
}

/// The progress key of one planned file: the item the per-file path would
/// have made for it, so a job that falls back keeps the same keys.
fn file_key(job: &Job, file: &UploadJob) -> String {
    job.key(&Item {
        local: file.local.to_string_lossy().into(),
        remote: file.remote.clone(),
        upload: true,
        directory: false,
    })
}

/// The name an entry carries inside the archive: its path relative to the
/// destination directory, which is where `tar -C` will put it. `Ok(None)` for
/// the destination directory itself.
fn archive_name(remote: &str, root: &str) -> TransferResult<Option<String>> {
    let Some(rest) = remote.strip_prefix(root) else {
        return Err(Failure::local(format!(
            "{remote} is not inside {root}, so it cannot be named in the archive"
        )));
    };
    let rest = rest.strip_prefix('/').unwrap_or(rest);
    // A trailing separator is the destination directory itself, not an entry.
    let rest = rest.trim_end_matches('/');
    if rest.is_empty() {
        return Ok(None);
    }
    if rest.starts_with('/') || rest.split('/').any(|part| part == "..") {
        return Err(Failure::local(format!(
            "{remote} does not name a safe archive entry"
        )));
    }
    Ok(Some(rest.to_string()))
}

// --- the exec channel -------------------------------------------------------

/// What one remote command wrote.
struct Command {
    stdout: Vec<u8>,
    stderr: Vec<u8>,
    exit_status: Option<u32>,
}

/// Opens the channel a remote command runs on.
///
/// A plain session channel of the transport, with no subsystem requested: the
/// exec request this module puts on it is the channel's whole purpose, exactly
/// as `session::ssh::remote_cwd` uses one for the working-directory query.
async fn command_channel(transport: &SharedTransport) -> TransferResult<Channel<Msg>> {
    transport.command_channel().await.map_err(Failure::network)
}

/// Feeds `script` to `sh` on the server and waits for it to finish. The
/// script goes in on stdin, the way `session::ssh::remote_cwd` asks for a
/// working directory, so the user's login shell never has to parse it.
async fn run_script(
    control: &Control,
    channel: &mut Channel<Msg>,
    script: &str,
) -> TransferResult<Command> {
    channel.exec(true, "sh").await.map_err(Failure::network)?;
    channel
        .data_bytes(script.as_bytes().to_vec())
        .await
        .map_err(Failure::network)?;
    channel.eof().await.map_err(Failure::network)?;
    read_command(control, channel).await
}

/// Collects a remote command's output until the channel ends. OpenSSH sends
/// exit-status before eof and close, but not every server keeps that order;
/// close (or a dropped channel) is the end either way.
///
/// A pause or a cancel stops the wait at once, so the caller can close the
/// channel and take the remote down with it.
async fn read_command(control: &Control, channel: &mut Channel<Msg>) -> TransferResult<Command> {
    let mut command = Command {
        stdout: Vec::new(),
        stderr: Vec::new(),
        exit_status: None,
    };
    loop {
        tokio::select! {
            biased;
            _ = control.stopped() => control.check()?,
            msg = channel.wait() => match msg {
                Some(ChannelMsg::Data { data }) => command.stdout.extend_from_slice(&data),
                Some(ChannelMsg::ExtendedData { data, .. }) => {
                    command.stderr.extend_from_slice(&data)
                }
                Some(ChannelMsg::ExitStatus { exit_status }) => {
                    command.exit_status = Some(exit_status)
                }
                Some(ChannelMsg::Close) | Some(ChannelMsg::Eof) | None => break,
                Some(_) => {}
            },
        }
    }
    Ok(command)
}
