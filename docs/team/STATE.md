# 项目状态

## 本轮：四向性能优化（2026-11-06）

- 用户确认：A（长历史内存）+B（批量传输）+C（链接识别走查）+D（全局排查）全选；修改并逐提交 main（`perf:` 带 Measured/Unmeasured、`fix:` 带 Tests:）；允许 WSL sshd 真实基准；按路线图验收门验收。
- 环境预检：`./dev.ps1 doctor` 通过（Node 24.19.0、rustc/cargo 1.99.1、cargoJobs=2、34.7 GiB 空闲）；`.tmp/ssh/id_ed25519` 仍在；127.0.0.1:2222 未监听，且会话沙箱内 `wsl` 报 `WSL_E_ACCESSDENIED`（命名管道边界）——真实服务器基准到 Wave 2 需提权或用户侧启动。
- 研究结论（3 个只读子代理 + Lead 逐条抽查核实）：
  - **路线图 B 项已大半落地**（13cec59 journal 出 runtime、43817f1 小文件 2 次 save、ea6e02c TOCTOU 修复+plain rename、53301cd readdir 规划、bb47ac7 files 8→16、4dbabeb FTP 精简、926e2ed tar 流、91dedbf/39607cd 窗口共享；5842f6c close 流水线被 dc09dfa 回退——真实 sftp-server 拒绝迟到 write）。原 B0→B3→B1 计划作废。**剩余缺口**：串行服务器模式未接入 3 个 `#[ignore]` 基准、并发文件数无引擎级断言、基准无数值记录（仅 eprintln）、job 无分阶段计时、无 bench-transfer.ps1（由 real_tests.rs 6 个 `#[ignore]` 替代）、`local::signature` 仍同步于 async fn（sftp.rs:1038/1179）、B7 多通道与 B9 并行遍历未做。行号以重验报告为准，勿引用路线图旧行号。
  - A 项：A0 已落地（默认 10k+内存估算+WebGL LRU+隐藏暂停；搜索已自研非 addon-search；无隐藏自动停闪）。A2 唯一高危假设＝xterm 无"裁剪前"事件 → 先做裁剪捕获 spike 再谈 2-3 周估算。工作区恢复（e0a905a）放大了启动内存涌入（20 标签×10k 行×200 列×12B≈480MB）。
  - C 项：链接 provider 仅在鼠标换格时求值（高输出+鼠标静止＝零求值）；现有测试无性能基准；方案 `scripts/measure-file-links.mjs` 复用 measure-agent-scroll.mjs 骨架。
  - D-lite 缺口：冷启动（卖点从未测量）、应用常驻内存、安装包体积守卫（README 卖点 4–5MB 无门禁）、终端 tab 切换门禁。
  - 战略：价值排序 B剩余 ≥ A > D-lite > C；Wave0＝测量重定基线，Wave1＝B7 探针+A2 spike+history 纯函数，Wave2＝真实 CSV 后定并发。砍：FTP 新工作、B11 快速模式、A3/A4、原生渲染评估。
