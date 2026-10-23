//! Passive FTP fixture, including data-stream failures and REST rejection.
use super::*;
use parking_lot::Mutex;
use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};

#[derive(Default)]
struct Server {
    files: HashMap<String, Vec<u8>>,
    dirs: std::collections::HashSet<String>,
    /// How many more STOR/APPE data streams are cut off after 1 MiB: a
    /// count rather than a flag, so the engine's retry loop can be made to
    /// fail through every attempt (a one-shot flag is auto-cleared by the
    /// first failure and the retry then sails through).
    fail_append: usize,
    reject_rest: bool,
    reject_append: bool,
    received: Vec<usize>,
    counts: HashMap<String, usize>,
}

#[test]
fn audit_ftp_durable_upload_is_rejected_before_writing() {
    let f = Fixture::new(Server::default());
    let mut job = f.job();
    Arc::get_mut(&mut job).unwrap().options.durable = true;
    let path = f.root.join("source");
    std::fs::write(&path, b"source").unwrap();
    let item = Item {
        local: path.to_string_lossy().into(),
        remote: "/target".into(),
        upload: true,
        directory: false,
    };
    let mut conn = open(&job).unwrap();
    let error = copy(&job, &mut conn.stream, &item).unwrap_err();
    assert_eq!(error.code, "unsupported");
    assert!(f.state.lock().files.is_empty());
}
struct Fixture {
    state: Arc<Mutex<Server>>,
    address: std::net::SocketAddr,
    stop: Arc<AtomicBool>,
    thread: Option<std::thread::JoinHandle<()>>,
    root: PathBuf,
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        let _ = TcpStream::connect(self.address);
        self.thread.take().unwrap().join().unwrap();
        let _ = std::fs::remove_dir_all(&self.root);
    }
}
impl Fixture {
    fn new(server: Server) -> Self {
        let state = Arc::new(Mutex::new(server));
        let stop = Arc::new(AtomicBool::new(false));
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let shared = state.clone();
        let stopped = stop.clone();
        let thread = std::thread::spawn(move || {
            while let Ok((stream, _)) = listener.accept() {
                if stopped.load(Ordering::SeqCst) {
                    break;
                }
                let state = shared.clone();
                std::thread::spawn(move || {
                    let _ = serve(stream, state);
                });
            }
        });
        let root = std::env::temp_dir().join(format!("edgeterm-ftp-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        Self {
            state,
            address,
            stop,
            thread: Some(thread),
            root,
        }
    }
    fn job(&self) -> Arc<Job> {
        let mut job = super::super::test_job(self.root.clone());
        let profile = &mut Arc::get_mut(&mut job).unwrap().profile;
        profile.kind = crate::model::SessionKind::Ftp;
        profile.host = Some("127.0.0.1".into());
        profile.port = Some(self.address.port());
        job
    }
    fn count(&self, label: &str) -> usize {
        self.state.lock().counts.get(label).copied().unwrap_or(0)
    }
}

/// The parent directory of a POSIX-style path, "/" at the root.
#[test]
fn resumed_download_counts_unstarted_files_before_copying() {
    let f = Fixture::new(Server {
        files: HashMap::from([
            ("/first".into(), b"abc".to_vec()),
            ("/second".into(), b"1234567".to_vec()),
        ]),
        ..Server::default()
    });
    let items: Vec<Item> = ["first", "second"]
        .iter()
        .map(|name| Item {
            local: local::normalize(&f.root.join(name).to_string_lossy()).unwrap(),
            remote: format!("/{name}"),
            upload: false,
            directory: false,
        })
        .collect();
    let job = f.job();
    *job.plan.lock() = Some(items);
    let mut conn = open(&job).unwrap();
    plan(&job, &mut conn).unwrap();
    assert_eq!(job.snapshot.lock().total, 10);
    assert_eq!(job.snapshot.lock().total_files, 2);
    drop(conn);
    run_blocking(&job).unwrap();
    assert_eq!(std::fs::read(f.root.join("first")).unwrap(), b"abc");
    assert_eq!(std::fs::read(f.root.join("second")).unwrap(), b"1234567");
}

fn parent_of(path: &str) -> &str {
    match path.rsplit_once('/') {
        Some(("", _)) => "/",
        Some((parent, _)) => parent,
        None => "/",
    }
}

fn serve(mut stream: TcpStream, state: Arc<Mutex<Server>>) -> std::io::Result<()> {
    stream.set_read_timeout(Some(Duration::from_secs(5)))?;
    let mut reader = BufReader::new(stream.try_clone()?);
    let mut passive = None;
    let mut rename = String::new();
    let mut rest = 0;
    let mut cwd = "/".to_string();
    stream.write_all(b"220 Fixture\r\n")?;
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line)? == 0 {
            return Ok(());
        }
        let (command, arg) = line
            .trim_end()
            .split_once(' ')
            .unwrap_or((line.trim_end(), ""));
        *state.lock().counts.entry(command.to_string()).or_default() += 1;
        let response = match command {
            "USER" => "331 Password".to_string(),
            "PASS" => "230 Logged in".into(),
            "SYST" => "215 UNIX Type: L8".into(),
            "FEAT" => "211-Features:\r\n MLST type*;size*;modify\r\n211 End".into(),
            "TYPE" | "OPTS" | "NOOP" => "200 OK".into(),
            "CWD" => {
                let target = if arg.starts_with('/') {
                    arg.trim_end_matches('/').to_string()
                } else {
                    format!("{}{}", cwd.trim_end_matches('/'), arg)
                };
                let exists = target.is_empty()
                    || target == "/"
                    || state.lock().dirs.contains(&target)
                    || state
                        .lock()
                        .files
                        .keys()
                        .any(|path| parent_of(path) == target);
                if exists {
                    cwd = if target.is_empty() {
                        "/".into()
                    } else {
                        target
                    };
                    "250 Directory changed".into()
                } else {
                    "550 No such directory".into()
                }
            }
            "PWD" => format!("257 \"{}\"", cwd),
            "SIZE" => state
                .lock()
                .files
                .get(arg)
                .map(|d| format!("213 {}", d.len()))
                .unwrap_or_else(|| "550 Missing".into()),
            "MDTM" => "213 20261013000000".into(),
            "PASV" => {
                let listener = TcpListener::bind("127.0.0.1:0")?;
                let port = listener.local_addr()?.port();
                passive = Some(listener);
                format!("227 Passive (127,0,0,1,{},{})", port / 256, port % 256)
            }
            "REST" => {
                if state.lock().reject_rest {
                    "502 REST unsupported".into()
                } else {
                    rest = arg.parse::<usize>().unwrap();
                    "350 Restart accepted".into()
                }
            }
            "MKD" => {
                state.lock().dirs.insert(arg.to_string());
                "257 Created".into()
            }
            "MLSD" => {
                stream.write_all(b"150 Data\r\n")?;
                let (mut data, _) = passive.take().unwrap().accept()?;
                let dir = arg.trim_end_matches('/');
                let mut listing = String::new();
                {
                    let server = state.lock();
                    for (path, bytes) in &server.files {
                        if parent_of(path) == dir {
                            listing.push_str(&format!(
                                "type=file;size={}; {}\r\n",
                                bytes.len(),
                                path.rsplit('/').next().unwrap()
                            ));
                        }
                    }
                    for path in &server.dirs {
                        if parent_of(path) == dir {
                            listing.push_str(&format!(
                                "type=dir; {}\r\n",
                                path.rsplit('/').next().unwrap()
                            ));
                        }
                    }
                }
                data.write_all(listing.as_bytes())?;
                drop(data);
                "226 Complete".into()
            }
            "RETR" | "STOR" | "APPE" => {
                if command == "APPE" && state.lock().reject_append {
                    passive = None;
                    stream.write_all(b"502 APPE unsupported\r\n")?;
                    continue;
                }
                stream.write_all(b"150 Data\r\n")?;
                let (mut data, _) = passive.take().unwrap().accept()?;
                data.set_read_timeout(Some(Duration::from_secs(3)))?;
                data.set_write_timeout(Some(Duration::from_secs(3)))?;
                if command == "RETR" {
                    let bytes = state.lock().files[arg].clone();
                    data.write_all(&bytes[rest..])?;
                    rest = 0;
                } else {
                    let fail = state.lock().fail_append > 0;
                    let mut bytes = Vec::new();
                    if fail {
                        Read::by_ref(&mut data)
                            .take(1024 * 1024)
                            .read_to_end(&mut bytes)?;
                    } else {
                        data.read_to_end(&mut bytes)?;
                    }
                    let mut state = state.lock();
                    let fail = fail && !bytes.is_empty();
                    if !bytes.is_empty() {
                        state.received.push(bytes.len());
                    }
                    if command == "STOR" {
                        state.files.insert(arg.into(), bytes);
                    } else {
                        state.files.entry(arg.into()).or_default().extend(bytes);
                    }
                    if fail {
                        state.fail_append = state.fail_append.saturating_sub(1);
                        drop(data);
                        stream.write_all(b"426 Data connection lost\r\n")?;
                        continue;
                    }
                }
                drop(data);
                "226 Complete".into()
            }
            "RNFR" => {
                rename = arg.into();
                "350 Rename ready".into()
            }
            "RNTO" => {
                let mut state = state.lock();
                if state.files.contains_key(arg) {
                    "550 Already exists".into()
                } else if let Some(bytes) = state.files.remove(&rename) {
                    state.files.insert(arg.into(), bytes);
                    "250 Renamed".into()
                } else {
                    "550 Missing".into()
                }
            }
            "DELE" => {
                if state.lock().files.remove(arg).is_some() {
                    "250 Deleted".into()
                } else {
                    "550 Missing".into()
                }
            }
            "QUIT" => {
                stream.write_all(b"221 Bye\r\n")?;
                return Ok(());
            }
            _ => "502 Unsupported".into(),
        };
        stream.write_all(format!("{response}\r\n").as_bytes())?;
    }
}

