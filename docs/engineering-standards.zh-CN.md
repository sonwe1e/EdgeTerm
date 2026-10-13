# 工程规范：评审教训、必须遵守的规则与测试方案

本文件源自上游仓库（miskin-lee/EdgeTerm）对 PR #91（列表排序）、#92（双栏拖拽）、#93（resize 防抖）的三份 "Changes Requested" 评审。事后逐条核查证实：**评审的十几条技术断言全部属实**，包括对 OpenSSH rename 语义、xterm reflow 条件、VS Code 防抖实现等外部事实的描述。三个 PR 的问题不是代码写不出来，而是**根因分析错了、声明与实现不符、协议语义没有查证**。以下规则把这三类错误变成可检查的要求。

## 一、事实断言必须查证（PR93 的教训）

PR93 声称"resize 会 reflow 整个 scrollback，所以需要 100ms 防抖"，并以拖动底部 Sender 面板为例。实际上 xterm 的 `Buffer._reflow()` 第一行就是 `if (this._cols === newCols) return;` ——**只有列数变化才 reflow**，纯行变化只是增删空行，几乎免费；而 Sender 默认停靠在底部，拖它只改行数。

**规则 R1：**
- 提交说明、代码注释里的每一条因果断言（"X 会导致 Y 开销，所以做了 Z"）必须先在真实实现里核实：读上游源码或协议文档，注明出处。
- 根因分析必须匹配自己举的场景。举不出一个真正触发根因的例子，就不能下结论。
- 性能改动必须带测量：改动前基线、改动后数字，写进提交说明。仓库里的基准模式：Rust 侧 `sftp_tests.rs` 的 `#[ignore]` 模拟延迟基准；前端侧 `scripts/cdp-*.cjs` 与 `scripts/check-file-performance.mjs`。
- 对第三方行为（xterm、VS Code、OpenSSH）的引用要落到版本：写清楚查证过的版本号或提交。

## 二、一个 UI 承诺，全部后端一致（PR92 的教训）

PR92 对同名目标弹出 "Replace … file?" 确认框，但确认后调用的 rename 在三端语义完全不同：

| 后端 | 实现确认 | 用户确认 Replace 后的实际结果 |
|---|---|---|
| 本地 | `std::fs::rename`（Windows 上是 `MoveFileExW(REPLACE_EXISTING)`，POSIX `rename(2)`） | 静默覆盖，与提示一致 |
| SFTP | russh-sftp 标准 v3 `SSH_FXP_RENAME`；OpenSSH sftp-server 用 `link()` 实现，目标存在即 EEXIST；只有 `posix-rename@openssh.com` 扩展才覆盖 | **调用失败**，与提示相反 |
| FTP | RNFR/RNTO，RFC 959 未定义覆盖语义 | 因服务器而异，不可承诺 |

**规则 R2：**
- 同一个 UI 动词（Replace / Move / Delete）在 local / SFTP / FTP 三端的行为必须先做成矩阵查证清楚，再决定 UI 能承诺什么。做不到一致就在 UI 层如实区分（拒绝并说明），而不是弹出无法兑现的确认框。
- 涉及协议语义时查权威源：OpenSSH 看 `sftp-server.c`，FTP 看 RFC 959，并注明"因服务器而异"时不得向用户做单向承诺。
- 破坏性或不可逆操作（rename/move/删除/覆盖）必须确认，且**确认文案描述的后果必须与实际执行的一致**。
- 无撤销的操作要考虑误触发成本：拖拽 5px 即触发 move 时，move 必须过确认。

## 三、默认可见行为不得悄悄改变（PR91 的教训）

PR91 让前端无条件用 `Intl.Collator(numeric)` 重排列表：没点过排序的用户看到的默认顺序也从后端的字节序（file10 在 file2 前）变成了数字序——没有人要求过这个变化。

**规则 R3：**
- 默认状态 = 用户没有表达任何偏好时的显示，必须与"改动前的行为"或"后端给定的顺序"一致。新增偏好只在用户显式选择后生效（本仓库的做法：默认序直通后端排序，见 `fileSort.ts` 的 `sortFileEntries`）。
- 前后端都做排序时要写明哪一侧是权威，另一侧默认直通。

## 四、持久化偏好必须登记（PR91 的教训）

`resetSettings` / `exportSettings` / `applySettings` 靠枚举字段工作。PR91 新增的 `edgeterm.filerSort` 游离在外：用户"恢复默认设置"清不掉它，导出设置也不带它。事后排查发现同类问题共有 5 个 key（filerSort、filerOpenWith、senderRepeat、senderSaveLevel、transfer-options）。

