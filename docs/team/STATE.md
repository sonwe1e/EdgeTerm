# 项目状态

## 本轮：目录与打包整理、缺陷修复（2026-11-01）

- 基线 `b4ba925`，工作区干净。协作约定见 [TEAM.md](../../TEAM.md)：本轮由 Lead 派两个只读审计任务（打包一致性、前端缺陷），修复与验证由 Lead 完成；审计者无写权限，结论逐条由 Lead 复核并给出可执行证据。
- 提交：`3536ebe` 受管入口在受限主机上的降级、`613c54b` 版本一致性守卫、`1e54e02` 手工发版产物忽略 + bump 脚本不再推送、`97d22e3` 文档索引与发版清单、`9ba681d` Sender 重复计数与状态本地化、`38d9800` 面板宽度偏好、`210e166` 传输设置写入失败、`e1012fa` 一条命令装配发版附件。

### 修复与证据

| 问题 | 修复 | 证据 |
| --- | --- | --- |
| 受限主机拒绝 CPU affinity 时，所有受管任务在启动前失败 | affinity/优先级降级为警告，doctor 报告真实预算；doctor 的版本探测不再经管道捕获 | `3536ebe`；`./dev.ps1 doctor` 由 “Exception setting ProcessorAffinity: Access is denied” 变为 `cpuMask: unbounded` 并继续执行；入口契约用例只接受“有预算”或“降级且告警” |
| 四个版本文件没有自动一致性校验（原校验随停用 workflow 失效） | 只读 `scripts/check-version.mjs` + `npm run version:check`，接入 CI | `613c54b`；漂移副本退出码 1 并指出 Cargo.toml 1.5.0 ≠ 1.5.1 |
| 手工发版产物未被忽略；`version-bump.sh` 会直接 push | 增加忽略规则；脚本只改版本、跑校验并打印提交命令 | `1e54e02` |
| Sender 在没有可写会话时仍计一次重复，并虚报 “repeated … done” | 只有 sendUnits 真正写入至少一个会话才计数；三条状态改走语言目录 | `9ba681d`；旧实现一个 tick 后 `getSchedule()` 变 null 且状态含 done，新实现保持等待；中文界面断言 “发送器：命令已重复 1 次，完成” |
| 窗口缩放后的面板宽度被当作偏好写回，放大窗口也回不去 | 偏好与显示值分离（`loadPanelSizingPreference`），底栏同一规则 | `38d9800`；500/500 在 1000px 窗口打开后仍能在 1600px 恢复 |
| 存储写入失败时 `saveTransferOptions` 把异常抛给 UI | 与其余偏好一致地捕获 | `210e166`；旧实现抛 QuotaExceededError |

### 出包链路（本轮追加）

发版附件过去只存在于停用 workflow 和人工步骤里，本轮把它变成一条可复现的命令，并在当前树上真实跑通：

| 项目 | 结果 |
| --- | --- |
| 真实出包 | `./dev.ps1 tauri:build --bundles nsis` → `EdgeTerm_1.5.1_x64-setup.exe` 4,184,827 B（3.99 MiB） |
| 附件装配 | `npm run release:package` → 安装包 + 便携包 5,212,734 B + 诊断包 5,471 B + `SHA256SUMS.txt`，0.9 s；`--check` 三个附件全部匹配 |
| 还原验证 | 便携包经 Windows `Expand-Archive` 还原出 `EdgeTerm.exe`、空 `data/`、`README.txt`，exe 的 SHA-256 与源一致；诊断包还原出两个脚本与说明 |
| 阻塞与绕法 | Tauri 的 NSIS 工具链下载在本机失败（CLI 报 `Peer disconnected`；PowerShell/curl 走 Schannel 报 `SEC_E_NO_CREDENTIALS`；Node 能连）。用 Node 分块下载并按 tauri-cli v2.12.1 源码里的 SHA-1 校验后预置到 `%LOCALAPPDATA%\tauri\NSIS`，重跑成功 |

### 验证

- 单元：113 文件 / 955 用例通过（基线 111 / 944；新增 3 条 Sender 重复、2 条面板偏好、1 条传输设置、5 条发版归档）。
- 浏览器：`PERF_BROWSER=msedge` 32 文件 / 172 用例通过（真实 Edge）。
- Rust：`./dev.ps1 test:rust` 459 通过、27 ignored、0 失败；本轮未改 Rust。
- 类型检查、Biome lint（仅生成绑定里两条既有 `any` 警告）、`format:check`、前端生产构建通过。
- 新增回归用例先在旧实现上运行并失败，修复后通过（逐条见上表）。
- 未验证：真实 Tauri 窗口内的面板拖拽与 Sender 重复（jsdom 与浏览器用例只覆盖状态机、纯布局函数和既有界面契约）；安装包未做安装、卸载与签名验证。