#[test]
fn ftp_upload_verifies_partial_content_before_append_and_preserves_original() {
    let f = Fixture::new(Server {
        files: HashMap::from([("/target".into(), b"original".to_vec())]),
        fail_append: 1,
        ..Server::default()
    });
    let job = f.job();
    let path = f.root.join("source");
    let bytes = vec![37; 3 * 1024 * 1024 + 17];
    std::fs::write(&path, &bytes).unwrap();
    let item = Item {
        local: path.to_string_lossy().into(),
        remote: "/target".into(),
        upload: true,
        directory: false,
    };
    let mut conn = connect(&job.profile).unwrap();
    assert!(copy(&job, &mut conn.stream, &item).is_err());
    drop(conn);
    assert_eq!(f.state.lock().files["/target"], b"original");
    let cp = job.checkpoint(&job.key(&item)).unwrap();
    assert_eq!(
        cp.offset, 0,
        "socket writes are not confirmed FTP checkpoints"
    );
    assert_eq!(f.state.lock().files[&cp.temporary].len(), 1024 * 1024);
    let mut conn = connect(&job.profile).unwrap();
    copy(&job, &mut conn.stream, &item).unwrap();
    assert_eq!(f.state.lock().files["/target"], bytes);
    assert_eq!(f.state.lock().received, [1024 * 1024, 2 * 1024 * 1024 + 17]);
    assert!(!f.state.lock().files.contains_key(&cp.backup));
}