**规则 R4：**
- 新增任何 localStorage 偏好，必须同步登记到 `src/persistKeys.ts`，并保证"恢复默认设置"能清掉它、设置导出/导入能带上它。
- 多个组件实例共享的偏好（如双栏的两个 FileBrowser）必须放进 zustand store（单一数据源、响应式同步），不允许各自 `useState(load…)` 只读一次后各自漂移。
- 每个偏好的读取函数必须对损坏/越界值做防御并回落默认。

## 五、UI 细节遵循既有体系（PR91 的教训）

- 图标用已注册的 codicon（`icons.tsx`），不用文本符号（" ↑"/" ↓"）。
- 改元素类型（span → button）时，同步更新**所有**相关 CSS 选择器，包括媒体查询里的；注意全局 reset（如 button 无 `text-align`，默认居中）与新元素的对齐差异。
- 破坏性按钮语义、hover/focus 样式跟随面板内已有约定。

## 六、resize / 渲染类改动的参照系（PR93 的教训与修正）

VS Code 的 `TerminalResizeDebouncer` 是本仓库 resize 策略的参照实现，四个要点均已核实（`terminalResizeDebouncer.ts`）：

1. `StartDebouncingThreshold = 200` 行以下立即 resize；
2. 行数变化始终立即应用（注释原话 "vertical resize is cheap"）；
3. 只有列数变化 100ms 防抖（注释原话 "due to reflow"）；
4. 不可见终端的 resize 推迟到窗口空闲。

**规则 R6：** 本仓库 `TerminalController.fit()` 遵循同一模型（列变化走 settle 节流、行变化直通），`TerminalPane` 的 ResizeObserver 跳过隐藏 pane（fit-on-show 已存在）。改动这条路径前先读 `FIT_SETTLE_MS` 的注释与 xterm `Buffer._reflow` 的实现，不要重新引入"每次 resize 都全量 reflow"的错误前提。

## 七、PR 卫生

- 不叠 PR，除非在描述里声明 "Stacks on #N" 且随时 rebase。
- 提交说明只声明已验证的事实；"理论上会更快"的改动要先用基准/小 Demo 验证再落地（本仓库 `benchmark_small_file_batch_at_20ms_rtt` 就是这个流程的产物：先固化基线，再改，复测对比写进提交说明）。
- 评审指出的每一条要么修、要么在回复里给出反证，不允许沉默合并。

## 八、测试方案（按改动类别）

| 改动类别 | 必须的测试 | 仓库内范例 |
|---|---|---|
| SFTP/FTP 传输与协议语义 | wire 级夹具测试：真实 `RawSftpSession` 对着可注入故障/延迟/乱序的假服务器；覆盖协议语义边界（rename 覆盖与否、部分写、丢应答）、断点续传路径、往返计数守卫（防止"优化"悄悄加回往返） | `src-tauri/src/file_transfer/sftp_tests.rs`（夹具会拒绝父目录未建就建子目录的 mkdir，顺序倒退会直接失败） |
| 性能改动 | 先基准后改动：模拟 RTT 基准（Rust `#[ignore]` 测试）或 CDP/Playwright 测量（前端）；数字进提交说明；负向数字必须解释或回退 | `benchmark_small_file_batch_at_20ms_rtt`、`scripts/cdp-*.cjs` |
| 持久化偏好 | key 登记完整性（新 key 必须进 `persistKeys.ts` 并被 reset/export 覆盖）；损坏值防御；旧版本存储的向后兼容（缺新字段不得整体作废） | `src/transferSettings.test.ts`、`src/fileSort.test.ts` |
| 多实例共享状态 | 改一处、断言另一处同步（store 化后由 zustand 保证，测试断言单一来源） | `store.ts` 的 `filerSort` |
| 默认行为 | "没点过偏好"的直通测试：默认状态下输出顺序等于输入顺序 | `fileSort.test.ts` 的 passthrough 用例 |
| 拖拽/指针交互 | 纯函数部分（dropAction、edgeScrollStep）单测；组件层用 jsdom + createRoot + act 模式 | `src/paneDrop.test.ts`、`src/edgeScroll.test.ts`、`src/fileTransfers.test.ts` |
| 终端输入/锁定 | TerminalController 级测试（jsdom 可直接构造 controller，内部方法用类型断言访问） | `src/reconnect.test.ts`、`src/terminalFlow.test.ts` |

## 九、已知未竟事项（2026-10 审计时点）

- 4 个非 store 偏好（senderRepeat / senderSaveLevel / filerOpenWith / transfer-options）已纳入 reset/export/import 覆盖，但组件仍在挂载时读一次本地 state；"恢复默认设置"后要等组件重新挂载才反映。彻底做法是全部迁入 store。
- 传输引擎的 `durable`（远端 fsync）默认关闭：换速度、保原子提交（rename），但服务器掉电窗口内的持久性需用户显式开启。
- mkdir 流水线依赖"单 channel 请求按序处理"（OpenSSH 及多数服务器如此）；对乱序服务器已做 drain-retry 兜底（`create_directories`）。
