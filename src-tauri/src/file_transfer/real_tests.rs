//! Acceptance against real servers: the dedicated loopback fixtures only.
//! Every test here is `#[ignore]`d — none of them runs in a plain
//! `cargo test`, and each one needs its environment variables:
//!
//! - SFTP (a dedicated OpenSSH): `EDGETERM_REAL_SSH_ADDR` (host:port),
//!   `EDGETERM_REAL_SSH_USER`, `EDGETERM_REAL_SSH_KEY` (the fixture's
//!   client key), `EDGETERM_REAL_SSH_ROOT` (an absolute path inside the
//!   fixture's own directory tree).
//! - FTP (a dedicated pyftpdlib): `EDGETERM_REAL_FTP_ADDR`,
//!   `EDGETERM_REAL_FTP_USER`, `EDGETERM_REAL_FTP_PASS`,
//!   `EDGETERM_REAL_FTP_ROOT` (a path inside the server's jail).
//!
//! SFTP tests dial through `test_transport`, which records host keys in a
//! scratch file the test owns — the user's `~/.ssh/known_hosts` is never
//! read or written. FTP tests go through the production `start`/`adopt`
//! manager entry points: the FTP engine dials its own connections from
//! the profile, and an FTP profile carries no host-key state. Interrupted
//! runs are paused, their I/O workers drained, and their test task handles
//! aborted without cancellation cleanup; a fresh manager over the same
//! journal root discovers and resumes them. This exercises persisted
//! recovery in one process, rather than claiming a desktop process crash.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use super::{journal_json, test_job_items, Item, Job, Options, Pacer, Transfers};
use crate::model::{AuthKind, SessionProfile};

fn var(name: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| panic!("{name} must be set for the real-fixture tests"))
}

fn split_addr(address: &str) -> (String, u16) {
    let (host, port) = address
        .rsplit_once(':')
        .unwrap_or_else(|| panic!("address must be host:port, got {address}"));
    (host.to_string(), port.parse().expect("numeric port"))
}

/// A login profile for the dedicated SFTP fixture: key auth, no prompt.
fn sftp_profile() -> SessionProfile {
    let (host, port) = split_addr(&var("EDGETERM_REAL_SSH_ADDR"));
    let mut profile: SessionProfile = serde_json::from_value(serde_json::json!({
        "name": "real-sftp", "kind": "sftp"
    }))
    .unwrap();
    profile.host = Some(host);
    profile.port = Some(port);
    profile.username = Some(var("EDGETERM_REAL_SSH_USER"));
    profile.auth = Some(AuthKind::PublicKey);
    profile.private_key_path = Some(var("EDGETERM_REAL_SSH_KEY"));
    profile
}

/// A login profile for the dedicated FTP fixture: the temporary test
/// account, password auth, nothing else.
fn ftp_profile() -> SessionProfile {
    let (host, port) = split_addr(&var("EDGETERM_REAL_FTP_ADDR"));
    let mut profile: SessionProfile = serde_json::from_value(serde_json::json!({
        "name": "real-ftp", "kind": "ftp"
    }))
    .unwrap();
    profile.host = Some(host);
    profile.port = Some(port);
    profile.username = Some(var("EDGETERM_REAL_FTP_USER"));
    profile.password = Some(var("EDGETERM_REAL_FTP_PASS"));
    profile
}

async fn ssh_transport(scratch: &Path) -> Arc<crate::session::ssh::SharedTransport> {
    let (host, port) = split_addr(&var("EDGETERM_REAL_SSH_ADDR"));
    crate::session::ssh::test_transport(
        &host,
        port,
        &var("EDGETERM_REAL_SSH_USER"),
        &var("EDGETERM_REAL_SSH_KEY"),
        &scratch.join("known_hosts"),
    )
    .await
}

/// A one-off journal root plus the source tree of an upload, both under
/// the system temp directory.
struct Scratch {
    root: PathBuf,
}
impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

