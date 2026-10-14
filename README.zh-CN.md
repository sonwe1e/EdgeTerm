<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/logo-dark.png">
    <img src="docs/logo.png" alt="EdgeTerm" width="480">
  </picture>
</p>

<p align="center">
  <a href="https://github.com/miskin-lee/EdgeTerm/stargazers"><img alt="GitHub stars" src="https://img.shields.io/github/stars/miskin-lee/EdgeTerm?style=flat"></a>
  <a href="https://qm.qq.com/q/oINZ2ffDOg"><img alt="加入 EdgeTerm QQ 群：1129162865" src="https://img.shields.io/badge/QQ%20group-Join%20discussion-12B7F5?style=flat"></a>
  <a href="https://github.com/miskin-lee/EdgeTerm/releases"><img alt="GitHub release downloads" src="https://img.shields.io/github/downloads/miskin-lee/EdgeTerm/total?style=flat&amp;label=downloads"></a>
  <a href="https://github.com/miskin-lee/EdgeTerm/releases/latest"><img alt="最新 GitHub 发布版本" src="https://img.shields.io/github/v/release/miskin-lee/EdgeTerm?style=flat"></a>
  <a href="LICENSE"><img alt="GPL-3.0 许可证" src="https://img.shields.io/github/license/miskin-lee/EdgeTerm?style=flat"></a>
  <a href="https://github.com/miskin-lee/EdgeTerm/graphs/contributors"><img alt="GitHub 贡献者" src="https://img.shields.io/github/contributors/miskin-lee/EdgeTerm?style=flat"></a>
</p>

[English](README.md) | [简体中文](README.zh-CN.md)

小巧、快速的终端 / SSH / Telnet / SFTP / FTP / 串口客户端，基于 **Rust + Tauri**，安装包约 4–5 MB。

