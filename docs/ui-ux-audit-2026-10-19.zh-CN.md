# EdgeTerm 界面、交互与默认值审计（2026-10-19）

## 结论摘要

这一轮按三条线审查：**实际界面**（层级、间距、对齐、反馈、全部状态）、**交互**（每个按钮/菜单/快捷键是否有真实结果、失败是否有恢复路径）、**默认值与开关**（软件已支持但默认关闭/藏在深层的能力）。

共核实 20 余项问题，已修改 53 个 `src/` 文件，新增 5 个源文件/测试与 1 份报告，重点：

- 破坏性确认框不再把裸 Enter 当“确认”，初始焦点回到 Cancel；
- 远端 OSC 52 写剪贴板默认聚焦“拒绝”，Enter 不再放行；
- 连接中的标签可以真正取消，不再出现“断开”点了没反应；
- Filer / FTP 的失败、离线、空目录都有明确状态与恢复动作；
- 面板宽度与 Sender 展开态持久化，分栏不会再被拖到把终端压成 0；
- 自然排序、当前会话保存范围等更合理的默认值生效；
- SFTP/FTP 双栏、空工作区、终端右键菜单、传输/隧道状态等完成中文化；
- 四套主题的弱化文字全部达到 4.5:1，修复了 1.28:1 的徽章和无边框输入框。

## 方法与基线

- 直接阅读实现与样式，不依赖截图猜测；关键结论都有文件/行为证据。
- 用一个临时夹具（`.tmp/audit-ui.mjs`，未纳入产品）把**真实 App + 真实 store + 真实样式**挂在模拟 IPC 上，在 1440×900 与 900×560、深色/浅色下截图核对空态、双栏、离线、错误、面板组合。
- 现有测试：`src/` 单测 82 个文件 / 612 用例；`npm run test:browser` 11 个文件 / 59 用例；`npm run typecheck`；`npm run lint`。
- 生产构建用 `npx vite build --outDir .tmp/build-audit` 验证；`npm run build` 会清理 `dist/assets`，被本机沙箱的批量删除保护拦截，不是代码问题。

## 已核实并修复

### 1. 破坏性操作与远端授权

| 问题 | 证据（修改前） | 处理 |
|---|---|---|
| 删除文件/主机、关闭会话、退出应用四个确认框：初始焦点在“删除/退出”，但对话框把**任意 Enter** 都当确认；焦点在 Cancel 时按 Enter 仍会执行危险动作 | `DeleteEntryDialog.tsx`、`DeleteProfileDialog.tsx`、`CloseSessionDialog.tsx`、`QuitConfirmDialog.tsx` 的 `onKeyDown` + `autoFocus` | 移除全局 Enter 绑定，`initialFocus=".btn:not(.is-danger)"`；Enter 只激活当前聚焦按钮。底部提示只保留 Esc |
| OSC 52 远端写剪贴板：Enter 直接 Allow，焦点也在 Allow | `ClipboardWriteDialog.tsx` 的 `onKeyDown` / `autoFocus` | 默认聚焦 Deny；移除 Enter=Allow；只有显式点 Allow 或在 Allow 上按 Enter 才放行 |
| Sender 删除已保存命令没有确认，成功也没有反馈 | `SenderPanel.tsx` 的删除菜单项；`useSenderLibrary.ts` 的 `removeCommand` | 删除前 `ask()` 确认，成功后状态栏回报命令名 |
| Filer 上传同名文件/文件夹会静默覆盖（后端就地替换） | `useFilerUpload.ts` 的 `uploadPaths` | 上传前按当前列表检测同名项，一次确认整批替换；取消则完全不发传输 |

新增真实浏览器回归：`src/test/modal.browser.test.ts` 断言删除框初始焦点非危险按钮、Enter 不删除；剪贴板框初始焦点非 Allow、Enter 不放行。

### 2. 失败与中断后的恢复路径

