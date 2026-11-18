use super::*;
use std::pin::Pin;

/// The read side of a shell channel, or a scripted stream standing in for one
/// so the session loop can be driven in a test without a server.
enum ShellReader {
    Live(russh::ChannelReadHalf),
    #[cfg(test)]
    Scripted(tokio::sync::mpsc::UnboundedReceiver<russh::ChannelMsg>),
}

impl ShellReader {
    async fn wait(&mut self) -> Option<russh::ChannelMsg> {
        match self {
            ShellReader::Live(reader) => reader.wait().await,
            #[cfg(test)]
            ShellReader::Scripted(rx) => rx.recv().await,
        }
    }
}

/// A writer that records what was sent, for a loop test with no server behind
/// it. Production never builds one.
#[cfg(test)]
#[derive(Default)]
struct ScriptedWriter {
    sent: std::sync::Arc<std::sync::Mutex<Vec<u8>>>,
    /// When set, every write waits for a permit before returning: a window the
    /// server never refills, without needing a server to stall it.
    gate: Option<std::sync::Arc<tokio::sync::Semaphore>>,
}

#[cfg(test)]
impl ScriptedWriter {
    async fn data(&mut self, data: Vec<u8>) -> std::result::Result<(), String> {
        self.sent.lock().expect("recorded").extend(data);
        if let Some(gate) = &self.gate {
            let permit = gate.acquire().await.expect("the gate is never closed");
            permit.forget();
        }
        Ok(())
    }
}

/// One input write the loop is waiting on: it returns the writer it borrowed,
/// whether the write worked, and the reply a confirmed write owes its caller.
type Writing = std::pin::Pin<
    Box<
        dyn std::future::Future<
                Output = (
                    ShellWriter,
                    std::result::Result<(), String>,
                    Option<tokio::sync::oneshot::Sender<crate::error::Result<()>>>,
                ),
            > + Send,
    >,
>;

/// The write side of the same channel, or a scripted stand-in that records what
/// was sent and can be held open, which is how a stalled write is reproduced.
enum ShellWriter {
    Live(russh::ChannelWriteHalf<russh::client::Msg>),
    #[cfg(test)]
    Scripted(ScriptedWriter),
}

impl ShellWriter {
    async fn data(&mut self, data: Vec<u8>) -> std::result::Result<(), String> {
        match self {
            ShellWriter::Live(writer) => writer.data_bytes(data).await.map_err(|e| e.to_string()),
            #[cfg(test)]
            ShellWriter::Scripted(writer) => writer.data(data).await,
        }
    }

    async fn resize(&mut self, cols: u32, rows: u32) -> std::result::Result<(), String> {
        match self {
            ShellWriter::Live(writer) => writer
                .window_change(cols, rows, 0, 0)
                .await
                .map_err(|e| e.to_string()),
            #[cfg(test)]
            ShellWriter::Scripted(_) => Ok(()),
        }
    }

    async fn close(&mut self) -> std::result::Result<(), String> {
        match self {
            ShellWriter::Live(writer) => {
                let _ = writer.eof().await;
                writer.close().await.map_err(|e| e.to_string())
            }
            #[cfg(test)]
            ShellWriter::Scripted(_) => Ok(()),
        }
    }
}

/// Drives one SSH shell session: pumps channel output to the UI and applies
/// commands coming back from it. `recorder` is the session's recording,
/// when the profile asked for one; it is fed here and closed with the task.
/// `output` is the per-session raw IPC channel the terminal's bytes go out on.
pub fn spawn(
    app: AppHandle,
    id: String,
    conn: SshConnection,
    mut rx: UnboundedReceiver<SessionCommand>,
    recorder: Option<Recorder>,
    output: crate::session::output::OutputChannel,
) {
    tauri::async_runtime::spawn(async move {
        let SshConnection {
            transport,
            channel,
            cwd_token,
        } = conn;
        // Held for as long as this session runs; the transport goes down
        // when the last session on it drops its share (see `SharedTransport`).
        let handle = transport.handle.clone();
        let (reader, writer) = channel.split();
        let mut pump = OutputPump::new(output, recorder);

        emit_state(&app, &id, "connected", None);

        let end = drive(
            ShellReader::Live(reader),
            ShellWriter::Live(writer),
            rx,
            &mut pump,
            Some(transport.clone()),
            Some(handle.clone()),
            cwd_token,
        )
        .await;

        pump.finish().await;
        if !end.close_requested && !pump.is_closed() {
            emit_state(&app, &id, "closed", close_reason(end.lost, end.exit_status));
        }
        // Only the channel is this session's own; whether the connection
        // under it closes now depends on the other tabs sharing it.
        drop(handle);
        drop(transport);
    });
}

