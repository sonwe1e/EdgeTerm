# 路线图：终端长历史与批量小文件传输

状态：规划稿（2026-10-14），基线 `rewrite/by-feature` @ `f73bad9`。本文只描述计划和已核对的代码事实，不是验收记录。遵循 [工程规范](engineering-standards.zh-CN.md) R1–R7 与 [测试与验收方案](test-plan.zh-CN.md)。

标记约定：
- 【已核对】：本次在当前代码、`node_modules` 中版本固定的依赖源码或引用的协议原文中找到对应。
- 【未核对】：来自审计或外部宣传，本次没有找到可复现的依据。
- 【判断】：作者推断，需要测量或维护者决策。

---

## 0. 结论摘要

- A（长历史）：推荐“热窗口 + 冷存储”路线。xterm.js 只保留 N 行热窗口；行在被裁剪前，以“逻辑行文本 + SGR 样式段 + 行号/时间”的形式送到 Rust 侧的压缩冷存储。冷历史默认只放在内存，落盘需要用户选择并加密。冷历史第一版用独立的只读历史视图展示，不做与 xterm 无缝衔接的滚动。原生渲染重写只保留为长期选项，设 go/no-go 条件。
- B（批量小文件）：先建测量工具（P0）。顺序是：把 journal 移出 async 线程并按批合并 → 新文件改用不覆盖语义的 rename，去掉提交前的 lstat → 规划阶段按目录 readdir，去掉探测 lstat → write 与 close 流水线 → 小文件提高并发并支持多 sftp channel → 下载签名去重与并行遍历 → FTP 精简 → 可选快速模式和 tar 流（都需要用户主动开启）。
- 核对时发现的偏差和新问题见 §1.3、§3.1。其中最重要的一条：当前新文件提交是“lstat 后 posix-rename”，两者之间存在 TOCTOU 窗口，可能静默覆盖期间新出现的目标文件。

---

## 1. 现状核对

### 1.1 A：终端缓冲