#[test]
fn ftp_download_restarts_safely_when_the_server_rejects_rest() {
    let bytes = vec![29; 80_013];
    let f = Fixture::new(Server {
        files: HashMap::from([("/source".into(), bytes.clone())]),
        reject_rest: true,
        ..Server::default()
    });
    let job = f.job();
    let target = f.root.join("target");
    std::fs::write(&target, b"original").unwrap();
    let item = Item {
        local: target.to_string_lossy().into(),
        remote: "/source".into(),
        upload: false,
        directory: false,
    };
    let key = job.key(&item);
    let temp = local::sibling(&target, &key, "part").unwrap();
    std::fs::write(&temp, &bytes[..32000]).unwrap();
    let mut conn = connect(&job.profile).unwrap();
    job.save(&Checkpoint {
        key,
        item: item.clone(),
        source: signature(
            job.pacer.as_ref(),
            &job.control,
            &mut conn.stream,
            "/source",
        )
        .unwrap()
        .unwrap(),
        original: local::target_signature(&target).unwrap(),
        temporary: temp.to_string_lossy().into(),
        backup: String::new(),
        offset: 32000,
        prefix_hash: local::digest(&bytes[..32000]),
        complete: false,
        committing: false,
        owns_temporary: true,
        owns_backup: false,
    })
    .unwrap();
    copy(&job, &mut conn.stream, &item).unwrap();
    assert_eq!(std::fs::read(&target).unwrap(), bytes);
    assert!(!temp.exists());
}