/// How a shell session ended, in the terms `close_reason` reports.
struct SessionEnd {
    /// Why the connection went away, when it was not a clean remote exit.
    lost: Option<String>,
    /// The remote's exit status, when it sent one.
    exit_status: Option<u32>,
    /// Whether the frontend asked for the close, which is not worth reporting
    /// as the session ending on its own.
    close_requested: bool,
}

/// Runs one shell session until it ends. It is separate from `spawn` so a test
/// can drive it with a scripted channel: everything Tauri-specific — the state
/// events and the window handle — stays in `spawn`.
async fn drive(
    mut reader: ShellReader,
    mut writer: ShellWriter,
    mut rx: UnboundedReceiver<SessionCommand>,
    pump: &mut OutputPump,
    // The transport and handle are absent in a test, where nothing can reach a
    // server: the two commands that need them are answered with a refusal
    // instead of being spawned.
    transport: Option<Arc<SharedTransport>>,
    handle: Option<Arc<Handle<Client>>>,
    cwd_token: String,
) -> SessionEnd {
    let sftp = Arc::new(tokio::sync::Mutex::new(None));
    let mut exit_status: Option<u32> = None;
    // Why the session ended on its own when it was not a clean remote
    // exit: the transport dropped under it. Reported so the user is told
    // a lost connection rather than left with a bare "closed"; see
    // `close_reason`.
    let mut lost: Option<String> = None;
    // Set when the frontend asked for the close; see `emit_state`.
    let mut close_requested = false;
    // A write can block for a long time: the remote stops reading its input,
    // the channel window never refills, and russh waits for the server's
    // window update with no deadline. Awaiting it inline froze the session —
    // the loop could not poll the remote's output, flush what it already had,
    // or notice a Close — so the write now runs beside the loop instead of in
    // front of it. The writer is owned by the loop while it is idle and by the
    // in-flight write while one is running; a command that needs the writer
    // waits for it, which is what the channel window makes it do anyway.
    let mut writer_slot: Option<ShellWriter> = Some(writer);
    let mut writing: Option<Writing> = None;

    loop {
        if pump.is_closed() && writing.is_none() {
            if let Some(mut writer) = writer_slot.take() {
                let _ = writer.close().await;
            }
            break;
        }
        if let Some(write) = writing.as_mut() {
            tokio::select! {
                msg = reader.wait(), if pump.can_read() => {
                    if read_output(msg, pump, &mut exit_status, &mut lost) {
                        break;
                    }
                }
                _ = pump.ready(), if !pump.is_empty() => pump.flush(),
                (writer, result, reply) = write => {
                    writing = None;
                    if let Some(reply) = reply {
                        let _ = reply.send(result.clone().map_err(AppError::new));
                    }
                    match result {
                        Ok(()) => writer_slot = Some(writer),
                        Err(e) => {
                            lost = Some(format!("the connection was lost while sending input: {e}"));
                            let mut writer = writer;
                            let _ = writer.close().await;
                            break;
                        }
                    }
                }
            }
            continue;
        }
        tokio::select! {
            msg = reader.wait(), if pump.can_read() => {
                if read_output(msg, pump, &mut exit_status, &mut lost) {
                    break;
                }
            }
            cmd = rx.recv() => {
                match cmd {
                    Some(SessionCommand::Write(data)) => {
                        let mut writer = writer_slot.take().expect("idle writer");
                        writing = Some(Box::pin(async move {
                            let result = writer.data(data).await;
                            (writer, result, None)
                        }));
                    }
                    Some(SessionCommand::WriteConfirmed { data, reply }) => {
                        let mut writer = writer_slot.take().expect("idle writer");
                        writing = Some(Box::pin(async move {
                            let result = writer.data(data).await;
                            (writer, result, Some(reply))
                        }));
                    }
                    Some(SessionCommand::Resize { cols, rows }) => {
                        if let Some(writer) = writer_slot.as_mut() {
                            let _ = writer.resize(cols as u32, rows as u32).await;
                        };
                    }
                    Some(SessionCommand::Sftp { request, reply }) => match transport.clone() {
                        Some(transport) => {
                            let slot = sftp.clone();
                            tauri::async_runtime::spawn(async move {
                                let _ = reply.send(browse_sftp(transport, slot, request).await);
                            });
                        }
                        None => {
                            let _ = reply.send(Err(AppError::new(
                                "this session has no connection to run that on",
                            )));
                        }
                    },
                    Some(SessionCommand::QueryCwd { reply }) => match handle.clone() {
                        Some(handle) => {
                            let cwd_token = cwd_token.clone();
                            tauri::async_runtime::spawn(async move {
                                let _ = reply.send(remote_cwd(handle, &cwd_token).await);
                            });
                        }
                        None => {
                            let _ = reply.send(Err(AppError::new(
                                "this session has no connection to ask",
                            )));
                        }
                    },
                    Some(SessionCommand::Close) | None => {
                        close_requested = true;
                        if let Some(mut writer) = writer_slot.take() {
                            let _ = writer.close().await;
                        }
                        break;
                    }
                }
            }
            _ = pump.ready(), if !pump.is_empty() => pump.flush(),
        }
    }

    SessionEnd {
        lost,
        exit_status,
        close_requested,
    }
}

