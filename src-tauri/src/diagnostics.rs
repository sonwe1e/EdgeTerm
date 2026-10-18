//! File-based diagnostics built on `tracing`.
//!
//! Every operation a user starts through the front end becomes a [`Request`]:
//! one id shared by the start event, every stage in between and the end event,
//! so a failure report reads as one story and can be traced across the
//! connection, authentication and remote-write stages. The log lives in the
//! application data directory's `logs/` (see [`logs_dir`]), rotates daily and
//! is capped in file count and total size by [`BoundedLogWriter`]. Segments
//! roll over at midnight or 2 MiB, on the background writer thread.
//!
//! What must never appear in a log line: passwords, passphrases, private key
//! material, terminal output and file contents. Call sites pass identifiers
//! and stage names only; someone adding a field should stop and ask whether it
//! can carry a secret.
//!
//! Writing is best-effort by design: [`init`] reports failure to stderr and
//! leaves the app running without a subscriber, the writer is non-blocking,
//! and a full disk only loses the affected line.

use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::time::Instant;

use tracing_appender::non_blocking::WorkerGuard;
use tracing_subscriber::EnvFilter;

use crate::error::Result;

/// Maximum number of log segments retained.
const MAX_LOG_FILES: usize = 5;
/// Total retained size; an oversized legacy file may be removed on startup.
const MAX_LOG_BYTES: u64 = 8 * 1024 * 1024;
/// Prefix shared by legacy daily files and new timestamped segments.
const FILE_NAME: &str = "edgeterm.log";

/// Where the log files live: the same data directory as `sessions.json`, so
/// portable mode takes them along.
pub fn logs_dir() -> PathBuf {
    crate::store::data_dir().join("logs")
}

/// Cap on how much log text the diagnostics export carries; the newest end is
/// what matters and older lines are summarized away.
const EXPORT_TAIL_BYTES: usize = 256 * 1024;

/// The diagnostics report: what this build is, where its logs live and a
/// bounded tail of the newest log text. Built separately from writing it so a
/// test can check exactly what a user would hand to support.
pub fn report() -> String {
    report_from(&logs_dir())
}

fn report_from(dir: &Path) -> String {
    let mut report = String::new();
    report.push_str("EdgeTerm diagnostics\n");
    report.push_str(&format!(
        "generated: {}\n",
        chrono::Local::now().format("%Y-%m-%d %H:%M:%S %z")
    ));
    report.push_str(&format!("version: {}\n", env!("CARGO_PKG_VERSION")));
    report.push_str(&format!(
        "os: {} {}\n",
        std::env::consts::OS,
        std::env::consts::ARCH
    ));
    report.push_str(&format!("log directory: {}\n", dir.display()));
    let files = log_files(dir);
    if files.is_empty() {
        report.push_str("log files: none\n");
    }
    for (path, size) in &files {
        report.push_str(&format!(
            "log file: {} ({size} bytes)\n",
            path.file_name().unwrap_or_default().to_string_lossy()
        ));
    }
    let (tail, truncated) = log_tail(&files);
    report.push_str(&format!(
        "\n--- log tail ({}) ---\n",
        match truncated {
            true => format!("newest {EXPORT_TAIL_BYTES} bytes; older lines omitted"),
            false => "complete".to_string(),
        }
    ));
    report.push_str(&tail);
    report
}

/// The log files with their sizes, oldest first. Only the app's own
/// `edgeterm.log*` files count; anything else in the directory is left out of
/// both the listing and the tail.
fn log_files(dir: &Path) -> Vec<(PathBuf, u64)> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut files: Vec<(PathBuf, u64)> = entries
        .flatten()
        .filter(|entry| entry.file_name().to_string_lossy().starts_with(FILE_NAME))
        .filter_map(|entry| {
            let data = entry.metadata().ok()?;
            data.is_file().then(|| (entry.path(), data.len()))
        })
        .collect();
    files.sort();
    files
}

