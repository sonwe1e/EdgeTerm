<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/logo-dark.png">
    <img src="docs/logo.png" alt="EdgeTerm" width="480">
  </picture>
</p>

<p align="center">
  <a href="https://github.com/miskin-lee/EdgeTerm/stargazers"><img alt="GitHub stars" src="https://img.shields.io/github/stars/miskin-lee/EdgeTerm?style=flat"></a>
  <a href="https://qm.qq.com/q/oINZ2ffDOg"><img alt="Join the EdgeTerm QQ group: 1129162865" src="https://img.shields.io/badge/QQ%20group-Join%20discussion-12B7F5?style=flat"></a>
  <a href="https://github.com/miskin-lee/EdgeTerm/releases"><img alt="GitHub release downloads" src="https://img.shields.io/github/downloads/miskin-lee/EdgeTerm/total?style=flat&amp;label=downloads"></a>
  <a href="https://github.com/miskin-lee/EdgeTerm/releases/latest"><img alt="Latest GitHub release" src="https://img.shields.io/github/v/release/miskin-lee/EdgeTerm?style=flat"></a>
  <a href="LICENSE"><img alt="GPL-3.0 license" src="https://img.shields.io/github/license/miskin-lee/EdgeTerm?style=flat"></a>
  <a href="https://github.com/miskin-lee/EdgeTerm/graphs/contributors"><img alt="GitHub contributors" src="https://img.shields.io/github/contributors/miskin-lee/EdgeTerm?style=flat"></a>
</p>

[English](README.md) | [简体中文](README.zh-CN.md)

A small, fast terminal, SSH, Telnet, SFTP, FTP and serial client built with **Rust + Tauri**. Installers are about 4–5 MB.