/// Takes one message from the remote while the session runs. Returns whether
/// the session is over: a clean close, or a transport that went away.
fn read_output(
    msg: Option<ChannelMsg>,
    pump: &mut OutputPump,
    exit_status: &mut Option<u32>,
    lost: &mut Option<String>,
) -> bool {
    match msg {
        Some(ChannelMsg::Data { data }) => pump.push(&data),
        Some(ChannelMsg::ExtendedData { data, .. }) => pump.push(&data),
        Some(ChannelMsg::ExitStatus { exit_status: code }) => *exit_status = Some(code),
        // The remote closed the shell — a normal exit, or the channel closing.
        Some(ChannelMsg::Eof) | Some(ChannelMsg::Close) => return true,
        // The transport ended with no channel close: a dropped connection, not
        // a clean exit, so it is reported lost.
        None => {
            *lost = Some("the connection was lost".to_string());
            return true;
        }
        Some(_) => {}
    }
    false
}

/// What a shell session reports when it ends on its own: the reason the
/// transport was lost if it dropped under the session, otherwise the remote's
/// exit status. A lost connection is the more useful of the two when a stalled
/// transfer or a killed session leaves both a dropped transport and a stale
/// exit code behind — the user reconnects on a lost link, not on an exit code.
fn close_reason(lost: Option<String>, exit_status: Option<u32>) -> Option<String> {
    lost.or_else(|| exit_status.map(|code| format!("exit status {code}")))
}

#[cfg(test)]
mod tests {
    use super::close_reason;

    #[test]
    fn a_lost_connection_is_reported_over_a_missing_or_stale_exit_status() {
        // The transport dropped and no exit status ever arrived: the loss is
        // all there is to report.
        assert_eq!(
            close_reason(Some("the connection was lost".to_string()), None),
            Some("the connection was lost".to_string())
        );
        // A clean remote exit keeps its exit status.
        assert_eq!(
            close_reason(None, Some(0)),
            Some("exit status 0".to_string())
        );
        // When the transport dropped, that reason wins over any exit status
        // the session happened to record before it went.
        assert_eq!(
            close_reason(Some("lost".to_string()), Some(1)),
            Some("lost".to_string())
        );
        // A bare channel close with neither reports nothing extra.
        assert_eq!(close_reason(None, None), None);
    }
}

