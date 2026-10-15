pub mod auth;
pub mod cwd;
pub mod encoding;
pub mod exec;
pub mod ftp;
pub mod local;
pub mod locale;
pub mod output;
pub mod recording;
pub mod reuse;
pub mod serial;
pub mod ssh;
pub mod telnet;
pub mod transfer;

use std::collections::HashMap;

use encoding_rs::Encoding;
use parking_lot::Mutex;
use serde::Serialize;
#[cfg(test)]
use tauri::ipc::Channel;
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::{mpsc, oneshot};

use self::output::{OutputChannel, OUTPUT_CHUNK};
use self::recording::Recorder;
use crate::error::{AppError, Result};
use crate::model::{DirListing, FileEntry, SessionInfo, SessionKind, SessionProfile};

pub const EVENT_STATE: &str = "session:state";

pub enum SftpRequest {
    Home,
    List {
        path: String,
    },
    Canonicalize {
        path: String,
    },
    Mkdir {
        path: String,
    },
    /// Creates an empty file, refusing to touch one that already exists.
    CreateFile {
        path: String,
    },
    Remove {
        path: String,
        is_dir: bool,
    },
    Rename {
        from: String,
        to: String,
    },
}

#[derive(Debug)]
pub enum SftpResponse {
    Listing(DirListing),
    Path(String),
    Done,
}

#[cfg_attr(feature = "bindings", derive(specta::Type))]
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferProgress {
    pub transferred: u64,
    pub total: u64,
}

pub enum SessionCommand {
    Write(Vec<u8>),
    /// Binary protocol data that needs transport-level backpressure. The
    /// owner resolves `reply` only after the bytes have actually been written
    /// to the PTY, SSH channel, or serial port.
    WriteConfirmed {
        data: Vec<u8>,
        reply: oneshot::Sender<Result<()>>,
    },
    Resize {
        cols: u16,
        rows: u16,
    },
    Sftp {
        request: SftpRequest,
        reply: oneshot::Sender<Result<SftpResponse>>,
    },
    /// The working directory of the shell's foreground job, for the Filer.
    /// Local sessions ask the OS, SSH sessions ask the server; see `cwd`.
    QueryCwd {
        reply: oneshot::Sender<Result<String>>,
    },
    Close,
}

pub struct SessionHandle {
    pub info: SessionInfo,
    pub tx: mpsc::UnboundedSender<SessionCommand>,
    /// What the session's bytes are in; keyboard text is encoded to it by
    /// `write_text` (see `encoding`).
    pub encoding: &'static Encoding,
    /// Serial sessions use a blocking owner thread. Joining it during close
    /// guarantees that the OS device handle is gone before the command returns.
    pub owner_thread: Option<std::thread::JoinHandle<()>>,
}

#[derive(Default)]
pub struct SessionManager {
    sessions: Mutex<HashMap<String, SessionHandle>>,
}

impl SessionManager {
    pub fn insert(&self, handle: SessionHandle) {
        self.sessions.lock().insert(handle.info.id.clone(), handle);
    }

    pub fn remove(&self, id: &str) -> Option<SessionHandle> {
        self.sessions.lock().remove(id)
    }

    pub fn list(&self) -> Vec<SessionInfo> {
        self.sessions
            .lock()
            .values()
            .map(|h| h.info.clone())
            .collect()
    }

    pub fn send(&self, id: &str, cmd: SessionCommand) -> Result<()> {
        let guard = self.sessions.lock();
        Self::dispatch(Self::handle(&guard, id)?, cmd)
    }

    /// Keyboard and paste text, encoded the way the session expects it.
    pub fn write_text(&self, id: &str, text: &str) -> Result<()> {
        let guard = self.sessions.lock();
        let handle = Self::handle(&guard, id)?;
        let bytes = encoding::encode_input(handle.encoding, text);
        Self::dispatch(handle, SessionCommand::Write(bytes))
    }

