//! Directory restoration happens when the shell starts, never by replaying
//! terminal input into a program that might already own the PTY.

use crate::error::{AppError, Result};

fn quote_sh(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}

/// sshd parses this through the account's login shell. Pass the actual script
/// as one quoted argument to POSIX sh, including for fish/csh login accounts.
pub fn ssh_start_command(path: &str, token: &str) -> Result<String> {
    if !path.starts_with('/') || path.len() > 8192 || path.chars().any(char::is_control) {
        return Err(AppError::new("invalid SSH starting directory"));
    }
    let script = format!(
        "cd -- {} || cd; export LC_EDGETERM_SESSION={}; exec \"${{SHELL:-/bin/sh}}\" -l",
        quote_sh(path),
        quote_sh(token)
    );
    Ok(format!("sh -c {}", quote_sh(&script)))
}

// Run after the user's PowerShell profile, preserving its prompt. $PWD is a
// shell location; reading the Windows process's PEB would give the wrong path.
const POWERSHELL_PROMPT: &str = r#"$global:__EdgeTermPrompt = $function:prompt; function global:prompt { $edgeExit = $global:LASTEXITCODE; if ($PWD.Provider.Name -eq 'FileSystem') { [Console]::Write(([char]27).ToString() + ']9;9;' + $PWD.Path + [char]7) }; $global:LASTEXITCODE = $edgeExit; & $global:__EdgeTermPrompt }"#;

