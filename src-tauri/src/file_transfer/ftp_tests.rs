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
    fail_append: bool,
    reject_rest: bool,
    reject_append: bool,
    received: Vec<usize>,
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
}

fn serve(mut stream: TcpStream, state: Arc<Mutex<Server>>) -> std::io::Result<()> {
    stream.set_read_timeout(Some(Duration::from_secs(5)))?;
    let mut reader = BufReader::new(stream.try_clone()?);
    let mut passive = None;
    let mut rename = String::new();
    let mut rest = 0;
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
        let response = match command {
            "USER" => "331 Password".to_string(),
            "PASS" => "230 Logged in".into(),
            "TYPE" | "OPTS" | "CWD" => "200 OK".into(),
            "PWD" => "257 \"/\"".into(),
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
                    let fail = state.lock().fail_append;
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
                        state.fail_append = false;
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
        fail_append: true,
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
        source: signature(&mut conn.stream, "/source", &job.control)
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
    let f = Fixture::new(Server {
        fail_append: true,
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
    copy(&job, &mut conn.stream, &item).unwrap();
    assert_eq!(f.state.lock().files["/target"], bytes);
    assert_eq!(f.state.lock().received, [1024 * 1024, 2 * 1024 * 1024 + 17]);
}