/// The newest [`EXPORT_TAIL_BYTES`] of log text, oldest line first, plus
/// whether anything was dropped. A file longer than the budget contributes
/// only its newest bytes, and the first partial line is cut.
fn log_tail(files: &[(PathBuf, u64)]) -> (String, bool) {
    let mut remaining = EXPORT_TAIL_BYTES;
    let mut newest_first: Vec<String> = Vec::new();
    let mut truncated = false;
    for (path, _) in files.iter().rev() {
        if remaining == 0 {
            truncated = true;
            break;
        }
        let Ok(mut file) = std::fs::File::open(path) else {
            continue;
        };
        let Ok((content, omitted)) = read_tail(&mut file, remaining) else {
            continue;
        };
        let slice = &content[..];
        // Starting mid-line would expose a partial event; cut to the next one.
        let slice = match omitted {
            true => match slice.iter().position(|byte| *byte == b'\n') {
                Some(newline) => &slice[newline + 1..],
                None => &[],
            },
            false => slice,
        };
        truncated |= omitted;
        // Charge bytes read, including a partial first line, so dropping that
        // line cannot pull older data back into a supposedly newest-only tail.
        remaining = remaining.saturating_sub(content.len());
        newest_first.push(String::from_utf8_lossy(slice).into_owned());
    }
    newest_first.reverse();
    (newest_first.concat(), truncated)
}

fn read_tail(reader: &mut (impl Read + Seek), budget: usize) -> std::io::Result<(Vec<u8>, bool)> {
    let length = reader.seek(SeekFrom::End(0))?;
    let start = length.saturating_sub(budget as u64);
    reader.seek(SeekFrom::Start(start))?;
    let mut bytes = Vec::with_capacity(budget);
    reader.take(budget as u64).read_to_end(&mut bytes)?;
    Ok((bytes, start > 0))
}

/// Installs the global file subscriber. Never fails the app: a directory that
/// cannot be created only disables diagnostics, which is reported on stderr.
pub fn init() {
    let dir = logs_dir();
    match build(&dir) {
        Ok((subscriber, guard)) => {
            if tracing::subscriber::set_global_default(subscriber).is_err() {
                // Another global subscriber already owns the process; leaving
                // it in place keeps the app running.
                return;
            }
            guard_slot().lock().replace(guard);
            tracing::info!(
                version = env!("CARGO_PKG_VERSION"),
                os = std::env::consts::OS,
                arch = std::env::consts::ARCH,
                log_dir = %dir.display(),
                "diagnostics started"
            );
        }
        Err(error) => eprintln!("EdgeTerm: diagnostics are disabled ({error})"),
    }
}

/// Flushes the writer on the way out; called from the app's exit event.
pub fn shutdown() {
    if let Some(slot) = GUARD.get() {
        slot.lock().take();
    }
}

static GUARD: std::sync::OnceLock<parking_lot::Mutex<Option<WorkerGuard>>> =
    std::sync::OnceLock::new();

fn guard_slot() -> &'static parking_lot::Mutex<Option<WorkerGuard>> {
    GUARD.get_or_init(|| parking_lot::Mutex::new(None))
}

/// Builds the file subscriber without installing it, so tests can scope it
/// with `tracing::subscriber::set_default` and several can run in one process.
pub(crate) fn build(dir: &Path) -> std::io::Result<(FileSubscriber, WorkerGuard)> {
    std::fs::create_dir_all(dir)?;
    prune(dir)?;
    let (writer, guard) = tracing_appender::non_blocking(BoundedLogWriter {
        dir: dir.to_owned(),
        file: None,
        size: 0,
        day: String::new(),
    });
    let subscriber = tracing_subscriber::fmt()
        .with_env_filter(filter())
        .with_writer(writer)
        .with_ansi(false)
        .finish();
    Ok((subscriber, guard))
}

/// The concrete subscription `build` produces: full-format events into an
/// `EnvFilter`ed non-blocking file writer.
type FileSubscriber = tracing_subscriber::fmt::Subscriber<
    tracing_subscriber::fmt::format::DefaultFields,
    tracing_subscriber::fmt::format::Format,
    EnvFilter,
    tracing_appender::non_blocking::NonBlocking,
>;

/// `EDGETERM_LOG` overrides the level. The default keeps other crates at
/// `warn` and records this application's own operations at `info`.
fn filter() -> EnvFilter {
    if std::env::var_os("EDGETERM_LOG").is_none() {
        return EnvFilter::new("warn,edgeterm_lib=info");
    }
    EnvFilter::try_from_env("EDGETERM_LOG").unwrap_or_else(|error| {
        eprintln!("EdgeTerm: ignoring the invalid EDGETERM_LOG value ({error})");
        EnvFilter::new("warn,edgeterm_lib=info")
    })
}