    fn handle<'a>(
        guard: &'a HashMap<String, SessionHandle>,
        id: &str,
    ) -> Result<&'a SessionHandle> {
        guard
            .get(id)
            .ok_or_else(|| AppError::new(format!("session {id} is not open")))
    }

    fn dispatch(handle: &SessionHandle, cmd: SessionCommand) -> Result<()> {
        handle
            .tx
            .send(cmd)
            .map_err(|_| AppError::new(format!("session {} has terminated", handle.info.id)))
    }

    /// Sends one bounded binary chunk and waits until the owning session has
    /// actually written it. Unlike the ordinary keyboard-input path, this
    /// applies backpressure so a large protocol transfer cannot accumulate in
    /// the unbounded command channel.
    pub async fn write_confirmed(&self, id: &str, data: Vec<u8>) -> Result<()> {
        let (reply, response) = oneshot::channel();
        self.send(id, SessionCommand::WriteConfirmed { data, reply })?;
        response
            .await
            .map_err(|_| AppError::new(format!("session {id} closed before writing binary data")))?
    }

    /// Round-trips an SFTP request through the owning session task.
    pub async fn sftp(&self, id: &str, request: SftpRequest) -> Result<SftpResponse> {
        let (reply, rx) = oneshot::channel();
        self.send(id, SessionCommand::Sftp { request, reply })?;
        rx.await
            .map_err(|_| AppError::new("session closed before the request completed"))?
    }

    /// Round-trips a working-directory query through the owning session.
    pub async fn query_cwd(&self, id: &str) -> Result<String> {
        let (reply, rx) = oneshot::channel();
        self.send(id, SessionCommand::QueryCwd { reply })?;
        rx.await
            .map_err(|_| AppError::new("session closed before the request completed"))?
    }
}

// --- events -----------------------------------------------------------------

#[cfg_attr(feature = "bindings", derive(specta::Type))]
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "bindings", derive(tauri_specta::Event))]
#[cfg_attr(feature = "bindings", tauri_specta(event_name = "session:state"))]
pub(crate) struct StateEvent {
    id: String,
    state: String,
    message: Option<String>,
}

/// Reports a change the session went through on its own: it came up, or the
/// peer / device / shell ended it. A close the frontend requested through
/// `close_session` is deliberately *not* reported: the frontend records that
/// state itself when the command returns, and it may reconnect under the
/// same session id right away, so a late "closed" from the old session would
/// otherwise be taken for the new one going down.
pub fn emit_state(app: &AppHandle, id: &str, state: &str, message: Option<String>) {
    if matches!(state, "closed" | "error") {
        if let Some(managed) = app.try_state::<crate::commands::AppState>() {
            managed.port_forwards.close_session(id);
        }
    }
    let _ = app.emit(
        EVENT_STATE,
        StateEvent {
            id: id.to_string(),
            state: state.to_string(),
            message,
        },
    );
}

/// Coalesces small writes so a flood of output does not turn into a flood of
/// IPC messages. Callers must `flush` whenever their read loop goes idle.
/// Every byte pushed also goes to the session's recording, when the profile
/// asked for one (see `recording`); dropping the pump ends the recording.
///
/// Bytes leave as raw IPC payloads on the per-session channel the frontend
/// opened with `open_session` — no base64 detour, so the webview receives an
/// ArrayBuffer it can hand straight to xterm.js.
pub struct OutputPump {
    output: OutputChannel,
    buf: Vec<u8>,
    recorder: Option<Recorder>,
    deadline: Option<tokio::time::Instant>,
}

impl OutputPump {
    const MAX: usize = OUTPUT_CHUNK;

    pub fn new(output: OutputChannel, recorder: Option<Recorder>) -> Self {
        Self {
            output,
            buf: Vec::with_capacity(8192),
            recorder,
            deadline: None,
        }
    }

