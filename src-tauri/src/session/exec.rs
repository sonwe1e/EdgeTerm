//! Bounded independent exec channels for commands outside the terminal PTY.
use super::ssh::SharedTransport;
use crate::{
    error::{AppError, Result},
    file_transfer::{Control, Failure},
};
use russh::ChannelMsg;
use std::sync::Arc;
use std::time::Duration;

pub async fn run(
    transport: Arc<SharedTransport>,
    script: &str,
    control: &Control,
    limit: usize,
    timeout: Duration,
) -> Result<String> {
    let output = capture(transport, script, control, limit, timeout, true).await?;
    if output.truncated {
        return Err(Failure::new("limit", "inspection output exceeded its limit", false).into());
    }
    if output.exit.is_some_and(|status| status != 0) {
        return Err(Failure::new(
            "exec",
            format!(
                "inspection command failed: {}",
                String::from_utf8_lossy(&output.stdout)
                    .chars()
                    .take(500)
                    .collect::<String>()
            ),
            false,
        )
        .into());
    }
    String::from_utf8(output.stdout)
        .map_err(|_| Failure::new("encoding", "inspection output is not UTF-8", false).into())
}

#[derive(Default)]
pub struct CommandOutput {
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    pub exit: Option<u32>,
    pub truncated: bool,
}

pub async fn run_status(
    transport: Arc<SharedTransport>,
    script: &str,
    control: &Control,
    limit: usize,
    timeout: Duration,
) -> Result<CommandOutput> {
    capture(transport, script, control, limit, timeout, false).await
}

async fn capture(
    transport: Arc<SharedTransport>,
    script: &str,
    control: &Control,
    limit: usize,
    timeout: Duration,
    merge_stderr: bool,
) -> Result<CommandOutput> {
    let work = control.run(async {
        let mut channel = transport
            .owned_command_channel()
            .await
            .map_err(Failure::connection)?;
        channel.terminate_on_drop();
        channel
            .exec(true, "sh")
            .await
            .map_err(Failure::connection)?;
        // sshd parses the command with the account's login shell, which may
        // be fish or csh. Let sh read the fixed POSIX script on stdin instead.
        channel
            .data_bytes(script.as_bytes().to_vec())
            .await
            .map_err(Failure::connection)?;
        channel.eof().await.map_err(Failure::connection)?;
        let mut output = CommandOutput::default();
        while let Some(message) = channel.wait().await {
            control.check()?;
            match message {
                ChannelMsg::ExtendedData { data, .. } if !merge_stderr => {
                    let keep = data
                        .len()
                        .min(8192usize.saturating_sub(output.stderr.len()));
                    output.stderr.extend_from_slice(&data[..keep]);
                }
                ChannelMsg::Data { data } | ChannelMsg::ExtendedData { data, .. } => {
                    let keep = data.len().min(limit - output.stdout.len());
                    output.stdout.extend_from_slice(&data[..keep]);
                    if keep < data.len() {
                        output.truncated = true;
                        if merge_stderr {
                            break;
                        }
                    }
                }
                ChannelMsg::Failure => {
                    return Err(Failure::new(
                        "denied",
                        "the server refused this inspection command",
                        false,
                    ))
                }
                ChannelMsg::ExitStatus { exit_status } => output.exit = Some(exit_status),
                ChannelMsg::Close => break,
                _ => {}
            }
        }
        Ok(output)
    });
    match tokio::time::timeout(timeout, work).await {
        Ok(result) => result.map_err(AppError::from),
        Err(_) => {
            control.set(2);
            Err(AppError::new("inspection timed out"))
        }
    }
}