| 审计事实 | 结论 | 依据 |
|---|---|---|
| 默认 20,000 行，最大 1,000,000 | 已核对（HEAD） | `src/store.ts:154` `TERMINAL_SCROLLBACK = { min: 0, max: 1_000_000, default: 20_000 }`。主线正在改默认值为 10,000，本文按改后的值规划 |
| 每 cell 3×Uint32 = 12 字节 | 已核对 | `node_modules/@xterm/xterm`（6.0.0）`src/common/buffer/BufferLine.ts:22` `CELL_SIZE = 3`，`:68` `new Uint32Array(cols * CELL_SIZE)`。另有每行的 `_combined` / `_extendedAttrs` 对象（`:63-64`），开销未测 |
| 每个标签独立 | 已核对 | 每个 `TerminalController` 构造各自的 `new Terminal({ scrollback, ... })`（`src/terminal.ts:542-561`），单位实际是 pane/会话 |
| 每行元数据 `lineTimes` | 已核对 | `src/terminal.ts:432`，`number[]`，按 `LINE_TIME_SLACK = 4096` 批量压缩（`:118`） |
| 语义着色 `paintRecords` WeakMap | 已核对 | `src/terminal.ts:501`，以 xterm 行对象为键，行被裁剪后随之释放 |
| 行号/时间戳 gutter | 已核对 | `firstLineNumber`（`:441`），`followTrimmedLines` 用 marker 测量裁剪量（`:2379-2398`） |
| 搜索用 @xterm/addon-search | 已核对 | 0.16.0；`highlightLimit = 1000`（`src/terminalSearch.ts:8`） |
| 原始流录制 | 已核对 | `src-tauri/src/session/recording.rs`：只录输出原始字节，独立写线程，写到用户可见目录。与冷存储目的不同，不复用其文件 |
| WindTerm“无限回滚，1000 万行约 133 MB” | 来源可定位，EdgeTerm 未验证 | [WindTerm README](https://github.com/kingToolbox/WindTerm)：`seq 1 10000000`，10.674 s，133.3 MB，“scrollback lines: unlimited”，并注明 “All test data is for reference only”。工作负载是每行约 8 字符的 `seq` 输出，不代表彩色宽行 |
| OxideTerm 改用 GPUI + alacritty_terminal | 未核对 | 本次未抓取其源码或发布说明，不作为依据 |

缓冲内存下限按 typed array 估算【判断，依据 `CELL_SIZE`；JS 对象、`_combined`、WebGL 纹理图集、`lineTimes`、DOM gutter 均不计入】：

| 行数（rows+scrollback） | 80 列 | 120 列 | 200 列 |
|---|---|---|---|
| 10,000 | 9.6 MB | 14.4 MB | 24 MB |
| 20,000 | 19.2 MB | 28.8 MB | 48 MB |
| 100,000 | 96 MB | 144 MB | 240 MB |
| 1,000,000 | 0.96 GB | 1.44 GB | 2.4 GB |

公式：`bytes ≈ lines × cols × 12`。行数组按 resize 时的列数分配，与行内容长短无关。所以 AI agent 标签里大量很短的行也照样占满整列。这是冷存储能节省内存的主要原因：冷存储只存实际内容。

### 1.2 B：传输引擎（委派子任务逐行核对，节选）

| 审计事实 | 结论 | 依据（`src-tauri/src/`） |
|---|---|---|
| 新小文件上传约 6 RTT（探测 lstat、open CREATE\|EXCL .part、write、close、提交 lstat、posix-rename） | 已核对，按 RTT 计为 6 次请求 | `file_transfer/sftp.rs` 中 `copy`（:608）→ `upload`（:807）→ `commit`（:979）。测试 `sftp_tests.rs:700-711` 断言 lstat=2、open=1、write=1、close=1、posix-rename=1，测试注释写“Five round trips”，与断言的 6 个请求不一致（注释把两次 lstat 算成一次探测）。本文统一按 6 次请求、6 RTT 计 |
| 每文件 6 次持久 journal 写 | 已核对：6 次（空文件 5 次） | `Job::save`（`mod.rs:323`）→ `local::save_json`（`local.rs:150-165`）：写 `.json.new`、`sync_all`，再 `MoveFileExW(REPLACE_EXISTING\|WRITE_THROUGH)`（`local.rs:124-148`）。6 个调用点在 `sftp.rs` :683、:697、:896、:916、:1037、:1088 |
| 这些写在 async 函数里同步执行 | 已核对 | SFTP 路径直接调用 `std::fs`，没有 `spawn_blocking`。`local::signature` 的同步读也一样（:623、:720）。FTP 整体运行在 `spawn_blocking` 中（`ftp.rs:32`） |
| 并发文件 = min(files=8, open_handles/2)，无 limits 时为 4，validate 上限 16 | 已核对 | `sftp.rs:130-136`；`mod.rs:224-232`；`src/transferSettings.ts:10-12`。只有服务器声明 `limits@openssh.com` 时才查询 limits（:101-107） |
| 每文件深度 | 补充 | `depth = requests / parallel`，默认 32/8 = 4（`sftp.rs:369`）；共享 `Semaphore(requests)`（:137）。无 limits 时 chunk 为 31,744 B |
| 一个 sftp 子系统 channel，跑在标签共享的 SSH 连接上 | 已核对 | 每次 job attempt 调一次 `SharedTransport::transfer_channel`（`session/ssh.rs:463-480`），没有共享连接时调 `connect_sftp`（`sftp.rs:63-93`） |
| 每 endpoint Semaphore(2) | 已核对 | `mod.rs:519-524`。另外 ≥16 MiB 的大文件也共享一个 `Semaphore(2)`（`sftp.rs:370`） |
| 下载约 13 RTT/文件，源签名读两次 | 已核对 | `source_signature` 在 :626 和 :722 各执行一次。每次是 lstat、open、读前 64 KiB、读后 64 KiB、close，读取不流水线（:183-195）。小文件为 5+3+5 = 13 RTT，另加 plan 阶段的 lstat |
| FTP 上传约 17 RTT，worker 上限 2 | 部分核对：上限 2 已核对（`ftp.rs:57`）；实际命令数随服务器变化，且比审计描述的更多 | 目标 SIZE（存在时加 MDTM，MDTM 失败则整文件 RETR 求哈希）→ `.part` SIZE → 空 STOR 占位（一个数据连接）→ 再次签名 `.part` → 第二次 STOR → SIZE 校验 → 提交时 SIZE 目标、SIZE backup → RNFR/RNTO。每个数据连接都要 EPSV/PASV。本文没有逐条计数确认 17 这个数，P0 用计数器给出准确值 |
| 规划：mkdir 每批 8、realpath 窗口、远端遍历串行 DFS | 已核对，有修正 | mkdir 是固定批次，每批排空后再发下一批，不是滑动窗口（`sftp.rs:407-446`）；realpath 是大小为 8 的滑动窗口（:556-583）；下载遍历是串行 DFS（:491-534）；FTP 规划完全串行（`ftp.rs:139-199`） |
| 之前的实现是串行，约 3-4 RTT/文件 | 无法核对 | 文件传输只有一个提交 `ca310db`，旧实现已不在本仓库历史中。只有代码注释提到旧行为（如 `sftp.rs:698-700`）。本文不引用这个数 |
| 模拟基准 | 已核对 | `sftp_tests.rs:795`、`:918`，`#[ignore]`；`tokio::io::duplex(2 MiB)`，每个应答在独立任务中延迟，因此应答相互重叠，不模拟串行服务器（:63-72）；没有记录结果数值 |

### 1.3 与审计不一致或新发现

1. Replace/Merge 冲突策略：不存在。代码中没有 Replace/Merge/Skip/ConflictPolicy。传输总是替换目标；如果目标在传输期间变化，报 “destination changed” 冲突。凡是以 Replace/Merge 为前提的设计（例如 tar 流的冲突处理），都要先定义这些策略。
2. 提交时的 TOCTOU 窗口【已核对代码，判断有风险】。新文件提交先 `lstat target`，确认目标仍不存在（`sftp.rs:983`），然后执行 `posix-rename@openssh.com`。posix-rename 在 OpenSSH 中直接调用 `rename(2)`，会覆盖已存在的目标（[sftp-server.c `process_extended_posix_rename`](https://github.com/openssh/openssh-portable/blob/master/sftp-server.c)）。如果另一方在 lstat 与 rename 之间创建了目标，它会被静默覆盖。B3 的不覆盖 rename 同时修复这个问题，并省掉一次 RTT。
3. 测试注释说“Five round trips”，断言实际是 6 个请求（见 §1.2）。
4. FTP 的 durable 选项总是被拒绝（`ftp.rs:267-273`），与 R2 表一致。

---

## 2. ITEM A：长历史与终端性能上限

### 2.1 选项对比

| 选项 | 内存上限 | 改动面 | 主要风险 | 结论 |
|---|---|---|---|---|
| (1) xterm 热窗口 + Rust 冷存储 | 热窗口固定；冷存储按压缩后实际内容计 | `terminal.ts` 裁剪钩子、新 IPC、新 Rust 模块、历史视图 | 样式连续性、跨边界选择、搜索、隐私 | 推荐（分阶段） |
| (2) 降默认值 + 内存估算 + 低功耗 | 线性下降，没有突破上限 | 小 | 用户想要长历史时仍受限 | Phase 0，主线已在做 |
| (3) 原生渲染（alacritty_terminal + GPU UI） | 取决于实现 | 重写终端层与 UI 层，失去 xterm 生态（IME 补丁、WebGL 恢复、addon、语义着色） | 工作量按人月计；与 Tauri WebView 并存方式未定 | 长期选项，设 go/no-go |
| (4a) 隐藏标签空闲时序列化 | 隐藏标签降到压缩后大小 | 需要 xterm 序列化与恢复 | 恢复需要重放（写入耗时）；恢复后 marker、装饰、paintRecords 全部重建 | 作为 (1) 的 Phase 3 |
| (4b) 按行实际长度存储（替代整列数组） | 短行节省明显 | 需要 fork xterm `BufferLine` | 维护 fork，跟进上游困难 | 不推荐【判断】 |

### 2.2 冷存储设计要点（选项 1）

存什么。比较两种方案：

| 方案 | 优点 | 缺点 |
|---|---|---|
| 原始 PTY 字节 + 周期性检查点 | 实现简单；与 recording 同源 | 必须重放解析才能显示；光标移动、清屏、alt screen 让“第 k 行”没有稳定的字节区间；resize 后无法按新列数重放已经过去的历史 |
| 序列化后的逻辑行（推荐） | 行可独立寻址；按行号、时间检索 | 必须从 xterm 缓冲读出，有 JS 端开销；会丢失 xterm 无法表达的信息（不受影响，因为屏幕本来也只显示这些） |

推荐格式：在行被裁剪之前，从 xterm 读出“逻辑行”（把 `isWrapped` 续行拼接起来）。每条记录：
- `abs_line: u64`，对应现有 `firstLineNumber` 的绝对行号
- `time_ms: u64`，来自 `lineTimes`
- `text: UTF-8`
- `runs: [(start_col, len, fg, bg, flags)]`，SGR 游程编码，包含 256 色/真彩、粗体、下划线样式与颜色（`_extendedAttrs`）
- 可选：OSC 8 超链接 id 与语义着色的类别

要点：
- ANSI 属性连续性：每行自带完整的游程，因此不依赖上一行的状态。
- 宽字符：记录 `wcwidth`，占位 cell 不单独存。
- 换行重排：按逻辑行存储，显示时按当前列数折行。冷区不参与 xterm reflow，resize 时零开销。
- 存储块：每 4,096 行一块，用 zstd/lz4 压缩【判断：Cargo.toml 当前没有 zstd/lz4，只有 russh 带的 flate2；新增依赖要固定版本】。每块有索引 `(first_abs_line, first_time, byte_off)`。

语义边界：

| 场景 | 规则 |
|---|---|
| alternate screen | 不入冷存储。alt buffer 本身没有 scrollback；只有 normal buffer 的裁剪行会进入 |
| `clear`（ED 2 + ED 3） | 现有 `scrollbackErased()`（`terminal.ts:1595`）会重置行号。冷存储同步清空该会话，内存与磁盘都清。这是用户期望的“清除” |
| 裸 ED 2（如 top） | 保持现状，屏幕被推入 scrollback，最终进入冷区 |
| 菜单“清除缓冲” | 同 `clear`，必须清空冷区 |
| 行号/时间戳 | 冷区记录绝对行号与时间；gutter 继续工作 |
| 语义着色 | 第一版冷区保存 SGR 原色。语义着色由 `semanticPaint` 在显示时重新计算，不入库 |
| 跨边界复制/选择 | 第一版不支持跨热冷边界的连续拖选。历史视图内可以选择和复制，并提供“复制第 a–b 行” |
| 滚动 UX | 第一版：滚到 xterm 顶部时显示“更早的 N 行在历史中”条，点击打开历史视图（虚拟列表，分页拉取块）。无缝滚动列为 Phase 4 候选，需要单独评估 |
| 搜索 | 热区沿用 addon-search；冷区由 Rust 按块解压后做 substring/regex 匹配，返回 `(abs_line, col)` 列表。UI 显示“热区 x 条 + 历史 y 条”。冷区 regex 必须有超时与结果上限 |
| 上限 | 每会话冷区默认上限：内存 64 MB 压缩数据或 100 万行，先达到者生效；全局上限 256 MB【判断，P0 测量后定】。超限时丢弃最旧的块，UI 显示“已丢弃 n 行” |
| 重连 | Enter 重连（`1085a2e`）沿用同一个 controller，冷区保留并继续累积 |
| 关闭标签 | 同步释放内存块；如果启用落盘，删除对应文件。启动时清理孤儿文件（以进程/会话 id 标识所有权，遵守 R2“所有权不明不清理”） |
| 静态隐私 | 默认只放内存，不落盘。落盘是显式选项：使用每次进程启动随机生成、只在内存中的密钥加密（ChaCha20-Poly1305/AES-GCM，`ring` 已在依赖中）。进程退出后文件即使残留也无法解密。设置文案需写明“终端输出可能包含密钥/令牌” |
| Windows | 落盘目录放在应用数据目录而不是 `%TEMP%`；文件使用 `FILE_ATTRIBUTE_TEMPORARY` 并在关闭时删除。杀毒软件扫描可能拖慢顺序写，P0 测量时需记录是否开启 Defender 实时防护 |

IPC：沿用二进制 IPC 路径（`54e2f2f`，`src/api.ts`）。JS → Rust 方向批量发送，每 ≥1,000 行或空闲 200 ms 一批，并沿用 backlog 那套空闲切片调度（`BACKLOG_SLICE_MS = 8`）。读出行的开销必须控制在单帧预算内。

实现关键：xterm 没有“行即将被裁剪”的事件。现有的 `followTrimmedLines` 使用 marker，只能在裁剪发生后得知数量，那时行对象已经被回收。可行做法【判断】：在 `onWriteParsed` 中，当 `buf.length` 接近 `rows + scrollback` 时，主动把最旧的 K 行（K 为 xterm `scrollback` 的 10% 余量）序列化并发出。实际裁剪时只核对 marker 的计数。这依赖“热窗口留有余量”，需要在 `terminalResize`/`terminalClear` 测试中加入真实 xterm 用例覆盖。

### 2.3 测量工具（A 各阶段共用）

- 不能用 jsdom 测量：内存、布局、GPU、帧时间。jsdom 只能证明逻辑契约，例如行号连续、冷热边界没有丢行或重复、clear 后冷区为空。
- 浏览器层：Playwright + Edge headless（`PERF_BROWSER=msedge`，沿用 `scripts/check-file-performance.mjs` 的隔离 Vite 方式），mock IPC。
  - 测量指标：`performance.measureUserAgentSpecificMemory()` 或 CDP `HeapProfiler.collectGarbage` + `Runtime.getHeapUsage`；写入吞吐（MB/s，`term.write` 回调计时）；滚动帧时间（CDP `Tracing` 或 rAF 间隔的 p95）。
  - 工作负载固定 3 种：W1 `seq 1 N`；W2 120 列彩色 `ls --color` 风格的行；W3 AI agent 风格（短行、频繁 SGR、spinner 重绘 `\r`）。
- 真实 WebView2 层：使用一次性应用实例，通过 CDP（`EDGETERM_CDP_TARGET_ID`，规则见 `scripts/README.md`）执行同样的工作负载。另外记录进程工作集（`Get-Process msedgewebview2` 的私有字节）。这一层只证明这台机器、这一 GPU、这一构建模式下的结果。
- 不能证明：其他 GPU/驱动、macOS/Linux WebKit、长时间（>24 h）的碎片化。

### 2.4 分阶段计划

#### Phase A0：默认值、内存估算、低功耗（主线进行中）

- 范围：默认值 10,000（主线）；设置对话框根据 `lines × cols × 12` 显示当前列数下的单标签估算和全部标签合计，并标注“仅含字符缓冲”；低功耗模式（隐藏标签禁用 WebGL，已有 `WEBGL_MAX_TERMINALS = 6` 的 LRU；暂停 backlog 着色；光标不闪）。
- 文件：`src/store.ts`、`src/components/FontSizeDialog.tsx`、`src/terminal.ts`（主线负责）。
- 验收门：估算值与 Playwright 实测堆增量误差在 ±30% 以内（W1/W2，10k/100k 行，各 3 次取中位数）；旧 localStorage 中 20,000 的值保持不变（R3/R4：只改默认值，不迁移用户已经选择的值）。
- 回滚：只回退默认常量。工作量：1–2 天。

#### Phase A1：基线测量（不改功能）

- 范围：新增 `scripts/check-terminal-memory.mjs`（Playwright）与一份 CDP 真实实例的操作步骤；产出 W1–W3 × {10k, 100k, 1M} × {80, 200 列} 的堆、写入吞吐、滚动 p95，以及 addon-search 在 100k/1M 行时的单次查找耗时。
- 验收门：脚本失败时非零退出、清理自身创建的会话（R7）；同一台机器连续 3 次运行，结果变异系数 <10%。
- 输出决定后续参数：热窗口 N、批量大小、冷区上限。工作量：2–3 天。

#### Phase A2：冷存储（仅内存）+ 历史视图

- 范围：
  - Rust `src-tauri/src/session/history.rs`（新增）：块存储、压缩、索引、搜索、上限与丢弃。
  - `commands.rs` 注册 `history_append` / `history_read` / `history_search` / `history_clear`。
  - `src/terminal.ts`：裁剪前导出、clear 联动、`dispose` 时清理。
  - 新文件 `src/terminalHistory.ts`：逻辑行序列化，纯函数，方便测试。
  - `src/components/HistoryView.tsx`：复用现有虚拟列表模式（`e15dab9`）。
  - store 新增“扩展历史”开关，默认关闭直到 A3 验收；在 `persistKeys` 或 store 导入导出中登记（R4）。
- 验收门（每条都要有数字）：
  1. 正确性（vitest + 真实 xterm，jsdom）：写入 5×scrollback 行后，热区 + 冷区的逻辑行与输入逐行一致，`abs_line` 连续无缺口；宽字符、续行、真彩游程能往返；`clear` 后冷区行数为 0；alt screen 中的输出不进入冷区。必须先证明“没有冷区时第 1 行已丢失”这一旧行为测试失败（R7）。
  2. 内存（Playwright Edge）：W1 1M 行，热窗口 10k 行时，JS 堆 ≤ 热窗口基线 + 20 MB，Rust 冷区 ≤ 30 MB（参照 WindTerm 公开的 1M 行 16.1 MB，作为参考上限而不是目标，【判断】）。W3 同样记录，不设门槛，只报告。
  3. 吞吐：W1 写入吞吐不低于 A1 基线的 90%。
  4. 交互：历史视图打开 1M 行时首屏 <200 ms，滚动 p95 帧 <16.7 ms（Edge headless，以及一次真实 WebView2 CDP）。
  5. 搜索：冷区 1M 行 substring 首个结果 <300 ms、全量 <2 s，结果上限 10k（release 构建）。
- 不能证明：真实 PTY 洪泛下与 output credit 流控（`session/output.rs`）的相互影响，需要另做 SSH 实测。
- 风险：裁剪前导出漏行（余量计算错误）、JS 端序列化抢占帧预算。缓解：在 `onWriteParsed` 之外用空闲切片做导出；测试覆盖 resize 期间裁剪。
- 回滚：开关默认关闭，关闭后代码路径完全不执行。工作量：2–3 周。

#### Phase A3：可选的加密落盘 + 隐藏标签压缩

- 范围：冷区溢出到加密文件（§2.2 隐私规则）；隐藏标签空闲 60 s 后，把热窗口中除最后 1 屏以外的行也移入冷区，并把 xterm `scrollback` 临时降到很小，显示时恢复（选项 4a 的轻量版：不做重放恢复，热窗口只是变小，旧行在历史视图中可见）。
- 验收门：20 个标签，每个 W2 100k 行，隐藏后总工作集下降 ≥50%（真实 WebView2 + 任务管理器私有字节，3 次中位数）；进程被强杀后重启，孤儿文件 100% 被清理，且残留文件在没有密钥时无法解出明文（单测：用错误密钥解密必须失败）；关闭标签后对应文件不存在。
- 风险：用户切回标签后看到的 xterm 回滚变短（UX 变化，需要提示条）；杀毒软件扫描导致写入延迟（只在后台线程写，不阻塞会话）。
- 回滚：落盘为独立开关，默认关闭。工作量：1–2 周。

#### Phase A4（候选）：无缝滚动

在 xterm 顶部插入冷区行，或者反过来，用历史视图托管全部 normal buffer 的只读显示。只有 A2 上线后，用户反馈表明独立视图不够用时才评估。

#### 长期选项：原生渲染

go 条件（全部满足才立项）：
1. A2/A3 完成后，W2/W3 在热窗口 10k 行时，真实 WebView2 上仍出现写入吞吐 < 20 MB/s，或滚动 p95 > 33 ms；
2. 并且 profile 证明瓶颈在 xterm 解析或渲染（而不是 IPC 或应用自身的着色/gutter）；
3. 并且维护者接受放弃或重写 IME 补丁、WebGL 恢复、addon-search、语义着色。

否则 no-go。alacritty_terminal 的能力与授权许可需立项时单独核对（本文未核对）。

### 2.5 A 的提交拆分

每个提交单独通过 `npm run typecheck`、`npm test`、`cargo test --lib`、`cargo fmt --check`、`git diff --check`。

1. `chore: terminal memory/throughput harness`：只加脚本与 README 说明。
2. `feat: serialize logical lines with SGR runs`：新增 `src/terminalHistory.ts` 及测试，暂不接入。
3. `feat: in-memory compressed history store`：Rust 模块及单测（往返、上限、丢弃、搜索超时），命令已注册但前端还没调用。
4. `feat: spill trimmed lines to history behind a setting`：接入 `terminal.ts`，加 clear/dispose 联动，开关默认关闭。
5. `feat: history view and cross-store search`：UI 与搜索计数。
6. `feat: enable extended history by default`：单独提交，附 A2 的测量数据（R1）。
7. A3 另开 PR，拆为加密落盘与隐藏标签压缩两个提交。

---

## 3. ITEM B：批量小文件传输

### 3.1 耗时模型

记号：N 为文件数，R 为网络 RTT，F 为实际并发文件数（默认 8；服务器没有 limits 时为 4），k 为每文件串行 RTT 数（上传 6，下载 13），J 为一次 `save_json` 的本地耗时（写 + `sync_all` + `MoveFileExW WRITE_THROUGH`），D 为目录数。

```
T_upload ≈ T_plan + N·k·R / F + T_journal + T_server
T_plan   ≈ ceil(D/8)·R（mkdir 固定批）+ ceil(parents/8)·R（realpath 窗口）+ 本地遍历
T_journal 介于 6·N·J / F（fsync 能并行）与 6·N·J（同盘 fsync 串行化）之间
```

【判断】审计的 `6·N·J` 是悲观上界。journal 在 tokio 多线程 runtime 的 worker 上同步执行，会阻塞该 worker，并且影响同一 runtime 上的其他任务（包括会话 IO）。NTFS 上多个 WRITE_THROUGH 的实际并行度未知，需要由 P0 测量。`T_server` 是 sftp-server 的串行处理时间：OpenSSH sftp-server 是单线程、按到达顺序逐个处理请求（[sftp-server.c](https://github.com/openssh/openssh-portable/blob/master/sftp-server.c) 主循环每轮 `process()` 只处理一个包），因此单 channel 上的服务器侧磁盘耗时会累加，无法靠提高 F 隐藏。

示例【判断，未测】：N=2000，R=20 ms，F=8，k=6：网络项为 2000·6·20/8 = 30 s。J=5 ms 时 journal 项在 7.5 s 到 60 s 之间。这说明 journal 有可能是主导项，必须先测量再排序。

### 3.2 协议事实（rename 不覆盖语义）

| 请求 | 目标已存在时 | 来源 |
|---|---|---|
| `SSH_FXP_RENAME`（v3） | 规范：“It is an error if there already exists a file with the name specified by newpath” | [draft-ietf-secsh-filexfer-02 §6.5](https://datatracker.ietf.org/doc/html/draft-ietf-secsh-filexfer-02) |
| OpenSSH 的 `SSH_FXP_RENAME` 实现 | 普通文件用 `link()` + `unlink()`：目标存在时 link 失败，不会覆盖，无竞争窗口。文件系统不支持硬链接时，退化为 `stat` + `rename`，源码注释写明 “This is racy” | [sftp-server.c `process_rename`](https://github.com/openssh/openssh-portable/blob/master/sftp-server.c) |
| `posix-rename@openssh.com` | 直接 `rename(2)`，覆盖已存在的目标 | 同上 `process_extended_posix_rename`；[PROTOCOL §4.3](https://github.com/openssh/openssh-portable/blob/master/PROTOCOL) 只说 POSIX 语义 |
| `hardlink@openssh.com` | `link(2)`，目标存在时失败 | PROTOCOL §4.5 |
| `limits@openssh.com` | max-open-handles 在 OpenSSH 中为 `RLIMIT_NOFILE` 软限制减 5；为 0 表示不限 | PROTOCOL §4.8；sftp-server.c `process_extended_limits` |
| 管线化 | 允许多个未决请求；同一文件的请求按序处理；应答可以乱序 | draft-02 §3、§6.1、§7 |

未核对：非 OpenSSH 服务器（Windows OpenSSH、ProFTPD mod_sftp、Bitvise、嵌入式 dropbear 的 sftp-server）对 plain RENAME 遇到已存在目标时的行为。所以“新文件用 plain RENAME 做不覆盖提交”的方案必须在服务器不满足时安全降级（见 B3）。

### 3.3 候选优化（按收益/工作量排序）

| # | 候选 | 预期收益公式【判断】 | 安全语义变化 | 旧行为必须失败的测试 | 风险 |
|---|---|---|---|---|---|
| B1 | journal 移到 `spawn_blocking`/专用写线程，同一 job 的保存合并（只保留最新快照，节流 ≥50 ms 或每批文件一次） | 去掉 `6·N·J` 中可合并的部分，剩下约 `(T/50ms)·J`；同时解除 runtime worker 阻塞 | 恢复粒度从“每文件每阶段”变为“最近一次已落盘快照”。崩溃后，已提交但未记录的文件会在重试时被视为“目标已变化”或需要核对 → 需要定义：重试时目标签名等于本 job 写入的签名，则判定为已完成（job 级 completed 列表 + 签名） | 计数 fixture：100 个小文件上传，断言 `save_json` 调用 ≤ ceil(T/50ms)+批数（旧实现为 600）；崩溃注入（在 commit 后、save 前 panic）后重试，目标内容正确且不报冲突 | 恢复逻辑变复杂；需要严格遵守 R2“所有权不明不清理” |
| B2 | 小文件（≤ chunk）只做 2 次 save：开始（含 `.part` 名，用于清理所有权）+ 完成；中间阶段只存在内存 | 6→2 次/文件，配合 B1 进一步合并 | 中途崩溃：`.part` 有所有权记录，可以清理；“committing” 阶段的崩溃需按 B1 的签名核对恢复 | 同上，加 “committing 中崩溃” 用例 | 低 |
| B3 | 新文件提交：不再 lstat，直接 plain `SSH_FXP_RENAME`（不覆盖）。失败时 lstat 区分“目标已出现 → 冲突”与其他错误 | k: 6→5 | 安全性提升：去掉 §1.3 中 TOCTOU 静默覆盖的窗口（在 OpenSSH + 支持硬链接的文件系统上）。不支持硬链接的文件系统上 OpenSSH 自身退化为 racy 的 stat+rename，与现状风险相当。服务器若对 plain RENAME 做覆盖（非 OpenSSH，未核对）→ 首次连接时用探测文件验证一次语义，验证失败则保留旧流程 | fixture：在 lstat 之后、rename 之前创建目标；旧实现覆盖了它（断言失败），新实现返回冲突且目标内容不变；请求计数断言 lstat=1 | 非 OpenSSH 服务器语义不一，必须做能力探测 |
| B4 | 规划阶段对每个目标目录 readdir 一次，缓存 “名字 → attrs”，去掉每文件的探测 lstat；新建目录直接视为空 | k: 5→4；增加 `ceil(已存在目录数)·(1+页数)` RTT | 规划和上传之间目标可能变化 → 仍由 B3 的不覆盖 rename 兜底；已存在文件仍走完整签名路径 | 计数：上传到全新目录树时 lstat=0；有“规划后出现的目标”时返回冲突 | 大目录 readdir 开销；需要分页 |
| B5 | write 与 close 流水线：不等最后一个 write ack 就发 close（同一 handle 按序处理，draft-02 §6.1） | 单块文件 k: 4→3 | 若 write 失败而 close 成功，必须仍判定失败并保留 `.part`。须检查所有应答，不只检查 close | fixture 注入 write 失败 + close 成功：文件不得被提交 | russh-sftp 的 API 是否允许不 await 就发下一个请求需要核对；可能要用 raw 请求 |
| B6 | 小文件提高并发：F 上限从 16 提到 64（仍受 `open_handles/2` 限制），没有 limits 时保持 4 或做自适应（按 RTT 与错误率） | `N·k·R/F` 随 F 线性下降，直到 `T_server` 或带宽成为瓶颈 | 无语义变化；服务器端 handle 压力变大 | 计数 fixture：峰值 in-flight 文件数断言 = min(设置值, open_handles/2) | 嵌入式服务器断连；需要错误退避 |
| B7 | 多个 sftp channel（同一连接上开 C 个 subsystem），每个 channel 对应一个 sftp-server 进程 | 解除单进程串行：`T_server/C` | 无语义变化；受 sshd `MaxSessions`（默认 10，[sshd_config(5)](https://man.openbsd.org/sshd_config#MaxSessions)）约束，标签本身也占用 session | channel 打开失败时退回单 channel，并在 job 中记录实际 C | 占满 MaxSessions 会导致用户新开的标签失败 → C 默认 2，可配置 |
| B8 | 下载签名去重：:626 与 :722 两次 `source_signature` 合并为一次，并改为 open 后在同一 handle 上读样本，同时流水线化 | 下载 k: 13→约 6–7 | 签名仍在提交前比较一次，用于检测源变化。需保证“下载期间源被改”仍能检出（用 open 后的 fstat + 读后再 fstat） | fixture：下载过程中修改源，必须报冲突；计数断言 open=1 | 低 |
| B9 | 远端下载遍历并行化（目录级窗口 8） | `T_walk` 从 `D·R` 降到约 `D·R/8` | 无 | 计数 + 结果顺序（父目录先于子目录）断言 | 低 |
| B10 | FTP：去掉空 STOR 占位与重复签名；只在目标存在时做 MDTM；用 MLSD 一次列出目录替代逐个 SIZE；worker 上限 2→4（可配置） | 每文件命令数约减半（P0 计数后确定） | 占位 STOR 的作用是声明 `.part` 所有权，去掉后需要另一种所有权证明（例如本地 journal 先写名字再 STOR） | ftp_tests fixture：命令计数；断线恢复用例保持通过 | FTP 服务器差异大；需要多服务器实测 |
| B11 | 快速模式（opt-in）：小的新文件 `open CREATE\|EXCL` 直接写最终名，不用 `.part` 和 rename | k: 约 3（open、write、close 可以流水线） | 失去原子可见性：中断后目标处留下不完整文件。EXCL 保证不覆盖已有文件。中断后的不完整文件需要以 job 记录的所有权清理或标记 | 中断注入：目标存在且被列为“不完整”，重试时截断重写；从不覆盖非本 job 创建的文件 | 用户误解为“和普通模式一样安全” → UI 明示 |
| B12 | tar 流（opt-in）：`exec "tar -xf - -C <dir>"`，本地流式打包 | 约 `T_bytes + 少量 RTT`，与 N 几乎无关 | 失去逐文件续传、原子性、冲突检测（tar 默认覆盖）、细粒度进度；需要远端有 tar；符号链接/权限/文件名编码依赖远端 tar 实现 | 见 §3.5 | 安全面最大 |

### 3.4 B12 tar 流的约束

- 可用性：先 `exec "command -v tar"`，没有 tar 则回退普通模式。Windows OpenSSH 服务器（cmd/PowerShell 作为 shell）不支持，直接禁用。
- 冲突：当前没有 Replace/Merge 策略（§1.3）。tar 模式只允许目标目录不存在或为空。用 `tar -k`/`--keep-old-files` 防止覆盖；GNU 与 BSD tar 的参数差异需要分别探测【未核对】。
- 中断：取消时关闭 channel，远端 tar 被 SIGPIPE 终止，已解出部分保留。UI 明示“部分文件可能已写入”，没有续传，重试时只能整目录重传或回退到逐文件模式（届时由逐文件模式按签名跳过）。
- 进度：按本地已打包的字节数/文件数计算，不代表远端已落盘。
- 与 Transfers job 模型：作为一种 job kind，复用 endpoint 信号量与取消；journal 只记录“进行中/结束”。
- 文件名编码：本地统一 UTF-8 写入 PAX 头；远端 locale 不是 UTF-8 时结果未定义 → 首版只在探测到 UTF-8 locale 时启用（复用 `session/locale.rs`）。

### 3.5 分阶段计划

#### Phase B0：测量工具（先于一切优化）

- 确定性层（CI，`cargo test --lib`）：
  - 给 `sftp_tests.rs` 的 fixture 增加按请求类型的计数器和峰值 in-flight 计数（部分已有 `f.count`），并新增一个串行服务器模式：应答按到达顺序逐个延迟，模拟单线程 sftp-server。
  - 新增断言型测试，固化当前基线：新文件上传为 6 个请求、下载为 13 个、每文件 save 6 次、峰值 in-flight 文件数为 4/8。后续每个阶段修改这些数字时都要在提交里说明。
  - 给 `save_json` 加一个可注入的计数/延迟钩子（`#[cfg(test)]`），用来测 journal 是否阻塞 runtime。
- 计时埋点：job 内按阶段（plan、mkdir、realpath、per-file open/write/close/commit、journal）累计耗时，作为 job 结束时的调试事件发送，并可在 Transfers 面板复制。不新增 tracing 依赖也能完成。
- 真实服务器层（可选，手动执行）：`scripts/bench-transfer.ps1`。
  - 服务器：WSL2 或 docker 中的 OpenSSH（固定版本，记录 `ssh -V`）。
  - 延迟：`tc qdisc add dev eth0 root netem delay 10ms`，测 RTT 0/20/50 ms 三档；脚本结束必须 `tc qdisc del`（R7）。
  - 数据：D1 = 2,000 × 4 KiB 平铺；D2 = 2,000 × 4 KiB，分布在 200 个嵌套目录中；D3 = 200 × 256 KiB。
  - 对照：OpenSSH `sftp -b`（`put -r`）、`scp -r`（注意 OpenSSH 9 以后默认走 SFTP 协议）、`tar cf - | ssh tar xf -`；有 WindTerm 时人工计时。
  - EdgeTerm 使用 release 构建（`npm run tauri:build`），在空目标和已存在目标两种情况下各测 5 次取中位数，记录 Defender 实时防护是否开启，以及本地盘类型。
- 验收门：确定性测试在 CI 中稳定（连续 20 次不出现抖动失败）；真实服务器脚本失败时非零退出，并输出原始结果 CSV。
- 工作量：3–4 天。

#### Phase B1：journal 与 runtime（B1 + B2）

- 文件：`file_transfer/mod.rs`（`Job::save` 改为发送到写线程）、`local.rs`（`save_json` 不变，仅调用位置变化）、`sftp.rs`（调用点）、`sftp_tests.rs`。
- 验收门：
  - 确定性：100 个小文件，save 次数从 600 降到 ≤ 20 + ceil(墙钟时间/50ms)；崩溃注入的 3 个用例（open 后、write 后、rename 后、save 前）重试后，目标内容逐字节正确，所属 `.part` 被清理，非本 job 的文件不被触碰。
  - 真实服务器：D1 在 RTT=0 时耗时下降，具体幅度不预设，报告测量值；RTT=20 ms 时不回退（不慢于 B0 的 105%）。
- 风险：恢复语义回归。回滚：单个提交可还原，journal 格式加 `version` 字段；旧 journal 仍可读。
- 工作量：1 周。

#### Phase B2：减少每文件 RTT（B3、B4、B5、B8）

- 每个候选单独提交，每个提交更新 B0 中固化的请求计数断言。
- 验收门：确定性层新文件上传 6→3 个串行 RTT（B3+B4+B5），下载 13→≤7（B8）；§3.3 中各项“旧行为必须失败”的测试都在旧代码上演示失败（R7）。真实服务器 D1/D2 在 RTT=20 ms 时报告前后对比。
- 前提：B3 需要能力探测（首次连接时 rename 一个探测文件到已存在名字，验证它会失败），结果缓存到 endpoint。
- 工作量：1.5–2 周。

#### Phase B3：并发（B6、B7、B9）

- 设置项：`files` 上限 16→64（`mod.rs` validate 与 `src/transferSettings.ts` 一起改，并做旧值兼容，R4）；新增 `channels`（1–4，默认 2）。
- 验收门：确定性层峰值 in-flight 等于预期；`MaxSessions` 被占满时自动回退为 1 个 channel 并继续完成。真实服务器上 D1 在 RTT=20 ms 时达到 `sftp -b` 的速度或更快，这是门槛；`tar|ssh` 只作参考，不是门槛。提高并发属于 R1 要求单列的收益，不能与算法收益混在一起报告。
- 工作量：1 周。

#### Phase B4：FTP（B10）

- 先用 B0 的计数确认当前每文件的命令数，再精简。必须在 vsftpd 与 FileZilla Server（或 pure-ftpd）上分别实测。
- 工作量：1 周。

#### Phase B5：可选模式（B11 快速模式、B12 tar 流）

- 只有维护者同意（见 §6）才开发。每个模式在 Transfers 设置里单独开启，并在 R2 能力边界表中新增一行：

| 路径 | 替换方式 | 能承诺的范围 |
|---|---|---|
| SFTP 快速模式（opt-in） | EXCL 新建，直接写最终名 | 不覆盖已存在文件；中断时目标处留下不完整文件，按 job 所有权标记，可清理 |
| tar 流（opt-in） | 远端 tar 解包 | 仅限空/新目标目录；没有逐文件原子性、续传和冲突检测；进度是发送进度 |

- 工作量：快速模式 3–4 天；tar 流 2 周。

### 3.6 B 的提交拆分

1. `chore: count sftp requests and serial-server mode in transfer fixtures`：只改测试。
2. `chore: per-phase transfer timings`：埋点，无行为变化。
3. `chore: real-server transfer benchmark script`
4. `perf: move transfer journal writes off the async runtime`
5. `perf: coalesce journal saves for small files`（含恢复用例）
6. `fix: commit new uploads with non-overwriting rename`：同时修复 TOCTOU；附能力探测。
7. `perf: plan upload targets from directory listings`
8. `perf: pipeline close behind the last write`
9. `perf: read the download source signature once`
10. `perf: walk remote directories concurrently`
11. `feat: configurable file concurrency and sftp channels`
12. FTP 精简按命令拆为 2–3 个提交。
13. 可选模式各开独立 PR。

每个提交都要单独通过 `cargo test --lib`、`cargo fmt --check`、`npm run typecheck`、`npm test`。

---

## 4. 测量之前不声称的内容

- 不说“比 WindTerm 快”或“接近 WindTerm”。WindTerm 只能通过同一台机器、同一服务器、同一数据集的人工计时对照。
- 不说“支持无限回滚”。只说明配置的上限，以及达到上限后的丢弃规则。
- 不给出任何倍率（如“小文件快 5 倍”），除非附有 B0 脚本的原始 CSV。
- 不把 fixture 计数下降表述为真实吞吐提升；不把 Playwright/Edge headless 的内存表述为 WebView2 应用内存。
- 不说 B3 “原子”：它只保证在 OpenSSH + 支持硬链接的文件系统上不覆盖。
- 不说 journal 合并“没有安全损失”：恢复粒度确实变了，要写清楚。

## 5. 依赖与顺序

```
A0 (主线) ──> A1 测量 ──> A2 内存冷存储 + 历史视图 ──> A3 加密落盘/隐藏标签压缩
                                     │                     │
                                     └──> A4 无缝滚动(候选)  └──> 原生渲染 go/no-go 评估

B0 测量 ──> B1 journal ──> B2 RTT 精简(B3 rename → B4 readdir → B5 close 流水线, B8 下载签名)
                         └──> B3 并发(B6/B7/B9) ── 需 B0 串行服务器模式
B0 ──> B4 FTP
B2 + B3 + 维护者决策 ──> B5 可选模式(快速模式 / tar 流)
```

A 与 B 相互独立，可以并行。B2 中的 B3（rename）修复了一个安全问题，建议即使暂停其他优化也优先合入。

## 6. 需要维护者决定的问题

1. 是否接受把终端历史写到磁盘（即使加密且退出即失效）？还是只允许内存冷存储？
2. 冷存储内存总上限的默认值（建议 256 MB），以及是否允许用户把它设成“不限”。
3. 第一版可以接受独立历史视图吗？还是必须与 xterm 无缝滚动？
4. 是否接受 journal 恢复粒度从“每文件每阶段”放宽为“最近快照 + 签名核对”？
5. 是否接受快速模式（不完整文件可能出现在最终名）作为 opt-in？默认关闭是否足够，还是需要每次传输确认？
6. 是否接受 tar 流作为 opt-in，并接受“仅限空目标目录”的限制？
7. 是否引入 Replace/Merge/Skip 冲突策略？它会影响 B11/B12 的设计，也会扩大 R2 表的范围。
8. 默认使用 2 个 sftp channel 是否可以接受（会多占一个 MaxSessions 名额）？
9. 新增压缩依赖（zstd 或 lz4_flex）是否可以接受，还是只用已有的 flate2？

