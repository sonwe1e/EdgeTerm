//! Bounded independent exec channels for read-only host inspection.
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
        let mut bytes = Vec::new();
        let mut exit = None;
        while let Some(message) = channel.wait().await {
            control.check()?;
            match message {
                ChannelMsg::Data { data } | ChannelMsg::ExtendedData { data, .. } => {
                    if bytes.len().saturating_add(data.len()) > limit {
                        return Err(Failure::new(
                            "limit",
                            "inspection output exceeded its limit",
                            false,
                        ));
                    }
                    bytes.extend_from_slice(&data);
                }
                ChannelMsg::Failure => {
                    return Err(Failure::new(
                        "denied",
                        "the server refused this inspection command",
                        false,
                    ))
                }
                ChannelMsg::ExitStatus { exit_status } => exit = Some(exit_status),
                ChannelMsg::Close => break,
                _ => {}
            }
        }
        if exit.is_some_and(|status| status != 0) {
            return Err(Failure::new(
                "exec",
                format!(
                    "inspection command failed: {}",
                    String::from_utf8_lossy(&bytes)
                        .chars()
                        .take(500)
                        .collect::<String>()
                ),
                false,
            ));
        }
        String::from_utf8(bytes)
            .map_err(|_| Failure::new("encoding", "inspection output is not UTF-8", false))
    });
    match tokio::time::timeout(timeout, work).await {
        Ok(result) => result.map_err(AppError::from),
        Err(_) => {
            control.set(2);
            Err(AppError::new("inspection timed out"))
        }
    }
}