| 问题 | 证据（修改前） | 处理 |
|---|---|---|
| Filer 列表失败与空目录都只是灰字，没有重试；离线时只提示，无法就地重连 | `FilerPanel.tsx` 两行 `.panel-empty` | 失败态：红字 + `role="alert"` + Retry；离线态：提示 + Reconnect；空目录：`此文件夹为空。`；加载中：`正在加载…` |
| 新建文件名校验失败时输入行先被关闭，用户要重打 | `useFilerActions.ts` 的 `commitNewEntry` 先 `setCreating(null)` | 先校验，只有合法且提交成功才关闭输入行 |
| 连接中的标签：菜单写“断开会话”，点击直接 return；电源键被 disabled，唯一出路是关标签 | `disconnectSession` 的 `state !== "connected"` 早退；`SessionPanel` 的 `disabled` | 引入 `connectAttempts` / `cancelledAttempts`：取消会标记当前尝试、立即关闭已建后端会话，并忽略迟到应答复活；菜单/电源键/浮层文案改为“取消连接” |
| 编辑已保存会话后，重连仍用标签打开时的旧配置（旧主机/旧端口/旧用户名） | `reconnectSession` 直接 `connectSession(id, tab.profile)` | 重连时取 store 中最新的保存配置；仅当保存配置没有密码/口令时保留标签内的临时秘密 |
| FTP/SFTP 连接断开的整页状态没有重连按钮 | `FtpPane.tsx` 的 `ftp-session-state` | 增加 `common.reconnect` 按钮 |
| QuickOpen 无项目或列表失败时永久显示 Loading | `QuickOpen.tsx` 的 `files ? empty : loading` | 失败显示错误 + Retry；无项目时不打开，改为提示先打开项目 |
| 更新下载阶段没有按钮、Esc 也被禁用，用户被锁在模态里 | `UpdateDialog.tsx` / `updater.ts` 的 `dismiss` | 下载阶段提供“隐藏”：下载继续，安装开始时对话框重新出现；明确这不是取消（底层没有 abort 句柄） |
| Filer 多选/文件夹下载直接写目标路径，同名文件/目录会被覆盖 | `useFilerDownloads.ts:42-50` | 目标文件夹先 `localList` 比对；有同名项先 `ask()` 确认，取消则完全不发传输（列目录失败不阻塞） |
| FTP 的新建/重命名/删除用 `window.prompt/confirm`，样式和平台行为不一致 | `useFtpActions.ts:34,47,60,72,85,99` | 新建/重命名复用 `GroupNameDialog`（名称错误内联显示）；删除改用 `ask()` 确认 |
| FTP 拖放同名的文件/目录用 `window.confirm` 询问覆盖/合并，错误提示也是英文 | `useFtpTransfer.ts:72-95` | 改为 `ask()`；覆盖/合并、同名类型冲突、本地符号链接拒绝全部走 `ftp.*` 文案；`mayLand` 改为异步 |

### 3. 布局与操作反馈

| 问题 | 证据（修改前） | 处理 |
|---|---|---|
| 两个侧栏各可拖到 720px；900px 窗口下中心终端会被压到 0，且没有任何提示 | `App.tsx` 的 `clamp(width, 150, 720)`；`.center { min-width: 0 }` | `src/panelSizing.ts`：拖拽时优先满足被拖侧、另一侧退到最小值；保留中心 320px、终端至少 200px；窗口缩小时两侧一起重算 |
| 面板宽度、Sender 展开态每次启动重置 | `App.tsx` 的 `useState(220/220/160/false)` | 持久化到 `edgeterm.panelSizing`，注册进 `persistKeys.ts`；恢复默认设置/导入会重新读取 |
| 状态栏错误无法关闭，会永久盖住正常状态 | `StatusBar.tsx` 只渲染文本 | 错误项加关闭按钮、`role="alert"`/`aria-live`；可点击项补 hover / `aria-expanded` 背景 |
| Sender 标签有 `is-selected` 类但没有任何样式 | `SenderLibrary.tsx:81`，`sender.styles.css` 无对应规则 | 选中标签加 accent 边框与 12% 底色 |

### 4. 默认值与“已有但没用上”的能力

| 项 | 修改前 | 修改后与理由 |
|---|---|---|
| 文件排序 | 默认直接透传后端字节序，`file10` 排在 `file2` 前；项目已实现 numeric collator 却只在用户点列头后才用 | `DEFAULT_FILE_SORT` 带 `explicit`，默认就走自然排序；保留旧存储值的透传分支 |
| Sender 保存范围 | 默认 `global`，在一台主机保存的 `rm -rf` 会出现在所有会话 | 默认 `profile`（当前会话）；仍记住用户显式选择的更宽范围 |
| 恢复默认设置 | 不重置语言；确认文案也没提传输/监控/工作台等实际会被清掉的项 | 重置语言到系统语言并删除存储键；文案如实列出范围 |
| 一次性的 Local Shell 连接 | 每次 Connect 都保存一个名为 `shell` 的新配置 | 新的本地一次性连接不再落盘（显式 Save 仍可保存），避免树里堆重复项 |
| 会话校验 | 只校验 locale 和串口波特率；空主机也能 Connect，先存一个死配置再失败 | 新增 `src/sessionValidation.ts`：远程协议必须有主机、端口 1–65535；有 5 条单测 |

### 5. 视觉与一致性