#[test]
fn cancellation_interrupts_a_blocked_ftp_data_socket() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let mut client = TcpStream::connect(listener.local_addr().unwrap()).unwrap();
    let (_peer, _) = listener.accept().unwrap();
    let control = Arc::new(Control::default());
    let guard = control.socket(&client).unwrap();
    let reader = std::thread::spawn(move || client.read(&mut [0; 1]));
    let started = std::time::Instant::now();
    control.set(2);
    let result = reader.join().unwrap();
    assert!(result.is_err() || result.unwrap() == 0);
    assert!(started.elapsed() < Duration::from_millis(500));
    drop(guard);
}

#[test]
fn ftp_upload_restarts_safely_when_append_is_unsupported() {
    assert_upload_restarts_after_append_rejection(None);
}

#[test]
fn ftp_upload_reads_append_rejection_after_passive_connection_errors() {
    for kind in [
        std::io::ErrorKind::ConnectionReset,
        std::io::ErrorKind::ConnectionRefused,
    ] {
        assert_upload_restarts_after_append_rejection(Some(kind));
    }
}

fn assert_upload_restarts_after_append_rejection(error: Option<std::io::ErrorKind>) {
    let f = Fixture::new(Server {
        fail_append: 1,
        reject_append: true,
        ..Server::default()
    });
    let job = f.job();
    let path = f.root.join("source");
    let bytes = vec![81; 2 * 1024 * 1024 + 17];
    std::fs::write(&path, &bytes).unwrap();
    let item = Item {
        local: path.to_string_lossy().into(),
        remote: "/target".into(),
        upload: true,
        directory: false,
    };
    let mut conn = connect(&job.profile).unwrap();
    assert!(copy(&job, &mut conn.stream, &item).is_err());
    drop(conn);
    let mut conn = connect(&job.profile).unwrap();
    if let Some(kind) = error {
        let connections = AtomicUsize::new(0);
        conn.stream = conn.stream.passive_stream_builder(move |address| {
            // The resume first reads the prefix via RETR, then sends APPE.
            // Inject the OS error at that second data connection so this
            // regression does not depend on the listener-close race.
            if connections.fetch_add(1, Ordering::SeqCst) == 1 {
                return Err(FtpError::ConnectionError(kind.into()));
            }
            TcpStream::connect(address).map_err(FtpError::ConnectionError)
        });
    }
    copy(&job, &mut conn.stream, &item).unwrap();
    assert_eq!(f.state.lock().files["/target"], bytes);
    assert_eq!(f.state.lock().received, [1024 * 1024, 2 * 1024 * 1024 + 17]);
    assert_eq!(f.count("APPE"), 1);
    assert_eq!(f.count("STOR"), 2);
}

/// A fresh small upload is the bulk-transfer case B10 streamlines. Each round
/// trip is one control command, so the per-file command count is its cost.
/// The empty placeholder STOR (and its SIZE probe of the partial), the SIZE
/// probe of a partial this run is about to create, and the SIZE probe of a
/// backup that cannot exist are all removed. What remains per file: the
/// destination probe before transfer, one STOR on one passive connection, the
/// post-upload size verification, the commit's destination re-check and the
/// RNFR/RNTO pair. These are fixture (local TCP server) counts, not a real
/// FTP server.
#[test]
fn fresh_ftp_upload_command_count_per_file() {
    let f = Fixture::new(Server::default());
    let job = f.job();
    let path = f.root.join("source");
    std::fs::write(&path, b"small file contents").unwrap();
    let item = Item {
        local: path.to_string_lossy().into(),
        remote: "/target".into(),
        upload: true,
        directory: false,
    };
    let mut conn = connect(&job.profile).unwrap();
    copy(&job, &mut conn.stream, &item).unwrap();
    assert_eq!(f.state.lock().files["/target"], b"small file contents");
    // Destination probe before the transfer, post-upload size check, and the
    // commit's destination re-check. The partial probe and the backup probe
    // are gone.
    assert_eq!(f.count("SIZE"), 3);
    // The partial is created by this run's STOR; its mtime is never read back.
    assert_eq!(f.count("MDTM"), 0);
    // One data connection: the real STOR, no empty placeholder.
    assert_eq!(f.count("STOR"), 1);
    assert_eq!(f.count("PASV"), 1);
    // RNFR/RNTO commit the partial into place.
    assert_eq!(f.count("RNFR"), 1);
    assert_eq!(f.count("RNTO"), 1);
}

