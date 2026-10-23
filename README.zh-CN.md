<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/logo-dark.png">
    <img src="docs/logo.png" alt="EdgeTerm" width="480">
  </picture>
</p>

<p align="center">
  <a href="https://github.com/sonwe1e/EdgeTerm/stargazers"><img alt="GitHub stars" src="https://img.shields.io/github/stars/sonwe1e/EdgeTerm?style=flat"></a>
  <a href="https://github.com/sonwe1e/EdgeTerm/releases"><img alt="GitHub release downloads" src="https://img.shields.io/github/downloads/sonwe1e/EdgeTerm/total?style=flat&amp;label=downloads"></a>
  <a href="https://github.com/sonwe1e/EdgeTerm/releases/latest"><img alt="最新 GitHub 发布版本" src="https://img.shields.io/github/v/release/sonwe1e/EdgeTerm?style=flat"></a>
  <a href="LICENSE"><img alt="GPL-3.0 许可证" src="https://img.shields.io/github/license/sonwe1e/EdgeTerm?style=flat"></a>
  <a href="https://github.com/sonwe1e/EdgeTerm/graphs/contributors"><img alt="GitHub 贡献者" src="https://img.shields.io/github/contributors/sonwe1e/EdgeTerm?style=flat"></a>
</p>

[English](README.md) | [简体中文](README.zh-CN.md)