- **对比度**：四套主题的 `--fg-faint` 分别提到 `#8b9199` / `#6f6f6f` / `#7b8494` / `#6f6f77`，在各自画布上 4.64–5.59:1（`foundation.styles.css:23,109,180,240`）。它被 106 处当正文/提示色使用，之前最低只有 2.18:1。
- **未定义变量**：`.update-notes` 的 `var(--bg)` 改为 `var(--bg-panel-alt)`；`.transfer-job-error` 的 `var(--danger, #e66)` 改为 `var(--red)`。
- **重复 `.wb-count`**：删掉会被覆盖的第一条；保留黄色徽章并把文字固定为深色（原 `var(--bg)` 未定义，实际对比度约 1.28:1）。
- **输入框边界**：Filer 路径、面板筛选、Sender 命令/标签/重复次数在浅色主题下是白底白框（约 1.04:1），统一补 `var(--border)`。
- **空工作区**：`Press Alt+N…` / `New Session` 硬编码英文改为 `t()`；中文下显示“按 Alt+N 新建会话…”。
- **内置 Local Shell**：侧栏行名随界面语言变化（`panel.localShell`），打开后的标签名一致。
- **终端右键菜单**：Copy / Paste / Select All / Clear Buffer / Reveal 改用现有菜单键，中文界面不再夹英文。
- **FTP 双栏完整本地化**：标题、路径 aria、列头、工具按钮、传输按钮、空目录/加载、传输状态、暂停/继续/取消、断线提示、旧式目录列表错误；新增约 30 个 `ftp.*` 键，`en`/`zhCN` 同步。
- **状态枚举**：TransferCenter 的 `job.status`/`job.phase`、ForwardCenter 的 `row.status`、FTP 的 `transferJob.phase` 不再把内部 token 直接显示给用户。
- **数据导入导出**：`dataTransfer.ts` 的对话框标题、扩展名校验、导入确认与详情、成功/失败状态、跳过计数全部改为 `t()`；`describe()` 的英文复数改成按语言取单/复数键。

## 验证结果

- `npm run typecheck`：通过。
- `npm run lint`：308 个文件，仅 `src/bindings.ts` 两条既有的生成代码 `noExplicitAny` 警告。
- `npm test`（`src/` 产品范围）：82 个文件 / **612 用例通过**（本机用 `--pool=threads --maxWorkers=2` 完成）。新增：
  - `src/panelSizing.test.ts`（14 条：拖拽分配、窗口收缩、持久化、损坏值修复）
  - `src/senderScope.test.ts`（5 条：默认范围、显式范围、回退）
  - `src/sessionValidation.test.ts`（5 条：主机、端口、串口、locale）
  - Filer 错误/空目录状态 2 条 + 下载覆盖确认 1 条
  - 导入导出的英文复数与中文确认 2 条
  - 删除/剪贴板确认框浏览器测试 2 条
  - 连接取消、最新配置重连、自然排序等回归
- `npm run test:browser`：11 个文件 / **59 用例通过**（直接 `npx vitest run --project browser`）。
- `npx vite build --outDir .tmp/build-audit --emptyOutDir`：构建通过（仅既有的 >500kB chunk 提示）。

> 说明：本机在 cargo 编译同时跑测试时，vitest worker 启动很慢，`src/zmodem.test.ts` 出现过 15s 超时、浏览器滚动断言偶发一次失败；单独/低并行重跑均通过。这是本机资源竞争，不是断言被放宽。`scripts/*.test.mjs`（3 个文件、29 条）属于当前环境的任务运行器脚手架（未跟踪），与它自己的 `test:rust` 共抢同一个 OS mutex，因此不在产品测试统计内；单独跑全量时它们会通过。

## 仍未修复 / 建议下一步

1. **键盘导航不完整**：菜单栏、会话树、文件列表仍以鼠标为主，没有 roving tabindex / 方向键导航；文件列表只有 Ctrl+A / Esc。属于可达性工程，不是单点修补。
2. **Filer 的“打开方式”列表只能增长**：`edgeterm.filerOpenWith` 最多 6 个，只有“恢复默认设置”能清空，没有单项删除入口。
3. **传输高级设置仍在折叠区**：并发/块大小/durable/tar 放在状态栏 → Transfers → Settings 的 `<details>` 里。默认值（32 请求 / 16 文件 / 128 KiB）已经合理，所以本轮没有改动，只建议把 tar 与 durable 的适用范围写得更靠前。
4. **更新下载只能隐藏、不能真正中止**：`downloadAndInstall` 没有暴露 abort 句柄；本轮保证用户不被困住，但没有假装提供取消。
5. **删除仍无撤销**：文件/会话删除有确认，但确认后不可撤销；要支持撤销需要在后端保留临时副本，属于新能力而不是界面修补。
6. **Sender 重复默认无限次**：`times = 0` 表示直到手动停止，对 keepalive 合理，但普通用户容易误开成死循环；重复入口本身是显式按钮，暂未改默认。

## 临时材料

- 截图与夹具在 `.tmp/audit/`、`.tmp/audit-ui.mjs`，用于本轮核对，未纳入产品代码。
- 本轮未改 Rust 后端，因此未运行 `cargo test`；所有后端行为通过现有前端契约测试覆盖。