// --- rate limiting and restart recovery, through the Transfers manager -------

use super::super::{Options, Transfers};

fn manager_for(root: &Path, port: u16) -> (Transfers, crate::model::SessionProfile) {
    let manager = Transfers::with_root(root.to_path_buf());
    let profile: crate::model::SessionProfile =
        serde_json::from_value(serde_json::json!({"name":"t", "kind":"ftp", "host":"127.0.0.1"}))
            .unwrap();
    let mut profile = profile;
    profile.host = Some("127.0.0.1".into());
    profile.port = Some(port);
    profile.username = Some("user".into());
    profile.password = Some("pw".into());
    manager.remember("session", &profile);
    (manager, profile)
}

fn sink() -> tauri::ipc::Channel<crate::session::TransferProgress> {
    tauri::ipc::Channel::new(|_| Ok(()))
}

/// Runs the manager's async worker loop on this blocking test thread.
fn run_to_completion(job: &Arc<Job>) -> crate::error::Result<()> {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(async { super::super::wait(job).await })
}

fn poll_status(manager: &Transfers, id: &str, limit: Duration, want: &str) -> String {
    let deadline = std::time::Instant::now() + limit;
    loop {
        let status = manager
            .snapshots()
            .into_iter()
            .find(|snapshot| snapshot.id == id)
            .map(|snapshot| snapshot.status)
            .unwrap_or_default();
        if status == want || std::time::Instant::now() > deadline {
            return status;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}

/// A paced FTP upload moves real bytes at the configured rate through the
/// whole manager: 192 KiB at 64 KiB/s minus the 64 KiB burst is ≥ 2 s.
#[test]
fn ftp_rate_limited_upload_measures_elapsed_and_content() {
    let f = Fixture::new(Server::default());
    let root = f.root.join("journals");
    std::fs::create_dir_all(&root).unwrap();
    let (manager, _profile) = manager_for(&root, f.address.port());
    let source = f.root.join("source");
    let bytes = vec![61u8; 192 * 1024];
    std::fs::write(&source, &bytes).unwrap();
    let started = std::time::Instant::now();
    let job = manager
        .start(
            None,
            "session".into(),
            vec![Item {
                local: source.to_string_lossy().into(),
                remote: "/target".into(),
                upload: true,
                directory: false,
            }],
            None,
            Options {
                rate_limit_bps: 64 * 1024,
                ..Options::default()
            },
            sink(),
        )
        .unwrap();
    run_to_completion(&job).unwrap();
    let elapsed = started.elapsed();
    assert_eq!(f.state.lock().files["/target"], bytes);
    assert!(
        elapsed >= Duration::from_millis(1900),
        "upload finished in {elapsed:?} despite the 64 KiB/s limit"
    );
    assert!(elapsed < Duration::from_secs(8), "upload took {elapsed:?}");
    let _ = std::fs::remove_dir_all(&root);
}

/// A tiny file under a 1 KiB/s limit finishes at once: EOF probes cost
/// nothing and the slice shrinks with the rate, so nothing waits on the
/// 64 KiB slice an upfront charge would have imposed.
#[test]
fn ftp_low_rate_small_file_completes_quickly() {
    let f = Fixture::new(Server::default());
    let root = f.root.join("journals");
    std::fs::create_dir_all(&root).unwrap();
    let (manager, _profile) = manager_for(&root, f.address.port());
    let source = f.root.join("tiny");
    std::fs::write(&source, b"0123456789abcdef").unwrap();
    let started = std::time::Instant::now();
    let job = manager
        .start(
            None,
            "session".into(),
            vec![Item {
                local: source.to_string_lossy().into(),
                remote: "/tiny".into(),
                upload: true,
                directory: false,
            }],
            None,
            Options {
                rate_limit_bps: 1024,
                ..Options::default()
            },
            sink(),
        )
        .unwrap();
    run_to_completion(&job).unwrap();
    let elapsed = started.elapsed();
    assert_eq!(f.state.lock().files["/tiny"], b"0123456789abcdef");
    assert!(
        elapsed < Duration::from_secs(2),
        "a 16-byte file at 1 KiB/s took {elapsed:?}"
    );
    let _ = std::fs::remove_dir_all(&root);
}

/// Short reads and the final EOF probe are billed by the bytes that
/// actually moved: 100 KiB at 32 KiB/s is ~2.1 s, where an EOF-charging or
/// slice-charging implementation adds whole seconds more.
#[test]
fn ftp_short_reads_and_eof_probe_are_billed_by_actual_bytes() {
    let f = Fixture::new(Server::default());
    let root = f.root.join("journals");
    std::fs::create_dir_all(&root).unwrap();
    let (manager, _profile) = manager_for(&root, f.address.port());
    let source = f.root.join("source");
    let bytes = vec![7u8; 100 * 1024];
    std::fs::write(&source, &bytes).unwrap();
    let started = std::time::Instant::now();
    let job = manager
        .start(
            None,
            "session".into(),
            vec![Item {
                local: source.to_string_lossy().into(),
                remote: "/target".into(),
                upload: true,
                directory: false,
            }],
            None,
            Options {
                rate_limit_bps: 32 * 1024,
                ..Options::default()
            },
            sink(),
        )
        .unwrap();
    run_to_completion(&job).unwrap();
    let elapsed = started.elapsed();
    assert_eq!(f.state.lock().files["/target"], bytes);
    // 100 KiB minus the 32 KiB burst is 68 KiB at 32 KiB/s ≈ 2.1 s; the
    // upload's own EOF/SIZE verification moves no payload.
    assert!(
        elapsed >= Duration::from_millis(2000),
        "the rate limit was not enforced: {elapsed:?}"
    );
    assert!(
        elapsed < Duration::from_millis(4000),
        "something beyond actual bytes was billed: {elapsed:?}"
    );
    let _ = std::fs::remove_dir_all(&root);
}

/// The queue is visible and controllable: while one job holds the
/// endpoint's slot, a second waits as `queued`, can be paused and
/// cancelled there, and cancelling the paced job interrupts its wait.
#[test]
fn ftp_queue_is_pausable_and_cancellable_while_waiting() {
    let f = Fixture::new(Server::default());
    let root = f.root.join("journals");
    std::fs::create_dir_all(&root).unwrap();
    let (manager, _profile) = manager_for(&root, f.address.port());
    let slow = f.root.join("slow");
    std::fs::write(&slow, vec![9u8; 192 * 1024]).unwrap();
    let hold = manager
        .start(
            None,
            "session".into(),
            vec![Item {
                local: slow.to_string_lossy().into(),
                remote: "/hold".into(),
                upload: true,
                directory: false,
            }],
            None,
            Options {
                rate_limit_bps: 8 * 1024,
                ..Options::default()
            },
            sink(),
        )
        .unwrap();
    assert_eq!(
        poll_status(&manager, &hold.id, Duration::from_secs(3), "running"),
        "running"
    );
    let waiting = f.root.join("waiting");
    std::fs::write(&waiting, vec![4u8; 1024]).unwrap();
    let queued = manager
        .start(
            None,
            "session".into(),
            vec![Item {
                local: waiting.to_string_lossy().into(),
                remote: "/waiting".into(),
                upload: true,
                directory: false,
            }],
            None,
            Options::default(),
            sink(),
        )
        .unwrap();
    assert_eq!(
        poll_status(&manager, &queued.id, Duration::from_secs(3), "queued"),
        "queued"
    );
    manager.control(&queued.id, "pause").unwrap();
    assert_eq!(
        poll_status(&manager, &queued.id, Duration::from_secs(3), "paused"),
        "paused"
    );
    manager.control(&queued.id, "cancel").unwrap();
    assert_eq!(
        poll_status(&manager, &queued.id, Duration::from_secs(3), "cancelled"),
        "cancelled"
    );
    // Cancelling the paced holder leaves its rate wait promptly: at
    // 8 KiB/s it would otherwise run for ~20 more seconds.
    let started = std::time::Instant::now();
    manager.cancel(&hold.id);
    assert_eq!(
        poll_status(&manager, &hold.id, Duration::from_secs(3), "cancelled"),
        "cancelled"
    );
    assert!(started.elapsed() < Duration::from_secs(3));
    assert!(!f.state.lock().files.contains_key("/hold"));
    let _ = std::fs::remove_dir_all(&root);
}

/// Two download jobs hold the endpoint slots; later jobs remain visible and
/// cancellable, then advance automatically when a running download leaves.
#[test]
fn ftp_download_queue_advances_when_a_slot_is_released() {
    let expected = b"queued download content".to_vec();
    let f = Fixture::new(Server {
        files: HashMap::from([
            ("/hold-a".into(), vec![7; 256 * 1024]),
            ("/hold-b".into(), vec![9; 256 * 1024]),
            ("/waiting".into(), expected.clone()),
            ("/cancelled".into(), b"must not arrive".to_vec()),
        ]),
        ..Server::default()
    });
    let root = f.root.join("journals");
    std::fs::create_dir_all(&root).unwrap();
    let (manager, _) = manager_for(&root, f.address.port());
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let mut jobs = Vec::new();
        for (index, name) in ["hold-a", "hold-b", "waiting", "cancelled"]
            .iter()
            .enumerate()
        {
            let job = manager
                .start(
                    None,
                    "session".into(),
                    vec![Item {
                        local: f.root.join(name).to_string_lossy().into(),
                        remote: format!("/{name}"),
                        upload: false,
                        directory: false,
                    }],
                    None,
                    Options {
                        rate_limit_bps: if index < 2 { 1024 } else { 0 },
                        ..Options::default()
                    },
                    sink(),
                )
                .unwrap();
            if index < 2 {
                assert_eq!(
                    poll_status(&manager, &job.id, Duration::from_secs(3), "running"),
                    "running"
                );
            }
            jobs.push(job);
        }
        // Require the queue to remain queued across worker scheduling, rather
        // than accepting only the initial snapshot before workers have run.
        for _ in 0..10 {
            let states = manager.snapshots();
            assert_eq!(states.iter().filter(|s| s.status == "running").count(), 2);
            assert_eq!(states.iter().filter(|s| s.status == "queued").count(), 2);
            std::thread::sleep(Duration::from_millis(20));
        }
        manager.control(&jobs[3].id, "cancel").unwrap();
        assert_eq!(
            poll_status(&manager, &jobs[3].id, Duration::from_secs(3), "cancelled"),
            "cancelled"
        );
        assert!(!f.root.join("cancelled").exists());
        manager.cancel(&jobs[0].id);
        assert_eq!(
            poll_status(&manager, &jobs[2].id, Duration::from_secs(3), "complete"),
            "complete"
        );
        assert_eq!(std::fs::read(f.root.join("waiting")).unwrap(), expected);
        assert_eq!(jobs[1].snapshot.lock().status, "running");
    }));
    // Leave no paced workers behind, including when an assertion panics.
    for job in manager.snapshots() {
        if !matches!(job.status.as_str(), "complete" | "cancelled" | "error") {
            manager.cancel(&job.id);
            let _ = poll_status(&manager, &job.id, Duration::from_secs(3), "cancelled");
        }
    }
    result.unwrap();
    assert!(manager
        .snapshots()
        .iter()
        .all(|job| matches!(job.status.as_str(), "complete" | "cancelled" | "error")));
}