/// The session loop, driven without a server: a scripted reader delivers
/// shell output and a Close ends the session. This is the harness the
/// stalled-write cases build on.
#[tokio::test]
async fn scripted_output_reaches_the_terminal_and_close_ends_the_session() {
    use tauri::ipc::InvokeResponseBody;

    let seen = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    let (reader_tx, reader_rx) = tokio::sync::mpsc::unbounded_channel();
    let (command_tx, command_rx) = tokio::sync::mpsc::unbounded_channel();
    let writer = ScriptedWriter::default();
    let sent = writer.sent.clone();

    // The loop chooses among its branches, so the test waits for each effect
    // instead of assuming the order they land in.
    let running = {
        let seen = seen.clone();
        tokio::spawn(async move {
            let streams = crate::session::output::OutputStreams::default();
            let channel = tauri::ipc::Channel::new(move |body| {
                if let InvokeResponseBody::Raw(bytes) = body {
                    seen.lock().expect("captured").extend(bytes);
                }
                Ok(())
            });
            let mut pump = crate::session::OutputPump::new(
                streams.open("t", "tok".into(), channel).expect("opened"),
                None,
            );
            let end = drive(
                ShellReader::Scripted(reader_rx),
                ShellWriter::Scripted(writer),
                command_rx,
                &mut pump,
                None,
                None,
                String::new(),
            )
            .await;
            pump.finish().await;
            end
        })
    };

    reader_tx
        .send(russh::ChannelMsg::Data {
            data: bytes::Bytes::from_static(b"hello"),
        })
        .expect("queued output");
    command_tx
        .send(SessionCommand::Write(b"typed".to_vec()))
        .expect("queued input");
    settle(|| {
        seen.lock().expect("read").as_slice() == b"hello"
            && sent.lock().expect("read").as_slice() == b"typed"
    })
    .await;
    command_tx
        .send(SessionCommand::Close)
        .expect("queued close");

    let end = running.await.expect("the loop finished");
    assert!(end.close_requested);
    assert!(end.lost.is_none());
}

/// Waits for an effect the loop produces in its own time, so a test never
/// depends on which branch of its select ran first.
async fn settle(ready: impl Fn() -> bool) {
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(5);
    while !ready() {
        assert!(
            tokio::time::Instant::now() < deadline,
            "the session loop never produced the expected effect"
        );
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    }
}

/// A write the server never acknowledges must not freeze the session: the
/// remote's output has to keep arriving, and a Close has to be honoured, while
/// the write is still in flight. Awaiting the write inline did neither — the
/// loop was parked inside `data`, so the terminal showed nothing new and the
/// tab could not be closed.
#[tokio::test]
async fn a_stalled_write_does_not_freeze_the_output_or_the_close() {
    use std::sync::Arc;
    use tauri::ipc::InvokeResponseBody;

    let seen = Arc::new(std::sync::Mutex::new(Vec::new()));
    let (reader_tx, reader_rx) = tokio::sync::mpsc::unbounded_channel();
    let (command_tx, command_rx) = tokio::sync::mpsc::unbounded_channel();
    // No permits: the write records the bytes and then waits for ever.
    let gate = Arc::new(tokio::sync::Semaphore::new(0));
    let writer = ScriptedWriter {
        sent: Arc::new(std::sync::Mutex::new(Vec::new())),
        gate: Some(gate.clone()),
    };
    let sent = writer.sent.clone();

    let running = {
        let seen = seen.clone();
        tokio::spawn(async move {
            let streams = crate::session::output::OutputStreams::default();
            let channel = tauri::ipc::Channel::new(move |body| {
                if let InvokeResponseBody::Raw(bytes) = body {
                    seen.lock().expect("captured").extend(bytes);
                }
                Ok(())
            });
            let mut pump = crate::session::OutputPump::new(
                streams.open("t", "tok".into(), channel).expect("opened"),
                None,
            );
            let end = drive(
                ShellReader::Scripted(reader_rx),
                ShellWriter::Scripted(writer),
                command_rx,
                &mut pump,
                None,
                None,
                String::new(),
            )
            .await;
            pump.finish().await;
            end
        })
    };

    command_tx
        .send(SessionCommand::Write(b"pasted".to_vec()))
        .expect("queued input");
    // The write is now parked on the gate.
    settle(|| sent.lock().expect("read").as_slice() == b"pasted").await;

    reader_tx
        .send(russh::ChannelMsg::Data {
            data: bytes::Bytes::from_static(b"prompt"),
        })
        .expect("queued output");
    settle(|| seen.lock().expect("read").as_slice() == b"prompt").await;

    gate.add_permits(1);
    command_tx
        .send(SessionCommand::Close)
        .expect("queued close");
    let end = running.await.expect("the loop finished");
    assert!(end.close_requested);
    assert!(end.lost.is_none(), "{:?}", end.lost);
}
