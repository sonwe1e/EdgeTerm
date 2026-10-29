//! A wire-protocol fixture for the editor save's replacement ladder.
//!
//! The fake server speaks real SFTP packets over a duplex stream, so the
//! production `RawSftpSession` and `Sftp::replace` run unchanged. What the
//! fixture varies is exactly what the ladder exists for: which replacement
//! operations a server announces, allows and refuses.
use super::*;
use bytes::{Buf, Bytes};
use parking_lot::Mutex;
use russh_sftp::client::RawSftpSession;
use russh_sftp::protocol::{Attrs, Data, FileAttributes, Handle, OpenFlags, Packet, StatusCode};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

#[derive(Default)]
struct Server {
    files: HashMap<String, Vec<u8>>,
    /// The version banner offers `posix-rename@openssh.com`.
    announce_posix_rename: bool,
    /// Every posix-rename extended request fails.
    fail_posix_rename: bool,
    /// v3 RENAME refuses an existing target, as the protocol allows it to.
    strict_rename: bool,
    /// Every rename whose source is the temp file fails, even after a remove.
    fail_temp_rename: bool,
    /// WRITE requests fail, the way a full or read-only filesystem does.
    fail_write: bool,
    counts: HashMap<String, usize>,
}

struct Fixture {
    state: Arc<Mutex<Server>>,
    sftp: Option<Sftp>,
    task: tokio::task::JoinHandle<()>,
}

impl Drop for Fixture {
    fn drop(&mut self) {
        self.task.abort();
    }
}

impl Fixture {
    async fn new(server: Server) -> Self {
        let state = Arc::new(Mutex::new(server));
        let (client, stream) = tokio::io::duplex(1024 * 1024);
        let shared = state.clone();
        let task = tokio::spawn(async move {
            let (mut reader, writer) = tokio::io::split(stream);
            let writer = Arc::new(tokio::sync::Mutex::new(writer));
            while let Ok(length) = reader.read_u32().await {
                let mut data = vec![0u8; length as usize];
                if reader.read_exact(&mut data).await.is_err() {
                    break;
                }
                let packet = Packet::try_from(&mut Bytes::from(data)).unwrap();
                if let Some(reply) = respond(&shared, packet) {
                    let bytes = Bytes::try_from(reply).unwrap();
                    let _ = writer.lock().await.write_all(&bytes).await;
                }
            }
        });
        let raw = RawSftpSession::new(client);
        raw.set_timeout(20);
        let version = raw.init().await.unwrap();
        // The same detection `Sftp::open` applies to the version banner.
        let posix_rename = version
            .extensions
            .get("posix-rename@openssh.com")
            .is_some_and(|value| value == "1");
        Self {
            state,
            sftp: Some(Sftp { raw, posix_rename }),
            task,
        }
    }

    fn sftp(&mut self) -> &Sftp {
        self.sftp
            .as_ref()
            .expect("the session lives as long as the fixture")
    }

    fn count(&self, label: &str) -> usize {
        self.state.lock().counts.get(label).copied().unwrap_or(0)
    }

    fn file(&self, path: &str) -> Vec<u8> {
        self.state
            .lock()
            .files
            .get(path)
            .cloned()
            .unwrap_or_default()
    }

    fn exists(&self, path: &str) -> bool {
        self.state.lock().files.contains_key(path)
    }
}

fn label(packet: &Packet) -> String {
    match packet {
        Packet::Rename(_) => "rename".into(),
        Packet::Remove(_) => "remove".into(),
        Packet::Write(_) => "write".into(),
        Packet::Extended(p) => p.request.clone(),
        _ => "other".into(),
    }
}

fn attrs(id: u32, size: usize) -> Packet {
    Packet::Attrs(Attrs {
        id,
        attrs: FileAttributes {
            size: Some(size as u64),
            permissions: Some(0o100644),
            mtime: Some(1),
            ..FileAttributes::empty()
        },
    })
}