/// Keeps the log directory bounded on startup, including a single oversized
/// file. Failure disables the writer instead of allowing unbounded growth.
fn prune(dir: &Path) -> std::io::Result<()> {
    prune_for(dir, 0, 0)
}

fn prune_for(dir: &Path, reserve_bytes: u64, reserve_files: usize) -> std::io::Result<()> {
    let mut files = log_files(dir);
    let mut total: u64 = files.iter().map(|(_, size)| size).sum();
    while !files.is_empty()
        && (files.len() + reserve_files > MAX_LOG_FILES || total + reserve_bytes > MAX_LOG_BYTES)
    {
        let (path, size) = files.remove(0);
        // If housekeeping fails, stop writing rather than pretend space was freed.
        std::fs::remove_file(&path)?;
        total = total.saturating_sub(size);
    }
    Ok(())
}

/// Runs only on tracing-appender's worker. Reserve a whole segment before
/// opening it, bounding disk use during a long-running process as well as at
/// startup. Older daily logs remain readable and participate in the budget.
struct BoundedLogWriter {
    dir: PathBuf,
    file: Option<std::fs::File>,
    size: u64,
    day: String,
}

const LOG_SEGMENT_BYTES: u64 = 2 * 1024 * 1024;

impl Write for BoundedLogWriter {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        if bytes.len() as u64 > LOG_SEGMENT_BYTES {
            // An oversized event must not defeat the disk budget.
            return Ok(bytes.len());
        }
        let now = chrono::Utc::now();
        let day = now.format("%Y-%m-%d").to_string();
        if self.file.is_none()
            || self.day != day
            || self.size + bytes.len() as u64 > LOG_SEGMENT_BYTES
        {
            self.file.take();
            prune_for(&self.dir, LOG_SEGMENT_BYTES, 1)?;
            let name = format!(
                "{FILE_NAME}.{}-{}",
                now.format("%Y-%m-%d.%H%M%S%f"),
                uuid::Uuid::new_v4()
            );
            self.file = Some(
                std::fs::OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .open(self.dir.join(name))?,
            );
            self.size = 0;
            self.day = day;
        }
        let written = self
            .file
            .as_mut()
            .expect("opened log segment")
            .write(bytes)?;
        self.size += written as u64;
        Ok(written)
    }

    fn flush(&mut self) -> std::io::Result<()> {
        match &mut self.file {
            Some(file) => file.flush(),
            None => Ok(()),
        }
    }
}

/// One operation a user started, as a unit of correlation: every event it
/// produces carries the same `request_id`, the operation name and (when the
/// caller knows it) the session id.
///
/// `Begin`/`finish` bracket the operation at the command boundary, while the
/// layers it crosses — dialling, authenticating, opening channels — add
/// `phase` events to the same request. Cloning shares the id and start time,
/// so a spawned worker can keep reporting under the same request.
#[derive(Clone)]
pub struct Request {
    id: std::sync::Arc<str>,
    operation: &'static str,
    session_id: Option<std::sync::Arc<str>>,
    transfer_id: Option<std::sync::Arc<str>>,
    started: Instant,
}

impl Request {
    /// Starts a request and logs its `start` event.
    pub fn begin(operation: &'static str) -> Self {
        let request = Request {
            id: uuid::Uuid::new_v4().simple().to_string().into(),
            operation,
            session_id: None,
            transfer_id: None,
            started: Instant::now(),
        };
        request.info("start", "started");
        request
    }

    /// Names the session this operation belongs to; every event repeats it.
    pub fn with_session(mut self, session_id: impl Into<String>) -> Self {
        self.session_id = Some(session_id.into().into());
        self
    }

    /// Names the file transfer this operation belongs to, when it is one.
    pub fn with_transfer(mut self, transfer_id: impl Into<String>) -> Self {
        self.transfer_id = Some(transfer_id.into().into());
        self
    }

    /// The id correlating this request's log lines.
    pub fn id(&self) -> &str {
        &self.id
    }