    pub fn push(&mut self, bytes: &[u8]) {
        if bytes.is_empty() || self.is_closed() {
            return;
        }
        if let Some(recorder) = &self.recorder {
            recorder.write(bytes);
        }
        self.buf.extend_from_slice(bytes);
        // A fixed deadline from the first byte, not an idle timer reset by
        // every small packet. Continuous small writes must still be shown.
        self.deadline.get_or_insert_with(|| {
            tokio::time::Instant::now() + std::time::Duration::from_millis(8)
        });
        if self.buf.len() >= Self::MAX {
            self.flush();
        }
    }

    pub fn is_empty(&self) -> bool {
        self.buf.is_empty()
    }

    pub fn flush(&mut self) {
        while !self.buf.is_empty() {
            let count = self.output.send(&mut self.buf);
            if count == 0 {
                break;
            }
        }
        if self.is_closed() {
            self.buf.clear();
        }
        if self.buf.is_empty() {
            self.deadline = None;
        }
    }

    pub fn is_closed(&self) -> bool {
        self.output.is_closed()
    }

    /// Stop transport reads when one pending batch cannot be delivered.
    /// Control commands stay outside this gate, including Close and writes.
    pub fn can_read(&self) -> bool {
        !self.is_closed() && self.buf.len() < Self::MAX
    }

    pub async fn ready(&self) {
        if self.buf.len() < Self::MAX {
            if let Some(deadline) = self.deadline {
                tokio::time::sleep_until(deadline).await;
            }
        }
        self.output.writable().await;
    }

    pub fn wait_readable(&mut self) -> bool {
        while !self.can_read() && !self.is_closed() {
            self.output.wait_writable();
            self.flush();
        }
        !self.is_closed()
    }

    /// Drain the last partial batch on natural EOF. Explicit close cancels
    /// the credit wait through OutputStreams before closing the transport.
    pub async fn finish(&mut self) {
        while !self.is_empty() && !self.is_closed() {
            self.output.writable().await;
            self.flush();
        }
    }

    pub fn finish_blocking(&mut self) {
        while !self.is_empty() && !self.is_closed() {
            self.output.wait_writable();
            self.flush();
        }
    }
}

// --- helpers shared by the backends ----------------------------------------

/// Answers the request-reply commands a backend cannot serve, so the caller
/// gets an error instead of a dropped reply channel.
pub fn reject_unsupported(cmd: SessionCommand, kind: SessionKind) {
    match cmd {
        SessionCommand::Sftp { reply, .. } => {
            let _ = reply.send(Err(AppError::new(format!(
                "{:?} sessions have no remote filesystem",
                kind
            ))));
        }
        SessionCommand::QueryCwd { reply } => {
            let _ = reply.send(Err(AppError::new(format!(
                "{:?} sessions have no shell working directory",
                kind
            ))));
        }
        SessionCommand::WriteConfirmed { reply, .. } => {
            let _ = reply.send(Err(AppError::new(format!(
                "{:?} session does not accept binary terminal data",
                kind
            ))));
        }
        _ => {}
    }
}

/// Normalises a possibly-relative remote path into an absolute one.
pub fn join_remote(base: &str, name: &str) -> String {
    if name.starts_with('/') {
        return name.to_string();
    }
    if base.is_empty() || base == "/" {
        format!("/{name}")
    } else if base.ends_with('/') {
        format!("{base}{name}")
    } else {
        format!("{base}/{name}")
    }
}

/// Sorts a listing the way the panels show it by default: folders first,
/// then names case-insensitively (byte-ish order — `file10` before `file2`).
/// The web side passes this order through untouched at the default sort and
/// only re-orders with its collator once the user picks one. The lowercased
/// key is computed once per entry (`sort_by_cached_key`) rather than twice
/// per comparison — a large directory paid tens of thousands of throwaway
/// `String`s otherwise.
pub fn sort_entries(entries: &mut [FileEntry]) {
    entries.sort_by_cached_key(|entry| (!entry.is_dir, entry.name.to_lowercase()));
}

