//! A wire-protocol fixture: replies may be short, reordered, dropped or failed.
//! Tests exercise the real RawSftpSession and the production copy/commit paths.
use super::*;
use bytes::{Buf, Bytes};
use parking_lot::Mutex;
use russh_sftp::protocol::{Attrs, Data, Handle, Version};

#[derive(Default)]
struct Server {
    files: HashMap<String, Vec<u8>>,
    dirs: std::collections::HashSet<String>,
    links: HashMap<String, String>,
    fail_write_at: Option<u64>,
    /// Reads at or past this offset fail once, mirroring `fail_write_at`
    /// for interrupted downloads.
    fail_read_at: Option<u64>,
    stall_writes: bool,
    short_reads: bool,
    writes: Vec<u64>,
    pending: usize,
    peak: usize,
    /// Answers one request at a time and only then reads the next, sleeping
    /// the whole reply delay first: a single-threaded sftp-server, or a link
    /// that carries only so much per round trip. A request pipelined behind
    /// others therefore waits for all of them, which is the shape that used
    /// to be mistaken for a stalled request.
    serial: bool,
    /// Total silence after which the job declares this server stalled. The
    /// production value is 30 s; the fixture shortens it so a stall test stays
    /// fast, while the protocol deadline stays at production's value.
    idle_timeout_ms: u64,
    /// A rate limit the fixture's Remote paces with: the same shared
    /// bucket shape production builds from `Options::rate_limit_bps`.
    rate_limit_bps: Option<u64>,
    /// Arrival time and payload length of every data-bearing request, for
    /// burst/rate window checks.
    arrivals: Vec<(std::time::Instant, usize)>,
    /// Peak number of data requests answered concurrently (needs delay_ms).
    peak_data: usize,
    /// Data requests currently being answered, for `peak_data`.
    data_pending: usize,
    /// Write replies this server has scheduled but not yet delivered.
    pending_writes: usize,
    /// Whether a close request arrived while a write reply was still
    /// undelivered — the signal that the close was pipelined behind the
    /// final writes instead of waiting for their acknowledgements.
    close_with_pending_write: bool,
    delay_ms: u64,
    lose_rename_reply: bool,
    /// Rejects the first mkdir of this path once, the way a server that has
    /// not finished an in-flight parent mkdir would.
    fail_mkdir_once: Option<String>,
    /// Creates this file just before the next rename request is handled, the
    /// way another writer can between a client's check and its rename.
    appear_before_rename: Option<(String, Vec<u8>)>,
    counts: HashMap<String, usize>,
    /// Directory handles that already delivered their one page of entries;
    /// the next readdir on them answers EOF, the way a server that sent the
    /// whole listing in one page does.
    read_dirs: std::collections::HashSet<String>,
    /// File handles a close has retired. A write or read arriving after its
    /// handle's close fails, the way a real sftp-server rejects a
    /// closed-handle request — a close the client sent while writes were
    /// still in flight kills those writes here.
    closed: std::collections::HashSet<String>,
}

