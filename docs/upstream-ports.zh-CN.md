# 上游移植记录

核对日期：2026-10-23（1.0.0..1.0.4）；2026-11-24 追加 1.0.4..1.0.8 一节。本分支共同祖先为上游 `v1.0.0`（`3e6e35738439a078de11abfd315c7160ca6b8ad4`）。本记录覆盖上游 `v1.0.0..v1.0.4` 的 14 个提交：10 个功能/修复提交与 4 个版本提交。上游 HEAD 核对为 `051f94e`，本地审查基线为 `c013923`，公开发行边界为本分支 `v1.2.8 / e3e920a`。

Git 祖先关系仍停留在 1.0.0；选择性移植不等于已 merge 上游 1.0.4。下表根据上游提交、本地 diff、现存代码和测试位置建立对应关系；“适配移植”不表示逐字 cherry-pick，也不代表逐项完成真实桌面/服务器验收。

## 上游 1.0.4..1.0.8（核对日期 2026-11-24）

上游 HEAD 核对为 `00158802`（1.0.8）。区间内 12 个提交：4 个版本提交 + 8 个功能/修复提交。下表逐个记录处置；「已有对应能力」以本分支文件为证，不主张与上游实现逐字相同。

| 上游提交 / 版本 | 本分支处理 | 对应证据 |
| --- | --- | --- |
| [870173a](https://github.com/miskin-lee/EdgeTerm/commit/870173a) · 1.0.5 · 分组右键新建会话 | 已有对应能力 | `src/components/panels/SessionPanel.tsx:608` `panel.newSessionInGroup` → `onNewSession(group)`；`src/sessionDefaults.ts:47` 由分组类型推出会话类型与端口；用例 `src/components/panels/sessionGroupSession.test.ts` |
| [1d68458](https://github.com/miskin-lee/EdgeTerm/commit/1d68458) · 1.0.5 · 移除标签通道重复实现（重构） | 未采纳：上游删掉的共享传输正是本分支在用的能力 | `src-tauri/src/session/ssh/transport.rs:13` `SharedTransport`、`:324` `SshTransports`；`src-tauri/src/session/reuse.rs:71` `ConnectionPool`；端口转发、编辑器、传输引擎都挂在其上；界面入口 `src/actions.ts:377` `duplicateSshChannel` |
| [cd492da](https://github.com/miskin-lee/EdgeTerm/commit/cd492da) · 1.0.5 · 多行命令保留空行 | 已适配移植（更早） | `src/senderUnits.ts:15-25` 与上游同一实现（注释保留 #115）；`src/senderUnits.test.ts` here-document 用例 |
| [f8a2780](https://github.com/miskin-lee/EdgeTerm/commit/f8a2780) · 1.0.6 · 查找框定位到活动窗格 | 已有对应能力 | `src/App.tsx:1104-1110` 把 `SearchOverlay` 作为 `Workspace` 的子节点；`src/components/Workspace.tsx:289-291` `pane-overlay` 跟随活动窗格（并额外跟随最大化窗格） |
| [dbd39c2](https://github.com/miskin-lee/EdgeTerm/commit/dbd39c2) · 1.0.6 · 标签右键保存／复制会话 | 部分已有 → **本轮补齐复制** | 保存：`src/components/TabStrip.tsx:403-408`、`src/storeProfileActions.ts:46` `saveTabProfile`、用例 `src/tabSaveSession.test.ts`。复制此前只有 SSH 通道版本；本轮新增 `duplicateSession`（`src/actions.ts`），标签菜单对非 SSH 标签显示「复制会话」，用例 `src/tabDuplicateSession.test.ts` |
| [a7d0923](https://github.com/miskin-lee/EdgeTerm/commit/a7d0923) · 1.0.6 · 传输按会话隔离、清理停滞进度 | 部分已有 → **本轮补齐面板页脚** | 后端按会话隔离早已存在（`src-tauri/src/file_transfer/manager.rs:65` `session_id`、`sessions.rs:336` `forget`），页脚汇总按会话过滤（`src/components/FilerTransferSummary.tsx:11`）。本轮修正面板底部的传输条：切换会话或连接断开时收起，不再留着指向已断开的 Cancel；用例 `src/components/panels/filerTransferCancel.test.ts` |
| [e0f4ec8](https://github.com/miskin-lee/EdgeTerm/commit/e0f4ec8) · 1.0.7 · 文件列表按名称／大小／修改时间排序 | 已有对应能力（并带持久化） | `src/fileSort.ts:63` `sortFileEntries`、`:26` `toggleFileSort`、`:113` 存取；接线 `src/components/panels/FilerPanel.tsx:38,423`；用例 `src/fileSort.test.ts`、`src/components/panels/filerSort.test.ts` |
| [ef45a21](https://github.com/miskin-lee/EdgeTerm/commit/ef45a21) · 1.0.8 · tmux 控制模式集成 | 未采纳 | 用户明确不用 tmux（第 153 轮指示）；本分支不提供该功能，也不移除既有终端能力 |
| `7568e4e`／`28efdda`／`ece336b`／`051f94e`／`ced1b63`／`83fd059`／`694d26c`／`0015880` | 版本提交 | 不移植：本分支使用独立版本序列（当前 1.7.8），见 AGENTS.md「Published History」 |

区间内 8 个功能/修复提交的处置：4 个已有对应能力、2 个在本轮补齐（标签复制、面板传输条）、1 个（共享传输重构）与本分支架构相反不采纳、1 个（tmux）按用户指示不采纳。

## 功能与修复对应

| 上游提交 / 首次发布 | 本分支处理 | 对应提交与证据 |
| --- | --- | --- |
| [6fc2231](https://github.com/miskin-lee/EdgeTerm/commit/6fc2231) · 1.0.1 · 多选与整组传输 | 适配移植：接入已有统一传输队列 | `600a60c`；`src/fileBatch.test.ts`、`src/components/FtpPane.test.ts`、`src/paneDropWiring.test.ts`；浏览器用例 `src/test/ftpKeyboard.browser.test.ts` |
| [ec9faa7](https://github.com/miskin-lee/EdgeTerm/commit/ec9faa7) · 1.0.1 · 搜索选项与选区内搜索 | 适配移植：以本地 find 引擎替换 search addon，并修复全字匹配/正则边界 | `0aeb229`；`src/terminalFind.test.ts`、`src/terminalSearch.test.ts` |
| [126ae8c](https://github.com/miskin-lee/EdgeTerm/commit/126ae8c) · 1.0.1 · 波特率建议下拉 | 适配移植：使用应用内下拉控件 | `bc4f930`；`src/components/comboBox.test.ts` |
| [65ceb9c](https://github.com/miskin-lee/EdgeTerm/commit/65ceb9c) · 1.0.1 · 拥挤标签栏可读性与滚动 | 适配移植：本地采用逐标签步进按钮，保留自身布局 | `1f85d69`；`src/components/TabBar.tsx`。未在此索引中补造独立回归通过记录 |
| [a5bb692](https://github.com/miskin-lee/EdgeTerm/commit/a5bb692) · 1.0.2 · 断线 Enter 重连 | 已有对应能力，未重复搬运 | `e6df914` 实现，`f375549` 补实际 action 接线测试；`src/reconnect.test.ts`。不主张与上游全部实现细节等同 |
| [376df7d](https://github.com/miskin-lee/EdgeTerm/commit/376df7d) · 1.0.3 · Filer 大小列 | 已有对应能力，保留本地大小/日期列体系 | `3ed5b96` 引入列，`922b2ab` 改进列展示，`6633288` 加拖宽；`src/components/panels/FilerPanel.tsx`、`filerPresentation.tsx` |
| [92c87f6](https://github.com/miskin-lee/EdgeTerm/commit/92c87f6) · 1.0.3 · 输入名称跳转 | 适配移植：本地文件列表与双栏列表接入 | `62334d6`；`src/fileTypeSelect.test.ts` |
| [b731d45](https://github.com/miskin-lee/EdgeTerm/commit/b731d45) · 1.0.3 · Sender 标签颜色与右键选项 | 适配移植：八色标签及本地主题/导出数据 | `07f6026`；`src/senderColors.test.ts`、`src/themes.test.ts`、`src-tauri/src/tests.rs` |
| [866c3fb](https://github.com/miskin-lee/EdgeTerm/commit/866c3fb) · 1.0.4 · 移除状态栏 | 未移植，保留本分支现状 | 本分支状态栏仍承载传输、资源与转发入口，见 `src/components/StatusBar.tsx`。本次只记录差异，不改变产品布局 |
| [4ed8be2](https://github.com/miskin-lee/EdgeTerm/commit/4ed8be2) · 1.0.4 · Sender 续行与设备提示符 | 适配移植：保留原 shell 词汇并增加输入提示符判定 | `544572f`；`src/terminalPrompt.ts`、`src/terminalActivity.test.ts` |

公共文案为 `941178d`，移植后的 README 说明为 `0084461`，本分支版本提交为 `ffb1569`；最终公开的 1.2.8 标签落在后续测试脚本修正 `e3e920a`，不能把版本提交误当成发布的最终 SHA。

## 上游版本提交

| 上游版本 | 版本提交 | 处理 |
| --- | --- | --- |
| 1.0.1 | `7568e4e` | 仅作为来源范围，不覆盖本分支版本 |
| 1.0.2 | `28efdda` | 同上 |
| 1.0.3 | `ece336b` | 同上 |
| 1.0.4 | `051f94e` | 同上 |

本地存在上游标签不代表本仓库发行过这些包，也不代表它们是本分支自动更新通道。

## 验证证据与后续同步

[本分支 1.2.8 发布说明](https://github.com/sonwe1e/EdgeTerm/releases/tag/v1.2.8)记载了前端、浏览器、Rust 与移植提交检查结果，同时保留真实 WebView2 与真实 FTP/SFTP 批量传输尚待手动验证的边界。本次建立索引没有重新运行那套历史验收，表内测试路径是可核查入口，不是本次通过声明。

后续同步先更新上游参照，检查每个提交的语义和依赖，再选择直接移植、适配、已有能力或暂不采用。直接 cherry-pick 用 `-x` 保留来源；适配实现的提交 body 用 `Upstream: <仓库 URL / 完整 SHA>` 写明来源与差异，并同步此表。不要自动接收上游版本号、更新公钥、下载源或功能删除，也不要用空合并伪造“全部上游改动已接受”。
## 2026-11-16 复核：v1.0.5–v1.0.7

核对方式：先用 `git ls-remote upstream` 确认上游 `main` 已到 `694d26c`，再 `git fetch upstream` 把本地 `upstream/main` 从 `ced1b63`（1.0.5）更新到该提交。范围 `051f94e..694d26c` 共 10 个提交：7 个功能/修复加 3 个版本提交。当日的核对只记录处置；处置在本分支 `codex/upstream-ports-20261116` 上执行，逐条提交如下。

| 上游提交 / 首次发布 | 内容 | 本分支处置 | 对应提交与证据 |
| --- | --- | --- | --- |
| [870173a](https://github.com/miskin-lee/EdgeTerm/commit/870173a) · 1.0.5 · 分组右键新建会话 | 分组菜单加“新建会话”，按分组类型预填 kind、端口和分组 id | 适配移植 | `9ec6096`；`src/components/panels/sessionGroupSession.test.ts`（预填映射与菜单回调）。本地补了 `initialGroup` 与 `newSessionProfile`，文案走 `t()`；上游硬编码英文未照搬 |
| [1d68458](https://github.com/miskin-lee/EdgeTerm/commit/1d68458) · 1.0.5 · 移除 tab 通道复用 | 删除 `reuseSessionId` 与 Duplicate SSH Channel，后端去掉 tab 通道复用 | 不采用 | 本分支保留该能力（`src/actions.ts` 的 `duplicateSshChannel`、`src/components/TabStrip.tsx` 菜单项），MFA 服务器只需输入一次验证码。上游属功能删除，不是改进 |
| [cd492da](https://github.com/miskin-lee/EdgeTerm/commit/cd492da) · 1.0.5 · Sender 保留空行 | `splitLines` 保留空行与纯空白行，尾换行视为行终止符；`firstLine` 取首个非空行 | 直接移植（`cherry-pick -x`） | `15f693d`；`src/senderUnits.test.ts`（5 例，含 #115 的 heredoc 空回答）。仅补了本地格式 |
| [f8a2780](https://github.com/miskin-lee/EdgeTerm/commit/f8a2780) · 1.0.6 · 查找框跟随活动窗格 | `Workspace` 加活动窗格的 `pane-overlay` 承载查找框，并允许换行、按窗格宽度收缩 | 适配移植 | `0a0be5b`；`src/components/Workspace.test.ts`（overlay 落在活动窗格矩形内、随焦点移动）。本地查找框更大，补了换行与窄窗格收缩 |
| [dbd39c2](https://github.com/miskin-lee/EdgeTerm/commit/dbd39c2) · 1.0.6 · 标签右键保存/复制会话 | 新增 Save Session…（把标签连接设置存成 profile 并重绑，不重连）与 Duplicate Session（新连接） | 部分适配：只取 Save Session… | `659cf0f`；`src/tabSaveSession.test.ts`。Duplicate Session 不搬：本分支的 `duplicateSshChannel` 是同一连接再开通道，语义不同（上游反而在 1d68458 删掉了它） |
| [a7d0923](https://github.com/miskin-lee/EdgeTerm/commit/a7d0923) · 1.0.6 · Filer 传输按会话隔离 | 传输、忙、错误状态移入 `src/filerActivity.ts`，按会话 id 或 `""` 分桶；取消立即撤 UI；旧目录请求不能结束新请求的忙碌态 | 已有对应能力，借“取消立即撤 UI” | 本地 `src/fileTransfers.ts` 已是带 `sessionId` 的队列，`FilerTransferSummary` 按会话汇总，另有重试。借语义的提交 `99c9a97`；`src/components/panels/filerTransferCancel.test.ts`。逐会话状态跨挂载存活未移植，仍是本地面板内的 hook 状态 |
| [e0f4ec8](https://github.com/miskin-lee/EdgeTerm/commit/e0f4ec8) · 1.0.7 · Filer 按名称/大小/修改时间排序 | 新增 `src/fileSort.ts`、列标题按钮、右键 Sort by、工具栏按钮 | 已有对应能力，借“等值按名称 tie-break” | 本分支 `src/fileSort.ts` 早已存在（`6f723c8`），排序存进 store 持久化。借语义的提交 `81202a2`；`src/fileSort.test.ts`。默认方向（上游元数据键降序）未采用 |
| 版本提交 `ced1b63` / `83fd059` / `694d26c` | 1.0.5 / 1.0.6 / 1.0.7 版本号 | 不采纳 | 本分支使用独立版本序列，不接收上游版本号 |

结论：7 个功能/修复提交里，4 项已落地——`cd492da`（空行与 heredoc，直接移植）、`f8a2780`（查找框定位）、`870173a`（分组新建会话）、`dbd39c2` 的 Save Session… 部分。`a7d0923` 与 `e0f4ec8` 的能力本分支已有，各借了一条语义（取消即时反馈、等值 tie-break）。`1d68458` 是功能删除，没有搬运；`dbd39c2` 的 Duplicate Session 与上游的版本提交同样未采纳。

性能方面，这批提交没有可测量的改进：排序本分支已用 `useMemo` 并复用 `Intl.Collator`，`a7d0923` 只是把组件状态外提，`1d68458` 的后端瘦身伴随功能删除。借来的两条都是体验修正，不是性能优化。

验证边界：上述提交各自跑过 `npm run typecheck`、`npm run format`、`npm run lint` 与对应 Vitest 文件；完整 `npm test` 与提交检查见本次分支最终校验。浏览器侧新增 `src/test/findBox.browser.test.ts`（查找框落在活动窗格、随焦点移动）并通过，签名改动的 `tabActivity.browser.test.ts` 也重跑通过；其余浏览器用例未运行。真实桌面与真实服务器交互未验证。

## 2026-11-24 复核：v1.0.8 与上游开放 PR #2

核对方式：`git fetch upstream` 后本地 `upstream/main` 为 `0015880`（1.0.8）；`git rev-list --left-right --count HEAD...upstream/main` 为 **743 领先 / 26 落后**，本轮只处理此前未记录的 1.0.8 与上游开放 PR。

### v1.0.8 的 1 个功能提交

| 上游提交 | 内容 | 本分支处置 |
| --- | --- | --- |
| [ef45a21](https://github.com/miskin-lee/EdgeTerm/commit/ef45a21) · 1.0.8 · tmux control-mode（`tmux -CC`） | 新增 `src/tmux.ts`（545 行）、`src/tmuxClient.ts`（162）、`src/tmuxProtocol.ts`（195）、`src/components/TmuxWorkspace.tsx`（249）、样式 121 行，并改动 `TerminalPane.tsx`、`actions.ts`、`terminal.ts` 等共 18 个文件；`package.json` 只新增 devDependency `@types/node` | **暂不采用，待评估**：这是一整套子系统，不是补丁。可借鉴的部分已经查清：`tmuxProtocol.ts`／`tmuxClient.ts` 与终端层解耦（客户端只接收 send/output/notify 回调），协议模块无运行时依赖；但 `TmuxWorkspace` 与上游的 `TerminalPane`／样式强耦合，本分支这些文件已大幅分化。真正移植需要先定窗口/窗格与本地标签体系的关系 |
| 版本提交 `0015880` | 1.0.8 版本号 | 不采纳：本分支使用独立版本序列 |

26 个落后提交中，1.0.1–1.0.7 的处置见上文两节；本轮没有发现漏记的提交。

### 上游开放 PR #2（SSH config import with ProxyJump）

事实：`gh pr list -R miskin-lee/EdgeTerm` 只有这一个开放 PR；`gh pr list -R sonwe1e/EdgeTerm` 返回 `[]`——**本仓库没有待合入的 PR**。该 PR 的 head 基于上游 0.3.2 时代（`git rev-list --left-right --count HEAD...pr/upstream-2` 为 **744 领先 / 46 落后**），改动 1072 行。

对照本分支现状，它的主张大多已存在：

| PR 主张 | 本分支现状 |
| --- | --- |
| 解析 `~/.ssh/config`（Host/HostName/Port/User/IdentityFile、通配符、`!` 取反、`Include`、首匹配优先） | 已有：`src-tauri/src/ssh_config.rs`（880 行）+ `tests.rs` 中通配符、取反、`Include`、`%h` 展开、无 HostName 的别名等用例 |
| 批量导入、逐项选择、跳过重复 | 已有：`src/components/SshConfigImportDialog.tsx`（287 行）带全选与逐项勾选 |
| ProxyJump | 已有单跳：`SessionProfile.jumpProfileId` → 已保存的 SSH 会话；后端 `connect_handle` 的 `jumps: &[SessionProfile]` **本来就支持多跳链**（逐跳 `direct-tcpip`，每跳独立校验主机密钥） |

结论：**不合并该 PR**。它的全部价值在于两个本分支尚缺的点——多跳 `ProxyJump a,b,c` 的**界面与数据模型**（后端已就绪，`jumpProfileId` 仍是单值）与 `HostKeyAlias`。为这两点去合入一条落后 744 个提交、重写 1072 行的分支不划算；按上面的方向在本地实现更稳，也更符合本仓库的移植规则。

验证边界：本轮只做只读核对与记录，没有运行构建或测试，也没有合并任何提交；上一轮 `npm run verify` 的结果不能当作本节的证据。

### 2026-11-24 补记：多跳跳板已在本分支实现

上文把「多跳 `ProxyJump` 的界面与数据模型」列为 PR #2 的价值点。本分支没有合入该 PR，而是按自己的设计实现：链存在会话自身（`jumpProfileIds`，第一跳在前），导入按 `ProxyJump` 顺序写入且不改动其他会话，对话框以编号列表编辑；旧的单值字段只读兼容并在保存前折叠。证据见 `docs/team/multi-hop-jump-chain-20261124.md` 与提交 `dcefe9f`。`HostKeyAlias` 仍未支持。