fn respond(state: &Arc<Mutex<Server>>, packet: Packet) -> Option<Packet> {
    let id = packet.get_request_id();
    let mut server = state.lock();
    *server.counts.entry(label(&packet)).or_default() += 1;
    Some(match packet {
        Packet::Init(_) => Packet::Version(russh_sftp::protocol::Version {
            version: 3,
            extensions: if server.announce_posix_rename {
                HashMap::from([("posix-rename@openssh.com".to_string(), "1".to_string())])
            } else {
                HashMap::new()
            },
        }),
        Packet::Stat(p) => match server.files.get(&p.path) {
            Some(data) => attrs(id, data.len()),
            None => Packet::error(id, StatusCode::NoSuchFile),
        },
        Packet::Fstat(p) => match server.files.get(&p.handle) {
            Some(data) => attrs(id, data.len()),
            None => Packet::error(id, StatusCode::NoSuchFile),
        },
        Packet::Open(p) => {
            if p.pflags.contains(OpenFlags::CREATE) || server.files.contains_key(&p.filename) {
                let data = server.files.entry(p.filename.clone()).or_default();
                if p.pflags.contains(OpenFlags::TRUNCATE) {
                    data.clear();
                }
                Packet::Handle(Handle {
                    id,
                    handle: p.filename,
                })
            } else {
                Packet::error(id, StatusCode::NoSuchFile)
            }
        }
        Packet::Read(p) => {
            let data = server.files.get(&p.handle)?;
            let start = p.offset as usize;
            if start >= data.len() {
                Packet::error(id, StatusCode::Eof)
            } else {
                Packet::Data(Data {
                    id,
                    data: data[start..].to_vec(),
                })
            }
        }
        Packet::Write(p) => {
            if server.fail_write {
                Packet::error(id, StatusCode::Failure)
            } else {
                let data = server.files.get_mut(&p.handle).unwrap();
                let start = p.offset as usize;
                data.resize(data.len().max(start + p.data.len()), 0);
                data[start..start + p.data.len()].copy_from_slice(&p.data);
                Packet::error(id, StatusCode::Ok)
            }
        }
        Packet::Close(_) => Packet::error(id, StatusCode::Ok),
        Packet::Rename(p) => {
            if server.fail_temp_rename && p.oldpath.ends_with(".tmp") {
                Packet::error(id, StatusCode::Failure)
            } else if server.strict_rename && server.files.contains_key(&p.newpath) {
                Packet::error(id, StatusCode::Failure)
            } else if let Some(data) = server.files.remove(&p.oldpath) {
                server.files.insert(p.newpath.clone(), data);
                Packet::error(id, StatusCode::Ok)
            } else {
                Packet::error(id, StatusCode::NoSuchFile)
            }
        }
        Packet::Extended(p) if p.request == "posix-rename@openssh.com" => {
            if server.fail_posix_rename {
                Packet::error(id, StatusCode::Failure)
            } else {
                let mut bytes = Bytes::from(p.data);
                let n = bytes.get_u32() as usize;
                let from = String::from_utf8(bytes.copy_to_bytes(n).to_vec()).unwrap();
                let n = bytes.get_u32() as usize;
                let to = String::from_utf8(bytes.copy_to_bytes(n).to_vec()).unwrap();
                if let Some(data) = server.files.remove(&from) {
                    server.files.insert(to, data);
                    Packet::error(id, StatusCode::Ok)
                } else {
                    Packet::error(id, StatusCode::NoSuchFile)
                }
            }
        }
        Packet::Remove(p) => {
            if server.files.remove(&p.filename).is_some() {
                Packet::error(id, StatusCode::Ok)
            } else {
                Packet::error(id, StatusCode::NoSuchFile)
            }
        }
        other => panic!("unimplemented fixture packet: {other:?}"),
    })
}

const TEMP: &str = "/dir/.f.edgeterm-1.tmp";
const BACKUP: &str = "/dir/.f.edgeterm-1.bak";
const TARGET: &str = "/dir/f";

/// The server state a save has already produced when `replace` runs.
fn replaced_save() -> HashMap<String, Vec<u8>> {
    HashMap::from([
        (TARGET.to_string(), b"old".to_vec()),
        (TEMP.to_string(), b"new".to_vec()),
        (BACKUP.to_string(), b"old".to_vec()),
    ])
}

#[tokio::test]
async fn an_announced_posix_rename_replaces_without_opening_any_gap() {
    let mut fixture = Fixture::new(Server {
        announce_posix_rename: true,
        files: replaced_save(),
        ..Default::default()
    })
    .await;
    let outcome = fixture
        .sftp()
        .replace(TEMP, TARGET, BACKUP, true, b"new", Some(0o644))
        .await;
    assert!(outcome.is_ok());
    assert_eq!(fixture.file(TARGET), b"new");
    assert!(!fixture.exists(TEMP), "the temp file moved into place");
    assert_eq!(fixture.count("posix-rename@openssh.com"), 1);
    assert_eq!(fixture.count("rename"), 0);
    assert_eq!(fixture.count("remove"), 0);
    assert_eq!(fixture.count("write"), 0);
}

#[tokio::test]
async fn a_refused_posix_rename_falls_back_to_the_plain_rename() {
    let mut fixture = Fixture::new(Server {
        announce_posix_rename: true,
        fail_posix_rename: true,
        // A server without the extension may still replace through v3 RENAME.
        strict_rename: false,
        files: replaced_save(),
        ..Default::default()
    })
    .await;
    let outcome = fixture
        .sftp()
        .replace(TEMP, TARGET, BACKUP, true, b"new", Some(0o644))
        .await;
    assert!(outcome.is_ok());
    assert_eq!(fixture.file(TARGET), b"new");
    assert_eq!(fixture.count("posix-rename@openssh.com"), 1);
    assert_eq!(fixture.count("rename"), 1);
    assert_eq!(fixture.count("remove"), 0);
}

