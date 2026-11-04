//! Read-only coding-agent installation inspection.
use super::*;
use std::process::Stdio;
use std::time::Duration;

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "bindings", derive(specta::Type))]
pub struct AgentInstallation {
    executable: String,
    version: String,
    home: String,
    config_root: String,
}

#[tauri::command]
#[cfg_attr(feature = "bindings", specta::specta)]
pub async fn coding_agent_inspect(
    state: State<'_, AppState>,
    id: String,
    tool: String,
) -> Result<AgentInstallation> {
    if !matches!(tool.as_str(), "pi" | "opencode") {
        return Err(err("unsupported coding agent"));
    }
    let profile = state
        .file_transfers
        .profile_of(&id)
        .ok_or_else(|| AppError::new("session is unavailable"))?;
    if profile.kind == SessionKind::Ssh {
        let transport = state
            .ssh_transports
            .get(&id)
            .ok_or_else(|| AppError::new("SSH connection is unavailable"))?;
        let script = format!(
            "printf '%s\\n' \"$HOME\" \"${{PI_CODING_AGENT_DIR:-$HOME/.pi/agent}}\"; command -v {tool} || printf '\\n'; {tool} --version 2>/dev/null || true\n"
        );
        let control = crate::file_transfer::Control::default();
        let output =
            session::exec::run(transport, &script, &control, 8192, Duration::from_secs(8)).await?;
        let mut lines = output.lines();
        return Ok(AgentInstallation {
            home: lines.next().unwrap_or_default().into(),
            config_root: lines.next().unwrap_or_default().into(),
            executable: lines.next().unwrap_or_default().into(),
            version: lines.next().unwrap_or_default().into(),
        });
    }
    if profile.kind != SessionKind::Local {
        return Err(err("coding agents require a local or SSH terminal"));
    }
    let executable = find_executable(&tool).unwrap_or_default();
    let version = if executable.is_empty() {
        String::new()
    } else {
        local_version(&tool, &executable).await?
    };
    let home = dirs::home_dir().ok_or_else(|| AppError::new("home directory is unavailable"))?;
    let root = std::env::var_os("PI_CODING_AGENT_DIR")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| home.join(".pi/agent"));
    Ok(AgentInstallation {
        executable,
        version,
        home: home.to_string_lossy().into(),
        config_root: root.to_string_lossy().into(),
    })
}

fn find_executable(tool: &str) -> Option<String> {
    let suffixes = if cfg!(windows) {
        vec![".exe", ".cmd", ".bat", ""]
    } else {
        vec![""]
    };
    std::env::split_paths(&std::env::var_os("PATH")?).find_map(|dir| {
        suffixes
            .iter()
            .map(|suffix| dir.join(format!("{tool}{suffix}")))
            .find(|path| path.is_file())
            .map(|path| path.to_string_lossy().into())
    })
}

async fn local_version(tool: &str, executable: &str) -> Result<String> {
    let mut command =
        if cfg!(windows) && (executable.ends_with(".cmd") || executable.ends_with(".bat")) {
            let mut command = tokio::process::Command::new("cmd.exe");
            // Both words are fixed/validated, never a path or prompt from the UI.
            command.args(["/d", "/c", tool, "--version"]);
            command
        } else {
            let mut command = tokio::process::Command::new(executable);
            command.arg("--version");
            command
        };
    #[cfg(windows)]
    command.creation_flags(0x0800_0000);
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    let mut child = command.spawn().map_err(AppError::new)?;
    let work = async {
        let mut bytes = Vec::new();
        child
            .stdout
            .take()
            .ok_or_else(|| AppError::new("missing version output"))?
            .take(8193)
            .read_to_end(&mut bytes)
            .await?;
        if bytes.len() > 8192 {
            return Err(err("version output exceeded its limit"));
        }
        let status = child.wait().await?;
        if !status.success() {
            return Err(err("agent version check failed"));
        }
        Ok(String::from_utf8_lossy(&bytes)
            .lines()
            .next()
            .unwrap_or_default()
            .to_owned())
    };
    tokio::time::timeout(Duration::from_secs(8), work)
        .await
        .map_err(|_| AppError::new("agent version check timed out"))?
}