/// An interrupted FTP directory upload survives a restart of the manager:
/// the journal is discovered, adopted on the matching endpoint, and the
/// resume verifies the confirmed prefix before finishing — every file
/// lands byte for byte. The local side is a real Windows directory tree.
#[test]
fn ftp_restart_recovery_finishes_an_interrupted_directory_upload() {
    let source =
        std::env::temp_dir().join(format!("edgeterm-ftp-restart-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(source.join("pkg")).unwrap();
    let a = (0..3 * 1024 * 1024 + 17u32)
        .map(|n| n as u8)
        .collect::<Vec<_>>();
    let b = b"second file".to_vec();
    std::fs::write(source.join("pkg/a"), &a).unwrap();
    std::fs::write(source.join("b"), &b).unwrap();

    let f = Fixture::new(Server {
        // Fail through the engine's whole retry ladder, so the first run
        // ends in `error` with a partial and its journal on disk.
        fail_append: 5,
        ..Server::default()
    });
    let root = f.root.join("journals");
    std::fs::create_dir_all(&root).unwrap();
    let (manager, profile) = manager_for(&root, f.address.port());
    let _ = &profile;
    let item = Item {
        local: source.to_string_lossy().into(),
        remote: "/dst".into(),
        upload: true,
        directory: true,
    };
    let id = "ftp-restart-dir";
    let first = manager
        .start(
            None,
            "session".into(),
            vec![item.clone()],
            Some(id.into()),
            Options::default(),
            sink(),
        )
        .unwrap();
    assert!(run_to_completion(&first).is_err());
    // The interruption journaled: a partial for `a` sits on the server and
    // the journal holds its checkpoint.
    let checkpointed = first.checkpoints.lock().len();
    drop(first);
    drop(manager);

    // A "restart": a fresh manager over the same journal root and the same
    // endpoint session, adopting the journal explicitly. The failure
    // injector has spent itself; recovery verifies the partial's prefix
    // against the (unchanged) source before appending the rest.
    f.state.lock().fail_append = 0;
    let (manager, profile) = manager_for(&root, f.address.port());
    let listed = manager.discover();
    assert!(
        listed
            .iter()
            .any(|found| found.id == id && !found.unrecognized),
        "{listed:?}"
    );
    let journal = manager.read_persisted(id).unwrap();
    let resumed = manager
        .adopt(
            None,
            journal,
            "session".into(),
            profile,
            Vec::new(),
            None,
            sink(),
        )
        .unwrap();
    run_to_completion(&resumed).unwrap();
    let server = f.state.lock();
    assert_eq!(server.files["/dst/pkg/a"], a);
    assert_eq!(server.files["/dst/b"], b);
    drop(server);
    assert!(checkpointed > 0);
    let _ = std::fs::remove_dir_all(&root);
    let _ = std::fs::remove_dir_all(&source);
}

/// The refusal side: a same-length source change after the restart makes
/// recovery fail without touching the destination.
#[test]
fn ftp_restart_recovery_refuses_a_same_length_source_change() {
    let source = std::env::temp_dir().join(format!("edgeterm-ftp-tamper-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&source).unwrap();
    let a = (0..3 * 1024 * 1024 + 17u32)
        .map(|n| n as u8)
        .collect::<Vec<_>>();
    std::fs::write(source.join("a"), &a).unwrap();

    let f = Fixture::new(Server {
        fail_append: 5,
        ..Server::default()
    });
    let root = f.root.join("journals");
    std::fs::create_dir_all(&root).unwrap();
    let (manager, _profile) = manager_for(&root, f.address.port());
    let item = Item {
        local: source.join("a").to_string_lossy().into(),
        remote: "/a".into(),
        upload: true,
        directory: false,
    };
    let id = "ftp-restart-tamper";
    let first = manager
        .start(
            None,
            "session".into(),
            vec![item.clone()],
            Some(id.into()),
            Options::default(),
            sink(),
        )
        .unwrap();
    assert!(run_to_completion(&first).is_err());
    drop(first);
    drop(manager);

    // Same length, different bytes.
    let mut tampered = a.clone();
    tampered[..8].copy_from_slice(&b"tampered"[..8]);
    std::fs::write(source.join("a"), &tampered).unwrap();
    f.state.lock().fail_append = 0;
    let (manager, profile) = manager_for(&root, f.address.port());
    let journal = manager.read_persisted(id).unwrap();
    let resumed = manager
        .adopt(
            None,
            journal,
            "session".into(),
            profile,
            Vec::new(),
            None,
            sink(),
        )
        .unwrap();
    let error = run_to_completion(&resumed).unwrap_err();
    assert!(error.to_string().contains("source changed"), "{error:?}");
    assert!(!f.state.lock().files.contains_key("/a"));
    let _ = std::fs::remove_dir_all(&root);
    let _ = std::fs::remove_dir_all(&source);
}