#[tokio::test]
async fn a_strict_server_without_the_extension_moves_the_target_aside() {
    let mut fixture = Fixture::new(Server {
        strict_rename: true,
        files: replaced_save(),
        ..Default::default()
    })
    .await;
    let outcome = fixture
        .sftp()
        .replace(TEMP, TARGET, BACKUP, true, b"new", Some(0o644))
        .await;
    assert!(outcome.is_ok());
    assert_eq!(fixture.file(TARGET), b"new");
    assert!(!fixture.exists(TEMP));
    // The first rename is refused by the strict target, the second lands.
    assert_eq!(fixture.count("rename"), 2);
    assert_eq!(fixture.count("remove"), 1);
    assert_eq!(fixture.count("write"), 0);
}

#[tokio::test]
async fn a_server_refusing_every_temp_rename_restores_and_rewrites_in_place() {
    let mut fixture = Fixture::new(Server {
        strict_rename: true,
        fail_temp_rename: true,
        files: replaced_save(),
        ..Default::default()
    })
    .await;
    let outcome = fixture
        .sftp()
        .replace(TEMP, TARGET, BACKUP, true, b"new", Some(0o644))
        .await;
    assert!(outcome.is_ok());
    // The rewrite landed and was read back byte for byte.
    assert_eq!(fixture.file(TARGET), b"new");
    assert!(fixture.count("write") > 0);
    // The restore consumed the backup; the verified rewrite retired the temp.
    assert!(!fixture.exists(BACKUP));
    assert!(!fixture.exists(TEMP));
}

#[tokio::test]
async fn a_failed_rewrite_reports_a_restored_target_and_keeps_the_temp() {
    let mut fixture = Fixture::new(Server {
        strict_rename: true,
        fail_temp_rename: true,
        fail_write: true,
        files: replaced_save(),
        ..Default::default()
    })
    .await;
    let outcome = fixture
        .sftp()
        .replace(TEMP, TARGET, BACKUP, true, b"new", Some(0o644))
        .await;
    let refused = outcome.expect_err("the rewrite failed");
    assert!(
        refused.restored,
        "the backup was moved back onto the target"
    );
    assert!(refused.reasons.contains("write"));
    // The caller's error message must name what is really on the server.
    assert!(!fixture.exists(BACKUP), "the restore consumed the backup");
    assert!(
        fixture.exists(TEMP),
        "the new content stayed at the temp file"
    );
}

#[tokio::test]
async fn a_fresh_save_renames_into_place_and_refuses_a_target_that_appeared() {
    // No existing target: the plain rename's no-overwrite rule is exactly
    // right, with or without the extension.
    let mut fixture = Fixture::new(Server {
        strict_rename: true,
        files: HashMap::from([(TEMP.to_string(), b"new".to_vec())]),
        ..Default::default()
    })
    .await;
    let outcome = fixture
        .sftp()
        .replace(TEMP, TARGET, BACKUP, false, b"new", Some(0o644))
        .await;
    assert!(outcome.is_ok());
    assert_eq!(fixture.file(TARGET), b"new");
    assert_eq!(fixture.count("rename"), 1);

    // A target that appeared before the rename must not be replaced.
    let mut fixture = Fixture::new(Server {
        strict_rename: true,
        files: replaced_save(),
        ..Default::default()
    })
    .await;
    let outcome = fixture
        .sftp()
        .replace(TEMP, TARGET, BACKUP, false, b"new", Some(0o644))
        .await;
    let refused = outcome.expect_err("a fresh save must not replace an existing target");
    assert!(!refused.restored);
    assert_eq!(fixture.file(TARGET), b"old");
    assert_eq!(fixture.file(TEMP), b"new");
}

#[test]
fn recovery_note_names_what_the_server_holds() {
    // A fresh save has no previous content to name.
    let fresh = recovery_note(false, false, TARGET, TEMP, BACKUP);
    assert!(fresh.contains(TEMP));
    assert!(!fresh.contains(BACKUP));

    // Both versions survive a refused replacement of an existing file.
    let kept = recovery_note(true, false, TARGET, TEMP, BACKUP);
    assert!(kept.contains(TEMP) && kept.contains(BACKUP));

    // The restore consumed the backup, so the note must not point at it, and
    // must warn that the target may hold a partial rewrite.
    let restored = recovery_note(true, true, TARGET, TEMP, BACKUP);
    assert!(restored.contains(TARGET) && restored.contains(TEMP));
    assert!(!restored.contains(BACKUP));
    assert!(restored.contains("partial"));
}
