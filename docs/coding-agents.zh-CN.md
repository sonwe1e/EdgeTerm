# Coding Agent 使用与开发记录

本页记录以 `dfc7b98` 为基线的开发改动与验收，当前功能纳入 1.7.0。
下文带日期的 1.6.2 工作区产物是发布前开发证据，正式版本见[发布索引](releases.zh-CN.md)。

## 使用入口

终端标签栏右侧的 **Agent 提示词** 一键展开 Sender 中的输入区，可以边看终端边写。
Enter 换行，Ctrl+Enter 整段放入当前终端；草稿按终端保留，命令模式的草稿也不受切换影响。
识别到 agent 后在提示词入口旁显示工具名。历史与恢复交给各 agent 自己的命令与界面。
Sender 的收起工具条与命令模式中也提供 Agent 入口。状态栏 **Coding Agent** 保留完整工具界面。
界面复用现有紧凑表单和主题变量，900×560 下内容区滚动，599/600/601px 也保留操作入口。

## 输入、文件与快捷键

提示词保留段落、空行和缩进，经 xterm bracketed paste 整段放入，不追加 Enter。
接收程序必须启用该模式；锁定、连接代次不符、传输占用输入或控制字符均阻止发送。
用户检查当前输入区后在终端提交；终端本身不能确定程序正处于 prompt、搜索框还是授权框。
关闭面板保留该终端的内存草稿，放入成功后清空；Sender 的逐行命令与重复发送语义不变。

“加入终端选区”引用所选终端的文字，追加到提示词草稿，已有内容与引用之间保留空行。
xterm 会在展开 Sender 导致尺寸变化、全屏程序重绘时清除可见选区；现在按终端连接保存选中文字快照。
重新在终端点击／选取、显式清除选择或断线时丢弃快照，不从其他终端或系统剪贴板取内容。
没有选区时显示操作提示；程序接管鼠标时可按住 Shift 拖选。快照仅存内存，上限 1 Mi 字符。
这个操作不会向 agent 发送输入。“放入终端输入区”才会粘贴完整草稿，仍不自动提交。

普通拖选被全屏程序接管时，也记录拖过的屏幕文字；不读取剪贴板、不模拟复制快捷键，
不拦截程序的点击和拖动。引用的是可见文字，不能还原 Markdown 源码或未显示的内容。
拖选过程中选中行的文字、终端尺寸或滚动位置变化时放弃这次引用，避免加入错误内容。
Shift 产生的终端选区会保留高亮，移向按钮时不再因全鼠标移动上报而被清除。

发送面板统一显示“命令 / Agent 提示词”两种模式；折叠栏的“新建”明确为“新建命令”，
包括编辑已保存命令在内的命令入口会切回命令模式。两个草稿分别保留。
加入选区、文件引用和放入终端后的清空使用浏览器编辑事务，支持草稿框中的 Ctrl+Z、
Ctrl+Shift+Z / Ctrl+Y；切换终端会建立独立输入控件，避免撤销带出另一个终端的内容。

可选择文件／图片作为路径引用。SSH 下先上传到项目的
`.edgeterm-attachments/<随机标识>-<文件名>`，成功且目标仍有效后才加入远端引用。
上传可在传输中心查看，文件留在远端；失败不会插入失效路径。
这里提供文件路径上下文，图片二进制嵌入仍使用 agent 自身的附件操作。

可选 Ctrl+Tab 透传使用 CSI-u，将 Ctrl+Tab / Ctrl+Shift+Tab 交给当前终端。
识别到交互 agent 时，Alt+方向键不再套用 Shell 的单词跳转转换。
断线或已识别 agent 结束后，Ctrl+Tab 透传自动清除。

## 兼容诊断与退出回放

检查只运行固定的 `pi --version` 或 `opencode --version`，显示安装入口、版本与配置来源。
本地使用应用进程 PATH；SSH 使用已有认证连接上的独立有界 exec 通道，其环境可能不同于交互 Shell。
诊断还显示屏幕、鼠标模式、历史行数、收到的字节与解析等待；解析等待不等于滚轮到画面的延迟。