### 边界与后续

- 发版第 5、6 步已由 `scripts/package-release.mjs` 承担，步骤见[发布索引](../releases.zh-CN.md#发版步骤可复现清单)。`artifacts/release-1.5.1/` 只是本地验证产物：版本号仍是 1.5.1，但源码已比已发布的 1.5.1 多 9 个提交，不能按 1.5.1 发布；正式发版要先 `npm run version:set`。
- 只读审计已报告但本轮未做：`check:icons` 只校验 dist 里的文件图标、不校验 `bundle.icon`；CI 不跑 `build`/`check:bindings`；`.cmd` 文件在 `.gitattributes` 下统一为 LF。
- 上一轮的输入、剪贴板与 Pi 修复细节见[终端输入修复](../terminal-input-fixes.zh-CN.md)、[侧栏诊断](../sidebar-freeze-diagnostics.zh-CN.md)，提交范围 `b6b5527..8353e4c`。

## 追加修复：本地终端启动失败（2026-11-01）

- 用户实测反馈：新建本地终端后连接失败，技术详情为 `CreateProcessW ... in cwd ... failed: 系统找不到指定的文件 (os error 2)`。
- 根因：本地会话把 Shell 字段当命令行切分，未加引号的 `C:\Program Files\PowerShell\7\pwsh.exe` 被切成 `C:\Program` + `Files\PowerShell\7\pwsh.exe`，于是去启动 `C:\Program`。报错里的 `\0` 是 portable-pty 打印 NUL 结尾缓冲区的产物，不是原因；`C:\Users\Sonwe\0` 是默认工作目录，同样只是打印方式。
- 修复（`563a47f`）：`shell_words` 在 Windows 下把“不带引号且整串指向已存在文件”当作单个程序，其余情况仍走原切分；本地会话改用它。失败提示按会话类型区分，本地失败指向 Shell 字段而不是地址/端口。
- 证据：新用例先断言旧切分（同一路径被切成两段）再断言新行为；`cargo test --lib shell` 14 通过，Rust 全量 460 通过 / 27 ignored，前端 113 文件 / 955 用例通过，typecheck/lint/format:check 通过；用当前树重出安装包 4,183,760 B。
- 未验证：真实窗口里“新建本地终端”的端到端路径，需用户实机复验。

## 删除实验工作台（2026-11-02）

用户决定把"实验工作台"整套能力从产品中移除，回到纯终端 + Filer + Sender 的表面。保留的唯一用户能力是 Filer 的"在内置编辑器中编辑"。

- 删除：`src/workbench/` 整目录（含浏览器截图）、`src/styles/workbench.styles.css`、`docs/workbench.zh-CN.md`；Rust 侧 `workspace.rs`、`drafts.rs`、`commands/workspaces.rs`、`commands/drafts.rs` 与 20 个 IPC 命令。
- 裁剪：`project.rs` 2902 → 922 行，只留 `read_text`/`write_text` 及 `ProjectOps`、`Sftp`、替换阶梯与锁；`commands/project.rs` 157 → 37 行。`file_diff.rs` 删 `compare_remote`，`session/exec.rs` 删 `ExecStatus`/`run_status`（均只剩工作台调用方）。
- 迁移（删了会连带删掉用户可见功能）：`CodeEditor`/`codemirror`/`editorState`/`editorTypes`/`textFile` → `src/editor/`；`Sparkline`/`resourceTrend` → `src/monitor/`；`.spark*` 样式迁 `monitor.styles.css`，`@keyframes wb-pulse` 改名 `pulse` 并迁 `foundation.styles.css`；i18n `wb.loading` → `common.loading`。
- 界面：菜单项、空状态入口、视图切换、两处快捷键守卫、`StatusBar` 的 `showResources` 全部移除；Tab 的 `workspaceId`/`workspaceName` 与项目 chip 删除。

### 验证

| 项目 | 结果 |
| --- | --- |
| 前端单测 | 107 文件 / 898 用例通过（删除前 113 / 955，差额为工作台用例） |
| typecheck | 通过 |
| 前端生产构建 | 通过 |
| Biome format / lint | format 通过；lint 仅 `src/bindings.ts` 两条既有 `any` 警告 |
| Rust | `cargo test --lib` 431 通过 / 0 失败 / 27 ignored（沙箱外基线 460 / 0 / 27，差额为工作台用例） |
| 绑定 | `node scripts/bindings.mjs` 重新生成，`--check` 通过（94/99 命令，工作台命令与类型已消失） |
| `cargo fmt --check` | **失败，但只在 `src-tauri/src/tests.rs`**，该文件本轮未改；已用 `git show HEAD` 的原文 + rustfmt 复现同样 diff，属既有问题 |

### 边界与后续

- `project_read_text`/`project_write_text`/`local_text.rs` 保留：内置编辑器的本地与远程读写仍走它们，`read_text` 与 `write_text` 函数体与删除前逐字节一致。
- 用户磁盘上已有的 `workspaces.json` 与 `drafts/` 目录不再被读取，也未主动删除。
- 提交（`40191cf` 之后四个，逐个独立通过 typecheck）：`608b390` 迁移共享模块、`63f1606` 删除工作台前端、`6173ce0` 删除 Rust 后端并重建绑定、`8a670f0` 文档。删除动作一度被仓库 ACL（继承 `Everyone:(I)(CI)(DENY)(DC)`）拒绝，四个 Rust 文件与 `__sandbox_probe__.txt` 由用户在普通终端执行一次性脚本删除。
- `src-tauri/src/tests.rs` 的 rustfmt 偏差是既有问题，可另行单独提交修复，不要混进本轮。
- 未验证：真实 Tauri 窗口内的内置编辑器端到端路径（jsdom 与浏览器用例只覆盖状态机与组件契约）；浏览器用例未在本机运行（Playwright Chromium 未安装）。

## 本轮：终端与远程资源协同（2026-11-02）

用户 2026-11-02 确认：四项功能一次交付、质量优先（发现缺陷堆积或质量下滑可停下报告）；只提交代码、不发版；验收先做本机可验项，真机项最后列清单；基线用当前 HEAD `48a12a0`（方案写作时的 `8805e77` 已过期，见 DECISIONS D12）。

| # | 功能 | 用户已定约束 |
| --- | --- | --- |
| ② | 鼠标定位 | 普通 Shell Alt+左键；OpenCode/TUI 走程序原生点击；用户未实测过症状 → 先复现再改；CJK/宽字符/折行必须测 |
| ③ | Filer 跟随终端 | 默认关闭、可暂停、每服务器独立、仅运行期内存、不轮询服务器 |
| ④ | 文件路径 Ctrl+点击 | 主要是 Linux 风格报错路径；相对路径归属"想办法解决、体验优先"（不拿确认弹窗打断）；复用内置编辑器与 revealLine |
| ⑤ | 远程预览 | 入口只在 Filer 右键；首版只支持 HTML 同目录相对资源；系统浏览器打开；允许 hyper/hyper-util 作为直接依赖 |

### 协作与写入边界

Lead 负责 `src/terminal.ts`、`src/actions.ts`、`src/locales/*`、`src/test/*` 的接线与全部验证/提交；共享任务 task-1..4 分别由 follow-builder（③）、links-builder（④）、preview-builder（⑤-B Rust）、remote-builder（⑤-A）独占写入范围。

### 验收环境（本机真实环境）

- WSL Ubuntu 26.04 内专用 sshd：`127.0.0.1:2222`，用户 `edgeterm`，密钥 `.tmp/ssh/id_ed25519`（`.tmp/` 已被忽略）；账号已解锁，密码仅用于解锁语义。
- 真实样例：`/home/edgeterm/work/exp`（`report.html` + `style.css` + `charts.js` + `data.json` + `assets/loss.png` + 8 MiB `big.bin` + 两个指向根目录外的符号链接）、`/home/edgeterm/work/project/train/model.py`（第 238 行）、远端 `127.0.0.1:6006` 静态服务作为 TensorBoard 替身。
- 浏览器契约用真实 Edge（`PERF_BROWSER=msedge`）。

### P0 鼠标定位：结论（已实测）

用真实 App + 真实 xterm + 真实 Chromium 指针输入（CDP，含 Alt 修饰键）验证：xterm 6.0.0 的 `_handleMouseUp` 在"无选择、按下-抬起 <500ms、Alt 按住、视口贴底"时用 `moveToCellSequence` 发方向键序列。4 条用例通过：

| 用例 | 断言 |
| --- | --- |
| 普通缓冲区 Alt+点击第 2 列（光标在第 20 列） | 发出 18 个 `\x1b[D`，无选择、光标未被本地改动 |
| 6 个 CJK 宽字符（光标 12 格） | 发出 12 个 `\x1b[D`（按格不按字符） |
| 程序已开鼠标跟踪（`?1000h?1006h`） | 发出 SGR 鼠标报告（按钮码含 Alt 位），不发方向键，不走 binary 通道 |
| 视口回滚进历史 | 不发出任何字节（不会改前台程序输入） |

⇒ 结论：该能力在终端契约层已存在且正确（此前缺少的是显式声明与回归用例，不是重新开发）。仍需真机 WebView2 验收（见文末未验证项）。

### 逐项进展

（Builder 交付后逐条补充；验证结果统一在"验证"一节。）


### 最终结果（2026-11-02）

四项功能全部落地，验证在本机真实环境完成（WSL sshd、真实 Edge、真实 Rust 后端）。

| 项目 | 结果 |
| --- | --- |
| 前端单测 | 110 文件 / 1026 用例通过 |
| 浏览器契约（真实 Edge） | 29 文件 / 156 用例通过（含本轮新增 Alt+点击 4 条、跟随与文件跳转 2 条） |
| Rust 全量 | 451 通过 / 0 失败 / 28 ignored |
| Rust 真实 sshd 验收（ignored） | `real_remote_report_preview_serves_assets_refuses_escapes_and_stops` 1 通过（127.0.0.1:2222） |
| typecheck / format / lint / 前端构建 | 通过（lint 仅 `src/bindings.ts` 两条既有 any 警告） |
| 绑定 | 重新生成 97/102 命令，`check:bindings` 通过 |
| rustfmt | `cargo fmt -- --check` 通过（顺带修掉 `scripts/bindings.mjs` 之外的 Rust 排版） |

逐项：

- ② 鼠标定位：xterm 6 的 Alt+点击在真实 Chromium 中已可用（普通缓冲区走方向键、CJK 按格、鼠标跟踪程序收 SGR 报告、历史区不动前台输入）。本轮做的是显式声明 `altClickMovesCursor`、补真实浏览器回归，并确认 TUI 场景不抢鼠标。
- ③ Filer 跟随：三态按钮（pin / 暂停图标 / 胶囊高亮），每会话独立、默认关闭、手动浏览即暂停、隐藏零请求、400ms 防抖只落最后一个目录、本地会话跨主机会暂停并提示、无 OSC 时首次同步回退到一次 `session_cwd`。浏览器用例覆盖"按钮开启 → 报目录 → Filer 落地"。
- ④ 文件跳转：`terminalFileLinks.ts`（traceback / path:N / path:N:C / 相对路径 / 引号括号 / grep 风格；抑制 URL、Windows 形态、裸 a:b、超限行号、超长 token）+ `CwdAttribution`（按稳定行号锚定，trim 由 `firstLineNumber` 换算）+ xterm link provider（Ctrl/Cmd、单元格 1-based、TUI 不响应、hover 零 IO）+ 编辑器先读后开、行号透传与 `clearRevealLine`。相对路径回退顺序：锚定 cwd → 会话当前 cwd → 报错；成功后在状态栏说明打开路径。
- ⑤-A 远程服务：SSH 会话里字面 loopback 地址经 127.0.0.1:0 转发打开，按 (session, 目标 host, 目标 port) 去重、并发点击共享一次建链、失败回滚本次创建的转发、浏览器失败保留可用转发；公网地址与其它会话类型按原行为直接打开。
- ⑤-B HTML 预览：Rust 只读回环服务（127.0.0.1:0 + 128-bit token + Host 校验 + realpath 根边界 + 只 GET/HEAD + no-store + 64 KiB 流式 + 单段 Range + 512 MiB/8 并发/16 连接/16 预览上限），Filer 右键 .html 打开、再右键可停止；会话关闭显式清理（`close_session` 已接入）。

需要留意的新增依赖：hyper 的 `server` feature 强制带进 `httpdate 1.0.3`（Cargo.lock 新增一条传递依赖，无其它新 crate）。

### 未验证（真机项，需用户复验）

- 真实 Tauri/WebView2 窗口内的行为：Alt+点击、Ctrl+点击文件路径、Filer 跟随按钮、右键预览菜单、系统浏览器实际打开。本机的浏览器用例跑在 Edge 页里，证明的是终端与前端契约，不是 WebView2。
- OpenCode / Vim / tmux 的真实 TUI 点击（无真实环境）；中文输入法组合态下点击。
- 真实隧道端到端：应用窗口内点 `http://localhost:6006/` 建转发并在系统浏览器打开（后端转发与前端分类各自有测试，但没在窗口里串起来验过）。
- 高输出下的链接识别/跟随性能走查（本轮未做基准测量）。
- 8 路并发/512 MiB 上限/客户端中途断开的资源回收；macOS 与 Linux 构建。
