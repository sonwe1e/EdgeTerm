use std::{path::Path, process::Stdio, sync::Arc, time::Duration};

use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWriteExt},
    process::Command,
};

use crate::{
    error::{err, AppError, Result},
    file_transfer::Control,
    session::{
        exec::{self, CommandOutput},
        ssh::SharedTransport,
    },
};

// A desktop launched by Git or a login shell must still address the worktree
// that was opened, even if that process exported overrides for its own index.
const REPO_ENV: &[&str] = &[
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_COMMON_DIR",
    "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_NAMESPACE",
    "GIT_PREFIX",
    "GIT_CONFIG",
    "GIT_GLOB_PATHSPECS",
    "GIT_NOGLOB_PATHSPECS",
    "GIT_ICASE_PATHSPECS",
];
const ENV: &[(&str, &str)] = &[
    ("LC_ALL", "C"),
    ("GIT_OPTIONAL_LOCKS", "0"),
    ("GIT_TERMINAL_PROMPT", "0"),
];
const ARGS: &[&str] = &[
    "--no-pager",
    "--literal-pathspecs",
    "-c",
    "core.fsmonitor=false",
    "-c",
    "core.quotePath=false",
    "-c",
    "color.ui=false",
    "-c",
    "core.bigFileThreshold=8m",
    "-C",
];

pub(super) enum Runner {
    Local,
    Ssh(Arc<SharedTransport>),
}

impl Runner {
    pub(super) fn windows(&self) -> bool {
        cfg!(windows) && matches!(self, Self::Local)
    }

    pub(super) async fn run(
        &self,
        directory: &str,
        args: &[&str],
        input: Option<&[u8]>,
        limit: usize,
        timeout: Duration,
    ) -> Result<CommandOutput> {
        let absolute = match self {
            Self::Local => Path::new(directory).is_absolute(),
            Self::Ssh(_) => directory.starts_with('/'),
        };
        if !absolute || directory.contains('\0') {
            return Err(AppError::invalid_input(
                "Git requires an absolute directory",
            ));
        }
        let output = match self {
            Self::Local => tokio::time::timeout(timeout, run_local(directory, args, input, limit))
                .await
                .map_err(|_| AppError::timeout("Git command timed out"))??,
            Self::Ssh(transport) => {
                let script = remote_script(directory, args, input)?;
                exec::run_status(
                    transport.clone(),
                    &script,
                    &Control::default(),
                    limit,
                    timeout,
                )
                .await?
            }
        };
        match output.exit {
            Some(127) => Err(err("Git is not installed or not on PATH on this host")),
            None => Err(AppError::connection_failed(
                "Git did not report an exit status",
            )),
            _ => Ok(output),
        }
    }
}

pub(super) fn quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

pub(super) fn remote_script(
    directory: &str,
    args: &[&str],
    input: Option<&[u8]>,
) -> Result<String> {
    let mut script = format!("unset {}\n", REPO_ENV.join(" "));
    for (key, value) in ENV {
        script.push_str(&format!("export {key}={value}\n"));
    }
    script.push_str("exec git");
    for argument in ARGS
        .iter()
        .copied()
        .chain([directory])
        .chain(args.iter().copied())
    {
        script.push(' ');
        script.push_str(&quote(argument));
    }
    if let Some(input) = input {
        let input = std::str::from_utf8(input).map_err(err)?;
        // The quoted here-doc preserves patch bytes and keeps arbitrarily
        // quoted input out of the command line. Both callers send a final LF.
        let delimiter = format!("EDGETERM_GIT_{}", uuid::Uuid::new_v4().simple());
        script.push_str(&format!(" <<'{delimiter}'\n{input}{delimiter}"));
    }
    script.push('\n');
    Ok(script)
}

fn executable() -> Result<std::path::PathBuf> {
    let name = if cfg!(windows) { "git.exe" } else { "git" };
    std::env::var_os("PATH")
        .and_then(|path| {
            std::env::split_paths(&path)
                .filter(|directory| directory.is_absolute())
                .map(|directory| directory.join(name))
                .find(|path| path.is_file())
        })
        .ok_or_else(|| err("Git is not installed or not on PATH on this computer"))
}

async fn drain(reader: impl AsyncRead + Unpin, limit: usize) -> std::io::Result<(Vec<u8>, bool)> {
    let mut reader = reader.take(limit as u64 + 1);
    let mut bytes = Vec::new();
    reader.read_to_end(&mut bytes).await?;
    let truncated = bytes.len() > limit;
    if truncated {
        bytes.truncate(limit);
        tokio::io::copy(&mut reader.into_inner(), &mut tokio::io::sink()).await?;
    }
    Ok((bytes, truncated))
}

async fn run_local(
    directory: &str,
    args: &[&str],
    input: Option<&[u8]>,
    limit: usize,
) -> Result<CommandOutput> {
    let mut command = Command::new(executable()?);
    for key in REPO_ENV {
        command.env_remove(key);
    }
    #[cfg(windows)]
    command.creation_flags(0x0800_0000);
    let mut child = command
        .envs(ENV.iter().copied())
        .args(ARGS)
        .arg(directory)
        .args(args)
        .stdin(if input.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()?;
    let stdout = child.stdout.take().expect("piped Git stdout");
    let stderr = child.stderr.take().expect("piped Git stderr");
    let mut stdin = child.stdin.take();
    let write = async move {
        if let (Some(pipe), Some(input)) = (&mut stdin, input) {
            // If Git rejected the command before reading stdin, its exit and
            // stderr carry the useful diagnostic.
            if let Err(error) = pipe.write_all(input).await {
                if error.kind() != std::io::ErrorKind::BrokenPipe {
                    return Err(error);
                }
            }
        }
        Ok(())
    };
    let ((stdout, truncated), (stderr, _), exit, ()) = tokio::try_join!(
        drain(stdout, limit),
        drain(stderr, 8192),
        child.wait(),
        write
    )?;
    Ok(CommandOutput {
        stdout,
        stderr,
        exit: exit.code().map(|code| code as u32),
        truncated,
    })
}