这是 [sonwe1e/EdgeTerm](https://github.com/sonwe1e/EdgeTerm) 维护的发行分支，源自 miskin 的 [上游 EdgeTerm](https://github.com/miskin-lee/EdgeTerm)。本分支独立发布版本，当前提供 Windows x64 下载；上游发布包不包含本分支的全部功能。原作者与许可声明保留在文末。

[历史发布索引](docs/releases.zh-CN.md) · [上游移植记录](docs/upstream-ports.zh-CN.md) · [分支与历史维护](docs/history-and-branches.zh-CN.md)

小巧、快速的终端 / SSH / Telnet / SFTP / FTP / 串口客户端，基于 **Rust + Tauri**，安装包约 4–5 MB。

> [!TIP]
> <a href="https://github.com/miskin-lee/serialX"><img src="https://raw.githubusercontent.com/miskin-lee/serialX/main/assets/icons/png/serialx-64.png" alt="serialX" width="20" height="20" align="top"></a> 做嵌入式开发、需要用串口调试设备？可以了解上游作者的 **[serialX](https://github.com/miskin-lee/serialX)**，一款专为串口调试打造的工作台。

<img src="docs/screenshot-dark.png" alt="EdgeTerm 深色主题：分栏、着色的日志与交换机输出、会话树、Filer 与 Sender" width="100%">

<img src="docs/screenshot-light.png" alt="EdgeTerm 浅色主题：同一工作区" width="100%">

## 功能

- **会话**：本地 Shell、SSH、Telnet、SFTP、FTP、串口，分组树管理，可筛选、复制，也可从 `~/.ssh/config` 导入。
- **SSH**：密码、公钥、ssh-agent、keyboard-interactive（MFA / 验证码）、跳板机，也能连只支持旧算法的网络设备。
- **易读的输出**：时间戳与行号栏，IP、URL、日志级别、HTTP 方法、路径、容量等语义着色。
- **分栏与标签**：向右 / 向下分栏，标签可在分栏间拖动，后台标签的运行 / 完成状态一眼可见。
- **Filer**：通过 SFTP、FTP 或本地磁盘浏览文件，支持与桌面之间双向拖拽、输入名称快速跳转，也可以多选后一次性传输。
- **实验工作台**：把服务器、项目目录、实验变体和每次运行分开记录；一个窗口内编辑 Python/配置、查看 Git 差异、启动训练、读日志和比较多主机资源。项目不依赖终端标签 id。
- **后台传输**：Filer 与双栏文件面板共用状态栏的 **Transfers**。支持批次并发、暂停/继续、取消、失败文件重试与断线自动重试；下载和上传先写同目录临时文件，完成后再替换目标。
- **Sender**：保存常用命令和多行脚本，发送到当前会话或全部会话，可定时重复；多行脚本的下一行会跟随 REPL 续行提示符与网络设备提示符，每个标签还能选八种颜色。
- **终端内文件传输**：ZMODEM（`rz` / `sz`）与 XMODEM。
- **日常细节**：主题、字体、光标样式，自定义编码与 locale，会话录制，选中即复制，多行粘贴提醒，查找支持区分大小写 / 全字匹配 / 正则 / 在选区中查找，快捷键可改，全部设置可导出 / 导入。

## 安装

从[本分支 Releases](https://github.com/sonwe1e/EdgeTerm/releases) 下载 Windows x64 安装程序（`.exe`）或便携版（`.zip`），并核对同页的 `SHA256SUMS.txt`。截至 2026-10-23，本分支未发布 macOS/Linux 安装包；需要这些平台时可自行构建，或明确选择功能不同的[上游发行版](https://github.com/miskin-lee/EdgeTerm/releases)。

- 安装包未做 Windows Authenticode 签名，首次打开时系统可能提示风险。
- 便携版的数据保存在 `EdgeTerm.exe` 旁的 `data` 文件夹；升级时保留该目录。保存的密码不保证能跨机器迁移。
- 本分支采用**手动升级**，不提供签名自动更新清单。本次整理后的应用入口为 **帮助 → 下载与更新…**，显示当前版本并打开本分支发布页，不自动检查、安装或重启。
- 已发布的 `1.2.8` 及更早安装包不会随源码修改而改变，其更新入口仍指向上游；请直接从本仓库发布页手动下载，勿依赖旧包中的更新提示。

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

### 实验工作台

在 **View → Workbench** 打开。左侧把“项目 → 实验 → 运行”分开列出：项目绑定已保存的 SSH 登录和远端代码目录，实验记录相对基线的变体（可指向另一个目录），运行记录启动时的代码标识、未提交差异、环境、命令、GPU、代码快照、日志和输出位置。切换项目会恢复该项目打开的文件和关联终端；断线或重启后，运行状态来自一次新的查询，不会自动重启训练。

内置编辑器按需加载 CodeMirror 6，支持多文件、语法高亮、撤销、查找替换和项目内搜索；切换文件会保留各自的撤销历史、选区和滚动位置，重载服务器版本或关闭标签才会丢弃历史。保存使用打开时的 SHA-256 作为比较基准，服务器副本变化时进入冲突而不是覆盖，未保存草稿在重启后可恢复。Git 变更和跨项目同路径文件比较都只读取有界文本，不扫描数据或 checkpoint 目录。运行通过 tmux（无 tmux 时用脱离进程）启动，日志尾读有上限；`sbatch/qsub/bsub` 只记录为“已提交”，不把提交命令的退出当作训练完成。

详细模型、保存/冲突语义、运行边界、验证记录、性能测量口径和插帧项目适配所需资料见 [实验工作台文档](docs/workbench.zh-CN.md)。

**Tunnels** 支持本地（L）和远端（R）TCP 转发，默认请求回环监听地址，监听端口填 0 自动分配。界面显示方向、监听/目标地址、所属标签、状态、连接数和负载字节计数；关闭所属标签会停止监听及活动数据流。远端最终绑定受 SSH 服务器 GatewayPorts 策略控制。面板可见时，每 5 秒读取 Linux 的 `ss`/`netstat` 监听表；**Use port** 填入可编辑的本地转发草稿，点击 **Create tunnel** 建立转发。

**Session 面板 → SSH connections** 可开启或关闭原生 SSH 已认证连接的自动复用。同一连接及认证配置的 SSH/SFTP 标签共享认证、分别打开通道；凭据、密钥文件内容和跳板配置参与隔离。关闭一个标签保留其他通道。开关影响后续新连接，**Duplicate SSH Channel** 仍明确复用来源连接。此实现沿用原生 SSH 栈，不使用系统 OpenSSH 的 ControlMaster/ControlPath 控制套接字。

终端沿用 8 ms / 64 KiB 输出合批和 xterm 帧调度；文件列表、diff、传输队列、恢复记录与失败文件的大列表使用虚拟滚动。隐藏终端停止渲染，同时继续解析和确认已消费的输出。

## 快捷键

| macOS | Windows / Linux | 作用 |
| --- | --- | --- |
| `⌘N` | `Alt+N` | 新建会话 |
| `⌘W` | `Ctrl+Shift+W` | 关闭会话 |
| `⌘F` / `⌘G` | `Ctrl+Shift+F` / `Ctrl+Shift+G` | 查找 / 查找下一个 |
| `⌥⌘C` / `W` / `R` / `L` | `Alt+C` / `W` / `R` / `L` | 查找框内：区分大小写 / 全字匹配 / 正则表达式 / 在选区中查找 |
| `⌘K` | `Alt+K` | 清屏 |
| `⌘J` | `Ctrl+Shift+J` | 在 Filer 中显示当前目录 |
| `⌘[` / `⌘]` | `Alt+[` / `Alt+]` | 上一个 / 下一个标签 |
| `⌘1`–`⌘9` | `Alt+1`–`Alt+9` | 切到第 N 个标签 |
| `⌘\` / `⌘⇧\` | `Ctrl+Shift+\` / `Ctrl+Alt+\` | 向右 / 向下分栏 |
| `⌘⌥[` / `⌘⌥]` | `Ctrl+Alt+[` / `Ctrl+Alt+]` | 上一个 / 下一个分栏 |
| `⌘⌥←` / `⌘⌥→` / `⌘⌥↓` | `Ctrl+Alt+←` / `→` / `↓` | 显示 / 隐藏 Session、Filer、Sender |
| `⌘C` / `⌘V` / `⌘A` | `Ctrl+Shift+C` / `V` / `A` | 复制 / 粘贴 / 全选 |
| `↩` | `Enter` | 会话断开后：重新连接 |

除标签序号键、查找框自身的按键和 Enter 外，都可在 **View → Keyboard Shortcuts…** 中修改。

## 开发与复审

修改代码前请阅读[工程规范](docs/engineering-standards.zh-CN.md)、[测试与验收方案](docs/test-plan.zh-CN.md)及[逐提交复审记录](docs/audit-2026-10-14.zh-CN.md)。复审记录区分已验证行为、夹具测量和仍需真实环境补测的项目。

## 许可证

EdgeTerm 采用 [GNU General Public License v3.0](LICENSE) 授权。

界面图标来自 Microsoft 的 [Codicons](https://github.com/microsoft/vscode-codicons)，依据 Creative Commons Attribution 4.0 许可使用。

应用名称“EdgeTerm”及其图标不在上述开源许可范围内，版权 © 2026 miskin，保留所有权利。