> [!TIP]
> <a href="https://github.com/miskin-lee/serialX"><img src="https://raw.githubusercontent.com/miskin-lee/serialX/main/assets/icons/png/serialx-64.png" alt="serialX" width="20" height="20" align="top"></a> Doing embedded work and debugging devices over a serial port? Try **[serialX](https://github.com/miskin-lee/serialX)** from the same author, a workspace built for serial debugging.

<img src="docs/screenshot-dark.png" alt="EdgeTerm dark theme: split panes, colored log and switch output, Session tree, Filer and Sender" width="100%">

<img src="docs/screenshot-light.png" alt="EdgeTerm light theme: the same workspace" width="100%">

## Features

- **Sessions**: local shell, SSH, Telnet, SFTP, FTP and serial port, saved in a grouped tree you can filter, duplicate and import from `~/.ssh/config`.
- **SSH**: password, public key, ssh-agent and keyboard-interactive (MFA / one-time codes), jump hosts, and older network gear that only speaks legacy algorithms.
- **Readable output**: a timestamp and line-number gutter, and semantic coloring of IPs, URLs, log levels, HTTP methods, paths, sizes and more.
- **Split panes and tabs**: split right or down, drag tabs between panes, and see at a glance which background tab is busy or done.
- **Filer**: browse over SFTP, FTP or the local disk, with drag and drop to and from your desktop.
- **Experiment workbench**: servers, project directories, experiment variants and individual runs are recorded separately; edit Python and config, review Git changes, launch training, read logs and compare host resources in one window. Projects never depend on terminal-tab ids.
- **Background transfers**: Filer and the dual-pane browser share **Transfers** in the status bar, with bounded file concurrency, pause/resume, cancellation, failed-file retries and automatic reconnect attempts. Files are staged beside their destination and replaced only after completion.
- **Sender**: saved commands and multi-line scripts, sent to one session or all of them, optionally on a timer.
- **File transfer in the terminal**: ZMODEM (`rz` / `sz`) and XMODEM.
- **Everyday details**: themes, fonts and cursor style, custom encodings and locale, session recording, Copy on Select, a warning before multi-line pastes, rebindable shortcuts, and export / import of all settings.

## Install

Download from [Releases](https://github.com/miskin-lee/EdgeTerm/releases):

| Platform | Package |
| --- | --- |
| Windows x64 | Installer (`.exe`) or portable `.zip` |
| macOS Apple Silicon | `.dmg` |
| Linux x64 / ARM64 | `.AppImage`, `.deb` or `.rpm` |

- Builds are not notarized or Authenticode-signed, so the OS may warn on first launch.
- The portable zip keeps all its data in the `data` folder next to `EdgeTerm.exe`. Saved passwords do not carry over to another machine.
- The `.rpm` needs WebKitGTK 4.1 (Fedora has it). On older distributions, use the AppImage.
- Installed copies update themselves (**Help → Check for Updates…**). The portable copy only tells you a new version is out.

## Getting started

1. **Session → New Session…** (`⌘N` / `Alt+N`) creates a session; double-click it in the Session panel to connect. Right-click a session to edit, duplicate, move or delete it.
2. The **Filer** on the right follows the active tab. Drop files onto it to upload, drag entries out to download, or press `⌘J` / `Ctrl+Shift+J` to jump to the shell's working directory.

3. The **Sender** at the bottom sends text to the current session or to all sessions. Save frequently used commands as tags.
4. **Split Right / Split Down** is on the tab's context menu and in **View**. Drag a tab onto another pane to move it there.
5. **Edit** holds the copy/paste behavior (right click, Copy on Select, OSC 52), and **View** holds the theme, fonts and **Keyboard Shortcuts…**.

### File transfers

File jobs continue across tabs while the app remains open. **Pause** retains partial files and checkpoints; **Resume** validates the source and transferred prefix before continuing. **Cancel** cleans up owned partial files, reporting retained files when the server is unreachable so cleanup can be retried. After an app restart, open **Transfers → Interrupted transfers**, connect to the same server and choose **Resume**. Recovery uses the saved file plan and confirmed checkpoints. **Forget** removes the local recovery record and leaves partial files for manual cleanup. If reconnecting requires interactive authentication, reconnect the session first, then retry the job.

Transfer settings apply to new jobs. Up to two jobs run per server endpoint; additional jobs wait in the queue. SFTP defaults to 32 concurrent data requests, 128 KiB chunks and 16 concurrent files, reduced to the server's advertised limits (and to 4 on servers that advertise none); each job transfers at most two large files simultaneously. FTP uses separate connections with at most four concurrent files. Resumed FTP uploads read back and verify the partial prefix; servers without REST/APPE support safely restart that file. Transient network errors retry up to three times; permission errors, changed sources and destination conflicts require attention before a manual retry. Durable writes are opt-in and require SFTP server support for fsync; an upload requesting this option fails explicitly on unsupported SFTP servers or FTP. Downloads are unaffected. SFTP uses a single replacement when posix-rename is supported. Otherwise, SFTP and FTP preserve the old target as a backup before committing the partial file in a second rename; the target path can briefly be absent between those steps.

**Rate limit (KiB/s)** is shared by all files and data connections in one job, including remote prefix verification. Zero is unlimited; supported limits range from 1 KiB/s to 1 GiB/s. The initial burst is at most one second of budget, capped at 1 MiB. Protocol control messages and local disk work are excluded. A running or recovered job keeps its original limit. Optional tar folder uploads also use that payload limit, but tar has no per-file resume or atomic replacement: cancellation leaves extracted files, and retry needs an empty/new destination.

### Experiment workbench

Open it from **View → Workbench**. The left sidebar separates projects, experiments and runs: a project binds a saved SSH login to a remote code directory, an experiment records a baseline-relative variant (optionally in another directory), and a run records the launch-time code identity, uncommitted diff, environment, command, GPU selection, optional code snapshot, log and output locations. Switching projects restores that project's open files and associated terminal; after a disconnect or restart, run status comes from a fresh query and training is never restarted automatically.

The built-in editor loads CodeMirror 6 on demand: multiple files, syntax highlighting, undo, find/replace and project search. Switching files keeps each document's undo history, selection and scroll position; reloading the server copy or closing the tab drops that history on purpose. A save uses the SHA-256 of the opened copy as its compare-and-swap token, so a changed server file produces an explicit conflict instead of being overwritten; unsaved drafts survive a restart. Git changes and cross-project same-path comparisons read bounded text only, never data or checkpoint trees. Runs start under tmux (or a detached process when tmux is absent) with bounded log tailing; `sbatch`/`qsub`/`bsub` are recorded as submissions, not as finished training.

The data model, save/conflict rules, run boundaries, verification record, measurement method and the information needed to adapt a real interpolation project are documented in [docs/workbench.zh-CN.md](docs/workbench.zh-CN.md) (Chinese).

### File comparison and SSH tools

In the dual-pane file view, select a local file and a remote SSH/SFTP/FTP file, then choose **Compare**. Comparison is read-only and shows byte equality, line edits, encoding and line endings. Each side is limited to 4 MiB; text views support up to 50,000 lines and 16 KiB per line. Binary or unsupported text still receives a complete byte comparison within the size limit. Oversized files are explicitly not compared. Large, heavily reordered text can use simplified alignment; that is shown separately from the exact byte result.

The status bar's **Resources** button monitors the current SSH/SFTP host. Linux sampling covers CPU, memory, root filesystem capacity, whole-device disk I/O and network rates. GPU queries currently cover NVIDIA; unsupported, denied and failed samples are identified. Rates require two samples. Sampling defaults to every two seconds and can be disabled or set to 1–30 seconds. Switching hosts, disconnecting or hiding the application cancels its current sample.

**Tunnels** creates local (L) or remote (R) TCP forwarding. Listener ports default to loopback; port zero asks the OS/server to allocate one. The view shows direction, addresses, owning tab, state, connections and payload counts. Closing the owning tab stops its listeners and active flows. Remote binding follows the SSH server's GatewayPorts policy. While this panel is visible, Linux listener discovery reads `ss`/`netstat` every five seconds; **Use port** fills an editable local-forward draft. Choose **Create tunnel** to establish it.

**Session panel → SSH connections** controls automatic reuse of authenticated native SSH connections. Matching SSH/SFTP profiles share authentication and open separate channels; credentials, key contents and jump-host configuration participate in identity. Closing one tab preserves sibling channels. This setting controls future connections; **Duplicate SSH Channel** still explicitly reuses its source. System OpenSSH ControlMaster/ControlPath sockets are not used.

Terminal output retains the existing 8 ms / 64 KiB batching and xterm frame scheduling. File lists, comparison rows, transfer/recovery lists and failed-file views use virtual scrolling for large datasets; hidden terminal panes stop rendering while continuing to parse and acknowledge output.

## Keyboard shortcuts

| macOS | Windows / Linux | Action |
| --- | --- | --- |
| `⌘N` | `Alt+N` | New session |
| `⌘W` | `Ctrl+Shift+W` | Close session |
| `⌘F` / `⌘G` | `Ctrl+Shift+F` / `Ctrl+Shift+G` | Find / find next |
| `⌘K` | `Alt+K` | Clear screen |
| `⌘J` | `Ctrl+Shift+J` | Show the working directory in the Filer |
| `⌘[` / `⌘]` | `Alt+[` / `Alt+]` | Previous / next tab |
| `⌘1`–`⌘9` | `Alt+1`–`Alt+9` | Go to tab N |
| `⌘\` / `⌘⇧\` | `Ctrl+Shift+\` / `Ctrl+Alt+\` | Split right / down |
| `⌘⌥[` / `⌘⌥]` | `Ctrl+Alt+[` / `Ctrl+Alt+]` | Previous / next pane |
| `⌘⌥←` / `⌘⌥→` / `⌘⌥↓` | `Ctrl+Alt+←` / `→` / `↓` | Toggle Session / Filer / Sender |
| `⌘C` / `⌘V` / `⌘A` | `Ctrl+Shift+C` / `V` / `A` | Copy / paste / select all |

All except the tab numbers can be changed in **View → Keyboard Shortcuts…**.

## Development and review

Read the [engineering standards](docs/engineering-standards.zh-CN.md), [test plan](docs/test-plan.zh-CN.md), and [commit audit](docs/audit-2026-10-14.zh-CN.md) before changing the code. The audit distinguishes verified behavior, fixture measurements and outstanding real-environment checks.

## License

EdgeTerm is licensed under the [GNU General Public License v3.0](LICENSE).

The interface icons are [Codicons](https://github.com/microsoft/vscode-codicons) by Microsoft, used under the Creative Commons Attribution 4.0 license.

The name “EdgeTerm” and its icon are not covered by the open-source license above. Copyright © 2026 miskin. All rights reserved.