Pi 1.4.0 默认在 fullscreen 退出时输出完整 transcript。诊断分别读取 agent 目录和项目的
`.pi/settings.json`，可对已读文件设置 `fullscreenExitOutput: resume-hint`，保留其他配置并检查 expected hash。
保存后在 Pi 执行 `/reload` 或重启；项目配置优先。读不到文件时显示未知。
全局文件已有设置不能证明运行中实例、另一项目或远端已经生效。
本轮没有修改第三方 bundle，也没有丢弃终端原始输出或改变清屏保留契约。

1.7.3 本地构建补充 Pi 全屏滚轮兼容：缺少鼠标上报时使用 PageUp/PageDown 翻历史，
防止滚轮退化成方向键而切换输入历史；同时补识别延迟到达的 SSH 启动命令回显。
正常鼠标报告、实际方向键和 Pi 普通屏幕滚动保持原行为。
已用真实 Pi 1.5.0 / 本机 SSH 验证人工注入鼠标模式丢失时草稿保持不变，
具体范围见[终端输入修复](terminal-input-fixes.zh-CN.md#2026-11-05ssh-pi-滚轮误切换输入历史)。
该修复也纳入正式发布的 1.7.2，与此前的 1.7.2 本地安装包内容不同。

## 2026-11-04 功能收窄

按用户反馈，删除 Agent 历史和恢复页面、标签栏入口、恢复卡片／命令生成、历史解析及
`coding_agent_request` 后端 HTTP 请求接口，移除相应测试与专属样式。
旧 `edgeterm.agents` 存储键只保留在导出／重置清理清单中，没有运行中的读取或写入。
输入页不再显示 Pi／OpenCode 工具选择器，提示词和文件引用不限制 agent 品牌；
工具选择只在既有兼容诊断里出现。Pi 退出回放诊断保留。

### 交互验证

新浏览器回归先在旧实现失败：真实鼠标拖选全屏终端文字，展开就地输入面板，点击加入选区后草稿仍为空。
修复后覆盖展开面板、TUI Shift 拖选、中文多行缩进、重绘、重新点击取消、重连以及终端之间的隔离。
现有整段粘贴、Ctrl+Enter、草稿保留、远端附件先上传后引用和兼容诊断继续回归。
使用真实 Edge／xterm、模拟 IPC，不调用模型，不读取用户会话，不证明真实 Codex 或 SSH 工作负载已验收。

本轮结果：Agent 与选区编辑浏览器回归 14 项、相关单元测试 147 项通过；Rust IPC 专项
1 项通过、1 项需专用 SSH 环境而跳过。TypeScript、前端生产构建、Windows release 构建、
本轮文件 Biome 格式、Rust 格式及 `git diff --check` 通过；lint 保留生成绑定的 2 条既有 any 警告。
Rust 绑定已重新生成，覆盖 98/103 个命令及 5 个事件。
截图见 `artifacts/usability/agents-selection-after.png`、`agents-inline-900x560-zh.png`；
旧实现失败截图位于浏览器测试的 `__screenshots__` 忽略目录。

本轮可运行产物：`artifacts/coding-agents-1.6.2-dfc7b98-working/EdgeTerm-agent-input.exe`。
从菜单退出旧程序后运行，沿用相邻 `data/`；旧 EXE 保留。仍是未发布的 1.6.2 基线工作区构建，
完整 SHA-256、来源及源文件哈希清单见相邻 `agent-input-build-info.json`、`agent-input-source-manifest.json`。
随后补充了下面的原生选区验收；其他原生交互仍沿用上述验证边界。

### 原生选区验收（2026-11-04 23:03）

在相同产品代码、独立应用标识 `com.edgeterm.selectiontest` 的 Windows release 实例中，
使用空便携配置、真实 WebView2 156／ConPTY、canvas 渲染器，1441×901 CSS 像素、DPR 1.75。
独立标识用于避开用户正在运行的程序的单实例限制；未修改用户会话或配置，测试后已关闭测试实例。
`scripts/check-native-agent-selection.mjs` 使用 Playwright 鼠标拖选和按钮点击，4 项通过：

- 先选中文字，再展开输入面板，选中文字正常加入草稿。
- 输入面板已展开时再次选择，文字追加到原草稿，段落分隔保留。
- 全屏程序接管鼠标后 Shift 拖选中文多行，重绘之后仍引用原文字并保留缩进。
- 完整 Coding Agent 对话框中的加入选区按钮正常引用文字。

每项都核对真实子进程收到的输入字节，引用操作没有向 PTY 写入；无页面异常。
测试使用生成的文字与全屏模式，不调用模型、不读取真实 Codex 会话，不代表实测物理鼠标或 SSH。
记录：`.tmp/records/native-agent-selection-20261104-230306/evidence/result.json`，
同目录 `1-quoted.png` 至 `4-modal-quoted.png` 保留截图。
测试 EXE SHA-256：`9541BA8DEE56853EAA7D392407C75B04BC5B1CC04DA778CE6D37BBF88F6917B5`；
已交付的 `EdgeTerm-agent-input.exe` 保持原文件，没有替换为测试标识构建。

### Codex 实机复测与撤销修复（2026-11-05 00:02）

用户反馈后补上真实 Codex 0.166.0：旧测试只有生成的终端输出，未覆盖 Codex 自己绘制的
鼠标选区，以及全鼠标移动上报导致 Shift 高亮消失的路径。另确认草稿直接赋值会失去
原生撤销记录，折叠后“新建”没有切回命令模式。对应浏览器回归均先在修复前失败。

旧 Windows 构建在真实 Codex 中普通拖选后引用为空；证据在
`.tmp/records/native-agent-selection-20261104-235318/evidence/result.json`。
修复后，`scripts/check-native-codex-selection.mjs` 在独立便携 WebView2/ConPTY 实例验收 6 项：
普通拖选引用、Shift 拖选引用、鼠标移开后选中行像素一致、引用撤销、重做、新建命令进入正确输入框。
全部通过，截图已检查。Codex 使用独立临时配置、回环地址的固定 Responses 文本；
没有真实模型请求、工具执行或访问用户会话；测试关闭 Codex 的自动复制以避免改动系统剪贴板。

修复版记录：`.tmp/records/native-agent-selection-20261105-000228/evidence/result.json`。
测试标识 EXE SHA-256：`0664F8A6FB1E152567B695F73DB0052CD45B833B40859D9CC7221A819560FCD9`。
本轮另有 19 项浏览器交互回归、60 项相关单元测试通过；TypeScript、生产构建、
所改文件格式与 lint 通过，lint 仍有生成绑定的 2 条既有警告。其他 Agent 的具体版本、
SSH、跨屏滚动拖选和平台未据此宣称实测通过。

交付文件为 `artifacts/coding-agents-1.6.2-dfc7b98-working/EdgeTerm-agent-selection.exe`，
使用标准应用标识，来源、完整哈希与源文件清单见相邻 `agent-selection-build-info.json`。
从菜单退出旧 EdgeTerm 后启动此文件，沿用旁边的 `data/`；仅关闭到托盘会使新文件激活旧实例。

### OpenCode 空闲状态与标签动画（2026-11-05）

用户报告 SSH 中的 OpenCode 2.2.5 没有任务，但 EdgeTerm 标签栏流动条仍运动。
基线 `99b0adb` 在任何 Agent 输入后，都会用后续收到的字节延长活动区间；
持续重绘可以让区间一直保持运行。该基线没有处理 Agent 自己发送的状态信号。

首次修复在已识别的 Agent 会话中接入 OSC 7501。核对的
[OpenCode 2.2.5 实现](https://github.com/anomalyco/opencode/blob/v2.2.5/packages/tui/src/context/program-status.ts)
会报告根状态与各任务状态；没有待处理任务时发送 `idle`。
通过现有本地／SSH 终端字节通道处理这些报告，无需远端插件或额外监听端口。

收到有效报告后，状态优先于输入／输出推断：`working` 在无输出时仍保持运行；
`idle` 停止动画；`blocked`、`done`、`error` 使用现有“需关注”提示，不宣称任务成功。
输入草稿、鼠标与持续重绘不再改变明确状态。子任务独立记录、按层级清除，
有其他运行任务时不因单个任务清除而停止；重复状态不重复通知。
退出 Agent、断线与终端完整重置清除状态跟踪。记录数量和单次报告大小有界，
不保存或展示协议中的标题／消息；格式错误的报告不覆盖已有状态。
没有有效报告的旧工具仍使用原来的活动推断。

验证：新增 5 条用例先在旧实现失败，包括空闲报告后仍运行、没有本地输入时的运行报告、
等待授权、子任务清除与能力查询。修复后相关单元测试 6 文件／132 项、
真实 Edge 浏览器 2 文件／20 项通过；类型检查、修改文件格式／lint、前端生产构建及
`git diff --check` 通过。浏览器用真实 xterm、生产状态回调与标签 CSS，
覆盖本地及模拟 SSH 的运行→空闲、空闲持续重绘和切回标签。
截图：`artifacts/usability/opencode-ssh-working.png`、`opencode-ssh-idle.png`，
以及同名 `local` 版本。没有连接用户 SSH 主机或调用模型，尚未实测用户会话，
其后按用户要求生成 1.7.1 Windows x64 独立 EXE，来源、校验和与构建边界见
[本地构建记录](releases.zh-CN.md#171-本地构建记录未发布)，未发布 GitHub Release。

后续用户反馈直接在 SSH 运行仍然异常。发现首次修复依赖 Enter 时已回显完整命令：
远端回显晚到时，`opencode` 被记作普通长命令，OSC 能力查询和状态报告都被忽略。
现改为在可用终端中独立处理协议，通过有效报告的 `app=opencode` 补识别；
首次 `idle` 必须清除之前的普通命令运行态。退出返回 shell 后解除 Agent 跟踪，
即使退出没有发送 `state=clear`，后续普通命令也正常计时。

三条新增回归先在第一次修复上失败，覆盖回显晚于 Enter、未观察启动命令以及提前能力查询。
补充退出、一般程序与无效标识后，相关单元测试 6 文件／140 项通过。
2026-11-05 使用官方 OpenCode 2.2.5 Linux x64、WSL OpenSSH、独立应用标识的 Windows
release/WebView2 和专用测试账号，给 SSH 下行增加 200 ms 延迟：旧实现收到真实
`state=idle:app=opencode` 时仍显示“命令运行中”，修复版显示空闲；草稿输入维持空闲，
退出后 `sleep 2` 正常开始及结束。没有调用模型或连接用户远端主机。
真实 TUI 的工作／授权／多任务状态仍由协议回归覆盖，未执行真实模型任务。
原始证据在 `.tmp/opencode-ssh-repro/baseline-run-20261105-142034/evidence/` 与
`candidate-run-20261105-142256/evidence/`，包含结果、独立终端录制与截图。
测试版只覆盖应用标识以避开已运行实例；交付安装器恢复正常标识。

### 状态与通信路线（此前分析，除上述终端状态接入外未实现）

没有明确状态的会话仍由 `TerminalCommands` 把输入后的 2 秒输出静默显示为“需关注”，这是活动推断。
网络等待、授权等待和工具执行都可能静默；“本轮已结束”也不代表用户的任务已正确完成。
优先目标应是统一展示：运行中、等待授权／输入、本轮结束、失败／中断、状态未知；
每个状态携带来源（明确事件／活动推断）与时间。未经确认的静默只提示查看。

2026-11-04 核对的官方接口：

| 工具 | 可用路线 | 边界 |
| --- | --- | --- |
| Codex | 先用 [notify](https://learn.chatgpt.com/docs/config-file/config-advanced#notifications) 的 agent-turn-complete；更多生命周期可检查 [Hooks](https://learn.chatgpt.com/docs/hooks)，托管会话可用 [App Server](https://learn.chatgpt.com/docs/app-server) | notify 当前只提供轮次完成；App Server 的结束包含 completed、interrupted、failed；需要关联到实际终端会话，不能启动另一个服务就认为接管了现有 TUI |
| Claude Code | [Hooks](https://code.claude.com/docs/en/hooks#stop) 的 Stop、StopFailure、授权通知 | Stop 需结合后台任务与继续运行机制；选定版本实测 |
| OpenCode | [插件事件](https://opencode.ai/docs/plugins/) 的 session.status、session.idle、session.error、permission.asked | 按实际版本和会话身份归一化，不以可访问端口判断绑定成功 |
| Pi | [扩展事件](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md) | 当前主分支区分 agent_end 和 agent_settled，前者可能仍有重试／队列；必须检查已安装版本的能力 |

推荐保留用户的 TUI 工作方式，通过薄桥接把事件转成 EdgeTerm 的同一数据结构。
事件包含工具、主机、终端连接代次、agent 会话 ID、轮次 ID、状态、序号、时间；不能仅用目录匹配。
本地可用回环服务或命名管道，SSH 后续走认证隧道；凭据按实例绑定，去重并拒绝旧连接事件。
没有桥接的 agent 继续提供终端和输入功能，状态明确显示为推断／未知。
这仍需要少量工具适配，但远小于重做每个工具的历史、恢复与聊天界面。
终端的 BEL／OSC 通知也可作为低成本“需关注”入口，但缺少结构化身份与结束原因，
不应单凭一声铃响认定任务成功。Codex 原生 notify 足够先试验完成提醒，完整状态再逐步补充。

Agent 间通信可以分三步：

1. 人工转交：选 A 的结果，选择 B，把内容放进 B 的草稿，用户确认提交。主要是目标选择与来源标记，风险和工作量最低。
2. 共享消息箱：独立 broker 保存消息，提供 send／receive／ack；支持 MCP 的工具可通过同一组工具访问。
   [MCP](https://modelcontextprotocol.io/docs/learn/architecture) 提供上下文和工具调用协议；消息协议、路由、自动唤醒、忙时排队仍需实现。
   消息应带发送者、接收者、任务 ID、消息 ID、引用结果与回执；原文作为外部上下文，不能隐式提升为系统指令。
3. 自动协作：驱动 B 开始处理、把结果发回 A，并处理取消、超时、循环、预算、授权与并发改文件。
   优先使用明确的 prompt/RPC 接口；不靠模拟 Enter 向未知 TUI 输入位置灌文本。

[ACP](https://agentclientprotocol.com/protocol/v1/prompt-turn) 可统一客户端到 agent 的 prompt、流式进度、授权与结束原因，
适合未来“由 EdgeTerm 启动并管理”的会话；它不是让所有现有终端内 agent 自动互联的协议，支持程度需逐一验证。
不同 agent 应使用独立 worktree 或明确的文件所有权，避免同时覆盖同一目录。

以下只是工程估计，按一名熟悉本仓库的开发者、Windows 本地和固定工具版本计算，未实测排期：

| 阶段 | 估计 | 应先验收的结果 |
| --- | --- | --- |
| 一个 agent 的真实状态桥接 | 2–4 个工作日 | 完成、错误、取消、授权等待与标签切换不会串会话 |
| 四个工具及状态 UI | 合计约 1–2 周 | 统一提醒、来源可见、不会把静默误报为完成 |
| 人工跨 agent 转交 | 1–3 个工作日 | 明确目标、可检查草稿、只向目标提交 |
| 消息箱与两种工具的半自动往返 | 额外约 1–2 周 | 回执、去重、离线／忙时排队、取消 |
| 自动分工、共享代码协作及 SSH 多机 | 数周至数月 | 需要独立需求和试点，不能由“能发消息”推断已完成 |

建议下一阶段先验证一个 agent 的可靠状态通知，再扩到其他工具。通信先用人工转交试验，
实际证明减少了来回复制的成本后，再决定是否投入自动协作。当前未修改任何用户 agent 配置或安装桥接。

## 滚动路径的受控测量

本轮限制建立超长逻辑行时的历史扫描；超预算时保留原文与 ANSI 样式，跳过该段自动语义着色。
普通短行和后续 IP 着色仍有回归保护。

2026-11-04：Windows 11 26300、Edge 156.0.4314.58、受管 4 CPU、Vite 开发模式、真实 xterm 80×24、
1 万行历史、80 万个无换行字符。没有挂载绘制器、PTY 或 SSH。
按基线／候选／候选／基线顺序，各预热 2 次、记录 5 次视口刷新：

| 构建 | 每次历史行读取数 | 10 个样本耗时中位数 |
| --- | ---: | ---: |
| `dfc7b98` | 19,999 | 1.45 ms |
| 本轮候选 | 2,496 | 0.30 ms |

原始数据：本机忽略目录 `.tmp/records/agents-20261104/semantic-cost.json`，含候选源码 SHA-256。
这是特定着色路径的成本对照，不能推导为真实 agent／SSH 的滚动提速比例。
列宽变化时的全历史时间戳重建、多后台解析竞争仍需各自定位。

复测时设置 `EDGETERM_AGENT_BASE=dfc7b98`，使用新的结果路径：

```powershell
./dev.ps1 script scripts/measure-agent-scroll.mjs .tmp/records/agents-new/semantic-cost.json
```

## 早期版本验证记录（包含现已删除的功能）

- CLI 识别的 6 条新增正例和长折行用例先在旧实现失败，修改后通过。
- 单元检查：114 文件／1064 项；两条既有环境测试在沙箱内受限，获准后在沙箱外重跑通过。
- 真实 Edge 浏览器：全量 30 文件／144 项通过；最后补充草稿和 Alt+方向键检查后，Agent 专项 8 项再次通过。覆盖输入、快捷键、配置、分页、上传顺序、过期响应和响应布局。
- Rust：455 项通过、28 项按条件跳过，包含真实 Tauri MockRuntime → IPC → loopback HTTP 和 chunked body 验证。
- UI 图在本机忽略目录 `artifacts/usability/agents-*.png`，覆盖中英文、明暗主题及最小桌面尺寸。

验证没有调用模型、访问用户对话或连接用户 SSH 主机。真实 OpenCode 服务的版本组合、真实 SSH 工作负载、
WebView2 内键鼠、模型流式输出和已有用户安装升级仍需部署环境验收。

## 早期本机开发产物（不含本轮收窄与选区修复）

2026-11-04 入口与输入体验调整：新增就地编辑、Ctrl+Enter、直接历史／恢复入口。
调整后全量浏览器 30 文件／147 项通过；随后修正最小窗口下输入按钮被裁切，专项 15 项通过。
截图：`artifacts/usability/agents-inline-1100.png`、`agents-inline-900x560-zh.png`。
入口调整版为同目录的 `EdgeTerm-agent-ui.exe`，请从菜单退出旧程序后运行。它沿用相邻 `data/` 的配置；
构建来源和校验和见 `agent-ui-build-info.json`。

`artifacts/coding-agents-1.6.2-dfc7b98-working/EdgeTerm.exe` 是本轮 Windows x64 release 构建，
相邻空 `data/` 启用独立便携配置。`build-info.json` 记录基线、工作区标记与 SHA-256，未发布新版。
可执行文件 SHA-256：`ADB1BE1055DB4BABBF4967AF219AE5EBB32018C8E0DB454ABEA9FE47624C4BB0`。