> [!TIP]
> <a href="https://github.com/miskin-lee/serialX"><img src="https://raw.githubusercontent.com/miskin-lee/serialX/main/assets/icons/png/serialx-64.png" alt="serialX" width="20" height="20" align="top"></a> 做嵌入式开发、需要用串口调试设备？推荐使用同一作者的 **[serialX](https://github.com/miskin-lee/serialX)**，一款专为串口调试打造的工作台。

<img src="docs/screenshot-dark.png" alt="EdgeTerm 深色主题：分栏、着色的日志与交换机输出、会话树、Filer 与 Sender" width="100%">

<img src="docs/screenshot-light.png" alt="EdgeTerm 浅色主题：同一工作区" width="100%">

## 功能

- **会话**：本地 Shell、SSH、Telnet、SFTP、FTP、串口，分组树管理，可筛选、复制，也可从 `~/.ssh/config` 导入。
- **SSH**：密码、公钥、ssh-agent、keyboard-interactive（MFA / 验证码）、跳板机，也能连只支持旧算法的网络设备。
- **易读的输出**：时间戳与行号栏，IP、URL、日志级别、HTTP 方法、路径、容量等语义着色。
- **分栏与标签**：向右 / 向下分栏，标签可在分栏间拖动，后台标签的运行 / 完成状态一眼可见。
- **Filer**：通过 SFTP、FTP 或本地磁盘浏览文件，支持与桌面之间双向拖拽。
- **后台传输**：Filer 与双栏文件面板共用状态栏的 **Transfers**。支持批次并发、暂停/继续、取消、失败文件重试与断线自动重试；下载和上传先写同目录临时文件，完成后再替换目标。
- **Sender**：保存常用命令和多行脚本，发送到当前会话或全部会话，可定时重复。
- **终端内文件传输**：ZMODEM（`rz` / `sz`）与 XMODEM。
- **日常细节**：主题、字体、光标样式，自定义编码与 locale，会话录制，选中即复制，多行粘贴提醒，快捷键可改，全部设置可导出 / 导入。

## 安装

从 [Releases](https://github.com/miskin-lee/EdgeTerm/releases) 下载：

| 平台 | 安装包 |
| --- | --- |
| Windows x64 | 安装程序（`.exe`）或便携版 `.zip` |
| macOS Apple Silicon | `.dmg` |
| Linux x64 / ARM64 | `.AppImage`、`.deb` 或 `.rpm` |

- 未做 macOS 公证和 Windows Authenticode 签名，首次打开时系统可能会提示风险。
- 便携版的数据都存在 `EdgeTerm.exe` 旁的 `data` 文件夹里；换机器后保存的密码不会带过去。
- `.rpm` 需要 WebKitGTK 4.1（Fedora 有），较老的发行版请用 AppImage。
- 安装版会自动更新（**Help → Check for Updates…**），便携版只提示有新版本。

## 快速上手

1. **Session → New Session…**（`⌘N` / `Alt+N`）新建会话，在 Session 面板里双击连接；右键会话可编辑、复制、移动或删除。
2. 右侧 **Filer** 跟随当前标签：把文件拖进去即上传，拖出来即下载；`⌘J` / `Ctrl+Shift+J` 跳到 shell 的当前目录。

3. 底部 **Sender** 把文本发到当前会话或全部会话，常用命令可存成标签。
4. 标签右键菜单和 **View** 里有 **Split Right / Split Down**，把标签拖到别的分栏即可移过去。
5. **Edit** 里是复制粘贴相关设置（右键行为、选中即复制、OSC 52），**View** 里是主题、字体和 **Keyboard Shortcuts…**。

### 文件传输

文件任务在应用保持打开时可跨标签继续运行。**Pause** 保留临时文件和检查点，**Resume** 校验源文件与已传前缀后继续，**Cancel** 清理任务拥有的临时文件；服务器离线时会提示保留并可重试清理。应用重启后，在 **Transfers → Interrupted transfers** 中查看记录，连接同一服务器后选择 **Resume**，按已保存的文件计划和确认的检查点恢复。**Forget** 只删除本地恢复记录，临时文件留待手动清理。需要交互认证的重连，请先重新连接会话，再重试任务。

传输中心的设置只影响新任务：每个服务器端点最多运行 2 个任务，后续任务排队。SFTP 默认 32 个并发数据请求、128 KiB 分块、16 个文件并发，按服务器声明的限制降级（未声明句柄上限的服务器封顶为 4）；同一任务的大文件同时最多 2 个。FTP 使用独立连接，文件并发最多 4 个；恢复上传前读回并校验临时文件前缀，服务器不支持 REST/APPE 时安全重传。瞬时网络错误最多自动重试 3 次，权限、源文件变化及目标冲突需要处理后手动重试。远端同步落盘为可选项，要求 SFTP 服务器支持 fsync；开启后在不支持的 SFTP 或 FTP 上上传会明确失败，下载不受影响。SFTP 支持 posix-rename 时执行单次替换；否则 SFTP 和 FTP 先将旧目标移到备份，再通过第二次重命名提交临时文件，两步之间目标路径可能短暂不存在。

**Rate limit (KiB/s)** 是每个任务的总网络负载限速，由所有文件和数据连接共同使用，恢复时的远端前缀读回也计入。0 表示不限速，范围为 1 KiB/s 至 1 GiB/s；初始突发最多为一秒额度且不超过 1 MiB。协议控制消息和本地磁盘操作不计入。运行中或从记录恢复的任务保留原始限速。可选 tar 文件夹上传也限速，但没有逐文件续传或原子替换：取消会留下已解包文件，重试需要新的或空的目标目录。

### 文件比较与 SSH 工具

在双栏文件视图中分别选中一个本地文件和一个 SSH/SFTP/FTP 远端文件，点击 **Compare**，只读查看字节是否一致、行差异、编码和换行格式。每侧最多读取 4 MiB，文本视图最多 50,000 行、每行 16 KiB。大小范围内的二进制或不支持的文本仍比较完整字节；超大文件明确显示未比较。大量重排行可能采用简化对齐，界面会标明，完整字节比较结果独立保留。

状态栏 **Resources** 只监控当前 SSH/SFTP 主机。Linux 支持 CPU、内存、根文件系统容量、整块设备的磁盘 I/O 和网络收发速率；GPU 当前覆盖 NVIDIA，并区分不支持、权限拒绝和采样失败。速率需要两个样本。默认每 2 秒采样，可关闭或调整为 1–30 秒；切换主机、断开连接或隐藏应用会取消当前采样。

**Tunnels** 支持本地（L）和远端（R）TCP 转发，默认请求回环监听地址，监听端口填 0 自动分配。界面显示方向、监听/目标地址、所属标签、状态、连接数和负载字节计数；关闭所属标签会停止监听及活动数据流。远端最终绑定受 SSH 服务器 GatewayPorts 策略控制。面板可见时，每 5 秒读取 Linux 的 `ss`/`netstat` 监听表；**Use port** 填入可编辑的本地转发草稿，点击 **Create tunnel** 建立转发。

**Session 面板 → SSH connections** 可开启或关闭原生 SSH 已认证连接的自动复用。同一连接及认证配置的 SSH/SFTP 标签共享认证、分别打开通道；凭据、密钥文件内容和跳板配置参与隔离。关闭一个标签保留其他通道。开关影响后续新连接，**Duplicate SSH Channel** 仍明确复用来源连接。此实现沿用原生 SSH 栈，不使用系统 OpenSSH 的 ControlMaster/ControlPath 控制套接字。

终端沿用 8 ms / 64 KiB 输出合批和 xterm 帧调度；文件列表、diff、传输队列、恢复记录与失败文件的大列表使用虚拟滚动。隐藏终端停止渲染，同时继续解析和确认已消费的输出。

## 快捷键

| macOS | Windows / Linux | 作用 |
| --- | --- | --- |
| `⌘N` | `Alt+N` | 新建会话 |
| `⌘W` | `Ctrl+Shift+W` | 关闭会话 |
| `⌘F` / `⌘G` | `Ctrl+Shift+F` / `Ctrl+Shift+G` | 查找 / 查找下一个 |
| `⌘K` | `Alt+K` | 清屏 |
| `⌘J` | `Ctrl+Shift+J` | 在 Filer 中显示当前目录 |
| `⌘[` / `⌘]` | `Alt+[` / `Alt+]` | 上一个 / 下一个标签 |
| `⌘1`–`⌘9` | `Alt+1`–`Alt+9` | 切到第 N 个标签 |
| `⌘\` / `⌘⇧\` | `Ctrl+Shift+\` / `Ctrl+Alt+\` | 向右 / 向下分栏 |
| `⌘⌥[` / `⌘⌥]` | `Ctrl+Alt+[` / `Ctrl+Alt+]` | 上一个 / 下一个分栏 |
| `⌘⌥←` / `⌘⌥→` / `⌘⌥↓` | `Ctrl+Alt+←` / `→` / `↓` | 显示 / 隐藏 Session、Filer、Sender |
| `⌘C` / `⌘V` / `⌘A` | `Ctrl+Shift+C` / `V` / `A` | 复制 / 粘贴 / 全选 |

除标签序号键外，都可在 **View → Keyboard Shortcuts…** 中修改。

## 开发与复审

修改代码前请阅读[工程规范](docs/engineering-standards.zh-CN.md)、[测试与验收方案](docs/test-plan.zh-CN.md)及[逐提交复审记录](docs/audit-2026-10-14.zh-CN.md)。复审记录区分已验证行为、夹具测量和仍需真实环境补测的项目。

## 许可证

EdgeTerm 采用 [GNU General Public License v3.0](LICENSE) 授权。

界面图标来自 Microsoft 的 [Codicons](https://github.com/microsoft/vscode-codicons)，依据 Creative Commons Attribution 4.0 许可使用。

应用名称“EdgeTerm”及其图标不在上述开源许可范围内，版权 © 2026 miskin，保留所有权利。
