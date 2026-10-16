use super::*;

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
        let SshConnection { transport, channel } = conn;
        // Held for as long as this session runs; the transport goes down
        // when the last session on it drops its share (see `SharedTransport`).
        let handle = transport.handle.clone();
        let (mut reader, writer) = channel.split();
        let mut pump = OutputPump::new(output, recorder);
        let sftp = Arc::new(tokio::sync::Mutex::new(None));
        let mut exit_status: Option<u32> = None;
        // Set when the frontend asked for the close; see `emit_state`.
        let mut close_requested = false;

        emit_state(&app, &id, "connected", None);

        loop {
            if pump.is_closed() {
                let _ = writer.eof().await;
                let _ = writer.close().await;
                break;
            }
            tokio::select! {
                msg = reader.wait(), if pump.can_read() => {
                    match msg {
                        Some(ChannelMsg::Data { data }) => pump.push(&data),
                        Some(ChannelMsg::ExtendedData { data, .. }) => pump.push(&data),
                        Some(ChannelMsg::ExitStatus { exit_status: code }) => exit_status = Some(code),
                        Some(ChannelMsg::Eof) | Some(ChannelMsg::Close) | None => break,
                        Some(_) => {}
                    }
                }
                cmd = rx.recv() => {
                    match cmd {
                        Some(SessionCommand::Write(data)) => {
                            if writer.data_bytes(data).await.is_err() {
                                break;
                            }
                        }
                        Some(SessionCommand::WriteConfirmed { data, reply }) => {
                            let result = writer.data_bytes(data).await.map_err(AppError::from);
                            let failed = result.is_err();
                            let _ = reply.send(result);
                            if failed {
                                break;
                            }
                        }
                        Some(SessionCommand::Resize { cols, rows }) => {
                            let _ = writer.window_change(cols as u32, rows as u32, 0, 0).await;
                        }
                        Some(SessionCommand::Sftp { request, reply }) => {
                            let transport = transport.clone();
                            let slot = sftp.clone();
                            tauri::async_runtime::spawn(async move {
                                let _ = reply.send(browse_sftp(transport, slot, request).await);
                            });
                        }
                        Some(SessionCommand::QueryCwd { reply }) => {
                            // Its own exec channel, off the session loop, so
                            // the shell channel is neither written to nor
                            // held up.
                            let handle = handle.clone();
                            tauri::async_runtime::spawn(async move {
                                let _ = reply.send(remote_cwd(handle).await);
                            });
                        }
                        Some(SessionCommand::Close) | None => {
                            close_requested = true;
                            let _ = writer.eof().await;
                            let _ = writer.close().await;
                            break;
                        }
                    }
                }
                _ = pump.ready(), if !pump.is_empty() => pump.flush(),
            }
        }

        pump.finish().await;
        if !close_requested && !pump.is_closed() {
            emit_state(
                &app,
                &id,
                "closed",
                exit_status.map(|c| format!("exit status {c}")),
            );
        }
        // Only the channel is this session's own; whether the connection
        // under it closes now depends on the other tabs sharing it.
        drop(handle);
        drop(transport);
    });
}