    /// A stage of the operation: dialling, authenticating, opening a channel…
    pub fn info(&self, phase: &str, message: impl std::fmt::Display) {
        let message = message.to_string();
        tracing::info!(
            request_id = %self.id,
            operation = self.operation,
            session_id = self.session_id.as_deref().unwrap_or(""),
            transfer_id = self.transfer_id.as_deref().unwrap_or(""),
            phase = %phase,
            "{}",
            message
        );
    }

    /// A stage worth remembering even when the operation succeeds, e.g. a
    /// host-key decision or legacy algorithms.
    pub fn warn(&self, phase: &str, message: impl std::fmt::Display) {
        let message = message.to_string();
        tracing::warn!(
            request_id = %self.id,
            operation = self.operation,
            session_id = self.session_id.as_deref().unwrap_or(""),
            transfer_id = self.transfer_id.as_deref().unwrap_or(""),
            phase = %phase,
            "{}",
            message
        );
    }

    /// Logs the operation's `end` event — duration and outcome — and returns
    /// the result, with the operation name and request id attached to any
    /// error so the failing call itself carries its diagnostics correlation.
    pub fn finish<T>(&self, result: Result<T>) -> Result<T> {
        let result = result.map_err(|error| {
            error
                .with_operation(self.operation)
                .with_request_id(self.id())
        });
        self.record_result(&result);
        result
    }

