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
        // Why the session ended on its own when it was not a clean remote
        // exit: the transport dropped under it. Reported so the user is told
        // a lost connection rather than left with a bare "closed"; see
        // `close_reason`.
        let mut lost: Option<String> = None;
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
                        // The remote closed the shell — a normal exit, or the
                        // channel closing — whose exit status, if any, is the
                        // reason reported below.
                        Some(ChannelMsg::Eof) | Some(ChannelMsg::Close) => break,
                        // The transport ended with no channel close: a dropped
                        // connection, not a clean exit, so it is reported lost.
                        None => {
                            lost = Some("the connection was lost".to_string());
                            break;
                        }
                        Some(_) => {}
                    }
                }
                cmd = rx.recv() => {
                    match cmd {
                        Some(SessionCommand::Write(data)) => {
                            if let Err(e) = writer.data_bytes(data).await {
                                lost = Some(format!(
                                    "the connection was lost while sending input: {e}"
                                ));
                                break;
                            }
                        }
                        Some(SessionCommand::WriteConfirmed { data, reply }) => {
                            let result = writer.data_bytes(data).await.map_err(AppError::from);
                            let failed = result.is_err();
                            if let Err(e) = &result {
                                lost = Some(format!(
                                    "the connection was lost while sending input: {e}"
                                ));
                            }
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
            emit_state(&app, &id, "closed", close_reason(lost, exit_status));
        }
        // Only the channel is this session's own; whether the connection
        // under it closes now depends on the other tabs sharing it.
        drop(handle);
        drop(transport);
    });
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
