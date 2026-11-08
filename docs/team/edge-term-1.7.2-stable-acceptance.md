# EdgeTerm 1.7.2 稳定体验验收卡（A2 保持关闭）

决策日期：2026-11-08。用户选择 **A：本轮只收尾既有稳定性及 UX，不重构 A2 冷历史**。

## 版本与边界

- **稳定主线**：`origin/main` 的 `492680bf` 已合入 oh-my-pi 识别（`11f9665`）和 Agent gutter 固定宽度（`492680b`）。验证这两项应使用**该提交或更新的主干源码构建**，不能只安装较早的公开 `v1.7.2` 附件（发布时源码为 `84221bc`）。
- **独立的小补丁**：显示设置的 A2 开关改为“Apply 才保存、Cancel 不改变”，并准确标示实验风险；对应代码和用例在本文件所在分支。该补丁是否合并，须与本文件的真机验证结果区分。
- **暂缓事项**：[Draft PR #2](https://github.com/sonwe1e/EdgeTerm/pull/2) 的 A2 冷历史物化与搜索修正继续保留在 Draft，不因本轮 P0 体验验收合入或默认开启。已实证长折行在冷热边界可能丢字、滚顶物化使 xterm 内存增长；百万行、吞吐及 WebView2 性能门没有通过。
- **特别注意**：*默认关闭不等于强制关闭*。曾开启 A2 的用户可能在本机保存了 `edgeterm.terminalColdHistory=1`。本次验收先在“显示设置”确认**无缝冷历史 OFF**，点击 **Apply**，重启后再确认；不要清空整个用户配置来达到这一点。

## 开始前（Windows x64）

1. 在**不覆盖未提交修改**的干净源码目录确认提交：`git status --short` 与 `git rev-parse --short HEAD`。检查目标应明确写成主干 `492680bf`（或其后续提交）／小补丁 PR 的实际 SHA；旧发布安装器不能验证新提交。
2. 运行 `./dev.ps1 doctor`，再用 `./dev.ps1 tauri:dev` 打开**真实 Tauri / Windows WebView2 窗口**。有需要时串行运行 `./dev.ps1 test`、`./dev.ps1 test:browser`、`./dev.ps1 test:rust`，不要同时启动多套受管任务争用资源。
3. 先把 gutter 显示模式设为 **行号 + 时间戳（both）**，再确认 A2 为 **OFF**。记录 Windows、WebView2、`opencode`、`pi`、`omp`（oh-my-pi）版本与终端字号；工具缺失则将对应项目记为 **受阻**，不能记为通过。SSH 测试尽量使用可清理的专用会话，不上传凭据或未脱敏服务器日志。

## 真机 P0 验收矩阵

所有步骤都在 **A2 OFF** 下执行。每项记录**通过 / 失败 / 受阻 / 未执行**，不要因自动化成功替代真实交互结论。

| 编号 | 操作（最少步骤） | 通过标准 |
| --- | --- | --- |
| **P0-1 开关安全** | 新装与既有配置分别打开“显示设置”；确认 A2 OFF；在小补丁分支上临时勾 ON→**Cancel**；再确认仍 OFF、Apply 并重启。**不在真机运行中执行 ON→Apply**（此路径已由单测覆盖） | 新配置默认 OFF；**Cancel 不会开启**（仅小补丁分支适用）；点击 Apply 保存的关闭状态、重启后仍 OFF。既有用户若曾开启，先手动关闭，不能把历史 ON 当成默认行为 |
| **P0-2 oh-my-pi gutter** | 本地 Shell 和一个 SSH 标签分别进入/退出交互式 `omp`，造成多次常规重绘；保持窗口和字号不变 | Agent 内可隐藏时间戳/行号**内容**，但左侧两条 gutter 占位宽度、正文左边界和折行列宽不能因此跳动；退出恢复正常显示。若环境无法触发原现象，记“未复现”，不冒充根因已证实消除 |
| **P0-3 Agent/TUI** | OpenCode、Pi 各进行一次输入、输出和退出；Vim/tmux 进入/退出其全屏或鼠标模式 | 键盘/鼠标交由 TUI 正常处理；切回 Shell 后 gutter 和历史顺序正常；没有 TUI 帧污染 Shell 历史或光标错位 |
| **P0-4 定位与选择** | 普通 Shell 输入长命令，Alt+点击不同位置；对命令拖选并 Delete/输入替换；在 Vim/tmux 鼠标模式重复点击/拖动 | Shell 光标移动、选区改写正确，不意外打开菜单；TUI 获得自身鼠标事件，不收到 Shell 方向键注入；查看旧历史时点击不改当前输入 |
| **P0-5 中文 IME** | 用 Windows 中文输入法，在有输入行选区时组合输入“你好”，确认后回车输出；重复一次不带选区 | 选区在 compositionstart **恰好删除一次**，确认时新文字**恰好写入一次**；无额外删除、错位、双输或漏字；回车结果与屏幕文字一致 |
| **P0-6 3–4 个 SSH 标签** | 打开不同主机或测试目标；其中一窗输出有序的 300 行编号日志，另一窗运行 Agent/TUI；约 20 次切标签并上下滚动 | 输出只进入所属标签、行号连续；后台输出不覆盖别的输入；没有异常重连或卡死。A2 OFF 时超出既定 scrollback 的旧行可按原策略裁剪 |
| **P0-7 Resize / 搜索** | Shell 输出重复词日志并滚到历史，10 次调整宽度/分屏/字号；搜索并导航；Agent 运行时重复窗口保持不变的重绘 | 用户主动调整尺寸后能重新排版；无额外重复/漏行、搜索错位或非预期跳底；仅 Agent 内容重绘时 gutter 不引发尺寸震荡 |

P1（不阻断上述 P0 结果的记录）：后台输出期间关闭单个会话并新建标签、应用重启后的工作区恢复，以及明暗主题与窄窗口布局。若任何 P0 失败，先保存最小复现，不合并相关候选补丁。

## 已有证据与仍需用户完成的部分

- `origin/main`=`492680bf`：GitHub Actions `frontend` 和 `rust` 均通过。Agent gutter 单测与 Chromium 浏览器契约覆盖部分重绘/布局，但**不是**真实 oh-my-pi / WebView2。
- Draft PR #2 `c136a842`：GitHub Actions `frontend` 和 `rust` 均通过；独立验证的冷历史分页回归与内存结构性诊断**不代表 A2 已验收**。
- 本文件所在小补丁：`src/components/FontSizeDialog.test.ts` 覆盖 Cancel、Apply、Reset 三种设置路径；仍需真实 Windows 对话框手动点击核对。
- Linux 运行环境不能执行真实 Windows Tauri/WebView2、IME 和 3–4 个实际 SSH/TUI 的联动；这部分需要用户本机完成。

### 发现失败时，只需回传一条记录

`编号 + Git SHA + Windows/WebView2 版本 + Agent 版本（若涉及） + 本地/SSH + gutter 模式/A2 OFF + 窗口尺寸/字号 + 3–5 步复现 + 脱敏截图或 15–30 秒录屏`。

**放行边界**：P0 通过只代表**主线稳定体验与小补丁 UX** 在该 Windows 环境通过，不授权开启 A2、不解除 Draft PR #2 的正确性与内存阻断项。按用户选择，A2 底层修复等待独立需求确认后再启动。

## 真机验证记录（2026-11-08，通过）

在 Windows 真机（Windows 11 Home 26H2，10.0.26300.9711；WebView2 157.0.4341.42；DPI 1.75）用本分支 `6802947` 源码构建的便携版（`tauri:build` release，exe SHA256 `DE2B92E9…0590F6`）通过 CDP 驱动真实 WebView2 窗口执行全部 P0 项。工具版本：omp/18.18.1（Windows bun 1.4.4 与 WSL Ubuntu-26.04 各一份）、opencode 1.19.5、pi 1.5.0（全局）/1.4.0（隔离副本 + 仓库官方 `patch-pi-windows-mouse` 修复）、vim 9.1（WSL）、tmux 3.6（WSL sshd 2222 端口，专用 `edgeterm` 账户密钥认证）。全程 gutter 模式 both、A2 OFF。

- **P0-1 通过**：新配置默认 OFF（`null`）；勾选 ON → Cancel 后持久值仍 `null`；Reset Defaults 仅暂存；Apply 关闭后持久化 `"0"`；**重启应用后仍 OFF 且对话框未勾选**。
- **P0-2 通过**：本地 Shell 与 SSH 标签各进入/退出交互式 omp：20/20 采样中时间戳/行号内容隐藏而 gutter 占位宽度不变（抖动 0.00px，主机宽度抖动 0.00px，重绘期间 `resize_session` 0 次）；退出后行号恢复（本地 27 行 / SSH 24 行）。SSH 侧 omp 首次运行进入设置向导，走完向导后双 Ctrl+C 退出。
- **P0-3 通过**：`check-native-terminal-input`（真实 Pi 1.4.0 离线转录）passed：双向滚轮翻历史、Alt+Delete 删词不开菜单、Ctrl+Tab 切换、退出后 shell 完成标记/鼠标释放/无历史污染、160 条消息原样。OpenCode 1.19.5 TUI 进入/退出期间 20/20 标签抑制 + 宽度恒定。Vim（本地）10/10：交替屏隐藏标签、宽度 173.09px 恒定、退出恢复。tmux 3.6 与 vim 9.1 over SSH 同样隐藏标签且宽度恒定。
- **P0-4 通过**：`check-native-agent-selection` 全 PASS（选区引用、全屏 Shift 选区、中文多行缩进、无意外 PTY 注入）；真机 PowerShell PSReadLine Alt+点击后输入落在点击处（`deltaX`）、无菜单打开；查看历史时点击不改当前输入。
- **P0-5 通过（边界）**：经 CDP `Input.imeSetComposition`/`insertText` 驱动真实 WebView2 渲染进程的组合事件路径：compositionstart/end 恰好各 1 次；带选区时"abc"被"你好"恰好替换一次（无双写/残留）；无选区时"世界"提交一次。**边界**：未驱动 Windows OS 输入法候选面板本体。
- **P0-6 通过**：4 个并行 SSH 标签（127.0.0.1:2222）：一个输出 300 行有序编号日志、一个 tmux 进出、一个 vim 进出、一个空闲；20 次切换 gutter 宽度抖动 0.00px；滚轮回看可达；空闲标签无跨标签泄漏；结束后 4/4 会话存活。另 `check-native-terminal-tabs`（8×ConPTY、3×20000 行突发、搜索、三轮切换）passed。
- **P0-7 通过**：Win32 驱动 10 次窗口宽度调整（920–1400px）：终端列宽随窗口全部重排（11 档不同 screenW），gutter 宽度全程恒定 173.09px；Ctrl+Shift+F 搜索计数与 Enter/Shift+Enter 导航正常、历史完好；Agent 运行且窗口不变时重绘不触发 resize（P0-2 采样）。

已知边界与本轮未执行：OpenCode 无模型凭据，以未认证 TUI 验证（真实 TUI 重绘/退出路径）；P1 项（后台输出期关单个会话、重启恢复、明暗主题/窄窗）未执行，按卡片定义不阻断。测试环境备注：宿主作业对象曾向被测应用转发 WM_CLOSE 触发"关闭 EdgeTerm"询问框（closeAction 默认 ask），取消即恢复且与被测行为无关；将应用移出作业对象后不再出现。证据：`.tmp/accept/p0-*`（result.json 与截图）与 `.tmp/accept/native-*`（仓库门禁原始输出，含 CPU profile/录制的会话字节）。