    /// Records outcomes for domains with their own error type, including
    /// transfer pause/cancel results produced outside the connection future.
    pub fn record_result<T, E: std::fmt::Display>(&self, result: &std::result::Result<T, E>) {
        let duration_ms = self.started.elapsed().as_millis() as u64;
        match result {
            Ok(_) => tracing::info!(
                request_id = %self.id,
                operation = self.operation,
                session_id = self.session_id.as_deref().unwrap_or(""),
                transfer_id = self.transfer_id.as_deref().unwrap_or(""),
                phase = "end",
                duration_ms,
                outcome = "ok",
                "finished"
            ),
            Err(error) => tracing::error!(
                request_id = %self.id,
                operation = self.operation,
                session_id = self.session_id.as_deref().unwrap_or(""),
                transfer_id = self.transfer_id.as_deref().unwrap_or(""),
                phase = "end",
                duration_ms,
                outcome = "error",
                error = %error,
                "failed"
            ),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::AppError;
    use std::time::Duration;

    fn scratch_dir() -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("edgeterm-diagnostics-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn log_files(dir: &Path) -> Vec<String> {
        let mut names: Vec<String> = std::fs::read_dir(dir)
            .unwrap()
            .flatten()
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    }

    fn read_logs(dir: &Path) -> String {
        let mut content = String::new();
        for name in log_files(dir) {
            content.push_str(&std::fs::read_to_string(dir.join(&name)).unwrap_or_default());
        }
        content
    }

    /// The non-blocking writer flushes on its worker thread; poll briefly so
    /// the assertion does not race the flush after the guard is dropped.
    fn wait_for(dir: &Path, needle: &str) -> String {
        for _ in 0..200 {
            let content = read_logs(dir);
            if content.contains(needle) {
                return content;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        read_logs(dir)
    }

    #[test]
    fn prune_drops_the_oldest_files_beyond_the_count_limit() {
        let dir = scratch_dir();
        for day in 1..=MAX_LOG_FILES + 3 {
            std::fs::write(dir.join(format!("{FILE_NAME}.2026-09-{day:02}")), b"line\n").unwrap();
        }
        prune(&dir).unwrap();
        let names = log_files(&dir);
        // Literal, not MAX_LOG_FILES: the limit is the contract under test, so
        // deriving the expectation from it would make any change self-consistent.
        assert_eq!(names.len(), 5);
        assert!(!names.contains(&format!("{FILE_NAME}.2026-09-01")));
        assert!(!names.contains(&format!("{FILE_NAME}.2026-09-03")));
        assert!(names.contains(&format!("{FILE_NAME}.2026-09-08")));
    }

    #[test]
    fn prune_drops_the_oldest_files_beyond_the_byte_budget() {
        let dir = scratch_dir();
        let chunk = vec![b'x'; 4 * 1024 * 1024];
        for day in ["01", "02", "03"] {
            std::fs::write(dir.join(format!("{FILE_NAME}.2026-09-{day}")), &chunk).unwrap();
        }
        prune(&dir).unwrap();
        let names = log_files(&dir);
        assert_eq!(
            names,
            vec![
                format!("{FILE_NAME}.2026-09-02"),
                format!("{FILE_NAME}.2026-09-03")
            ]
        );
    }

    #[test]
    fn prune_removes_an_oversized_latest_file() {
        let dir = scratch_dir();
        let path = dir.join("edgeterm.log.2026-10-16");
        std::fs::File::create(&path)
            .unwrap()
            .set_len(9 * 1024 * 1024)
            .unwrap();
        prune(&dir).unwrap();
        assert!(super::log_files(&dir).iter().map(|(_, n)| n).sum::<u64>() <= 8 * 1024 * 1024);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn running_writer_bounds_segments_and_keeps_latest_events() {
        let dir = scratch_dir();
        let (subscriber, guard) = build(&dir).unwrap();
        {
            let _default = tracing::subscriber::set_default(subscriber);
            let payload = "x".repeat(256 * 1024);
            for _ in 0..48 {
                tracing::info!("{payload}");
            }
            tracing::info!("latest-event-survives");
        }
        drop(guard);
        let files = super::log_files(&dir);
        assert!(files.len() <= 5);
        assert!(files.iter().all(|(_, n)| *n <= 2 * 1024 * 1024));
        assert!(files.iter().map(|(_, n)| n).sum::<u64>() <= 8 * 1024 * 1024);
        assert!(report_from(&dir).contains("latest-event-survives"));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn tail_reader_never_reads_the_whole_file() {
        struct Counted {
            inner: std::io::Cursor<Vec<u8>>,
            read: usize,
        }
        impl Read for Counted {
            fn read(&mut self, bytes: &mut [u8]) -> std::io::Result<usize> {
                let count = self.inner.read(bytes)?;
                self.read += count;
                Ok(count)
            }
        }
        impl Seek for Counted {
            fn seek(&mut self, from: SeekFrom) -> std::io::Result<u64> {
                self.inner.seek(from)
            }
        }
        let mut reader = Counted {
            inner: std::io::Cursor::new(vec![b'x'; 1024 * 1024]),
            read: 0,
        };
        let (tail, omitted) = read_tail(&mut reader, 256 * 1024).unwrap();
        assert!(omitted);
        assert_eq!(reader.read, 262144);
        assert_eq!(tail.len(), 262144);
    }

    #[test]
    fn the_report_names_the_build_and_tails_the_newest_log_text() {
        let dir = scratch_dir();
        std::fs::write(dir.join(format!("{FILE_NAME}.2026-09-15")), b"old line\n").unwrap();
        std::fs::write(dir.join(format!("{FILE_NAME}.2026-09-16")), b"new line\n").unwrap();
        let report = report_from(&dir);
        assert!(report.contains(&format!("version: {}", env!("CARGO_PKG_VERSION"))));
        assert!(report.contains(&format!("os: {}", std::env::consts::OS)));
        assert!(report.contains("log file: edgeterm.log.2026-09-15"));
        assert!(report.contains("log file: edgeterm.log.2026-09-16"));
        let old = report.find("old line").expect("older line missing");
        let new = report.find("new line").expect("newer line missing");
        assert!(old < new, "the tail must read oldest first: {report}");
        assert!(report.contains("(complete)"));
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn the_report_bounds_the_tail_and_says_what_it_dropped() {
        let dir = scratch_dir();
        // The newest file alone exceeds the budget: only its tail survives,
        // and the export must stay close to the budget instead of the file.
        let mut content = String::from("SENTINEL-oldest\n");
        while content.len() < EXPORT_TAIL_BYTES + 64 * 1024 {
            content.push_str(&"x".repeat(79));
            content.push('\n');
        }
        content.push_str("SENTINEL-newest\n");
        std::fs::write(dir.join(format!("{FILE_NAME}.2026-09-16")), content).unwrap();
        let report = report_from(&dir);
        assert!(report.contains("SENTINEL-newest"));
        assert!(!report.contains("SENTINEL-oldest"));
        assert!(report.contains("older lines omitted"));
        assert!(
            report.len() < EXPORT_TAIL_BYTES + 4096,
            "the report grew to {} bytes",
            report.len()
        );
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn the_report_leaves_out_files_that_are_not_logs() {
        let dir = scratch_dir();
        std::fs::write(dir.join("notes.txt"), b"SENTINEL-not-a-log\n").unwrap();
        std::fs::write(dir.join(format!("{FILE_NAME}.2026-09-16")), b"kept\n").unwrap();
        let report = report_from(&dir);
        assert!(report.contains("kept"));
        assert!(!report.contains("SENTINEL-not-a-log"));
        assert!(!report.contains("notes.txt"));
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn request_events_carry_one_id_and_the_duration() {
        let dir = scratch_dir();
        let (subscriber, guard) = build(&dir).unwrap();
        let mut id = String::new();
        {
            let _default = tracing::subscriber::set_default(subscriber);
            let request = Request::begin("open_session").with_session("tab-1");
            id.push_str(request.id());
            request.info("connect", "dialling example.test:22");
            let result: Result<()> = Err(AppError::new("cannot reach example.test:22"));
            request.finish(result).unwrap_err();
        }
        drop(guard);
        let content = wait_for(&dir, "duration_ms");
        assert!(content.contains(&id), "missing request id in: {content}");
        assert!(content.contains("dialling example.test:22"));
        assert!(content.contains("cannot reach example.test:22"));
        assert!(content.contains("outcome=error") || content.contains("outcome=\"error\""));
        assert!(log_files(&dir)
            .iter()
            .all(|name| name.starts_with(FILE_NAME)));
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn finish_attaches_the_operation_and_request_id_to_failures() {
        let request = Request::begin("open_session");
        let error = request
            .finish::<()>(Err(AppError::new("boom")))
            .unwrap_err();
        assert_eq!(error.operation.as_deref(), Some("open_session"));
        assert_eq!(error.request_id.as_deref(), Some(request.id()));

        // An operation an inner layer set wins over the command's own name.
        let inner = AppError::new("boom").with_operation("write_remote_key");
        let error = request.finish::<()>(Err(inner)).unwrap_err();
        assert_eq!(error.operation.as_deref(), Some("write_remote_key"));
        assert_eq!(error.request_id.as_deref(), Some(request.id()));
    }

    #[test]
    fn a_failed_log_directory_does_not_stop_the_app() {
        let dir = scratch_dir();
        let blocked = dir.join("blocked");
        std::fs::write(&blocked, b"a file where the directory should be").unwrap();
        assert!(build(&blocked.join("logs")).is_err());
        // With no subscriber installed, a request is a no-op, never a panic.
        let request = Request::begin("open_session");
        request.info("connect", "dialling");
        request.finish::<()>(Ok(())).unwrap();
        std::fs::remove_dir_all(dir).ok();
    }

    /// The stages of a connection attempt must never repeat the credentials
    /// they were handed: a unique sentinel stands in for a password and a
    /// passphrase and must not appear in the file.
    #[tokio::test(flavor = "current_thread")]
    async fn connection_stages_log_no_credentials() {
        let dir = scratch_dir();
        let (subscriber, guard) = build(&dir).unwrap();
        let sentinel = "SENTINEL-hunter2-must-not-be-logged";
        let mut profile = crate::tests::profile(crate::model::SessionKind::Ssh);
        profile.host = Some("127.0.0.1".into());
        // A port nothing listens on on the loopback interface: the dial is
        // refused at once, so the test does not need a server.
        profile.port = Some(1);
        profile.username = Some("diag-user".into());
        profile.password = Some(sentinel.to_string());
        profile.passphrase = Some(sentinel.to_string());
        let answers = parking_lot::Mutex::new(crate::session::auth::CannedAnswers::default());
        let prompter = crate::session::auth::AuthPrompter::canned(&answers);
        {
            let _default = tracing::subscriber::set_default(subscriber);
            let request = Request::begin("open_session").with_session("tab-diag");
            let result = crate::session::ssh::connect(&profile, &[], &prompter, &request).await;
            request.finish(result.map(|_| ())).unwrap_err();
        }
        drop(guard);
        let content = wait_for(&dir, "dialling 127.0.0.1:1");
        assert!(
            content.contains("dialling 127.0.0.1:1"),
            "dial stage missing: {content}"
        );
        assert!(
            !content.contains(sentinel),
            "credentials leaked into the log: {content}"
        );
        std::fs::remove_dir_all(dir).ok();
    }
}
