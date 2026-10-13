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
    stall_writes: bool,
    short_reads: bool,
    writes: Vec<u64>,
    pending: usize,
    peak: usize,
    delay_ms: u64,
    lose_rename_reply: bool,
    /// Rejects the first mkdir of this path once, the way a server that has
    /// not finished an in-flight parent mkdir would.
    fail_mkdir_once: Option<String>,
    counts: HashMap<String, usize>,
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
                let (reply, delay) = response(&mut shared.lock(), packet);
                let Some(reply) = reply else {
                    continue;
                };
                let state = shared.clone();
                let writer = writer.clone();
                tokio::spawn(async move {
                    if delay > 0 {
                        tokio::time::sleep(Duration::from_millis(delay)).await;
                    }
                    let bytes = Bytes::try_from(reply).unwrap();
                    let _ = writer.lock().await.write_all(&bytes).await;
                    if delay > 0 {
                        state.lock().pending -= 1;
                    }
                });
            }
        });
        let raw = RawSftpSession::new(client);
        raw.set_timeout(1);
        raw.init().await.unwrap();
        let remote = Arc::new(Remote {
            raw,
            extensions: HashMap::new(),
            read_len: 128 * 1024,
            write_len: 128 * 1024,
            files: 4,
            requests: Semaphore::new(32),
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
                Packet::Handle(Handle {
                    id,
                    handle: p.filename,
                })
            } else {
                Packet::error(id, StatusCode::NoSuchFile)
            }
        }
        Packet::Read(p) => {
            let data = server.files.get(&p.handle).unwrap();
            let start = p.offset as usize;
            let count = if server.short_reads {
                (p.len as usize).min(701)
            } else {
                p.len as usize
            };
            if start >= data.len() {
                Packet::error(id, StatusCode::Eof)
            } else {
                delay = server.delay_ms;
                Packet::Data(Data {
                    id,
                    data: data[start..(start + count).min(data.len())].to_vec(),
                })
            }
        }
        Packet::Write(p) => {
            server.writes.push(p.offset);
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
        Packet::FSetStat(p) => {
            if let Some(size) = p.attrs.size {
                server
                    .files
                    .get_mut(&p.handle)
                    .unwrap()
                    .resize(size as usize, 0);
            }
            Packet::error(id, StatusCode::Ok)
        }
        Packet::SetStat(_) | Packet::Close(_) => Packet::error(id, StatusCode::Ok),
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
    if delay > 0 {
        server.pending += 1;
        server.peak = server.peak.max(server.pending);
    }
    (Some(reply), delay)
}

fn payload(size: usize) -> Vec<u8> {
    (0..size)
        .map(|n| (n.wrapping_mul(13) ^ (n >> 12)) as u8)
        .collect()
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
    assert_eq!(f.count("posix-rename@openssh.com"), 1);
    assert_eq!(f.count("fsetstat"), 0);
    assert_eq!(f.count("fsync@openssh.com"), 0);
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