- 分工：c-bench-builder（teammate）写 measure-file-links.mjs；Lead 做 B0-lite（串行基准变体+并发文件断言+跑基准记数值）；验证由 Lead 串行执行（单 runner 约束）。
- **本会话沙箱实测（重要）**：受管任务/子进程对仓库内被 gitignore 的目录（`src-tauri/target`、`.tmp/`、`node_modules/`、`artifacts/`）一律 os error 5 拒写（旧会话建成的 ACE 只带旧沙箱身份；`G:\Workspaces\acl-reports\` 有 ACL 修复记录与回滚命令，修复了 WRITE_OWNER 前端条件但不改变该行为）；未忽略路径与 `%TEMP%` 可写。绕行：`CARGO_TARGET_DIR=%TEMP%\edgeterm-cargo-target`；浏览器/测量脚本输出目录同样需可覆盖到临时区。gitignore 之外的构建产物目录在本会话均按此约束设计验证命令。后续实测补充：拒写不限于忽略目录——`src-tauri/src`、`scripts`、`.git`（提交需提权命令）同样拒写；仓库根与前端 `src/` 可写。PowerShell 会吞裸 `--`，传给 cargo 的分隔符需引号 `'--'`。

### B0 基线数值（2026-11-06，受管 runner，CPU 亲和被拒用满核、cargo jobs=2，fixture 20ms RTT，提交 085a3e2，`--ignored --nocapture` 单次运行）

| 基准 | 数值 |
| --- | --- |
| journal 落盘成本 | 200 次 save 297.0ms → **每次 1.485ms**；每 fresh 文件 6 次 save 共 8.91ms |
| 500×4KiB/51 目录（重叠应答） | F=4：copy 20.94s；F=8：11.28s；F=16：6.05s；F=32：3.35s（随 F 近似线性） |
| 500×4KiB/51 目录（**串行服务器**） | **F=4：84.23s；F=16：84.75s——完全打平**；plan 约 3.1s（串行下 mkdir/realpath 窗口也逐个应答） |
| 8MiB pipeline 深度 | upload 2.38s@1→0.53s@8→0.26s@32；download 2.28s→0.56s→0.41s；peak_inflight 与深度一致 |
| 24×4KiB | F=1：4.80s；F=4：1.20s |
| 50×4KiB/11 目录 | F=4：2.34s；F=8：1.36s |

结论（fixture 证据，非真实服务器）：重叠应答服务器上文件并发收益到 F=32 仍在；**单线程 sftp-server 形态下文件并发收益为零（T_server 主导）**，串行服务器只有多 sftp channel（B7，T_server/C）或 opt-in tar 流两个杠杆；plan 阶段在串行链路约占 3.1s。真实服务器 CSV（netem 三档 RTT）留待 Wave 2 决策 B7 时再做。

### C 项：高输出链接识别走查（2026-11-07 关闭——未发现性能问题）

- 交付：`scripts/measure-file-links.mjs` + scripts/README 小节（提交 86b79d1）。首个基准：进程内 node:http 页面 + 真实 xterm（无渲染器/无鼠标管线/无 IPC）+ 生产 `createFileLinkProvider`，经与 src/terminal.ts 相同的 registerLinkProvider 路径计时每次 provideLinks；固定校验块证明夹具真实出链（traceback/path:line 必须出、普通行必须不出）。
- 实测（Edge 157.0.4341.42 headless，external-cdp 接入，两轮 PASS 差异 ≤0.7ms；工件 `.tmp/records/file-links/`，含采样数组与 sourceSha256）：
  - 80×24、801k 字符 → 10,024 缓冲行（scrollback 触顶）：全缓冲逐行 19.0–19.6ms ≈ **0.002ms/行**；视口扫过（24 行）p50 0.1 / p95 0.2–0.3ms。
  - 200×24、801k 字符 → 5,242 行：全缓冲 17.1–17.8ms ≈ 0.0034ms/行（80→200 列 ~1.7×，随行宽缩放符合预期）。
  - 单次调用受非跨域页 performance.now ~0.1ms 量化限制（p99=0.1ms 即下限），全缓冲均值是可信口径。
- **结论：指针扫过整个视口的链接求值成本 0.1–0.3ms，距 50ms tripwire 三个数量级；2026-11-02 轮遗留的"高输出下链接识别/跟随性能走查"以证据关闭。** 未覆盖：Linkifier 行缓存/dispose、渲染器命中、hover 下划线、click/open IO、WebView2 真实渲染。
- 本会话沙箱适配（已写入脚本与 README）：`--out` 覆盖输出；esbuild 管道进程被禁 → 进程内 transpileModule；浏览器 spawn 全禁 → `EDGETERM_FILE_LINKS_CDP` 连接外部调试 Edge（Lead 提权启动，测后关闭）。

### A1-lite：终端内存/吞吐基线（2026-11-07，脚本 measure-terminal-memory.mjs，本波提交）

- 矩阵 W1/W3 × {10k,100k} 行 × {80,200} 列（scrollback=行数），进程内 node:http + 真实 xterm 无渲染器，CDP HeapProfiler.collectGarbage×2 + Runtime.getHeapUsage 取堆；external-cdp 接入 Edge 157 headless；两轮 PASS，堆增量差异 ≤0.2%，校验块（buffer.length、首末行）全过。工件 `.tmp/records/terminal-memory/`。
- 数值：10k 行 ≈ +2.2–2.4 MB；100k 行 ≈ +20.55–20.59 MB（≈205–240 B/行）；写吞吐 6.6–15.7 MB/s（W3 比 W1 低 20–30%，200 列比 80 列低 20–30%，100k 比 10k 慢）；滚动 p50/p95 ≈7/8 ms 全变体无差异（无渲染器 O(1)，JS 侧上限口径）。
- **关键发现 1（推翻路线图 §1.1 内存模型）：堆增量只随行数缩放、与列宽完全无关**（100k×80 与 ×200 均 ≈20.57MB）。xterm 6.0 行存储按内容惰性分配，并非按 cols 预分配整列数组；路线图"短行也占满整列、1M×200 列 ≈2.4GB"的估算对短行负载不成立（短行 1M 行 ≈210MB 量级）。A0 的 rows×cols×12 公式对短行最多高估 ~11.6×（仅对满宽行接近下限；本轮未测满宽行）。**影响：A2 冷存储的内存收益前提需重估（长历史仍有 ~10× 压缩空间，但 GB 级痛点叙事不成立）；§6 决策 1-3 征求时按本实测口径重新陈述。**
- 关键发现 2：SGR/spinner 负载（W3）堆与纯文本几乎相同（属性稀疏存储），代价在解析吞吐而非内存。
- 边界：V8 堆≠WebView2 进程工作集；无渲染器/无 IPC/无 PTY；合成负载；本机单机数值；满宽行（cat 大文件）形态未覆盖，定阈值前需补一轮或改用"每行实测均值"口径。

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

## 1.6.0 打包产物（2026-11-02）

- 版本从 1.5.1 提升到 1.6.0（兼容性新功能，minor），四个版本文件由 `npm run version:set 1.6.0` 同步，`version:check` 通过。
- 发布源码固定为 `42d01f0f29ea61c2362b716685fb36a2e8ffb492`（`v1.6.0` 标签解引用），该提交含发布说明；构建与打包都在该提交的干净工作区完成。
- 在 Windows x64 上用受管 runner 执行 `./dev.ps1 tauri:build --bundles nsis`（Node 24.19.0、rustc/cargo 1.99.1、MSVC 与 Windows SDK、已预置的 NSIS），release 构建 3m20s；`edgeterm.exe` 与安装器的文件版本均为 1.6.0。
- 产物在 `artifacts/release-1.6.0/`（git 忽略）；`npm run release:package -- --check` 三个附件与 `SHA256SUMS.txt` 匹配：

| 附件 | 字节 | SHA-256 |
| --- | ---: | --- |
| EdgeTerm_1.6.0_x64-setup.exe | 4,097,199 | `fa963c165f1003d771ca95fd712b65ea86d4643705e7547158cc6a3ab79ef6b3` |
| EdgeTerm_1.6.0_x64-portable.zip | 5,097,433 | `ed361ee31a63e35d11fc30ac24e26c5b0f57d469cc77dfef12f9260c17ae2187` |
| EdgeTerm_1.6.0_windows-diagnostics.zip | 5,471 | `e2e841260726ca0705dc400dcdce1303ec5490bd621e8690ae48733e7eaef0bc` |

- 便携包内 `EdgeTerm.exe` 为 10,058,240 字节，SHA-256 `c04acff0954182cc246c9e0daad37116a0a57f7294516fbdd40134497ae69add`，另含 `data/` 与 `README.txt`。
- 2026-11-02 08:19（北京时间）公开为 latest（非草稿、非预发布）：https://github.com/sonwe1e/EdgeTerm/releases/tag/v1.6.0 。发布后从该页回下载四个附件逐个计算 SHA-256，与本地 `SHA256SUMS.txt` 一致。
- GitHub CI（push 到 main）：run [41366374494](https://github.com/sonwe1e/EdgeTerm/actions/runs/41366374494) 的 frontend 与 rust 两个 job 均通过。本轮之前的两条 main 推送是失败状态（`cargo fmt --check` 的既有偏差），本轮的 `d9d8b71` 修掉该偏差后转绿。
- 未验证：安装、卸载、覆盖升级与数字签名；未在干净机器上运行安装器；未在真实 Tauri/WebView2 窗口内验收交互（见"未验证（真机项）"）。

## 1.6.1 打包产物（2026-11-02）

- 内容为 1.6.0 之后的兼容修复（Alt+点击后菜单栏误弹出）与一项兼容新能力（输入行选区删除/替换，`79a6b64`、`fce6752`）；按维护者决定使用补丁版本 1.6.1（先例 1.5.1），四个版本文件由 `npm run version:set 1.6.1` 同步，`version:check` 通过，`tauri.conf.json` 仍引用 `../package.json`。
- 在 Windows x64 上用受管 runner 执行 `./dev.ps1 tauri:build --bundles nsis`（Node 24.19.0、rustc/cargo 1.99.1、MSVC 与 Windows SDK、已预置的 NSIS），release 构建 2m55s；`edgeterm.exe` 与安装器的文件版本均为 1.6.1。本轮未改 Rust 代码；`test:rust` 全量首跑有一条 `closing_a_pending_remote_forward_cancels_its_late_allocation` 在并行负载下断言 `stopping`≠`stopped` 失败，单独重跑与全量重跑（451 通过 / 28 ignored / 0 失败）均通过，判定为既有用例的时序抖动，不是本轮改动引入。
- 产物在 `artifacts/release-1.6.1/`（git 忽略）；`npm run release:package -- --check` 三个附件与 `SHA256SUMS.txt` 匹配：

| 附件 | 字节 | SHA-256 |
| --- | ---: | --- |
| EdgeTerm_1.6.1_x64-setup.exe | 4,098,396 | `9f7db9b83f9bd083f23a7521917c99f509b38829050266bdcef4f5c257f3c92e` |
| EdgeTerm_1.6.1_x64-portable.zip | 5,092,743 | `fdc101d785a62e88ae5e01bf792e0082ecb332e2ca8d6901748080a3c4c10d6b` |
| EdgeTerm_1.6.1_windows-diagnostics.zip | 5,471 | `d9ee8815b2282371791bdd84845ad4c97863ecd350955d479f4d06ad299cc55a` |

- 便携包内 `EdgeTerm.exe` 为 10,058,752 字节，SHA-256 `fb6ebe9d8e56165676bc96b7977592671c316039347c6c0973305ca10d3454ef`，另含 `data/` 与 `README.txt`。
- Windows 本地检查：111 个前端单元测试文件 / 1051 项、30 个浏览器测试文件 / 160 项（真实 Edge，含 Alt+点击 5 项、终端输入 5 项、选区编辑 3 项）、typecheck、Biome 格式、lint（保留生成绑定两条既有 `any` 警告）与前端生产构建通过；`79a6b64` 与 `fce6752` 两条提交已逐个独立验证（fix 提交独立通过 typecheck 与自身浏览器套件）。
- 发布源码固定为 `fe8976be5fb486fec27e9104aa19562e1b2d762f`（`v1.6.1` 标签解引用），构建与打包在其干净工作区完成。2026-11-02 14:38（北京时间）公开为 latest（非草稿、非预发布）：https://github.com/sonwe1e/EdgeTerm/releases/tag/v1.6.1 。发布后回下载四个附件逐个计算 SHA-256 与本地一致，远端标签解引用确认。
- GitHub CI（push 到 main）：run [41401149489](https://github.com/sonwe1e/EdgeTerm/actions/runs/41401149489) 通过。
- 未验证：安装、卸载、覆盖升级与数字签名；未在干净机器上运行安装器；未在真实 Tauri/WebView2 窗口内验收 Alt+点击、选区编辑与 IME 组合态。