struct Fixture {
    state: Arc<Mutex<Server>>,
    remote: Arc<Remote>,
    root: PathBuf,
    task: tokio::task::JoinHandle<()>,
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.task.abort();
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

impl Fixture {
    async fn new(server: Server) -> Self {
        let root = std::env::temp_dir().join(format!("edgeterm-wire-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        let rate_limit = server.rate_limit_bps;
        // The production idle deadline is 30 s; a test that proves a stall is
        // caught cannot wait that long, so the fixture's default is 1 s.
        let idle_timeout = Duration::from_millis(if server.idle_timeout_ms == 0 {
            1000
        } else {
            server.idle_timeout_ms
        });
        let state = Arc::new(Mutex::new(server));
        let (client, stream) = tokio::io::duplex(2 * 1024 * 1024);
        let shared = state.clone();
        let task = tokio::spawn(async move {
            let (mut reader, writer) = tokio::io::split(stream);
            let writer = Arc::new(tokio::sync::Mutex::new(writer));
            while let Ok(length) = reader.read_u32().await {
                assert!(length < 1024 * 1024);
                let mut data = vec![0; length as usize];
                if reader.read_exact(&mut data).await.is_err() {
                    break;
                }
                let packet = Packet::try_from(&mut Bytes::from(data)).unwrap();
                let is_write = matches!(packet, Packet::Write(_));
                let is_data = matches!(packet, Packet::Read(_) | Packet::Write(_));
                let (serial, reply, delay) = {
                    let mut server = shared.lock();
                    let serial = server.serial;
                    let (reply, delay) = response(&mut server, packet);
                    // A serial server never has two replies in flight, so there
                    // is nothing to count; the concurrent path tracks them here.
                    if !serial && delay > 0 {
                        server.pending += 1;
                        server.peak = server.peak.max(server.pending);
                        if is_write {
                            server.pending_writes += 1;
                        }
                        if is_data {
                            server.data_pending += 1;
                            server.peak_data = server.peak_data.max(server.data_pending);
                        }
                    }
                    (serial, reply, delay)
                };
                let Some(reply) = reply else {
                    continue;
                };
                if serial {
                    // One request at a time: the reply is written before the
                    // next request is even read, so a pipelined request's wait
                    // includes every request ahead of it. This is what a
                    // single-threaded sftp-server, and a link drained chunk by
                    // chunk, look like from the client.
                    if delay > 0 {
                        tokio::time::sleep(Duration::from_millis(delay)).await;
                    }
                    let bytes = Bytes::try_from(reply).unwrap();
                    let _ = writer.lock().await.write_all(&bytes).await;
                    continue;
                }
                let state = shared.clone();
                let writer = writer.clone();
                tokio::spawn(async move {
                    if delay > 0 {
                        tokio::time::sleep(Duration::from_millis(delay)).await;
                        // Account for a reply before its bytes are written: a
                        // reply the client has received is one this task has
                        // already counted as delivered, so a close that finds
                        // a nonzero count really did overtake it.
                        let mut server = state.lock();
                        server.pending -= 1;
                        if is_write {
                            server.pending_writes -= 1;
                        }
                        if is_data {
                            server.data_pending -= 1;
                        }
                    }
                    let bytes = Bytes::try_from(reply).unwrap();
                    let _ = writer.lock().await.write_all(&bytes).await;
                });
            }
        });
        let raw = RawSftpSession::new(client);
        // Production's protocol deadline: a request's own wait must not decide
        // a stall, so the fixture never shortens this one — only the idle
        // watchdog above it is shortened.
        raw.set_timeout(REQUEST_TIMEOUT_SECS);
        raw.init().await.unwrap();
        let pacer = rate_limit.map(|rate| Arc::new(super::super::Pacer::new(rate)));
        // The production connect() shrinks its read/write lengths to the
        // pacer's slice; mirror that so paced tests exercise the same shape.
        let (read_len, write_len) = match &pacer {
            Some(p) => (p.slice(128 * 1024), p.slice(128 * 1024)),
            None => (128 * 1024, 128 * 1024),
        };
        let remote = Arc::new(Remote {
            raw,
            extensions: HashMap::new(),
            read_len,
            write_len,
            files: 4,
            requests: Semaphore::new(32),
            readback: 32,
            pacer,
            listings: Mutex::new(HashMap::new()),
            last_response: Mutex::new(std::time::Instant::now()),
            idle_timeout,
            _transport: None,
        });
        Self {
            state,
            remote,
            root,
            task,
        }
    }
    fn job(&self) -> Arc<Job> {
        super::super::test_job(self.root.clone())
    }
    fn count(&self, label: &str) -> usize {
        self.state.lock().counts.get(label).copied().unwrap_or(0)
    }
    fn upload(&self, bytes: &[u8]) -> Item {
        let path = self.root.join("source.bin");
        std::fs::write(&path, bytes).unwrap();
        Item {
            local: path.to_string_lossy().into(),
            remote: "/target".into(),
            upload: true,
            directory: false,
        }
    }
}

fn label(packet: &Packet) -> String {
    match packet {
        Packet::Open(_) => "open",
        Packet::Read(_) => "read",
        Packet::Write(_) => "write",
        Packet::Lstat(_) => "lstat",
        Packet::Stat(_) => "stat",
        Packet::FSetStat(_) => "fsetstat",
        Packet::SetStat(_) => "setstat",
        Packet::Fstat(_) => "fstat",
        Packet::Close(_) => "close",
        Packet::Rename(_) => "rename",
        Packet::Remove(_) => "remove",
        Packet::MkDir(_) => "mkdir",
        Packet::RmDir(_) => "rmdir",
        Packet::RealPath(_) => "realpath",
        Packet::OpenDir(_) => "opendir",
        Packet::ReadDir(_) => "readdir",
        Packet::Extended(p) => return p.request.clone(),
        _ => "other",
    }
    .into()
}

fn response(server: &mut Server, packet: Packet) -> (Option<Packet>, u64) {
    let id = packet.get_request_id();
    *server.counts.entry(label(&packet)).or_default() += 1;
    let mut delay = server.delay_ms;
    let reply = match packet {
        Packet::Init(_) => Packet::Version(Version {
            version: 3,
            extensions: HashMap::new(),
        }),
        Packet::Lstat(p) if server.links.contains_key(&p.path) => Packet::Attrs(Attrs {
            id,
            attrs: FileAttributes {
                permissions: Some(0o120777),
                ..FileAttributes::empty()
            },
        }),
        Packet::Lstat(p) if server.dirs.contains(&p.path) => Packet::Attrs(Attrs {
            id,
            attrs: FileAttributes {
                permissions: Some(0o040755),
                ..FileAttributes::empty()
            },
        }),
        Packet::Lstat(p) => match server.files.get(&p.path) {
            Some(data) => Packet::Attrs(Attrs {
                id,
                attrs: FileAttributes {
                    size: Some(data.len() as u64),
                    permissions: Some(0o100644),
                    mtime: Some(1),
                    ..FileAttributes::empty()
                },
            }),
            None => Packet::error(id, StatusCode::NoSuchFile),
        },
        Packet::Stat(p) => {
            let path = server.links.get(&p.path).unwrap_or(&p.path);
            if server.dirs.contains(path) {
                Packet::Attrs(Attrs {
                    id,
                    attrs: FileAttributes {
                        permissions: Some(0o040755),
                        ..FileAttributes::empty()
                    },
                })
            } else {
                Packet::Attrs(Attrs {
                    id,
                    attrs: FileAttributes {
                        size: Some(server.files[path].len() as u64),
                        permissions: Some(0o100644),
                        mtime: Some(1),
                        ..FileAttributes::empty()
                    },
                })
            }
        }
        Packet::Open(mut p) => {
            if let Some(path) = server.links.get(&p.filename) {
                p.filename = path.clone();
            }
            if p.pflags.contains(OpenFlags::EXCLUDE) && server.files.contains_key(&p.filename) {
                Packet::error(id, StatusCode::Failure)
            } else if p.pflags.contains(OpenFlags::CREATE) || server.files.contains_key(&p.filename)
            {
                server.files.entry(p.filename.clone()).or_default();
                // A new open of the same path is a new handle generation.
                server.closed.remove(&p.filename);
                Packet::Handle(Handle {
                    id,
                    handle: p.filename,
                })
            } else {
                Packet::error(id, StatusCode::NoSuchFile)
            }
        }
        Packet::Read(p) => {
            if server.closed.contains(&p.handle) {
                Packet::error(id, StatusCode::Failure)
            } else {
                let data = server.files.get(&p.handle).unwrap();
                let start = p.offset as usize;
                let count = if server.short_reads {
                    (p.len as usize).min(701)
                } else {
                    p.len as usize
                };
                if start >= data.len() {
                    Packet::error(id, StatusCode::Eof)
                } else if server.fail_read_at.is_some_and(|at| p.offset >= at) {
                    Packet::error(id, StatusCode::Failure)
                } else {
                    let sent = (start + count).min(data.len()) - start;
                    server.arrivals.push((std::time::Instant::now(), sent));
                    delay = server.delay_ms;
                    Packet::Data(Data {
                        id,
                        data: data[start..(start + count).min(data.len())].to_vec(),
                    })
                }
            }
        }
        Packet::Write(p) => {
            if server.closed.contains(&p.handle) {
                Packet::error(id, StatusCode::Failure)
            } else {
                server.writes.push(p.offset);
                server
                    .arrivals
                    .push((std::time::Instant::now(), p.data.len()));
                if server.fail_write_at.is_some_and(|at| p.offset >= at) {
                    Packet::error(id, StatusCode::Failure)
                } else {
                    let data = server.files.get_mut(&p.handle).unwrap();
                    let start = p.offset as usize;
                    data.resize(data.len().max(start + p.data.len()), 0);
                    data[start..start + p.data.len()].copy_from_slice(&p.data);
                    if server.stall_writes {
                        return (None, 0);
                    }
                    // Later chunks receive ACKs first, exercising contiguous checkpoints.
                    delay = server.delay_ms + if p.offset % (512 * 1024) == 0 { 12 } else { 1 };
                    Packet::error(id, StatusCode::Ok)
                }
            }
        }
        Packet::FSetStat(p) => {
            if server.closed.contains(&p.handle) {
                Packet::error(id, StatusCode::Failure)
            } else {
                if let Some(size) = p.attrs.size {
                    server
                        .files
                        .get_mut(&p.handle)
                        .unwrap()
                        .resize(size as usize, 0);
                }
                Packet::error(id, StatusCode::Ok)
            }
        }
        Packet::SetStat(_) => Packet::error(id, StatusCode::Ok),
        Packet::Close(p) => {
            server.close_with_pending_write = server.pending_writes > 0;
            server.closed.insert(p.handle);
            Packet::error(id, StatusCode::Ok)
        }
        Packet::OpenDir(p) => {
            if p.path == "/" || server.dirs.contains(&p.path) {
                // A fresh opendir delivers a fresh page: the one-page
                // marker is per handle generation, not per directory
                // forever (a real single-page server resends the page to
                // every new opendir, which is what a re-plan after a
                // restart relies on).
                server.read_dirs.remove(&p.path);
                Packet::Handle(Handle { id, handle: p.path })
            } else {
                Packet::error(id, StatusCode::NoSuchFile)
            }
        }
        Packet::ReadDir(p) => {
            if !server.read_dirs.insert(p.handle.clone()) {
                return (Some(Packet::error(id, StatusCode::Eof)), 0);
            }
            let dir = p.handle.trim_end_matches('/');
            let mut entries = Vec::new();
            let mut push = |name: &str, attrs: FileAttributes| {
                entries.push(russh_sftp::protocol::File {
                    filename: name.to_string(),
                    longname: String::new(),
                    attrs,
                });
            };
            for (path, data) in &server.files {
                if parent_of(path) == dir {
                    push(
                        path.rsplit('/').next().unwrap(),
                        FileAttributes {
                            size: Some(data.len() as u64),
                            permissions: Some(0o100644),
                            mtime: Some(1),
                            ..FileAttributes::empty()
                        },
                    );
                }
            }
            for path in &server.dirs {
                if parent_of(path) == dir {
                    push(
                        path.rsplit('/').next().unwrap(),
                        FileAttributes {
                            permissions: Some(0o040755),
                            mtime: Some(1),
                            ..FileAttributes::empty()
                        },
                    );
                }
            }
            for path in server.links.keys() {
                if parent_of(path) == dir {
                    push(
                        path.rsplit('/').next().unwrap(),
                        FileAttributes {
                            permissions: Some(0o120777),
                            ..FileAttributes::empty()
                        },
                    );
                }
            }
            if entries.is_empty() {
                Packet::error(id, StatusCode::Eof)
            } else {
                Packet::Name(russh_sftp::protocol::Name { id, files: entries })
            }
        }
        Packet::MkDir(p) => {
            if server.dirs.contains(&p.path) || server.files.contains_key(&p.path) {
                Packet::error(id, StatusCode::Failure)
            } else if server.fail_mkdir_once.as_deref() == Some(p.path.as_str()) {
                server.fail_mkdir_once = None;
                Packet::error(id, StatusCode::NoSuchFile)
            } else {
                // A real sftp-server refuses a directory whose parent has
                // not been created yet, so an ordering mistake in a
                // pipelined plan cannot slip through as a success.
                let parent_missing = match p.path.rsplit_once('/') {
                    Some(("", _)) => false,
                    Some((parent, _)) => !server.dirs.contains(parent),
                    None => false,
                };
                if parent_missing {
                    Packet::error(id, StatusCode::NoSuchFile)
                } else {
                    server.dirs.insert(p.path.clone());
                    Packet::error(id, StatusCode::Ok)
                }
            }
        }
        Packet::RealPath(p) => Packet::Name(russh_sftp::protocol::Name {
            id,
            files: vec![russh_sftp::protocol::File {
                filename: p.path.trim_end_matches('/').to_string(),
                longname: String::new(),
                attrs: FileAttributes::empty(),
            }],
        }),
        Packet::Rename(p) => {
            if let Some((path, data)) = server.appear_before_rename.take() {
                server.files.insert(path, data);
            }
            if server.files.contains_key(&p.newpath) {
                Packet::error(id, StatusCode::Failure)
            } else if let Some(data) = server.files.remove(&p.oldpath) {
                server.files.insert(p.newpath.clone(), data);
                if server.lose_rename_reply && p.newpath == "/target" {
                    server.lose_rename_reply = false;
                    return (None, 0);
                }
                Packet::error(id, StatusCode::Ok)
            } else {
                Packet::error(id, StatusCode::NoSuchFile)
            }
        }
        Packet::Extended(p) if p.request == "fsync@openssh.com" => {
            Packet::error(id, StatusCode::Ok)
        }
        Packet::Extended(p) if p.request == "posix-rename@openssh.com" => {
            let mut bytes = Bytes::from(p.data);
            let n = bytes.get_u32() as usize;
            let from = String::from_utf8(bytes.copy_to_bytes(n).to_vec()).unwrap();
            let n = bytes.get_u32() as usize;
            let to = String::from_utf8(bytes.copy_to_bytes(n).to_vec()).unwrap();
            if let Some((path, data)) = server.appear_before_rename.take() {
                server.files.insert(path, data);
            }
            let data = server.files.remove(&from).unwrap();
            server.files.insert(to, data);
            Packet::error(id, StatusCode::Ok)
        }
        Packet::Remove(p) => {
            if server.files.remove(&p.filename).is_some() {
                Packet::error(id, StatusCode::Ok)
            } else {
                Packet::error(id, StatusCode::NoSuchFile)
            }
        }
        other => panic!("unimplemented fixture packet: {other:?}"),
    };
    (Some(reply), delay)
}

fn payload(size: usize) -> Vec<u8> {
    (0..size)
        .map(|n| (n.wrapping_mul(13) ^ (n >> 12)) as u8)
        .collect()
}

/// The directory that holds `path`, with the root kept as "/".
fn parent_of(path: &str) -> &str {
    match path.rsplit_once('/') {
        Some(("", _)) => "/",
        Some((parent, _)) => parent,
        None => "/",
    }
}

#[tokio::test]
async fn source_file_links_are_read_but_destination_links_are_not_replaced() {
    let f = Fixture::new(Server {
        files: HashMap::from([("/source".into(), b"linked contents".to_vec())]),
        links: HashMap::from([("/alias".into(), "/source".into())]),
        ..Server::default()
    })
    .await;
    let job = f.job();
    let target = f.root.join("download");
    let item = Item {
        local: target.to_string_lossy().into(),
        remote: "/alias".into(),
        upload: false,
        directory: false,
    };
    copy(&job, &f.remote, item.clone(), 4, &Semaphore::new(2))
        .await
        .unwrap();
    assert_eq!(std::fs::read(target).unwrap(), b"linked contents");
    assert!(copy(
        &job,
        &f.remote,
        Item {
            upload: true,
            ..item
        },
        4,
        &Semaphore::new(2)
    )
    .await
    .unwrap_err()
    .message
    .contains("symlink"));
    assert_eq!(f.state.lock().files["/source"], b"linked contents");
}

#[tokio::test]
async fn upload_resumes_only_confirmed_prefix_after_out_of_order_acknowledgements() {
    let f = Fixture::new(Server {
        files: HashMap::from([("/target".into(), b"original".to_vec())]),
        fail_write_at: Some(4 * 1024 * 1024),
        ..Server::default()
    })
    .await;
    let bytes = payload(5 * 1024 * 1024 + 91);
    let item = f.upload(&bytes);
    let job = f.job();
    let large = Semaphore::new(2);
    assert!(copy(&job, &f.remote, item.clone(), 8, &large)
        .await
        .is_err());
    let cp = job.checkpoint(&job.key(&item)).unwrap();
    assert_eq!(cp.offset, 4 * 1024 * 1024);
    assert_eq!(f.state.lock().files["/target"], b"original");
    assert!(f.state.lock().peak > 1, "writes must be pipelined");
    f.state.lock().fail_write_at = None;
    f.state.lock().writes.clear();
    copy(&job, &f.remote, item.clone(), 8, &large)
        .await
        .unwrap();
    assert!(f
        .state
        .lock()
        .writes
        .iter()
        .all(|&offset| offset >= cp.offset));
    assert_eq!(f.state.lock().files["/target"], bytes);
    assert!(job.checkpoint(&job.key(&item)).unwrap().complete);
}

#[tokio::test]
async fn short_data_packets_are_completed_and_the_original_is_replaced_only_on_success() {
    let bytes = payload(300_007);
    let f = Fixture::new(Server {
        files: HashMap::from([("/source".into(), bytes.clone())]),
        short_reads: true,
        ..Server::default()
    })
    .await;
    let job = f.job();
    let target = f.root.join("target");
    std::fs::write(&target, b"old").unwrap();
    let item = Item {
        local: target.to_string_lossy().into(),
        remote: "/source".into(),
        upload: false,
        directory: false,
    };
    copy(&job, &f.remote, item, 8, &Semaphore::new(2))
        .await
        .unwrap();
    assert_eq!(std::fs::read(target).unwrap(), bytes);
}

#[tokio::test]
async fn a_stalled_write_times_out_without_replacing_the_destination() {
    let f = Fixture::new(Server {
        files: HashMap::from([("/target".into(), b"old".to_vec())]),
        stall_writes: true,
        ..Server::default()
    })
    .await;
    let item = f.upload(b"new");
    let job = f.job();
    let result = tokio::time::timeout(
        Duration::from_secs(3),
        copy(&job, &f.remote, item.clone(), 8, &Semaphore::new(2)),
    )
    .await
    .unwrap()
    .unwrap_err();
    assert_eq!(result.code, "timeout");
    assert_eq!(job.checkpoint(&job.key(&item)).unwrap().offset, 0);
    assert_eq!(f.state.lock().files["/target"], b"old");
}

/// The same pipeline against a server that answers one request at a time and
/// spends real time on each. A request's wait therefore grows with the backlog
/// ahead of it, while progress itself never stops. That wait used to be cut
/// off at a per-request deadline and reported as a stall, which turned a slow
/// server or link into a retry loop; the transfer must instead finish.
#[tokio::test]
async fn a_slow_serial_server_does_not_stall_a_pipelined_upload() {
    let f = Fixture::new(Server {
        serial: true,
        delay_ms: 250,
        ..Server::default()
    })
    .await;
    let bytes = payload(2 * 1024 * 1024);
    let item = f.upload(&bytes);
    let job = f.job();
    let started = std::time::Instant::now();
    copy(&job, &f.remote, item.clone(), 8, &Semaphore::new(2))
        .await
        .unwrap();
    assert!(
        started.elapsed() < Duration::from_secs(30),
        "sixteen serialised replies at 250 ms each fit well inside this bound"
    );
    assert_eq!(f.state.lock().files["/target"], bytes);
    assert!(job.checkpoint(&job.key(&item)).unwrap().complete);
}

/// The download side of the same queue, where the backlog is server replies
/// rather than writes.
#[tokio::test]
async fn a_slow_serial_server_does_not_stall_a_pipelined_download() {
    let bytes = payload(2 * 1024 * 1024);
    let f = Fixture::new(Server {
        serial: true,
        delay_ms: 250,
        files: HashMap::from([("/source".into(), bytes.clone())]),
        ..Server::default()
    })
    .await;
    let job = f.job();
    let target = f.root.join("download");
    let item = Item {
        local: target.to_string_lossy().into(),
        remote: "/source".into(),
        upload: false,
        directory: false,
    };
    let started = std::time::Instant::now();
    copy(&job, &f.remote, item, 8, &Semaphore::new(2))
        .await
        .unwrap();
    assert!(
        started.elapsed() < Duration::from_secs(30),
        "the pipelined reads must outlive their own queue"
    );
    assert_eq!(std::fs::read(target).unwrap(), bytes);
}

#[tokio::test]
async fn pause_interrupts_a_stalled_write_and_resume_reuses_the_job() {
    let f = Fixture::new(Server {
        stall_writes: true,
        ..Server::default()
    })
    .await;
    let bytes = payload(600_001);
    let item = f.upload(&bytes);
    let job = f.job();
    let running_job = job.clone();
    let remote = f.remote.clone();
    let running_item = item.clone();
    let task = tokio::spawn(async move {
        copy(&running_job, &remote, running_item, 8, &Semaphore::new(2)).await
    });
    tokio::time::timeout(Duration::from_secs(3), async {
        while f.state.lock().writes.is_empty() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    job.control.set(1);
    let error = tokio::time::timeout(Duration::from_millis(500), task)
        .await
        .unwrap()
        .unwrap()
        .unwrap_err();
    assert_eq!(error.code, "paused");
    job.control.set(0);
    f.state.lock().stall_writes = false;
    copy(&job, &f.remote, item, 8, &Semaphore::new(2))
        .await
        .unwrap();
    assert_eq!(f.state.lock().files["/target"], bytes);
}

#[tokio::test]
async fn retry_reconciles_a_successful_rename_whose_reply_was_lost() {
    let f = Fixture::new(Server {
        files: HashMap::from([("/target".into(), b"old".to_vec())]),
        lose_rename_reply: true,
        ..Server::default()
    })
    .await;
    let item = f.upload(b"new contents");
    let job = f.job();
    let large = Semaphore::new(2);
    assert!(copy(&job, &f.remote, item.clone(), 8, &large)
        .await
        .is_err());
    assert_eq!(f.state.lock().files["/target"], b"new contents");
    f.state.lock().writes.clear();
    copy(&job, &f.remote, item.clone(), 8, &large)
        .await
        .unwrap();
    assert!(f.state.lock().writes.is_empty());
    assert!(!f
        .state
        .lock()
        .files
        .keys()
        .any(|name| name.ends_with(".backup")));
    assert!(job.checkpoint(&job.key(&item)).unwrap().complete);
}

#[tokio::test]
async fn posix_rename_replaces_the_target_without_touching_an_unowned_backup() {
    let mut f = Fixture::new(Server {
        files: HashMap::from([("/target".into(), b"old".to_vec())]),
        ..Server::default()
    })
    .await;
    Arc::get_mut(&mut f.remote)
        .unwrap()
        .extensions
        .insert("posix-rename@openssh.com".into(), "1".into());
    let item = f.upload(b"new contents");
    let job = f.job();
    let backup = format!("/.edgeterm-{}.backup", job.key(&item));
    f.state
        .lock()
        .files
        .insert(backup.clone(), b"unowned file".to_vec());
    copy(&job, &f.remote, item, 8, &Semaphore::new(2))
        .await
        .unwrap();
    assert_eq!(f.state.lock().files["/target"], b"new contents");
    assert_eq!(f.state.lock().files[&backup], b"unowned file");
}

#[tokio::test]
async fn source_changes_and_partial_tampering_block_resume() {
    let f = Fixture::new(Server {
        fail_write_at: Some(4 * 1024 * 1024),
        ..Server::default()
    })
    .await;
    let bytes = payload(5 * 1024 * 1024);
    let item = f.upload(&bytes);
    let job = f.job();
    let large = Semaphore::new(2);
    assert!(copy(&job, &f.remote, item.clone(), 8, &large)
        .await
        .is_err());
    let cp = job.checkpoint(&job.key(&item)).unwrap();
    f.state.lock().files.get_mut(&cp.temporary).unwrap()[12345] ^= 1;
    f.state.lock().fail_write_at = None;
    assert!(copy(&job, &f.remote, item.clone(), 8, &large)
        .await
        .unwrap_err()
        .message
        .contains("checkpoint changed"));
    std::fs::write(&item.local, b"changed").unwrap();
    assert!(copy(&job, &f.remote, item.clone(), 8, &large)
        .await
        .unwrap_err()
        .message
        .contains("source changed"));
    assert!(!f.state.lock().files.contains_key("/target"));
}

/// A batch may hold more large files than the two slots that transfer at
/// once. Waiting for a slot is a local wait: it must not be reported as a
/// timeout while the files ahead are still moving, and a cancel must still
/// interrupt it at once.
#[tokio::test]
async fn a_large_file_waiting_for_its_slot_is_not_a_timeout_and_still_cancels() {
    let f = Fixture::new(Server::default()).await;
    let bytes = payload(16 * 1024 * 1024 + 1);
    let item = f.upload(&bytes);
    let job = f.job();
    let large = Arc::new(Semaphore::new(2));
    let _first = large.clone().acquire_owned().await.unwrap();
    let _second = large.clone().acquire_owned().await.unwrap();
    let task = {
        let job = job.clone();
        let remote = f.remote.clone();
        let item = item.clone();
        let large = large.clone();
        tokio::spawn(async move { copy(&job, &remote, item, 8, &large).await })
    };
    // Long enough for the copy to reach the slot and settle there.
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(
        !task.is_finished(),
        "a large file must wait for a slot, not fail: {:?}",
        task.is_finished()
    );
    job.control.set(2);
    let error = tokio::time::timeout(Duration::from_secs(2), task)
        .await
        .expect("cancel must interrupt the slot wait")
        .unwrap()
        .unwrap_err();
    assert_eq!(error.code, "cancelled");
}

/// The slot wait used to run inside the 30 s operation deadline, so a batch
/// with three or more large files failed the waiting one while the first two
/// were still legitimately transferring — and the retry repeated it. This must
/// actually wait out that deadline, so it is ignored by default and run
/// explicitly; see the commit's `Tests:` line.
#[tokio::test]
#[ignore = "waits out the old 30 s slot deadline; run explicitly with --ignored"]
async fn a_large_file_waiting_for_a_slot_outlives_the_old_deadline() {
    let f = Fixture::new(Server::default()).await;
    let bytes = payload(16 * 1024 * 1024 + 1);
    let item = f.upload(&bytes);
    let job = f.job();
    let large = Arc::new(Semaphore::new(2));
    let first = large.clone().acquire_owned().await.unwrap();
    let second = large.clone().acquire_owned().await.unwrap();
    let task = {
        let job = job.clone();
        let remote = f.remote.clone();
        let item = item.clone();
        let large = large.clone();
        tokio::spawn(async move { copy(&job, &remote, item, 8, &large).await })
    };
    tokio::time::sleep(Duration::from_secs(31)).await;
    assert!(
        !task.is_finished(),
        "the slot wait must outlive the old 30 s operation deadline"
    );
    drop(first);
    drop(second);
    task.await.unwrap().unwrap();
    assert_eq!(f.state.lock().files["/target"], bytes);
}

#[tokio::test]
async fn a_failed_file_does_not_block_other_files_in_the_batch() {
    let f = Fixture::new(Server {
        files: HashMap::from([("/source".into(), b"good".to_vec())]),
        ..Server::default()
    })
    .await;
    let job = f.job();
    let items = vec![
        Item {
            local: f.root.join("bad").to_string_lossy().into(),
            remote: "/missing".into(),
            upload: false,
            directory: false,
        },
        Item {
            local: f.root.join("good").to_string_lossy().into(),
            remote: "/source".into(),
            upload: false,
            directory: false,
        },
    ];
    assert!(copy_files(&job, &f.remote, items).await.is_err());
    assert_eq!(std::fs::read(f.root.join("good")).unwrap(), b"good");
    assert_eq!(job.snapshot.lock().failed_files.len(), 1);
    assert_eq!(job.snapshot.lock().completed_files, 1);
}

#[tokio::test]
async fn cancel_restores_an_original_moved_before_interrupted_commit() {
    let f = Fixture::new(Server {
        files: HashMap::from([("/target".into(), b"original".to_vec())]),
        stall_writes: true,
        ..Server::default()
    })
    .await;
    let item = f.upload(b"new");
    let job = f.job();
    assert!(copy(&job, &f.remote, item.clone(), 8, &Semaphore::new(2))
        .await
        .is_err());
    let mut cp = job.checkpoint(&job.key(&item)).unwrap();
    cp.committing = true;
    cp.owns_backup = true;
    {
        let mut state = f.state.lock();
        let old = state.files.remove("/target").unwrap();
        state.files.insert(cp.backup.clone(), old);
    }
    cleanup_remote(&f.remote, vec![cp.clone()], None)
        .await
        .unwrap();
    assert_eq!(f.state.lock().files["/target"], b"original");
    assert!(!f.state.lock().files.contains_key(&cp.temporary));
    assert!(!f.state.lock().files.contains_key(&cp.backup));
}

#[tokio::test]
async fn local_resume_discards_unconfirmed_tail_and_rejects_changed_destination() {
    let bytes = payload(300_007);
    let f = Fixture::new(Server {
        files: HashMap::from([("/source".into(), bytes.clone())]),
        ..Server::default()
    })
    .await;
    let job = f.job();
    let target = f.root.join("target");
    std::fs::write(&target, b"old").unwrap();
    let item = Item {
        local: target.to_string_lossy().into(),
        remote: "/source".into(),
        upload: false,
        directory: false,
    };
    let key = job.key(&item);
    let temp = local::sibling(&target, &key, "part").unwrap();
    std::fs::write(&temp, [&bytes[..131072], b"unconfirmed tail"].concat()).unwrap();
    let cp = Checkpoint {
        key,
        item: item.clone(),
        source: f
            .remote
            .signature("/source", &job.control)
            .await
            .unwrap()
            .unwrap(),
        original: local::target_signature(&target).unwrap(),
        temporary: temp.to_string_lossy().into(),
        backup: String::new(),
        offset: 131072,
        prefix_hash: local::digest(&bytes[..131072]),
        complete: false,
        committing: false,
        owns_temporary: true,
        owns_backup: false,
    };
    job.save(&cp).unwrap();
    std::fs::write(&target, b"external edit").unwrap();
    let error = copy(&job, &f.remote, item.clone(), 8, &Semaphore::new(2))
        .await
        .unwrap_err();
    assert!(error.message.contains("destination changed"));
    assert_eq!(std::fs::read(&target).unwrap(), b"external edit");
    assert_eq!(std::fs::read(temp).unwrap(), bytes);
}

#[tokio::test]
async fn fresh_upload_takes_the_small_file_fast_path() {
    let mut f = Fixture::new(Server::default()).await;
    {
        let remote = Arc::get_mut(&mut f.remote).unwrap();
        remote
            .extensions
            .insert("fsync@openssh.com".into(), "1".into());
        remote
            .extensions
            .insert("posix-rename@openssh.com".into(), "1".into());
    }
    let item = f.upload(b"fast path");
    let job = f.job();
    copy(&job, &f.remote, item.clone(), 4, &Semaphore::new(2))
        .await
        .unwrap();
    assert_eq!(f.state.lock().files["/target"], b"fast path");
    // Five round trips per fresh file: probe the destination, create the
    // partial, write it, close it and rename it into place. Stat'ing the
    // partial this run just created, truncating a zero offset, probing for
    // a backup that cannot exist and flushing the server's disk are all
    // skipped on this path.
    assert_eq!(f.count("lstat"), 2);
    assert_eq!(f.count("open"), 1);
    assert_eq!(f.count("write"), 1);
    assert_eq!(f.count("close"), 1);
    // A fresh file is committed with the plain rename, which refuses an
    // existing target; posix-rename is kept for replacing a file that was
    // there when the transfer started.
    assert_eq!(f.count("rename"), 1);
    assert_eq!(f.count("posix-rename@openssh.com"), 0);
    assert_eq!(f.count("fsetstat"), 0);
    assert_eq!(f.count("fsync@openssh.com"), 0);
}

/// The close runs only after every write has been acknowledged. The
/// previous implementation queued the close beside the pipelined writes;
/// the write futures are lazy (they charge the pacer and take their
/// permit when first polled), so under pacing the close could reach the
/// server while writes were still waiting, and a real sftp-server then
/// failed the late writes against a closed handle. The fixture now
/// retires a handle at close and fails late writes, so a raced close
/// fails this test outright.
#[tokio::test]
async fn the_close_waits_for_every_write_acknowledgement() {
    let f = Fixture::new(Server {
        delay_ms: 2,
        ..Server::default()
    })
    .await;
    let bytes = payload(300_007);
    let item = f.upload(&bytes);
    let job = f.job();
    copy(&job, &f.remote, item.clone(), 4, &Semaphore::new(2))
        .await
        .unwrap();
    assert_eq!(f.state.lock().files["/target"], bytes);
    assert!(
        !f.state.lock().close_with_pending_write,
        "the close overlapped write replies still in flight"
    );
}

/// The same barrier under a low rate with a short final window: the last
/// pipeline window is not full, several write futures are still waiting
/// for budget when the end is reached, and the close must not overtake
/// them. The fixture fails any write that arrives after its close, so a
/// clean finish with intact content is the assertion.
#[tokio::test]
async fn a_paced_upload_with_a_short_final_window_commits_intact() {
    let rate = 64 * 1024u64;
    let f = Fixture::new(Server {
        rate_limit_bps: Some(rate),
        ..Server::default()
    })
    .await;
    let bytes = payload(150_003);
    let item = f.upload(&bytes);
    let job = f.job();
    copy(&job, &f.remote, item, 4, &Semaphore::new(2))
        .await
        .unwrap();
    assert_eq!(f.state.lock().files["/target"], bytes);
    assert!(f.count("close") >= 1);
}

/// A fresh small file journals twice: the checkpoint that claims the
/// partial, and the completion. The previous implementation wrote the
/// journal six times per file, and each write is a blocking disk call.
#[tokio::test]
async fn a_small_file_batch_journals_its_start_and_its_end_only() {
    let f = Fixture::new(Server::default()).await;
    let job = f.job();
    local::save_counts::register(&job.directory);
    let mut items = Vec::new();
    for n in 0..100 {
        let path = f.root.join(format!("small-{n}"));
        std::fs::write(&path, payload(4096)).unwrap();
        items.push(Item {
            local: path.to_string_lossy().into(),
            remote: format!("/small-{n}"),
            upload: true,
            directory: false,
        });
    }
    copy_files(&job, &f.remote, items).await.unwrap();
    let saves = local::save_counts::count(&job.directory);
    local::save_counts::clear(&job.directory);
    assert_eq!(saves, 200);
    assert_eq!(f.state.lock().files.len(), 100);
    assert_eq!(job.snapshot.lock().completed_files, 100);
}

/// A file past the first chunk keeps every checkpoint: its resume prefix is
/// worth the disk write, so the coalescing does not reach it.
#[tokio::test]
async fn a_multi_chunk_file_keeps_its_checkpoints() {
    let f = Fixture::new(Server::default()).await;
    let job = f.job();
    local::save_counts::register(&job.directory);
    let bytes = payload(3 * 128 * 1024 + 17);
    let item = f.upload(&bytes);
    copy(&job, &f.remote, item.clone(), 4, &Semaphore::new(2))
        .await
        .unwrap();
    let saves = local::save_counts::count(&job.directory);
    local::save_counts::clear(&job.directory);
    assert_eq!(f.state.lock().files["/target"], bytes);
    assert_eq!(saves, 6);
}

/// A coalesced journal does not record the commit, so a retry can find the
/// partial renamed away with the completion unsaved. The job counts the file
/// as done when the destination holds exactly the bytes this job wrote: the
/// same size and the same digest as the local source.
#[tokio::test]
async fn a_retry_counts_a_file_done_when_the_target_holds_what_the_job_wrote() {
    let f = Fixture::new(Server::default()).await;
    let bytes = b"the whole file".to_vec();
    let item = f.upload(&bytes);
    let job = f.job();
    let key = job.key(&item);
    // The state a crash between the rename and the completion save leaves:
    // the partial is gone, the destination holds the file, and the journal
    // still says the file is unfinished.
    f.state.lock().files.insert("/target".into(), bytes.clone());
    let cp = Checkpoint {
        key,
        item: item.clone(),
        source: local::signature(Path::new(&item.local)).unwrap(),
        original: None,
        temporary: format!("/.edgeterm-{}.part", job.key(&item)),
        backup: String::new(),
        offset: 0,
        prefix_hash: local::digest(&[]),
        complete: false,
        committing: false,
        owns_temporary: true,
        owns_backup: false,
    };
    job.save(&cp).unwrap();
    f.state.lock().writes.clear();
    copy(&job, &f.remote, item.clone(), 4, &Semaphore::new(2))
        .await
        .unwrap();
    assert!(f.state.lock().writes.is_empty(), "the file was rewritten");
    assert_eq!(f.state.lock().files["/target"], bytes);
    assert!(job.checkpoint(&job.key(&item)).unwrap().complete);
}

/// The same recovery refuses when the destination holds anything else: a
/// destination this job never wrote is never adopted as its result.
#[tokio::test]
async fn a_retry_reports_a_conflict_when_the_target_is_not_what_the_job_wrote() {
    let f = Fixture::new(Server::default()).await;
    let item = f.upload(b"the whole file");
    let job = f.job();
    f.state
        .lock()
        .files
        .insert("/target".into(), b"someone else's file".to_vec());
    let cp = Checkpoint {
        key: job.key(&item),
        item: item.clone(),
        source: local::signature(Path::new(&item.local)).unwrap(),
        original: None,
        temporary: format!("/.edgeterm-{}.part", job.key(&item)),
        backup: String::new(),
        offset: 0,
        prefix_hash: local::digest(&[]),
        complete: false,
        committing: false,
        owns_temporary: true,
        owns_backup: false,
    };
    job.save(&cp).unwrap();
    let error = copy(&job, &f.remote, item.clone(), 4, &Semaphore::new(2))
        .await
        .unwrap_err();
    assert!(error.message.contains("remote partial disappeared"));
    assert_eq!(f.state.lock().files["/target"], b"someone else's file");
}

/// The download side of the same rule: the local partial is gone and the
/// local destination already holds the source's bytes.
#[tokio::test]
async fn a_download_retry_counts_a_file_done_when_the_target_holds_the_source() {
    let f = Fixture::new(Server {
        files: HashMap::from([("/source".into(), b"download me".to_vec())]),
        ..Server::default()
    })
    .await;
    let job = f.job();
    let target = f.root.join("target");
    std::fs::write(&target, b"download me").unwrap();
    let item = Item {
        local: target.to_string_lossy().into(),
        remote: "/source".into(),
        upload: false,
        directory: false,
    };
    let key = job.key(&item);
    let cp = Checkpoint {
        key: key.clone(),
        item: item.clone(),
        source: f
            .remote
            .signature("/source", &job.control)
            .await
            .unwrap()
            .unwrap(),
        original: None,
        temporary: local::sibling(&target, &key, "part")
            .unwrap()
            .to_string_lossy()
            .into(),
        backup: String::new(),
        offset: 0,
        prefix_hash: local::digest(&[]),
        complete: false,
        committing: false,
        owns_temporary: true,
        owns_backup: false,
    };
    job.save(&cp).unwrap();
    copy(&job, &f.remote, item.clone(), 4, &Semaphore::new(2))
        .await
        .unwrap();
    assert_eq!(std::fs::read(&target).unwrap(), b"download me");
    assert!(job.checkpoint(&key).unwrap().complete);
    // Two reads sample the source signature and one verifies the recovery;
    // no data transfer happened.
    assert_eq!(f.count("read"), 3);
}

/// A journal save is a blocking disk write. Run inside an async fn it holds
/// the runtime thread, so every other task on that thread (other files of the
/// batch, the session's own IO) waits for it. The saves are slowed to 100 ms
/// here and a ticker task measures the longest time it was kept from running.
#[tokio::test]
async fn journal_saves_do_not_block_the_async_runtime() {
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::time::{Duration, Instant};

    let f = Fixture::new(Server::default()).await;
    let item = f.upload(b"small file");
    let job = f.job();
    local::slow_saves::register(&job.directory, Duration::from_millis(100));

    let stop = Arc::new(AtomicBool::new(false));
    let ticker = {
        let stop = stop.clone();
        tokio::spawn(async move {
            let mut worst = Duration::ZERO;
            let mut last = Instant::now();
            while !stop.load(Ordering::Relaxed) {
                tokio::time::sleep(Duration::from_millis(2)).await;
                let now = Instant::now();
                worst = worst.max(now - last);
                last = now;
            }
            worst
        })
    };
    let result = copy(&job, &f.remote, item, 4, &Semaphore::new(2)).await;
    stop.store(true, Ordering::Relaxed);
    let worst = ticker.await.unwrap();
    local::slow_saves::clear(&job.directory);

    result.unwrap();
    assert_eq!(f.state.lock().files["/target"], b"small file");
    assert!(
        worst < Duration::from_millis(50),
        "a journal save held the runtime for {worst:?}"
    );
}

/// The commit checks that the destination is still absent, then renames. A
/// file another writer creates in between must not be replaced: with
/// posix-rename (which overwrites) that check-then-rename left a window, so a
/// fresh upload now uses the plain rename, which refuses an existing target.
#[tokio::test]
async fn a_target_created_during_commit_is_not_overwritten_by_a_fresh_upload() {
    let mut f = Fixture::new(Server {
        appear_before_rename: Some(("/target".into(), b"someone else".to_vec())),
        ..Server::default()
    })
    .await;
    Arc::get_mut(&mut f.remote)
        .unwrap()
        .extensions
        .insert("posix-rename@openssh.com".into(), "1".into());
    let item = f.upload(b"mine");
    let job = f.job();
    let error = copy(&job, &f.remote, item, 4, &Semaphore::new(2))
        .await
        .unwrap_err();
    assert_eq!(error.code, "conflict");
    assert_eq!(f.state.lock().files["/target"], b"someone else");
}

/// A source signature samples the first and the last 64 KiB. For a file that
/// fits in one sample those are the same bytes, so reading them twice costs a
/// round trip for nothing, and a download takes the signature twice (before
/// and after the copy). The signature itself must not change: a checkpoint
/// stores it and a resumed transfer compares against it.
#[tokio::test]
async fn a_small_download_reads_each_byte_range_once_per_signature() {
    let f = Fixture::new(Server {
        files: HashMap::from([("/source".into(), b"download me".to_vec())]),
        ..Server::default()
    })
    .await;
    let job = f.job();
    let target = f.root.join("download");
    let item = Item {
        local: target.to_string_lossy().into(),
        remote: "/source".into(),
        upload: false,
        directory: false,
    };
    copy(&job, &f.remote, item.clone(), 4, &Semaphore::new(2))
        .await
        .unwrap();
    assert_eq!(std::fs::read(&target).unwrap(), b"download me");
    // One read for each of the two signatures and one for the data.
    assert_eq!(f.count("read"), 3);
    assert_eq!(f.count("lstat"), 2);
    assert_eq!(f.count("open"), 3);

    // The stored signature is the one the sampled bytes have always produced:
    // SHA-256 over the sample taken twice.
    let stored = job.checkpoint(&job.key(&item)).unwrap().source;
    let mut context = Context::new(&SHA256);
    context.update(b"download me");
    context.update(b"download me");
    assert_eq!(stored.sample, local::hex(context.finish().as_ref()));
}

/// Uploads a real folder to a real SFTP server through the production
/// connect, plan and copy paths, and prints the time of each phase. It needs
/// a server, so it is ignored by default:
///
/// ```text
/// EDGETERM_BENCH_ADDR=127.0.0.1:2300 EDGETERM_BENCH_USER=me \
/// EDGETERM_BENCH_KEY=/path/to/key EDGETERM_BENCH_SOURCE=/path/to/folder \
/// EDGETERM_BENCH_REMOTE=/remote/empty/dir \
/// cargo test --lib benchmark_real_server_folder_upload -- --ignored --nocapture
/// ```
///
/// The remote directory should not exist yet or be empty. Host keys go to a
/// scratch file, not the user's known_hosts. It prints numbers and asserts
/// only that every file arrived; run it with a release build for figures.
#[tokio::test]
#[ignore = "needs a real SFTP server; see the doc comment for the environment"]
async fn benchmark_real_server_folder_upload() {
    let var = |name: &str| std::env::var(name).unwrap_or_else(|_| panic!("{name} must be set"));
    let address = var("EDGETERM_BENCH_ADDR");
    let (host, port) = address
        .rsplit_once(':')
        .expect("EDGETERM_BENCH_ADDR is host:port");
    let scratch = std::env::temp_dir().join(format!("edgeterm-bench-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&scratch).unwrap();
    let transport = crate::session::ssh::test_transport(
        host,
        port.parse().expect("numeric port"),
        &var("EDGETERM_BENCH_USER"),
        &var("EDGETERM_BENCH_KEY"),
        &scratch.join("known_hosts"),
    )
    .await;
    let source = PathBuf::from(var("EDGETERM_BENCH_SOURCE"));
    let files = walk_count(&source);
    let job = super::super::test_job_items(
        scratch.clone(),
        vec![Item {
            local: source.to_string_lossy().into(),
            remote: var("EDGETERM_BENCH_REMOTE"),
            upload: true,
            directory: true,
        }],
    );
    *job.transport.lock() = Some(transport);

    let started = std::time::Instant::now();
    let mut remote = Remote::connect(&job).await.unwrap();
    // Optional: force the number of files in flight, to see how the time
    // scales with it. The job's own options are left alone.
    if let Ok(files) = std::env::var("EDGETERM_BENCH_FILES") {
        Arc::get_mut(&mut remote).unwrap().files = files.parse().expect("numeric files");
    }
    let connected = started.elapsed();
    let started = std::time::Instant::now();
    let items = plan(&job, &remote).await.unwrap();
    let planned = started.elapsed();
    let started = std::time::Instant::now();
    copy_files(&job, &remote, items).await.unwrap();
    let copied = started.elapsed();
    eprintln!(
        "real server upload of {files} files: files in flight={}, connect={connected:?}, plan={planned:?}, copy={copied:?}, plan+copy={:?}",
        remote.files,
        planned + copied
    );
    std::fs::remove_dir_all(&scratch).unwrap();
}

fn walk_count(dir: &Path) -> usize {
    std::fs::read_dir(dir)
        .unwrap()
        .map(|entry| {
            let path = entry.unwrap().path();
            if path.is_dir() {
                walk_count(&path)
            } else {
                1
            }
        })
        .sum()
}

#[tokio::test]
async fn durable_option_restores_the_per_file_fsync() {
    let mut f = Fixture::new(Server::default()).await;
    Arc::get_mut(&mut f.remote)
        .unwrap()
        .extensions
        .insert("fsync@openssh.com".into(), "1".into());
    let item = f.upload(b"contents");
    let mut job = f.job();
    Arc::get_mut(&mut job).unwrap().options.durable = true;
    copy(&job, &f.remote, item, 4, &Semaphore::new(2))
        .await
        .unwrap();
    assert_eq!(f.count("fsync@openssh.com"), 1);
}

#[tokio::test]
async fn empty_files_upload_through_the_fast_path() {
    let f = Fixture::new(Server::default()).await;
    let item = f.upload(b"");
    let job = f.job();
    copy(&job, &f.remote, item.clone(), 4, &Semaphore::new(2))
        .await
        .unwrap();
    assert_eq!(f.state.lock().files["/target"], b"");
    assert_eq!(f.count("write"), 0);
    assert!(job.checkpoint(&job.key(&item)).unwrap().complete);
}

#[tokio::test]
async fn replanned_uploads_tolerate_directories_that_already_exist() {
    let f = Fixture::new(Server::default()).await;
    let root = f.root.join("project");
    std::fs::create_dir_all(root.join("pkg/deep")).unwrap();
    std::fs::write(root.join("pkg/deep/mod.py"), b"first").unwrap();
    let item = Item {
        local: root.to_string_lossy().into(),
        remote: "/site".into(),
        upload: true,
        directory: true,
    };
    let job = super::super::test_job_items(f.root.clone(), vec![item.clone()]);
    let files = plan(&job, &f.remote).await.unwrap();
    copy_files(&job, &f.remote, files).await.unwrap();
    assert_eq!(f.state.lock().files["/site/pkg/deep/mod.py"], b"first");
    // A second run recreates the plan over the existing tree; every mkdir
    // now fails with "already exists" and must be recognised as such.
    std::fs::write(root.join("pkg/deep/mod.py"), b"second").unwrap();
    let job = super::super::test_job_items(f.root.clone(), vec![item]);
    let files = plan(&job, &f.remote).await.unwrap();
    copy_files(&job, &f.remote, files).await.unwrap();
    assert_eq!(f.state.lock().files["/site/pkg/deep/mod.py"], b"second");
    for dir in ["/site", "/site/pkg", "/site/pkg/deep"] {
        assert!(f.state.lock().dirs.contains(dir), "{dir} must exist");
    }
}

/// Planning reads each target directory once, and a directory this plan
/// just created is empty by construction. A fresh upload therefore pays
/// no destination probe per file; only the commit-time check remains.
#[tokio::test]
async fn a_fresh_tree_upload_skips_the_per_file_destination_probe() {
    let f = Fixture::new(Server::default()).await;
    let root = f.root.join("project");
    std::fs::create_dir_all(root.join("pkg/deep")).unwrap();
    std::fs::write(root.join("pkg/deep/mod.py"), b"first").unwrap();
    std::fs::write(root.join("top.txt"), b"second").unwrap();
    let item = Item {
        local: root.to_string_lossy().into(),
        remote: "/site".into(),
        upload: true,
        directory: true,
    };
    let job = super::super::test_job_items(f.root.clone(), vec![item]);
    let files = plan(&job, &f.remote).await.unwrap();
    copy_files(&job, &f.remote, files).await.unwrap();
    assert_eq!(f.state.lock().files["/site/pkg/deep/mod.py"], b"first");
    assert_eq!(f.state.lock().files["/site/top.txt"], b"second");
    // Two files: the previous implementation stat'ed each destination
    // twice (the probe plus the commit check). The plan's listings answer
    // the probe, so one commit-time stat per file is all that is left.
    assert_eq!(f.count("lstat"), 2);
}

/// A target directory that already exists is read once during planning;
/// that listing then answers the destination probe for every file in it.
#[tokio::test]
async fn an_existing_target_directory_is_listed_once_instead_of_probed_per_file() {
    let f = Fixture::new(Server::default()).await;
    {
        let mut state = f.state.lock();
        state.dirs.insert("/site".into());
        state
            .files
            .insert("/site/keep.bin".into(), b"keep".to_vec());
    }
    let root = f.root.join("project");
    std::fs::create_dir_all(root.join("pkg")).unwrap();
    for n in 0..3 {
        std::fs::write(root.join(format!("mod-{n}.py")), payload(4096)).unwrap();
        std::fs::write(root.join(format!("pkg/inner-{n}.py")), payload(4096)).unwrap();
    }
    let item = Item {
        local: root.to_string_lossy().into(),
        remote: "/site".into(),
        upload: true,
        directory: true,
    };
    let job = super::super::test_job_items(f.root.clone(), vec![item]);
    let files = plan(&job, &f.remote).await.unwrap();
    copy_files(&job, &f.remote, files).await.unwrap();
    assert_eq!(f.state.lock().files.len(), 7);
    // /site already existed, so its mkdir fails and one lstat confirms it
    // is a directory; /site/pkg was created by this plan and counts as
    // empty. One listing of /site replaces six destination probes.
    assert_eq!(f.count("opendir"), 1);
    assert_eq!(f.count("lstat"), 7);
}

#[tokio::test]
async fn a_deferred_parent_mkdir_is_retried_once() {
    let f = Fixture::new(Server {
        fail_mkdir_once: Some("/site/pkg".into()),
        ..Server::default()
    })
    .await;
    let root = f.root.join("project");
    std::fs::create_dir_all(root.join("pkg")).unwrap();
    std::fs::write(root.join("pkg/mod.py"), b"retry").unwrap();
    let item = Item {
        local: root.to_string_lossy().into(),
        remote: "/site".into(),
        upload: true,
        directory: true,
    };
    let job = super::super::test_job_items(f.root.clone(), vec![item]);
    let files = plan(&job, &f.remote).await.unwrap();
    copy_files(&job, &f.remote, files).await.unwrap();
    assert_eq!(f.state.lock().files["/site/pkg/mod.py"], b"retry");
    assert!(f.state.lock().dirs.contains("/site/pkg"));
}

#[tokio::test]
#[ignore = "repeatable simulated-latency benchmark; run with --ignored --nocapture"]
async fn benchmark_pipeline_at_20ms_rtt() {
    for depth in [1, 8, 32] {
        let f = Fixture::new(Server {
            delay_ms: 20,
            ..Server::default()
        })
        .await;
        let item = f.upload(&payload(8 * 1024 * 1024));
        let job = f.job();
        let started = std::time::Instant::now();
        copy(&job, &f.remote, item, depth, &Semaphore::new(2))
            .await
            .unwrap();
        eprintln!(
            "upload 8MiB, depth={depth}, elapsed={:?}, peak_inflight={}",
            started.elapsed(),
            f.state.lock().peak
        );
        let download = Item {
            local: f.root.join("download").to_string_lossy().into(),
            remote: "/target".into(),
            upload: false,
            directory: false,
        };
        let started = std::time::Instant::now();
        copy(&job, &f.remote, download, depth, &Semaphore::new(2))
            .await
            .unwrap();
        eprintln!(
            "download 8MiB, depth={depth}, elapsed={:?}",
            started.elapsed()
        );
    }
    for files in [1, 4] {
        let mut f = Fixture::new(Server {
            delay_ms: 20,
            ..Server::default()
        })
        .await;
        Arc::get_mut(&mut f.remote).unwrap().files = files;
        let job = f.job();
        let mut items = Vec::new();
        for n in 0..24 {
            let path = f.root.join(format!("small-{n}"));
            std::fs::write(&path, payload(4096)).unwrap();
            items.push(Item {
                local: path.to_string_lossy().into(),
                remote: format!("/small-{n}"),
                upload: true,
                directory: false,
            });
        }
        let started = std::time::Instant::now();
        copy_files(&job, &f.remote, items).await.unwrap();
        eprintln!(
            "upload 24 x 4KiB, file_concurrency={files}, elapsed={:?}",
            started.elapsed()
        );
    }
}

/// The bulk-small-file shape at the concurrency the setting now allows:
/// 500 files in a nested tree at a 20 ms round trip, swept over the file
/// widths the bound permits. Fixture evidence only — a simulated server
/// that answers out of order and never processes serially, not a real one.
#[tokio::test]
#[ignore = "repeatable simulated-latency benchmark; run with --ignored --nocapture"]
async fn benchmark_500_files_at_20ms_rtt() {
    for files in [4, 8, 16, 32] {
        let mut f = Fixture::new(Server {
            delay_ms: 20,
            ..Server::default()
        })
        .await;
        {
            let remote = Arc::get_mut(&mut f.remote).unwrap();
            remote.files = files;
        }
        let root = f.root.join("project");
        for d in 0..50 {
            let dir = root.join(format!("pkg-{d}"));
            std::fs::create_dir_all(&dir).unwrap();
            for n in 0..10 {
                std::fs::write(dir.join(format!("mod-{n}.py")), payload(4096)).unwrap();
            }
        }
        let job = super::super::test_job_items(
            f.root.clone(),
            vec![Item {
                local: root.to_string_lossy().into(),
                remote: "/site".into(),
                upload: true,
                directory: true,
            }],
        );
        let started = std::time::Instant::now();
        let items = plan(&job, &f.remote).await.unwrap();
        let planned = started.elapsed();
        let started = std::time::Instant::now();
        copy_files(&job, &f.remote, items).await.unwrap();
        let copied = started.elapsed();
        assert_eq!(f.state.lock().files.len(), 500);
        assert_eq!(f.state.lock().dirs.len(), 51);
        eprintln!(
            "upload 500 x 4KiB in 51 dirs, file_concurrency={files}: plan={planned:?}, copy={copied:?}, total={:?}",
            planned + copied
        );
    }
}

#[tokio::test]
async fn audit_mkdir_recovers_every_failed_descendant_in_a_full_window() {
    let f = Fixture::new(Server {
        fail_mkdir_once: Some("/site".into()),
        ..Server::default()
    })
    .await;
    let dirs: Vec<String> = (0..10)
        .map(|n| format!("/site{}", "/child".repeat(n)))
        .collect();
    create_directories(&f.job(), &f.remote, &dirs)
        .await
        .unwrap();
    for dir in dirs {
        assert!(f.state.lock().dirs.contains(&dir), "missing {dir}");
    }
}

#[tokio::test]
async fn audit_durable_upload_refuses_a_server_without_fsync_before_writing() {
    let f = Fixture::new(Server::default()).await;
    let item = f.upload(b"must be flushed");
    let mut job = f.job();
    Arc::get_mut(&mut job).unwrap().options.durable = true;
    let error = copy(&job, &f.remote, item, 1, &Semaphore::new(2))
        .await
        .unwrap_err();
    assert_eq!(error.code, "unsupported");
    assert!(f.state.lock().files.is_empty());
}

#[tokio::test]
async fn audit_zero_checkpoint_resume_discards_unconfirmed_tail() {
    let f = Fixture::new(Server {
        fail_write_at: Some(0),
        ..Server::default()
    })
    .await;
    let item = f.upload(b"data");
    let job = f.job();
    assert!(copy(&job, &f.remote, item.clone(), 1, &Semaphore::new(2))
        .await
        .is_err());
    let cp = job.checkpoint(&job.key(&item)).unwrap();
    assert_eq!(cp.offset, 0);
    {
        let mut state = f.state.lock();
        state.fail_write_at = None;
        state
            .files
            .insert(cp.temporary, b"unconfirmed trailing bytes".to_vec());
    }
    copy(&job, &f.remote, item, 1, &Semaphore::new(2))
        .await
        .unwrap();
    assert_eq!(f.state.lock().files["/target"], b"data");
}

/// Models the user-reported case: dragging a small project folder (many small
/// files in nested directories) to a remote with real round-trip latency.
#[tokio::test]
#[ignore = "repeatable simulated-latency benchmark; run with --ignored --nocapture"]
async fn benchmark_small_file_batch_at_20ms_rtt() {
    for files in [4, 8] {
        let mut f = Fixture::new(Server {
            delay_ms: 20,
            ..Server::default()
        })
        .await;
        {
            let remote = Arc::get_mut(&mut f.remote).unwrap();
            remote.files = files;
            remote
                .extensions
                .insert("fsync@openssh.com".into(), "1".into());
            remote
                .extensions
                .insert("posix-rename@openssh.com".into(), "1".into());
        }
        let root = f.root.join("project");
        for d in 0..10 {
            let dir = root.join(format!("pkg-{d}"));
            std::fs::create_dir_all(&dir).unwrap();
            for n in 0..5 {
                std::fs::write(dir.join(format!("mod-{n}.py")), payload(4096)).unwrap();
            }
        }
        let job = super::super::test_job_items(
            f.root.clone(),
            vec![Item {
                local: root.to_string_lossy().into(),
                remote: "/site".into(),
                upload: true,
                directory: true,
            }],
        );
        let started = std::time::Instant::now();
        let items = plan(&job, &f.remote).await.unwrap();
        let planned = started.elapsed();
        let started = std::time::Instant::now();
        copy_files(&job, &f.remote, items).await.unwrap();
        let copied = started.elapsed();
        assert_eq!(f.state.lock().files.len(), 50);
        assert_eq!(f.state.lock().dirs.len(), 11);
        eprintln!(
            "upload 50 x 4KiB in 11 dirs, file_concurrency={files}: plan={planned:?}, copy={copied:?}, total={:?}",
            planned + copied
        );
    }
}

// --- rate limiting, at the engine entry the production paths use --------------

/// Polls `probe` until it returns `Some`, or panics with `what` after `limit`.
async fn wait_for<T>(limit: Duration, what: &str, mut probe: impl FnMut() -> Option<T>) -> T {
    let deadline = tokio::time::Instant::now() + limit;
    loop {
        if let Some(value) = probe() {
            return value;
        }
        if tokio::time::Instant::now() >= deadline {
            panic!("timed out waiting for {what}");
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

/// Every data payload that arrived by each point in time fits the token
/// bucket's contract: cumulative bytes ≤ burst + rate × elapsed, with one
/// slice of slack for the request/reserve boundary.
fn arrivals_within_budget(
    arrivals: &[(std::time::Instant, usize)],
    rate: u64,
    burst: u64,
) -> Result<(), String> {
    let Some((start, _)) = arrivals.first() else {
        return Ok(());
    };
    let slack = rate / 10 + 4096;
    let mut cumulative = 0usize;
    for (time, length) in arrivals {
        cumulative += length;
        let elapsed = time.saturating_duration_since(*start).as_secs_f64();
        let allowance = burst as f64 + rate as f64 * elapsed + slack as f64;
        if cumulative as f64 > allowance {
            return Err(format!(
                "{cumulative} bytes had arrived {elapsed:.3}s in: the allowance is {allowance:.0}"
            ));
        }
    }
    Ok(())
}

/// A job whose options and journal directory line up with a fixed id, for
/// restart-recovery tests that read the journal back through a manager.
fn named_job(root: &Path, id: &str, items: Vec<Item>) -> Arc<Job> {
    let mut job = super::super::test_job_items(root.to_path_buf(), items);
    let mutable = Arc::get_mut(&mut job).unwrap();
    mutable.id = id.into();
    mutable.directory = root.join(id);
    job
}

#[tokio::test]
async fn resumed_download_counts_unstarted_files_before_copying() {
    let f = Fixture::new(Server {
        files: HashMap::from([
            ("/first".into(), b"abc".to_vec()),
            ("/second".into(), b"1234567".to_vec()),
        ]),
        ..Server::default()
    })
    .await;
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
    *job.plan.lock() = Some(items.clone());
    let planned = plan(&job, &f.remote).await.unwrap();
    assert_eq!(job.snapshot.lock().total, 10);
    assert_eq!(job.snapshot.lock().total_files, 2);
    copy_files(&job, &f.remote, planned).await.unwrap();
    assert_eq!(std::fs::read(f.root.join("first")).unwrap(), b"abc");
    assert_eq!(std::fs::read(f.root.join("second")).unwrap(), b"1234567");
}

fn paced_copy_options() -> super::super::Options {
    super::super::Options {
        requests: 4,
        chunk_kib: 128,
        files: 16,
        durable: false,
        tar: false,
        rate_limit_bps: 0,
    }
}

#[tokio::test]
async fn rate_limited_upload_paces_payload_within_burst_and_rate() {
    let rate = 256 * 1024u64;
    let bytes = payload(512 * 1024);
    let f = Fixture::new(Server {
        rate_limit_bps: Some(rate),
        ..Server::default()
    })
    .await;
    let item = f.upload(&bytes);
    let job = f.job();
    let started = std::time::Instant::now();
    copy(&job, &f.remote, item.clone(), 1, &Semaphore::new(2))
        .await
        .unwrap();
    let elapsed = started.elapsed();
    assert_eq!(f.state.lock().files["/target"], bytes);
    // 512 KiB at 256 KiB/s minus the 256 KiB burst is one second of true
    // waiting on the data path, and the window check below holds at every
    // arrival, not just on the total.
    assert!(
        elapsed >= Duration::from_millis(950),
        "upload finished in {elapsed:?} despite the {rate} B/s limit"
    );
    assert!(elapsed < Duration::from_secs(6), "upload took {elapsed:?}");
    let arrivals = f.state.lock().arrivals.clone();
    arrivals_within_budget(&arrivals, rate, rate)
        .inspect_err(|e| eprintln!("window violation: {e}"))
        .unwrap();
}

#[tokio::test]
async fn rate_limited_download_paces_payload_within_burst_and_rate() {
    let rate = 256 * 1024u64;
    let bytes = payload(512 * 1024);
    let f = Fixture::new(Server {
        rate_limit_bps: Some(rate),
        files: HashMap::from([("/source".into(), bytes.clone())]),
        ..Server::default()
    })
    .await;
    let target = f.root.join("target");
    let item = Item {
        local: target.to_string_lossy().into(),
        remote: "/source".into(),
        upload: false,
        directory: false,
    };
    let job = f.job();
    let started = std::time::Instant::now();
    copy(&job, &f.remote, item, 1, &Semaphore::new(2))
        .await
        .unwrap();
    let elapsed = started.elapsed();
    assert_eq!(std::fs::read(&target).unwrap(), bytes);
    // The source sample (head and tail) rides the same budget, so the
    // budgeted payload is ~640 KiB: at least (640−256)/256 = 1.5 s.
    assert!(
        elapsed >= Duration::from_millis(1400),
        "download finished in {elapsed:?} despite the {rate} B/s limit"
    );
    assert!(
        elapsed < Duration::from_secs(7),
        "download took {elapsed:?}"
    );
    let arrivals = f.state.lock().arrivals.clone();
    arrivals_within_budget(&arrivals, rate, rate)
        .inspect_err(|e| eprintln!("window violation: {e}"))
        .unwrap();
}

/// A paced job's long-run throughput sits at its limit, not merely under
/// it: a clean upload charges exactly its wire payload once, so the wall
/// time matches the budget's own arithmetic — and would roughly double if
/// the same bytes were charged on a second path as well.
#[tokio::test]
async fn a_paced_upload_reaches_its_configured_limit() {
    let rate = 256 * 1024u64;
    let bytes = payload(1024 * 1024);
    let f = Fixture::new(Server {
        rate_limit_bps: Some(rate),
        ..Server::default()
    })
    .await;
    let item = f.upload(&bytes);
    let job = f.job();
    let started = std::time::Instant::now();
    copy(&job, &f.remote, item, 1, &Semaphore::new(2))
        .await
        .unwrap();
    let elapsed = started.elapsed().as_secs_f64();
    assert_eq!(f.state.lock().files["/target"], bytes);
    // Wire payload: the 1 MiB of data writes. The source signature reads
    // local disk only, and the commit is protocol messages, so the theory
    // is (1 MiB − the 256 KiB burst) at 256 KiB/s = 3 s.
    let theory = (1024 * 1024 - 256 * 1024) as f64 / rate as f64;
    assert!(
        elapsed >= theory * 0.85 && elapsed <= theory * 1.5,
        "1 MiB at {rate} B/s took {elapsed:.3}s; theory {theory:.2}s — the payload is not being charged exactly once"
    );
    let arrivals = f.state.lock().arrivals.clone();
    arrivals_within_budget(&arrivals, rate, rate)
        .inspect_err(|e| eprintln!("window violation: {e}"))
        .unwrap();
}

/// The download twin: the wire payload is the data plus the head/tail
/// signature samples the remote read-back moves, charged once each.
#[tokio::test]
async fn a_paced_download_reaches_its_configured_limit() {
    let rate = 256 * 1024u64;
    let bytes = payload(512 * 1024);
    let f = Fixture::new(Server {
        rate_limit_bps: Some(rate),
        files: HashMap::from([("/source".into(), bytes.clone())]),
        ..Server::default()
    })
    .await;
    let target = f.root.join("target");
    let item = Item {
        local: target.to_string_lossy().into(),
        remote: "/source".into(),
        upload: false,
        directory: false,
    };
    let job = f.job();
    let started = std::time::Instant::now();
    copy(&job, &f.remote, item, 1, &Semaphore::new(2))
        .await
        .unwrap();
    let elapsed = started.elapsed().as_secs_f64();
    assert_eq!(std::fs::read(&target).unwrap(), bytes);
    // Wire payload: 512 KiB of data + 128 KiB of remote signature samples
    // = 640 KiB; (640 − 256 burst) at 256 KiB/s = 1.5 s.
    let theory = (640 * 1024 - 256 * 1024) as f64 / rate as f64;
    assert!(
        elapsed >= theory * 0.85 && elapsed <= theory * 1.6,
        "512 KiB + samples at {rate} B/s took {elapsed:.3}s; theory {theory:.2}s — the payload is not being charged exactly once"
    );
    let arrivals = f.state.lock().arrivals.clone();
    arrivals_within_budget(&arrivals, rate, rate)
        .inspect_err(|e| eprintln!("window violation: {e}"))
        .unwrap();
}

#[tokio::test]
async fn pause_and_resume_of_a_paced_job_resumes_progress_at_once() {
    let rate = 64 * 1024u64;
    let f = Fixture::new(Server {
        rate_limit_bps: Some(rate),
        ..Server::default()
    })
    .await;
    // Four files over four lanes (requests=4 → one request each): several
    // workers have charged slices and are waiting when the pause lands.
    let items: Vec<_> = (0..4)
        .map(|n| {
            let path = f.root.join(format!("source{n}"));
            std::fs::write(&path, payload(256 * 1024)).unwrap();
            Item {
                local: path.to_string_lossy().into(),
                remote: format!("/target{n}"),
                upload: true,
                directory: false,
            }
        })
        .collect();
    let mut job = f.job();
    Arc::get_mut(&mut job).unwrap().options = paced_copy_options();
    let running = {
        let job = job.clone();
        let remote = f.remote.clone();
        let items = items.clone();
        tokio::spawn(async move { copy_files(&job, &remote, items).await })
    };
    let moved = wait_for(Duration::from_secs(5), "first progress", || {
        let transferred = job.snapshot.lock().transferred;
        (transferred > 0).then_some(transferred)
    })
    .await;
    job.control.set(1);
    let stopped = tokio::time::timeout(Duration::from_secs(3), running)
        .await
        .expect("pause stops the workers")
        .unwrap()
        .unwrap_err();
    assert_eq!(stopped.code, "paused");
    // The pause interrupted rate settles mid-wait; a resumed job must move
    // again immediately — inherited debt would stall it for tens of
    // seconds (4 lanes × 256 KiB at 64 KiB/s).
    job.control.set(0);
    let resumed = {
        let job = job.clone();
        let remote = f.remote.clone();
        let items = items.clone();
        tokio::spawn(async move { copy_files(&job, &remote, items).await })
    };
    let grew = wait_for(Duration::from_millis(2500), "progress after resume", || {
        let transferred = job.snapshot.lock().transferred;
        (transferred > moved).then_some(transferred)
    })
    .await;
    assert!(grew > moved);
    job.control.set(2);
    let _ = tokio::time::timeout(Duration::from_secs(3), resumed).await;
}

#[tokio::test]
async fn cancel_during_a_rate_settle_returns_promptly() {
    let f = Fixture::new(Server {
        rate_limit_bps: Some(1024),
        ..Server::default()
    })
    .await;
    let item = f.upload(&payload(128 * 1024));
    let job = f.job();
    let running = {
        let job = job.clone();
        let remote = f.remote.clone();
        let item = item.clone();
        tokio::spawn(async move { copy(&job, &remote, item, 1, &Semaphore::new(2)).await })
    };
    wait_for(Duration::from_secs(5), "first progress", || {
        let transferred = job.snapshot.lock().transferred;
        (transferred > 0).then_some(transferred)
    })
    .await;
    job.control.set(2);
    let error = tokio::time::timeout(Duration::from_secs(2), running)
        .await
        .expect("cancel leaves the rate wait promptly")
        .unwrap()
        .unwrap_err();
    assert_eq!(error.code, "cancelled");
}

/// A resume whose prefix read-back moves 4 MiB shares the rate budget: at
/// 1 MiB/s the verify alone costs ~3 s, while an unlimited fixture does the
/// same job in a fraction of a second.
#[tokio::test]
async fn resume_prefix_readback_shares_the_rate_budget() {
    let bytes = payload(5 * 1024 * 1024 + 91);
    let journal_root =
        std::env::temp_dir().join(format!("edgeterm-restart-{}", uuid::Uuid::new_v4()));
    // The source lives beside the journal, not inside either fixture: the
    // interrupted run and the resumed run must name the very same local
    // path, or the checkpoint's key would not match and nothing would
    // resume.
    let source_dir = journal_root.with_extension("src");
    std::fs::create_dir_all(&source_dir).unwrap();
    std::fs::write(source_dir.join("source"), &bytes).unwrap();
    let make_item = || Item {
        local: source_dir.join("source").to_string_lossy().into(),
        remote: "/target".into(),
        upload: true,
        directory: false,
    };
    // 1. An unlimited run interrupted at 4 MiB journals a real checkpoint.
    let plain = Fixture::new(Server {
        fail_write_at: Some(4 * 1024 * 1024),
        ..Server::default()
    })
    .await;
    let id = "readback-paced";
    let job = named_job(&journal_root, id, vec![make_item()]);
    std::fs::create_dir_all(journal_root.join(id)).unwrap();
    local::save_json(
        &journal_root.join(id).join("job.json"),
        &super::super::journal_json(
            id,
            &job.profile,
            &[make_item()],
            &super::super::Options::default(),
        ),
    )
    .unwrap();
    // The production sequence plans (freezing plan.json beside job.json)
    // before the first byte moves; a checkpoint without that plan is not
    // claimable after the restart. The planned row — its local path
    // normalized — is exactly what copy_files hands to copy.
    let planned = plan(&job, &plain.remote).await.unwrap();
    assert!(copy(
        &job,
        &plain.remote,
        planned[0].clone(),
        4,
        &Semaphore::new(2)
    )
    .await
    .is_err());
    let cp = job.checkpoint(&job.key(&planned[0])).unwrap();
    assert_eq!(cp.offset, 4 * 1024 * 1024);
    let partial = cp.temporary.clone();
    let partial_bytes = plain.state.lock().files[&partial].clone();
    drop(job);
    drop(plain);

    // 2. The same journal, resumed on a paced fixture: the 4 MiB prefix
    //    read-back rides the budget.
    let rate = 1024 * 1024u64;
    let paced = Fixture::new(Server {
        rate_limit_bps: Some(rate),
        files: HashMap::from([(partial.clone(), partial_bytes)]),
        ..Server::default()
    })
    .await;
    let manager = super::super::Transfers::with_root(journal_root.clone());
    let journal = manager.read_persisted(id).unwrap();
    // The resumed run transfers the frozen plan's own (normalized) row.
    let resumed_item = journal.plan.as_ref().unwrap()[0].clone();
    let resumed = manager
        .rebuild(
            journal.id,
            "session".into(),
            journal.items.clone(),
            // The resumed job runs the journal's own frozen plan, exactly
            // as the production `adopt` path hands it over.
            journal.plan.clone(),
            journal.options,
            job_profile(),
            Vec::new(),
            None,
            journal_root.join(id),
            "target".into(),
            journal.checkpoints,
            tauri::ipc::Channel::new(|_| Ok(())),
            None,
        )
        .unwrap();
    let started = std::time::Instant::now();
    copy(&resumed, &paced.remote, resumed_item, 4, &Semaphore::new(2))
        .await
        .unwrap();
    let elapsed = started.elapsed();
    assert_eq!(paced.state.lock().files["/target"], bytes);
    // 4 MiB read-back + ~1 MiB remaining at 1 MiB/s minus the 1 MiB burst.
    assert!(
        elapsed >= Duration::from_millis(3800),
        "the prefix read-back was not paced: {elapsed:?}"
    );
    assert!(elapsed < Duration::from_secs(12), "resume took {elapsed:?}");
    let arrivals = paced.state.lock().arrivals.clone();
    arrivals_within_budget(&arrivals, rate, rate)
        .inspect_err(|e| eprintln!("window violation: {e}"))
        .unwrap();
    let _ = std::fs::remove_dir_all(&journal_root);
    let _ = std::fs::remove_dir_all(&source_dir);
}

/// The `requests` option is the job-wide ceiling on data requests in
/// flight: files=16/requests=1 never runs more than one, and the default
/// configuration runs its pipelined width without exceeding 32.
#[tokio::test]
async fn data_request_peak_respects_the_requests_ceiling() {
    let f = Fixture::new(Server {
        delay_ms: 1,
        ..Server::default()
    })
    .await;
    let items: Vec<_> = (0..6)
        .map(|n| {
            let path = f.root.join(format!("source{n}"));
            std::fs::write(&path, payload(4 * 1024)).unwrap();
            Item {
                local: path.to_string_lossy().into(),
                remote: format!("/narrow{n}"),
                upload: true,
                directory: false,
            }
        })
        .collect();
    let mut narrow = f.job();
    {
        let options = &mut Arc::get_mut(&mut narrow).unwrap().options;
        options.files = 16;
        options.requests = 1;
    }
    copy_files(&narrow, &f.remote, items).await.unwrap();
    assert_eq!(
        f.state.lock().peak_data,
        1,
        "requests=1 must cap the whole job at one data request in flight"
    );
    assert_eq!(f.state.lock().files.len(), 6);

    let wide_items: Vec<_> = (0..6)
        .map(|n| {
            let path = f.root.join(format!("wide{n}"));
            std::fs::write(&path, payload(64 * 1024)).unwrap();
            Item {
                local: path.to_string_lossy().into(),
                remote: format!("/wide{n}"),
                upload: true,
                directory: false,
            }
        })
        .collect();
    let mut wide = f.job();
    {
        let options = &mut Arc::get_mut(&mut wide).unwrap().options;
        options.files = 16;
        options.requests = 32;
    }
    copy_files(&wide, &f.remote, wide_items).await.unwrap();
    let peak = f.state.lock().peak_data;
    assert!(peak >= 2, "the default width must still pipeline: {peak}");
    assert!(peak <= 32, "requests=32 exceeded: {peak}");
}

fn job_profile() -> crate::model::SessionProfile {
    serde_json::from_value(
        serde_json::json!({"name":"t", "kind":"sftp", "host":"fixture", "username":"u"}),
    )
    .unwrap()
}

/// A directory upload interrupted mid-file leaves a journal a fresh
/// manager can rebuild and finish: planned children are attributed, the
/// confirmed prefix is resumed, and every file lands byte for byte.
#[tokio::test]
async fn restart_recovery_finishes_an_interrupted_directory_upload() {
    let source =
        std::env::temp_dir().join(format!("edgeterm-restart-dir-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(source.join("pkg")).unwrap();
    let a = payload(5 * 1024 * 1024 + 91);
    let b = payload(4096);
    std::fs::write(source.join("pkg/a"), &a).unwrap();
    std::fs::write(source.join("b"), &b).unwrap();
    let item = Item {
        local: source.to_string_lossy().into(),
        remote: "/site".into(),
        upload: true,
        directory: true,
    };

    let root =
        std::env::temp_dir().join(format!("edgeterm-restart-journal-{}", uuid::Uuid::new_v4()));
    let id = "restart-dir-upload";
    let mut first = named_job(&root, id, vec![item.clone()]);
    {
        let job = Arc::get_mut(&mut first).unwrap();
        job.options = paced_copy_options();
    }
    std::fs::create_dir_all(root.join(id)).unwrap();
    local::save_json(
        &root.join(id).join("job.json"),
        &super::super::journal_json(id, &first.profile, &[item.clone()], &first.options),
    )
    .unwrap();
    let f = Fixture::new(Server {
        fail_write_at: Some(4 * 1024 * 1024),
        ..Server::default()
    })
    .await;
    let planned = plan(&first, &f.remote).await.unwrap();
    assert!(copy_files(&first, &f.remote, planned).await.is_err());
    let checkpointed: Vec<_> = first.checkpoints.lock().keys().cloned().collect();
    assert!(!checkpointed.is_empty(), "the interruption must journal");
    drop(first);

    // A "restart": a fresh manager over the same journal root.
    f.state.lock().fail_write_at = None;
    let manager = super::super::Transfers::with_root(root.clone());
    let listed = manager.discover();
    assert!(
        listed
            .iter()
            .any(|found| found.id == id && !found.unrecognized),
        "the interrupted job must be listed: {listed:?}"
    );
    let journal = manager.read_persisted(id).unwrap();
    let resumed = manager
        .rebuild(
            journal.id,
            "session".into(),
            journal.items.clone(),
            // The resumed job runs the journal's own frozen plan, exactly
            // as the production `adopt` path hands it over.
            journal.plan.clone(),
            journal.options,
            job_profile(),
            Vec::new(),
            None,
            root.join(id),
            "site".into(),
            journal.checkpoints,
            tauri::ipc::Channel::new(|_| Ok(())),
            None,
        )
        .unwrap();
    let files = plan(&resumed, &f.remote).await.unwrap();
    copy_files(&resumed, &f.remote, files).await.unwrap();
    let server = f.state.lock();
    assert_eq!(server.files["/site/pkg/a"], a);
    assert_eq!(server.files["/site/b"], b);
    drop(server);
    let _ = std::fs::remove_dir_all(&root);
    let _ = std::fs::remove_dir_all(&source);
}

/// The download twin: a directory interrupted mid-file resumes from its
/// confirmed prefix, and the final local tree matches byte for byte.
#[tokio::test]
async fn restart_recovery_finishes_an_interrupted_directory_download() {
    let a = payload(5 * 1024 * 1024 + 91);
    let b = payload(4096);
    let f = Fixture::new(Server {
        files: HashMap::from([
            ("/srv/pkg/a".into(), a.clone()),
            ("/srv/b".into(), b.clone()),
        ]),
        dirs: ["/srv".to_string(), "/srv/pkg".to_string()]
            .into_iter()
            .collect(),
        fail_read_at: Some(4 * 1024 * 1024),
        ..Server::default()
    })
    .await;
    let target = std::env::temp_dir().join(format!("edgeterm-restart-dl-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&target).unwrap();
    let item = Item {
        local: target.to_string_lossy().into(),
        remote: "/srv".into(),
        upload: false,
        directory: true,
    };
    let root =
        std::env::temp_dir().join(format!("edgeterm-restart-journal-{}", uuid::Uuid::new_v4()));
    let id = "restart-dir-download";
    let mut first = named_job(&root, id, vec![item.clone()]);
    {
        let job = Arc::get_mut(&mut first).unwrap();
        job.options = paced_copy_options();
    }
    std::fs::create_dir_all(root.join(id)).unwrap();
    local::save_json(
        &root.join(id).join("job.json"),
        &super::super::journal_json(id, &first.profile, &[item.clone()], &first.options),
    )
    .unwrap();
    let planned = plan(&first, &f.remote).await.unwrap();
    assert!(copy_files(&first, &f.remote, planned).await.is_err());
    let checkpointed: Vec<_> = first.checkpoints.lock().keys().cloned().collect();
    assert!(!checkpointed.is_empty());
    drop(first);

    f.state.lock().fail_read_at = None;
    let manager = super::super::Transfers::with_root(root.clone());
    let journal = manager.read_persisted(id).unwrap();
    let resumed = manager
        .rebuild(
            journal.id,
            "session".into(),
            journal.items.clone(),
            // The resumed job runs the journal's own frozen plan, exactly
            // as the production `adopt` path hands it over.
            journal.plan.clone(),
            journal.options,
            job_profile(),
            Vec::new(),
            None,
            root.join(id),
            "srv".into(),
            journal.checkpoints,
            tauri::ipc::Channel::new(|_| Ok(())),
            None,
        )
        .unwrap();
    let files = plan(&resumed, &f.remote).await.unwrap();
    copy_files(&resumed, &f.remote, files).await.unwrap();
    assert_eq!(std::fs::read(target.join("pkg/a")).unwrap(), a);
    assert_eq!(std::fs::read(target.join("b")).unwrap(), b);
    let _ = std::fs::remove_dir_all(&root);
    let _ = std::fs::remove_dir_all(&target);
}

/// A same-length change to the source after the restart is refused, and
/// the interrupted run's own checkpoint state is left in place.
#[tokio::test]
async fn restart_recovery_refuses_a_same_length_source_change() {
    let bytes = payload(5 * 1024 * 1024 + 91);
    let make_item = |root: &Path| Item {
        local: root.join("source").to_string_lossy().into(),
        remote: "/target".into(),
        upload: true,
        directory: false,
    };
    let f = Fixture::new(Server {
        fail_write_at: Some(4 * 1024 * 1024),
        ..Server::default()
    })
    .await;
    std::fs::write(f.root.join("source"), &bytes).unwrap();
    let root =
        std::env::temp_dir().join(format!("edgeterm-restart-tamper-{}", uuid::Uuid::new_v4()));
    let id = "restart-tamper";
    let first = named_job(&root, id, vec![make_item(&f.root)]);
    std::fs::create_dir_all(root.join(id)).unwrap();
    local::save_json(
        &root.join(id).join("job.json"),
        &super::super::journal_json(id, &first.profile, &[make_item(&f.root)], &first.options),
    )
    .unwrap();
    // Freeze the plan first, exactly as run_job does; a checkpoint without
    // a saved plan must not be claimed by the restart below. copy_files
    // transfers the plan's own normalized row, so the checkpoint journals
    // exactly that row.
    let planned = plan(&first, &f.remote).await.unwrap();
    assert!(
        copy(&first, &f.remote, planned[0].clone(), 4, &Semaphore::new(2))
            .await
            .is_err()
    );
    drop(first);
    // Same length, different bytes.
    let mut tampered = bytes.clone();
    tampered[..8].copy_from_slice(&b"tampered"[..8]);
    std::fs::write(f.root.join("source"), &tampered).unwrap();
    f.state.lock().fail_write_at = None;
    let manager = super::super::Transfers::with_root(root.clone());
    let journal = manager.read_persisted(id).unwrap();
    let resumed_item = journal.plan.as_ref().unwrap()[0].clone();
    let resumed = manager
        .rebuild(
            journal.id,
            "session".into(),
            journal.items.clone(),
            // The resumed job runs the journal's own frozen plan, exactly
            // as the production `adopt` path hands it over.
            journal.plan.clone(),
            journal.options,
            job_profile(),
            Vec::new(),
            None,
            root.join(id),
            "target".into(),
            journal.checkpoints,
            tauri::ipc::Channel::new(|_| Ok(())),
            None,
        )
        .unwrap();
    let error = copy(&resumed, &f.remote, resumed_item, 4, &Semaphore::new(2))
        .await
        .unwrap_err();
    assert!(error.message.contains("source changed"), "{error:?}");
    // Nothing was committed over the original state.
    assert!(!f.state.lock().files.contains_key("/target"));
    let _ = std::fs::remove_dir_all(&root);
}

/// A read may ask for the server's whole packet budget less the DATA
/// framing. The previous implementation subtracted a flat kilobyte from both
/// directions, so a server that advertises a 32 KiB packet threw away a
/// kilobyte of every read; `authorized_keys` already accounts for the exact
/// 13 bytes a DATA reply spends around its payload.
#[test]
fn read_lengths_leave_room_for_only_the_data_framing() {
    let advertised = Limits {
        packet_len: Some(32 * 1024),
        read_len: Some(64 * 1024),
        write_len: Some(64 * 1024),
        open_handles: Some(0),
    };
    let (read, write) = super::wire_lengths(advertised, 128);
    assert_eq!(read, 32 * 1024 - super::DATA_FRAMING as usize);
    // A WRITE carries the server's handle, whose length is not this client's
    // to choose, so the write side keeps the wider allowance.
    assert_eq!(write, 32 * 1024 - super::WRITE_FRAMING as usize);

    // A server that advertises nothing keeps the conservative defaults, and
    // the read side gains the same kilobyte from them.
    let (read, write) = super::wire_lengths(Limits::default(), 128);
    assert_eq!(read, 32 * 1024 - super::DATA_FRAMING as usize);
    assert_eq!(write, 32 * 1024 - super::WRITE_FRAMING as usize);

    // A chunk below the packet budget is still the chunk.
    let (read, _) = super::wire_lengths(advertised, 16);
    assert_eq!(read, 16 * 1024);

    // A packet budget that cannot hold a DATA reply reports zero, which
    // `connect` turns into an unusable-limits failure.
    let (read, _) = super::wire_lengths(
        Limits {
            packet_len: Some(8),
            ..advertised
        },
        128,
    );
    assert_eq!(read, 0);
}

/// The two sample windows of a signature are independent reads on one
/// handle. They used to be awaited one after the other, so a signature cost
/// two round trips on a slow link — and a download takes it twice, once
/// before the copy and once to check the source did not move.
#[tokio::test]
async fn a_signature_samples_both_windows_in_one_round_trip() {
    let bytes = payload(256 * 1024);
    let f = Fixture::new(Server {
        delay_ms: 20,
        files: HashMap::from([("/source".into(), bytes.clone())]),
        ..Server::default()
    })
    .await;
    let job = f.job();
    let signature = f
        .remote
        .source_signature("/source", &job.control)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(signature.size, bytes.len() as u64);
    // Both windows are outstanding at once, which is only possible if the
    // second read was issued before the first reply came back; awaiting them
    // one after the other leaves a peak of one.
    assert_eq!(f.state.lock().peak_data, 2);
    assert_eq!(f.count("read"), 2);
    // The digest is unchanged: the head window first, the tail window second.
    let mut context = Context::new(&SHA256);
    context.update(&bytes[..64 * 1024]);
    context.update(&bytes[bytes.len() - 64 * 1024..]);
    assert_eq!(signature.sample, local::hex(context.finish().as_ref()));
}

/// A resumed file's prefix is re-read to verify it before anything is
/// appended. The read-back used a fixed window of eight, so a large prefix
/// was verified at a quarter of the width it was transferred at — on a slow
/// link that costs several times what the transfer itself did. The window is
/// now the job's own request ceiling.
#[tokio::test]
async fn a_resume_prefix_is_verified_at_the_jobs_request_width() {
    let f = Fixture::new(Server {
        delay_ms: 20,
        fail_write_at: Some(4 * 1024 * 1024),
        ..Server::default()
    })
    .await;
    let bytes = payload(6 * 1024 * 1024 + 91);
    let item = f.upload(&bytes);
    let job = f.job();
    let large = Semaphore::new(2);
    assert!(copy(&job, &f.remote, item.clone(), 8, &large)
        .await
        .is_err());
    assert_eq!(
        job.checkpoint(&job.key(&item)).unwrap().offset,
        4 * 1024 * 1024
    );
    // The interrupted run's own writes already reached the depth this test
    // asks for (8), so a peak above that can only have come from the
    // verification: 4 MiB at the fixture's 128 KiB read is 32 reads, and the
    // old window of eight never let more than eight be in flight.
    assert!(f.state.lock().peak_data <= 8);
    // The server stops refusing the write, so the resumed run can finish; the
    // read-back that verifies the 4 MiB prefix runs before it appends.
    f.state.lock().fail_write_at = None;
    copy(&job, &f.remote, item.clone(), 8, &large)
        .await
        .unwrap();
    assert_eq!(f.state.lock().files["/target"], bytes);
    assert!(job.checkpoint(&job.key(&item)).unwrap().complete);
    let peak = f.state.lock().peak_data;
    assert!(
        peak > 8,
        "the prefix read-back did not fill the pipeline: {peak}"
    );
}

/// A flat batch's sizes are asked of the server over a window. Each one is a
/// round trip, and a batch of a hundred files would otherwise spend a hundred
/// of them before the first byte moved — and a restarted job pays the same
/// for the files it never started.
#[tokio::test]
async fn a_flat_batch_plans_its_sizes_over_a_window() {
    let sources: HashMap<String, Vec<u8>> = (0..16)
        .map(|n| (format!("/file-{n}"), payload(4096)))
        .collect();
    let f = Fixture::new(Server {
        delay_ms: 20,
        files: sources,
        ..Server::default()
    })
    .await;
    let items: Vec<Item> = (0..16)
        .map(|n| Item {
            local: f.root.join(format!("file-{n}")).to_string_lossy().into(),
            remote: format!("/file-{n}"),
            upload: false,
            directory: false,
        })
        .collect();
    let job = super::super::test_job_items(f.root.clone(), items);
    let started = std::time::Instant::now();
    let planned = plan(&job, &f.remote).await.unwrap();
    // Sixteen sizes at 20 ms each: one round trip apiece is 320 ms, the
    // window of eight is two of them plus the parent resolution.
    assert!(
        started.elapsed() < Duration::from_millis(160),
        "planning took {:?}",
        started.elapsed()
    );
    assert_eq!(planned.len(), 16);
    assert_eq!(job.snapshot.lock().total, 16 * 4096u64);
    assert!(
        f.state.lock().peak >= 8,
        "the size lookups did not overlap: {}",
        f.state.lock().peak
    );
}