pub fn make_info(id: &str, profile: &SessionProfile) -> SessionInfo {
    SessionInfo {
        id: id.to_string(),
        profile_id: if profile.id.is_empty() {
            None
        } else {
            Some(profile.id.clone())
        },
        name: profile.name.clone(),
        kind: profile.kind,
        protocol: profile.protocol().to_string(),
        address: profile.address(),
        color: profile.color.clone(),
        supports_remote_files: matches!(
            profile.kind,
            SessionKind::Ssh | SessionKind::Ftp | SessionKind::Sftp
        ),
        recording: None,
        legacy_algorithms: Vec::new(),
        shared_connection: false,
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::*;

    /// Explicit smoke test of a real ConPTY/Unix PTY, separate from the
    /// deterministic suite because process startup depends on the host.
    #[test]
    #[ignore = "spawns a real local shell; run explicitly for transport validation"]
    fn native_pty_output_survives_a_stalled_consumer() {
        use super::output::OutputStreams;
        use portable_pty::{native_pty_system, CommandBuilder, PtySize};
        use std::io::{Read, Write};
        use std::time::Duration;
        use tauri::ipc::InvokeResponseBody;

        let pair = native_pty_system()
            .openpty(PtySize {
                rows: 24,
                cols: 100,
                pixel_width: 0,
                pixel_height: 0,
            })
            .unwrap();
        let mut cmd = if cfg!(windows) {
            let mut cmd = CommandBuilder::new("cmd.exe");
            cmd.args([
                "/D",
                "/Q",
                "/C",
                "for /L %i in (1,1,30000) do @echo native-flow-marker-%i",
            ]);
            cmd
        } else {
            let mut cmd = CommandBuilder::new("sh");
            cmd.args(["-c", "i=0; while [ \"$i\" -lt 30000 ]; do i=$((i+1)); printf 'native-flow-marker-%s\\n' \"$i\"; done"]);
            cmd
        };
        cmd.env("TERM", "xterm-256color");
        let mut child = pair.slave.spawn_command(cmd).unwrap();
        drop(pair.slave);
        let mut reader = pair.master.try_clone_reader().unwrap();
        let mut writer = Some(pair.master.take_writer().unwrap());
        let mut master = Some(pair.master);
        let streams = OutputStreams::default();
        let (sent, received) = std::sync::mpsc::channel();
        let output = streams
            .open(
                "pty",
                "pty".into(),
                Channel::new(move |body| {
                    if let InvokeResponseBody::Raw(bytes) = body {
                        let _ = sent.send(bytes);
                    }
                    Ok(())
                }),
            )
            .unwrap();
        let worker = std::thread::spawn(move || {
            let mut pump = OutputPump::new(output, None);
            let mut bytes = vec![0; 32 * 1024];
            while pump.wait_readable() {
                match reader.read(&mut bytes) {
                    Ok(0) => break,
                    Ok(n) => {
                        pump.push(&bytes[..n]);
                        pump.flush();
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                    Err(_) => break,
                }
            }
            pump.finish_blocking();
        });
        let mut captured = Vec::new();
        let mut acknowledged = 0;
        let mut stalls = 0;
        let started = std::time::Instant::now();
        let mut exit_status = None;
        loop {
            match received.recv_timeout(Duration::from_millis(100)) {
                Ok(bytes) => {
                    captured.extend(bytes);
                    // ConPTY asks the attached terminal for its initial
                    // cursor position before allowing the shell to print.
                    // xterm answers this in the app; this headless consumer
                    // must answer it as well.
                    if cfg!(windows) && captured.ends_with(b"\x1b[6n") {
                        writer.as_mut().unwrap().write_all(b"\x1b[1;1R").unwrap();
                        writer.as_mut().unwrap().flush().unwrap();
                    }
                    // Deliberately exhaust an entire session window before
                    // returning any credit, then hold it a little longer.
                    if captured.len() - acknowledged >= 512 * 1024 {
                        std::thread::sleep(Duration::from_millis(30));
                        streams.acknowledge("pty", captured.len() as u64);
                        acknowledged = captured.len();
                        stalls += 1;
                    }
                }
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
                Err(_) if started.elapsed() < Duration::from_secs(30) => {
                    if exit_status.is_none() {
                        exit_status = child.try_wait().unwrap();
                    }
                    if exit_status.is_some() {
                        // ConPTY owns a console host as well as the child;
                        // close that host after the child exits to yield EOF.
                        writer.take();
                        master.take();
                    }
                }
                Err(error) => {
                    streams.close_session("pty");
                    let _ = child.kill();
                    panic!("native PTY stalled after {} bytes: {error}", captured.len());
                }
            }
        }
        streams.acknowledge("pty", captured.len() as u64);
        worker.join().unwrap();
        assert!(exit_status
            .unwrap_or_else(|| child.wait().unwrap())
            .success());
        let text = String::from_utf8_lossy(&captured);
        assert!(
            stalls > 0,
            "must exercise backpressure, not just a small banner"
        );
        assert_eq!(text.matches("native-flow-marker-").count(), 30000);
        assert!(text.contains("native-flow-marker-30000"));
    }

    #[tokio::test]
    async fn output_pump_preserves_order_across_slow_consumption_and_final_partial_batch() {
        use super::output::OutputStreams;
        use tauri::ipc::InvokeResponseBody;
        let streams = OutputStreams::default();
        let delivered = Arc::new(Mutex::new(Vec::new()));
        let capture = delivered.clone();
        let channel = Channel::new(move |body| {
            if let InvokeResponseBody::Raw(bytes) = body {
                assert!(bytes.len() <= OUTPUT_CHUNK);
                capture.lock().extend(bytes);
            }
            Ok(())
        });
        let mut pump =
            OutputPump::new(streams.open("test", "token".into(), channel).unwrap(), None);
        let input: Vec<u8> = (0..2 * 1024 * 1024 + 17).map(|i| (i % 251) as u8).collect();
        for part in input.chunks(32 * 1024) {
            if !pump.can_read() {
                let consumed = delivered.lock().len() as u64;
                streams.acknowledge("token", consumed);
                pump.flush();
                assert!(pump.can_read());
            }
            pump.push(part);
            pump.flush();
            assert!(pump.buf.len() <= OUTPUT_CHUNK);
        }
        let consumed = delivered.lock().len() as u64;
        streams.acknowledge("token", consumed);
        pump.finish().await;
        assert_eq!(*delivered.lock(), input);
    }

    #[tokio::test]
    async fn one_byte_fragments_are_batched_and_eof_preserves_every_byte() {
        use super::output::OutputStreams;
        use tauri::ipc::InvokeResponseBody;
        let streams = OutputStreams::default();
        let delivered = Arc::new(Mutex::new(Vec::<Vec<u8>>::new()));
        let capture = delivered.clone();
        let channel = Channel::new(move |body| {
            if let InvokeResponseBody::Raw(bytes) = body {
                capture.lock().push(bytes);
            }
            Ok(())
        });
        let mut pump = OutputPump::new(
            streams
                .open("fragments", "fragments".into(), channel)
                .unwrap(),
            None,
        );
        let input: Vec<u8> = (0..20000).map(|n| (n % 256) as u8).collect();
        for byte in &input {
            pump.push(&[*byte]);
        }
        assert!(
            delivered.lock().is_empty(),
            "small packets must not flush per byte"
        );
        pump.finish().await;
        let batches = delivered.lock();
        assert_eq!(batches.len(), 1);
        assert_eq!(batches.concat(), input);
        assert_eq!(OutputPump::MAX, 65536);
    }
    #[tokio::test]
    async fn small_packets_keep_the_first_flush_deadline() {
        use super::output::OutputStreams;
        let streams = OutputStreams::default();
        let output = streams
            .open("small", "small".into(), Channel::new(|_| Ok(())))
            .unwrap();
        let mut pump = OutputPump::new(output, None);
        pump.push(b"one");
        let deadline = pump.deadline;
        assert!(
            deadline
                .unwrap()
                .saturating_duration_since(tokio::time::Instant::now())
                <= std::time::Duration::from_millis(8)
        );
        for _ in 0..100 {
            pump.push(b"two");
        }
        assert_eq!(pump.deadline, deadline);
        tokio::time::timeout(std::time::Duration::from_secs(1), pump.ready())
            .await
            .unwrap();
        pump.flush();
        assert!(pump.is_empty());
        assert!(pump.deadline.is_none());
    }

    #[tokio::test]
    async fn cancellation_releases_an_eof_waiting_for_credits() {
        use super::output::OutputStreams;
        let streams = OutputStreams::default();
        let output = streams
            .open("eof", "eof".into(), Channel::new(|_| Ok(())))
            .unwrap();
        let mut pump = OutputPump::new(output, None);
        while pump.can_read() {
            pump.push(&vec![0; OUTPUT_CHUNK]);
        }
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(10), pump.finish())
                .await
                .is_err()
        );
        streams.close_session("eof");
        tokio::time::timeout(std::time::Duration::from_secs(1), pump.finish())
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn confirmed_binary_write_waits_for_the_session_owner() {
        let manager = Arc::new(SessionManager::default());
        let (tx, mut rx) = mpsc::unbounded_channel();
        manager.insert(SessionHandle {
            info: SessionInfo {
                id: "confirmed-write".into(),
                profile_id: None,
                name: "test".into(),
                kind: SessionKind::Ssh,
                protocol: "ssh".into(),
                address: "example.test:22".into(),
                color: None,
                supports_remote_files: true,
                recording: None,
                legacy_algorithms: Vec::new(),
                shared_connection: false,
            },
            tx,
            encoding: encoding_rs::UTF_8,
            owner_thread: None,
        });

        let write_task = tokio::spawn({
            let manager = manager.clone();
            async move {
                manager
                    .write_confirmed("confirmed-write", vec![1, 2, 3, 4])
                    .await
            }
        });

        let command = rx.recv().await.expect("write command");
        let SessionCommand::WriteConfirmed { data, reply } = command else {
            panic!("expected a confirmed write command");
        };
        assert_eq!(data, vec![1, 2, 3, 4]);
        assert!(
            !write_task.is_finished(),
            "the caller must remain blocked until the owner finishes writing"
        );

        reply.send(Ok(())).expect("acknowledge write");
        write_task
            .await
            .expect("write task should not panic")
            .expect("confirmed write should succeed");
    }

    #[tokio::test]
    async fn text_is_encoded_for_the_session_it_goes_to() {
        let manager = SessionManager::default();
        let (tx, mut rx) = mpsc::unbounded_channel();
        manager.insert(SessionHandle {
            info: SessionInfo {
                id: "gbk".into(),
                profile_id: None,
                name: "test".into(),
                kind: SessionKind::Ssh,
                protocol: "ssh".into(),
                address: "example.test:22".into(),
                color: None,
                supports_remote_files: true,
                recording: None,
                legacy_algorithms: Vec::new(),
                shared_connection: false,
            },
            tx,
            encoding: encoding_rs::GBK,
            owner_thread: None,
        });

        manager.write_text("gbk", "ls 你好\r").expect("write");
        let SessionCommand::Write(bytes) = rx.recv().await.expect("write command") else {
            panic!("expected a plain write");
        };
        assert_eq!(bytes, b"ls \xc4\xe3\xba\xc3\r".to_vec());

        assert!(manager.write_text("missing", "x").is_err());
    }
}