fn scratch(tag: &str) -> Scratch {
    let root = std::env::temp_dir().join(format!("edgeterm-real-{tag}-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&root).unwrap();
    Scratch { root }
}

/// A job whose journal directory and id line up, driven directly by the
/// engine entry points (`plan` + `copy_files`), the way `run_job` does.
async fn engine_job(
    journal_root: &Path,
    id: &str,
    item: Item,
    options: Options,
    profile: &SessionProfile,
    transport: Option<Arc<crate::session::ssh::SharedTransport>>,
) -> Arc<Job> {
    let directory = journal_root.join(id);
    std::fs::create_dir_all(&directory).unwrap();
    let pacer = (options.rate_limit_bps > 0).then(|| Arc::new(Pacer::new(options.rate_limit_bps)));
    let mut job = test_job_items(journal_root.to_path_buf(), vec![item.clone()]);
    let mutable = Arc::get_mut(&mut job).unwrap();
    mutable.id = id.into();
    mutable.directory = directory;
    mutable.options = options.clone();
    mutable.profile = profile.clone();
    mutable.pacer = pacer;
    *mutable.transport.lock() = transport;
    super::local::save_json(
        &journal_root.join(id).join("job.json"),
        &journal_json(id, profile, &[item], &options),
    )
    .unwrap();
    job
}

/// Fills `dir` with a fixed tree: three files with varied sizes, one in a
/// nested subdirectory, returning each file's (relative name, bytes).
/// Sized so a paced run can be interrupted reliably mid-file.
fn source_tree(dir: &Path) -> Vec<(&'static str, Vec<u8>)> {
    let a: Vec<u8> = (0..8 * 1024 * 1024u32).map(|n| (n % 251) as u8).collect();
    let b: Vec<u8> = (0..4 * 1024 * 1024 + 91u32)
        .map(|n| (n * 7 % 241) as u8)
        .collect();
    let c: Vec<u8> = (0..1024 * 1024u32).map(|n| (n % 17) as u8).collect();
    std::fs::create_dir_all(dir.join("pkg/deep")).unwrap();
    std::fs::write(dir.join("a"), &a).unwrap();
    std::fs::write(dir.join("pkg/b"), &b).unwrap();
    std::fs::write(dir.join("pkg/deep/c"), &c).unwrap();
    vec![("a", a), ("pkg/b", b), ("pkg/deep/c", c)]
}

fn sha256_file(path: &Path) -> String {
    use ring::digest::{Context, SHA256};
    let mut file = std::fs::File::open(path).unwrap();
    let mut context = Context::new(&SHA256);
    let mut buffer = vec![0u8; 256 * 1024];
    loop {
        let n = std::io::Read::read(&mut file, &mut buffer).unwrap();
        if n == 0 {
            break;
        }
        context.update(&buffer[..n]);
    }
    super::local::hex(context.finish().as_ref())
}

/// Waits until the job reports a terminal status, failing the test on
/// timeout. Returns (status, error).
async fn settle(job: &Arc<Job>, timeout: Duration) -> (String, Option<super::Failure>) {
    let started = std::time::Instant::now();
    loop {
        let (status, error) = {
            let snapshot = job.snapshot.lock();
            (snapshot.status.clone(), snapshot.error.clone())
        };
        if matches!(status.as_str(), "complete" | "error" | "cancelled") {
            if status == "error" {
                let failed = job.snapshot.lock().failed_files.clone();
                eprintln!("job failed: {error:?}; failed files: {failed:?}");
            }
            return (status, error);
        }
        assert!(
            started.elapsed() < timeout,
            "job stayed {status:?} for {:?}; transferred={}",
            started.elapsed(),
            job.snapshot.lock().transferred
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

fn sink() -> tauri::ipc::Channel<crate::session::TransferProgress> {
    tauri::ipc::Channel::new(|_| Ok(()))
}

fn assert_running(snapshot: &super::Snapshot) {
    assert!(
        matches!(snapshot.status.as_str(), "queued" | "running" | "retrying"),
        "interruption requires an unfinished job, got {}: {:?}; failed files {:?}",
        snapshot.status,
        snapshot.error,
        snapshot.failed_files
    );
}

// ---------------------------------------------------------------------------
// SFTP: the engine paths over a real OpenSSH, the restart through the
// production manager.
// ---------------------------------------------------------------------------

/// A real directory upload, interrupted mid-run and resumed by a fresh
/// manager: the finished tree matches the source byte for byte (SHA-256
/// per file), both after the upload and after a real download back.
#[tokio::test]
#[ignore = "needs the dedicated OpenSSH fixture; see the module docs"]
async fn real_sftp_directory_upload_resumes_and_content_matches() {
    let scratch = scratch("sftp-up");
    let journal_root = scratch.root.join("journals");
    std::fs::create_dir_all(&journal_root).unwrap();
    let source = scratch.root.join("tree");
    let files = source_tree(&source);
    let profile = sftp_profile();
    let remote_root = format!(
        "{}/accept-{}",
        var("EDGETERM_REAL_SSH_ROOT"),
        uuid::Uuid::new_v4()
    );

    // 1. Drive a real upload through the engine until part of it is on the
    //    server, then abandon it mid-run (a pause with no cleanup — the
    //    journal stays exactly as a crash would leave it).
    let id = "real-sftp-upload";
    let job = engine_job(
        &journal_root,
        id,
        Item {
            local: source.to_string_lossy().into(),
            remote: remote_root.clone(),
            upload: true,
            directory: true,
        },
        Options {
            // Paced so the interruption lands mid-file, not after the
            // loopback server has already taken the whole tree.
            rate_limit_bps: 4 * 1024 * 1024,
            ..Options::default()
        },
        &profile,
        Some(ssh_transport(&scratch.root).await),
    )
    .await;
    let remote = super::sftp::Remote::connect(&job).await.unwrap();
    let planned = super::sftp::plan(&job, &remote).await.unwrap();
    let total: u64 = job.snapshot.lock().total;
    let running = tokio::spawn({
        let job = job.clone();
        let remote = remote.clone();
        let planned = planned.clone();
        async move { super::sftp::copy_files(&job, &remote, planned).await }
    });
    let started = std::time::Instant::now();
    loop {
        let transferred = job.snapshot.lock().transferred;
        if transferred > total / 4 {
            job.control.set(1);
            break;
        }
        assert!(
            started.elapsed() < Duration::from_secs(60),
            "upload made no progress"
        );
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    let interrupted = running.await.unwrap();
    assert!(
        interrupted.is_err(),
        "the paused run must stop, not finish: {interrupted:?}"
    );
    drop(job);
    drop(remote);

    // 2. A fresh manager — the restart — discovers the journal and adopts
    //    it on a new session's transport.
    let manager = Transfers::with_root(journal_root.clone());
    let listed = manager.discover();
    assert!(
        listed
            .iter()
            .any(|found| found.id == id && !found.unrecognized),
        "the interrupted job must be listed: {listed:?}"
    );
    let journal = manager.read_persisted(id).unwrap();
    let resumed = manager
        .adopt(
            None,
            journal,
            "session-2".into(),
            profile.clone(),
            Vec::new(),
            Some(ssh_transport(&scratch.root).await),
            sink(),
        )
        .unwrap();
    let (status, error) = settle(&resumed, Duration::from_secs(90)).await;
    assert_eq!(status, "complete", "resume failed: {error:?}");

    // 3. Download the finished tree back through the engine and compare
    //    every file's SHA-256 with the source.
    let back = scratch.root.join("back");
    std::fs::create_dir_all(&back).unwrap();
    let download = engine_job(
        &journal_root,
        "real-sftp-download",
        Item {
            local: back.to_string_lossy().into(),
            remote: remote_root.clone(),
            upload: false,
            directory: true,
        },
        Options::default(),
        &profile,
        Some(ssh_transport(&scratch.root).await),
    )
    .await;
    let remote = super::sftp::Remote::connect(&download).await.unwrap();
    let planned = super::sftp::plan(&download, &remote).await.unwrap();
    super::sftp::copy_files(&download, &remote, planned)
        .await
        .unwrap();
    for (name, bytes) in &files {
        let path = back.join(name);
        assert!(path.exists(), "{name} did not come back");
        assert_eq!(
            sha256_file(&path),
            super::local::digest(bytes),
            "{name} content mismatch"
        );
    }
    manager.stop_test_workers().await;
}

/// A same-length change to the source between the interruption and the
/// resume is refused, and nothing lands at the destination.
#[tokio::test]
#[ignore = "needs the dedicated OpenSSH fixture; see the module docs"]
async fn real_sftp_recovery_refuses_a_tampered_source() {
    let scratch = scratch("sftp-tamper");
    let journal_root = scratch.root.join("journals");
    std::fs::create_dir_all(&journal_root).unwrap();
    let source = scratch.root.join("file");
    let bytes: Vec<u8> = (0..2 * 1024 * 1024u32).map(|n| (n % 251) as u8).collect();
    std::fs::write(&source, &bytes).unwrap();
    let profile = sftp_profile();
    // A single file directly inside the fixture root: a file upload does
    // not create parent directories, so the parent must already exist.
    let remote_file = format!(
        "{}/accept-{}.file",
        var("EDGETERM_REAL_SSH_ROOT"),
        uuid::Uuid::new_v4()
    );

    let id = "real-sftp-tamper";
    let job = engine_job(
        &journal_root,
        id,
        Item {
            local: source.to_string_lossy().into(),
            remote: remote_file.clone(),
            upload: true,
            directory: false,
        },
        // Paced so the interruption lands mid-file with a journaled
        // checkpoint, instead of racing a loopback upload to its end.
        Options {
            rate_limit_bps: 1024 * 1024,
            ..Options::default()
        },
        &profile,
        Some(ssh_transport(&scratch.root).await),
    )
    .await;
    let remote = super::sftp::Remote::connect(&job).await.unwrap();
    let planned = super::sftp::plan(&job, &remote).await.unwrap();
    let running = tokio::spawn({
        let job = job.clone();
        let remote = remote.clone();
        async move { super::sftp::copy_files(&job, &remote, planned).await }
    });
    let started = std::time::Instant::now();
    loop {
        if job.snapshot.lock().transferred > 256 * 1024 {
            job.control.set(1);
            break;
        }
        assert!(started.elapsed() < Duration::from_secs(60), "no progress");
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    let _ = running.await.unwrap();
    drop(job);
    drop(remote);

    // Same length, different bytes.
    let mut tampered = bytes.clone();
    for (index, byte) in b"tampered!".iter().enumerate() {
        tampered[index] = *byte;
    }
    std::fs::write(&source, &tampered).unwrap();

    let manager = Transfers::with_root(journal_root.clone());
    let journal = manager.read_persisted(id).unwrap();
    let resumed = manager
        .adopt(
            None,
            journal,
            "session-2".into(),
            profile,
            Vec::new(),
            Some(ssh_transport(&scratch.root).await),
            sink(),
        )
        .unwrap();
    let (status, error) = settle(&resumed, Duration::from_secs(60)).await;
    assert_eq!(status, "error", "the tampered resume must fail: {error:?}");
    let message = error.map(|e| e.message).unwrap_or_default();
    assert!(
        message.contains("source changed"),
        "unexpected refusal reason: {message}"
    );
    manager.stop_test_workers().await;
}

/// The read-back verifying a resumed upload's remote prefix is wire
/// payload: under the journal's saved rate limit the resume's wall time
/// matches the budget's own arithmetic for prefix + remainder, charged
/// once. (Pausing and cancelling mid-wait stays prompt; see the FTP set
/// for the cancel clock.)
#[tokio::test]
#[ignore = "needs the dedicated OpenSSH fixture; see the module docs"]
async fn real_sftp_resume_readback_rides_the_saved_rate_limit() {
    let rate = 512 * 1024u64;
    let scratch = scratch("sftp-paced");
    let journal_root = scratch.root.join("journals");
    std::fs::create_dir_all(&journal_root).unwrap();
    let source = scratch.root.join("file");
    // Past the 4 MiB checkpoint boundary, so the interruption journals a
    // real prefix the resume must read back over the wire.
    let bytes: Vec<u8> = (0..6 * 1024 * 1024u32).map(|n| (n % 251) as u8).collect();
    std::fs::write(&source, &bytes).unwrap();
    let profile = sftp_profile();
    // A single file directly inside the fixture root (a file upload does
    // not create parent directories).
    let remote_file = format!(
        "{}/accept-{}.file",
        var("EDGETERM_REAL_SSH_ROOT"),
        uuid::Uuid::new_v4()
    );

    // 1. A paced upload interrupted once a slice has landed.
    let id = "real-sftp-paced";
    let options = Options {
        rate_limit_bps: rate,
        ..Options::default()
    };
    let job = engine_job(
        &journal_root,
        id,
        Item {
            local: source.to_string_lossy().into(),
            remote: remote_file.clone(),
            upload: true,
            directory: false,
        },
        options.clone(),
        &profile,
        Some(ssh_transport(&scratch.root).await),
    )
    .await;
    let remote = super::sftp::Remote::connect(&job).await.unwrap();
    let planned = super::sftp::plan(&job, &remote).await.unwrap();
    let running = tokio::spawn({
        let job = job.clone();
        let remote = remote.clone();
        async move { super::sftp::copy_files(&job, &remote, planned).await }
    });
    let started = std::time::Instant::now();
    loop {
        if job.snapshot.lock().transferred >= 4 * 1024 * 1024 + 64 * 1024 {
            job.control.set(1);
            break;
        }
        assert!(started.elapsed() < Duration::from_secs(60), "no progress");
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    let _ = running.await.unwrap();
    let checkpoint = job
        .checkpoints
        .lock()
        .values()
        .next()
        .cloned()
        .expect("the interruption journaled a checkpoint");
    drop(job);
    drop(remote);
    let prefix = checkpoint.offset;

    // 2. The restart resumes under the same saved limit. Wire payload:
    //    the prefix read-back plus the remainder — both cross the wire.
    let manager = Transfers::with_root(journal_root.clone());
    let journal = manager.read_persisted(id).unwrap();
    assert_eq!(journal.options.rate_limit_bps, rate);
    let resumed = manager
        .adopt(
            None,
            journal,
            "session-2".into(),
            profile,
            Vec::new(),
            Some(ssh_transport(&scratch.root).await),
            sink(),
        )
        .unwrap();
    let started = std::time::Instant::now();
    let (status, error) = settle(&resumed, Duration::from_secs(90)).await;
    let elapsed = started.elapsed();
    assert_eq!(status, "complete", "resume failed: {error:?}");
    let payload = prefix + (bytes.len() as u64 - prefix);
    let theory = (payload as f64 - rate as f64) / rate as f64;
    let measured = elapsed.as_secs_f64();
    assert!(
        measured >= theory * 0.85 && measured <= theory * 1.6,
        "resume of {payload} B at {rate} B/s took {measured:.2}s; theory {theory:.2}s"
    );
    manager.stop_test_workers().await;
}

// ---------------------------------------------------------------------------
// FTP: the production manager entry points against a real pyftpdlib.
// ---------------------------------------------------------------------------

/// A real FTP directory upload interrupted and resumed through the full
/// manager (`start` → pause → fresh manager → `adopt`), with the finished
/// tree downloaded back and compared per file.
#[tokio::test]
#[ignore = "needs the dedicated pyftpdlib fixture; see the module docs"]
async fn real_ftp_directory_upload_resumes_through_the_manager_and_matches() {
    let scratch = scratch("ftp-up");
    let journal_root = scratch.root.join("journals");
    std::fs::create_dir_all(&journal_root).unwrap();
    let source = scratch.root.join("tree");
    let files = source_tree(&source);
    let profile = ftp_profile();
    let remote_root = format!(
        "{}/accept-{}",
        var("EDGETERM_REAL_FTP_ROOT"),
        uuid::Uuid::new_v4()
    );

    let id = "real-ftp-upload";
    let manager = Transfers::with_root(journal_root.clone());
    manager.remember("session-1", &profile);
    let job = manager
        .start(
            None,
            "session-1".into(),
            vec![Item {
                local: source.to_string_lossy().into(),
                remote: remote_root.clone(),
                upload: true,
                directory: true,
            }],
            Some(id.into()),
            Options {
                rate_limit_bps: 4 * 1024 * 1024,
                ..Options::default()
            },
            sink(),
        )
        .unwrap();
    // Interrupt mid-run: pause once a third is on the server, wait for the
    // paused state, then abandon the manager (no cancel, no cleanup).
    let started = std::time::Instant::now();
    loop {
        let snapshot = job.snapshot.lock();
        let transferred = snapshot.transferred;
        let status = snapshot.status.clone();
        assert_running(&snapshot);
        if transferred > snapshot.total / 3 {
            drop(snapshot);
            manager.control(id, "pause").unwrap();
            break;
        }
        drop(snapshot);
        assert!(
            started.elapsed() < Duration::from_secs(60),
            "no progress: {status}"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let started = std::time::Instant::now();
    loop {
        let snapshot = job.snapshot.lock();
        let status = snapshot.status.clone();
        drop(snapshot);
        if status == "paused" {
            break;
        }
        assert!(
            started.elapsed() < Duration::from_secs(30),
            "never paused: {status}"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    manager.stop_test_workers().await;
    drop(job);
    drop(manager);

    // The restart: a fresh manager adopts the journal and finishes it.
    let manager = Transfers::with_root(journal_root.clone());
    let journal = manager.read_persisted(id).unwrap();
    let resumed = manager
        .adopt(
            None,
            journal,
            "session-2".into(),
            profile.clone(),
            Vec::new(),
            None,
            sink(),
        )
        .unwrap();
    let (status, error) = settle(&resumed, Duration::from_secs(90)).await;
    assert_eq!(status, "complete", "resume failed: {error:?}");

    // Download the tree back and compare hashes.
    let back = scratch.root.join("back");
    std::fs::create_dir_all(&back).unwrap();
    manager.remember("session-3", &profile);
    let download = manager
        .start(
            None,
            "session-3".into(),
            vec![Item {
                local: back.to_string_lossy().into(),
                remote: remote_root.clone(),
                upload: false,
                directory: true,
            }],
            Some("real-ftp-download".into()),
            Options::default(),
            sink(),
        )
        .unwrap();
    let (status, error) = settle(&download, Duration::from_secs(90)).await;
    assert_eq!(status, "complete", "download failed: {error:?}");
    for (name, bytes) in &files {
        let path = back.join(name);
        assert!(path.exists(), "{name} did not come back");
        assert_eq!(
            sha256_file(&path),
            super::local::digest(bytes),
            "{name} mismatch"
        );
    }
    manager.stop_test_workers().await;
}

/// A same-length source change between pause and resume is refused.
#[tokio::test]
#[ignore = "needs the dedicated pyftpdlib fixture; see the module docs"]
async fn real_ftp_recovery_refuses_a_tampered_source() {
    let scratch = scratch("ftp-tamper");
    let journal_root = scratch.root.join("journals");
    std::fs::create_dir_all(&journal_root).unwrap();
    let source = scratch.root.join("file");
    let bytes: Vec<u8> = (0..1024 * 1024u32).map(|n| (n % 251) as u8).collect();
    std::fs::write(&source, &bytes).unwrap();
    let profile = ftp_profile();
    let remote_file = format!(
        "{}/accept-{}.file",
        var("EDGETERM_REAL_FTP_ROOT"),
        uuid::Uuid::new_v4()
    );

    let id = "real-ftp-tamper";
    let manager = Transfers::with_root(journal_root.clone());
    manager.remember("session-1", &profile);
    let job = manager
        .start(
            None,
            "session-1".into(),
            vec![Item {
                local: source.to_string_lossy().into(),
                remote: remote_file.clone(),
                upload: true,
                directory: false,
            }],
            Some(id.into()),
            Options {
                rate_limit_bps: 256 * 1024,
                ..Options::default()
            },
            sink(),
        )
        .unwrap();
    let started = std::time::Instant::now();
    loop {
        let snapshot = job.snapshot.lock();
        assert_running(&snapshot);
        let transferred = snapshot.transferred;
        if transferred > 128 * 1024 {
            drop(snapshot);
            manager.control(id, "pause").unwrap();
            break;
        }
        drop(snapshot);
        assert!(started.elapsed() < Duration::from_secs(60), "no progress");
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let started = std::time::Instant::now();
    loop {
        let status = job.snapshot.lock().status.clone();
        if status == "paused" {
            break;
        }
        assert!(
            started.elapsed() < Duration::from_secs(30),
            "never paused: {status}"
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    manager.stop_test_workers().await;
    drop(job);
    drop(manager);

    let mut tampered = bytes.clone();
    for (index, byte) in b"tampered!".iter().enumerate() {
        tampered[index] = *byte;
    }
    std::fs::write(&source, &tampered).unwrap();

    let manager = Transfers::with_root(journal_root.clone());
    let journal = manager.read_persisted(id).unwrap();
    let resumed = manager
        .adopt(
            None,
            journal,
            "session-2".into(),
            profile,
            Vec::new(),
            None,
            sink(),
        )
        .unwrap();
    let (status, error) = settle(&resumed, Duration::from_secs(60)).await;
    assert_eq!(status, "error", "the tampered resume must fail: {error:?}");
    let message = error.map(|e| e.message).unwrap_or_default();
    assert!(
        message.contains("source changed"),
        "unexpected refusal reason: {message}"
    );
    manager.stop_test_workers().await;
}

/// Queue and cancellation at the manager level: per endpoint at most two
/// jobs run while the rest wait queued; a queued job cancels at once; a
/// paced job's rate-limit wait is cancellable within seconds.
#[tokio::test]
#[ignore = "needs the dedicated pyftpdlib fixture; see the module docs"]
async fn real_ftp_queue_and_cancellation_are_prompt() {
    let scratch = scratch("ftp-queue");
    let journal_root = scratch.root.join("journals");
    std::fs::create_dir_all(&journal_root).unwrap();
    let profile = ftp_profile();
    let remote_root = var("EDGETERM_REAL_FTP_ROOT");
    let manager = Transfers::with_root(journal_root.clone());
    manager.remember("session-1", &profile);
    let options = Options {
        rate_limit_bps: 64 * 1024,
        ..Options::default()
    };
    let bytes: Vec<u8> = (0..4 * 1024 * 1024u32).map(|n| (n % 251) as u8).collect();
    let mut jobs = Vec::new();
    for n in 0..3 {
        let source = scratch.root.join(format!("file{n}"));
        std::fs::write(&source, &bytes).unwrap();
        let job = manager
            .start(
                None,
                "session-1".into(),
                vec![Item {
                    local: source.to_string_lossy().into(),
                    remote: format!("{remote_root}/accept-{}-file{n}", uuid::Uuid::new_v4()),
                    upload: true,
                    directory: false,
                }],
                Some(format!("real-ftp-queue-{n}")),
                options.clone(),
                sink(),
            )
            .unwrap();
        jobs.push(job);
    }
    // Let the two slots start, then check the third is queued (and stays
    // queued, not failed).
    tokio::time::sleep(Duration::from_secs(2)).await;
    let statuses: Vec<String> = jobs
        .iter()
        .map(|job| job.snapshot.lock().status.clone())
        .collect();
    let running = statuses.iter().filter(|s| s.as_str() == "running").count();
    let queued = statuses.iter().filter(|s| s.as_str() == "queued").count();
    assert!(
        running == 2 && queued == 1,
        "expected 2 running + 1 queued, got {statuses:?}"
    );
    // The queued job cancels immediately; the paced running jobs leave
    // their rate-limit waits within seconds.
    let started = std::time::Instant::now();
    for (n, _job) in jobs.iter().enumerate() {
        manager
            .control(&format!("real-ftp-queue-{n}"), "cancel")
            .unwrap();
    }
    for job in &jobs {
        let (status, error) = settle(job, Duration::from_secs(15)).await;
        assert_eq!(status, "cancelled", "cancel failed: {error:?}");
    }
    let elapsed = started.elapsed();
    assert!(
        elapsed < Duration::from_secs(10),
        "cancelling out of rate-limit waits took {elapsed:?}"
    );
    manager.stop_test_workers().await;
}