pub fn windows_shell_integration(argv: &mut Vec<String>) -> Option<String> {
    let program = argv
        .first()?
        .rsplit(['/', '\\'])
        .next()?
        .to_ascii_lowercase();
    if program == "cmd" || program == "cmd.exe" {
        let original = std::env::var("PROMPT").unwrap_or_else(|_| "$P$G".into());
        return Some(format!("$E]9;9;$P$E\\{original}"));
    }
    if !["pwsh", "pwsh.exe", "powershell", "powershell.exe"].contains(&program.as_str()) {
        return None;
    }
    // A custom -Command/-File/encoded command belongs to the user. Only
    // interactive shell launches are wrapped, with known standalone flags.
    if argv[1..].iter().any(|arg| {
        !["-nologo", "-noprofile", "-noexit", "-login", "-l"]
            .contains(&arg.to_ascii_lowercase().as_str())
    }) {
        return None;
    }
    if !argv.iter().any(|arg| arg.eq_ignore_ascii_case("-NoExit")) {
        argv.push("-NoExit".into());
    }
    argv.push("-Command".into());
    argv.push(POWERSHELL_PROMPT.into());
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ssh_directory_is_one_literal_argument() {
        let command =
            ssh_start_command("/srv/a'b $(touch SHOULD_NOT_EXIST); 中文", "test").unwrap();
        assert!(command.starts_with("sh -c '"));
        assert!(command.contains("exec"));
        for invalid in ["relative", "/tmp/a\nb", "/tmp/\x1b[2J"] {
            assert!(ssh_start_command(invalid, "test").is_err());
        }
    }

    #[test]
    fn wraps_interactive_powershell_and_leaves_custom_commands_alone() {
        let mut argv = vec![
            "C:\\Program Files\\PowerShell\\7\\pwsh.exe".into(),
            "-NoLogo".into(),
        ];
        assert_eq!(windows_shell_integration(&mut argv), None);
        assert!(argv.contains(&"-NoExit".into()));
        assert_eq!(argv.last().unwrap(), POWERSHELL_PROMPT);
        for words in [
            ["pwsh", "-File", "start.ps1"],
            ["powershell.exe", "-c", "Get-Date"],
            ["wsl.exe", "-d", "Ubuntu"],
        ] {
            let mut argv: Vec<String> = words.iter().map(|word| word.to_string()).collect();
            let original = argv.clone();
            assert_eq!(windows_shell_integration(&mut argv), None);
            assert_eq!(argv, original);
        }
    }

    /// Real ConPTY shells, not a command-string assertion: change directory and
    /// observe the next prompt's OSC report, including spaces and apostrophes.
    #[cfg(windows)]
    fn check_windows_prompt(program: &str, powershell: bool) {
        use portable_pty::{native_pty_system, CommandBuilder, PtySize};
        use std::io::{Read, Write};
        use std::time::{Duration, Instant};

        let root = std::env::temp_dir().join(format!("edgeterm-cwd-{}", uuid::Uuid::new_v4()));
        let changed = root.join("dir's space 中文");
        std::fs::create_dir_all(&changed).unwrap();
        let pty = native_pty_system()
            .openpty(PtySize {
                rows: 24,
                cols: 120,
                pixel_width: 0,
                pixel_height: 0,
            })
            .unwrap();
        let mut argv = vec![program.to_string()];
        if powershell {
            argv.extend(["-NoLogo".into(), "-NoProfile".into()]);
        } else {
            argv.push("/D".into());
        }
        let prompt = windows_shell_integration(&mut argv);
        let mut command = CommandBuilder::new(&argv[0]);
        command.args(&argv[1..]);
        command.cwd(&root);
        if let Some(prompt) = prompt {
            command.env("PROMPT", prompt);
        }
        let mut child = pty.slave.spawn_command(command).unwrap();
        drop(pty.slave);
        let mut reader = pty.master.try_clone_reader().unwrap();
        let mut writer = pty.master.take_writer().unwrap();
        let (send, receive) = std::sync::mpsc::channel();
        let reader_thread = std::thread::spawn(move || {
            let mut buffer = [0u8; 4096];
            while let Ok(n) = reader.read(&mut buffer) {
                if n == 0 || send.send(buffer[..n].to_vec()).is_err() {
                    break;
                }
            }
        });
        let mut output = Vec::new();
        let initial = format!("\x1b]9;9;{}", root.display());
        let expected = format!("\x1b]9;9;{}", changed.display());
        let deadline = Instant::now() + Duration::from_secs(20);
        let mut sent = false;
        let mut found = false;
        let mut answered_at = 0;
        while Instant::now() < deadline {
            if let Ok(bytes) = receive.recv_timeout(Duration::from_millis(100)) {
                output.extend(bytes);
            }
            let text = String::from_utf8_lossy(&output);
            // ConPTY inherits its initial cursor position from the terminal.
            // The real xterm answers this DSR; this headless reader must too.
            if let Some(at) = text.rfind("\x1b[6n") {
                if at + 4 > answered_at {
                    writer.write_all(b"\x1b[1;1R").unwrap();
                    writer.flush().unwrap();
                    answered_at = at + 4;
                }
            }
            if !sent && text.contains(&initial) {
                let cd = if powershell {
                    format!(
                        "Set-Location -LiteralPath '{}'\r",
                        changed.to_string_lossy().replace('\'', "''")
                    )
                } else {
                    format!("cd /d \"{}\"\r", changed.display())
                };
                writer.write_all(cd.as_bytes()).unwrap();
                writer.flush().unwrap();
                sent = true;
            }
            if text.contains(&expected) {
                found = true;
                break;
            }
        }
        let _ = child.kill();
        let _ = child.wait();
        drop(writer);
        drop(pty.master);
        drop(receive);
        let _ = reader_thread.join();
        let _ = std::fs::remove_dir(&changed);
        let _ = std::fs::remove_dir(&root);
        assert!(
            found,
            "{program} did not report its changed directory: {}",
            String::from_utf8_lossy(&output)
        );
    }

    #[test]
    #[cfg(windows)]
    fn cmd_reports_actual_directory_through_conpty() {
        check_windows_prompt("cmd.exe", false);
    }

    #[test]
    #[cfg(windows)]
    fn powershell_reports_actual_directory_through_conpty() {
        check_windows_prompt("powershell.exe", true);
    }
}
