# 长代码维护性检查与文件比较改进（2026-10-16）

基线：`f5a1fc2`。功能与职责拆分已提交在 `codex/edgeterm-flow181-improvements` 分支。
下文第 4～6 节保留各阶段的验证记录；最终拆分与验收状态见第 7 节。按照
[工程规范](engineering-standards.zh-CN.md)检查当前源码，不以历史改造说明代替证据。

## 1. 哪些代码最难定位和修改

下表行数来自基线文件，包含注释和文件内测试，去除末尾空行。行数用于筛选，优先级结合
单个组件/类的跨度、职责数量和生命周期耦合判断；不把声明表、生成代码或测试夹具直接当作复杂业务代码。
TypeScript 组件跨度用 TypeScript AST 读取起止行，Rust 测试边界再人工核对。

| 优先级 | 文件 | 基线总行数 | 具体维护障碍 | 建议拆分边界 |
|---|---|---:|---|---|
| 高 | `src/components/panels/FilerPanel.tsx` | 1,883 | `FilerPanelBase` 从 175 到 1,627 行，单组件 1,453 行；目录请求、离线状态、编辑、传输、内外拖拽和菜单共享大量 ref/state | 先提取目录加载与过期请求保护，再提取传输状态、原生拖拽、菜单/对话框；保留面板协调入口 |
| 高 | `src/components/panels/SenderPanel.tsx` | 1,209 | `SenderPanel` 从 86 到 1,197 行，单组件 1,112 行；编辑草稿、命令库、作用域选择、分页、发送和计划条交错 | 命令库与编辑草稿 hook、命令列表、保存作用域选择器、重复发送条；复用已有 `senderSchedule`/`senderSend`，避免重新实现 |
| 高 | `src/terminal.ts` | 2,939 | `TerminalController` 包含键盘处理、WebGL 生命周期、fit、剪贴板、传输、搜索、命令追踪、补全、行号与语义着色；构造器 225 行，`filterKey` 150 行 | 先提取命令追踪/补全和行元数据/gutter，再处理渲染器生命周期；保持现有 controller 公共接口及 dispose/隐藏清理契约 |
| 高 | `src/components/FtpPane.tsx` | 1,141 | `FtpPane` 单组件 751 行；目录请求、复制冲突、指针拖拽/自动滚动与双栏 UI 混合；还包含 `FileBrowser` 和工具函数 | `FileBrowser` 独立组件，目录 hook，跨栏拖拽 hook，传输/冲突协调；不要与 Filer 的原生拖拽混成同一协议 |
| 中高 | `src/store.ts` | 1,749 | store 创建回调 794 行；标签/布局、连接状态、显示偏好、导入导出和通知集中 | 先提取偏好解析与序列化，再按状态域组织 action；保留一个公共 store 和共享偏好订阅，防止 reset/import 不同步 |
| 中高 | `src-tauri/src/session/ssh.rs` | 3,467 | 约 1,928 行主实现后有大型测试模块；主实现仍混合 host key、认证、跳板/传输通道、shell 和 SFTP | 先分离测试，再提取 host-key、认证、transport/channel、SFTP 操作；保持 guest/owner 和 Drop 资源所有权 |
| 中高 | `src-tauri/src/file_transfer/mod.rs` | 2,631 | 后段包含大量测试；主实现同时管理控制信号、限速、Job、journal/checkpoint 归属、恢复和队列 | 先移出测试，再提取 control/pacer、journal/recovery、job/queue；保留暂停/取消、确认检查点和目标互斥测试 |
| 中 | `src/styles.css` | 5,106 | 按主题和功能分段，但很多组件共享一个文件；修改后需跨文件搜索媒体查询、hover/focus 和覆盖关系 | 按主题变量、应用外壳、terminal、Filer/FTP、Sender、dialog 分批迁移；每批检查导入顺序和真实浏览器布局 |
| 中 | `src-tauri/src/commands.rs` | 1,872 | 多个领域的 Tauri 命令在同一入口，查找一个业务需跨越大量无关命令 | 按 profiles/settings、session、files、transfers、monitor 分组；同步维护注册和 bindings，不改 IPC 名称 |
| 低 | `src/i18n.ts` | 1,991 | 两份静态词典，长句字符串会拉长源码行；业务复杂度低于同规模组件 | 后续按语言/功能域分表，继续让 `MessageKey`/`Catalog` 检查键完整性；无需为缩短行数切碎用户可见句子 |

`src-tauri/src/tests.rs` 有 2,196 行，是测试集合，应按被测模块归档，不排在生产组件重构之前。
生成的 `src/bindings.ts` 应通过生成器维护；图标映射和静态词典也不宜按行数机械拆分。

建议实施顺序：Filer → Sender → FTP 双栏 → terminal 的独立职责 → store → Rust 模块。
每一步独立保持 typecheck/相关行为测试通过。先移动已有逻辑，再在后续改动中改变行为；
涉及 Rust 所有权、认证和 journal 时，补齐相应模块及专用服务验证。
这些是维护性建议，没有据此宣称运行速度或内存改善。

## 2. 本次比较界面的确定问题

原 `FileDiffDialog` 用整份结果中的最大字符串长度估算列宽，乘二后作为两栏最小宽度。
因此一侧的一条长注释就会撑宽整份比较，让另一侧移出视口。行使用 `white-space: pre` 和
固定 28px 高度，只增加换行 CSS 会导致虚拟行重叠，必须同时处理行高和滚动定位。

原工具栏只有首行/末行，行背景虽有颜色，但没有全文件差异位置提示，也没有上一处/下一处。

复现负载：10,000 行，首行包含中文/Tab 注释和连续无空格代码，差异分布在首部、中部、末尾。
900px 浏览器视口下，基线比较容器 `clientWidth=828`、`scrollWidth=24648`；
新增浏览器用例在旧实现失败，候选通过。该数值是布局尺寸，不是性能 benchmark。

## 3. 已实施的行为与代码边界

- 默认自动换行，保留“自动换行”开关，关闭后可查看原始长行；重新启用时清除水平偏移。
- 左右同一逻辑行按实际较高的一侧对齐；行号和换行符列保留。
- 上一处/下一处按连续差异块跳转，显示当前编号/总数；到达边界时禁用对应按钮。
- 右侧差异概览条按逻辑行位置显示：红色仅本地、绿色仅远程、黄色修改。
  点击可定位，附近细标记有命中容差；键盘 Home/End 到首尾、上下键到差异。
- 修改行左侧红色、右侧绿色，新增/删除仅突出存在内容的一侧，并提供图例。
- 继续只渲染可见行及缓冲行；字体/宽度变化重新测量，换行开关和宽度变化保留逻辑行位置。
  概览按每种颜色最多 400 个区间聚合，避免大量交替差异产生逐行标记 DOM。
- 元数据差异仍由原始比较状态呈现；没有行级差异时提示“无行级差异”，不会伪造文本差异位置。
- 保持现有只读、取消请求和拒绝旧响应的行为；本次没有改变后端比较算法或读取限制。

| 文件 | 职责 |
|---|---|
| `src/components/FileDiffDialog.tsx` | 请求、取消/重试、状态和元数据，保留原入口 |
| `src/components/FileDiffView.tsx` | 比较行、换行开关与差异导航 |
| `src/components/FileDiffOverview.tsx` | 彩色概览、点击和键盘定位 |
| `src/components/useDiffViewport.ts` | 可变行高测量、虚拟窗口和滚动锚点 |
| `src/fileDiffLayout.ts` | 差异分组、行位置二分查找与初始高度估计 |
| `src/components/fileDiff.styles.css` | 比较界面专用样式，从全局样式迁出并展开声明 |

## 4. 验证记录

环境：Windows、Node v24.19.0、Playwright Chromium 156.0.8078.4、真实 React/CSS，模拟 IPC 数据。
日期：2026-10-16。浏览器用例在 `src/test/fileDiff.browser.test.ts`，包含：

- 1280/900/799/700px × 明暗主题，中文/Tab/长单词完整换行、无水平溢出、相邻行不重叠。
- 10,000 行的首中尾差异、导航边界、计数、概览实际指针点击/键盘定位、末行可见。
- 深处切换换行/改变宽度保留位置，顶部/中部/底部行 DOM 有界。
- 相邻不同类型差异归并、5,000 量级交替差异的概览 DOM 有界。
- 字体变化后的重新测量、真实 wheel 滚动后视口覆盖、变高末行可达。
- 无行级差异时禁用导航，保留元数据差异状态。

新增比较浏览器测试 12 项通过；全量 `npm test` 为 65 文件、497 项通过，
`npm run test:browser` 为 6 文件、44 项通过；`npm run typecheck`、`npm run build`、
`npm run lint`、`git diff --check` 通过。
lint 的两处 `bindings.ts` 生成代码 `any` 警告和构建的大 chunk 提示保留，未修改无关生成物。
本次未修改 Rust，未重跑 Rust 测试或打包桌面程序。

截图：`artifacts/performance/file-diff/dark-900.png`、`light-1280.png`，均已查看。
布局、点击与虚拟滚动的浏览器证据不能替代 WebView2/其他操作系统桌面验证，也不能证明真实服务器行为。
后端原有 4MiB、50,000 行、单行 16KiB 读取限制仍适用；超过限制的内容不会因本次换行功能变成可比较。

### R10 变异检查

在 `.tmp/mutate/filediff` 一次性 worktree 中复制候选源码和测试；不链接 `node_modules`。
同快照控制组先通过，再逐项改动并检查实际断言失败，结束后移除 worktree。

| 行为 | 变异 | 实际结果 |
|---|---|---|
| 默认换行 | 将 `useState(true)` 改为 `false` | 900px 水平溢出断言失败 |
| 下一处差异实际跳转 | next 点击强制跳到第 0 行 | 中部目标不可见，断言失败 |
| 概览实际点击定位 | 指针处理强制跳到第 0 行 | 末尾目标不可见，断言失败 |
| 渲染窗口有界 | 向后缓冲从 5 行改为 500 行 | 顶部 DOM 数量断言失败 |
| 换行行高按实际布局校正 | 禁止接受正行高测量 | 相邻行位置相差 100px，断言失败 |

最初的 DOM 数量检查只在跳到末尾后执行，使“多渲染 500 行”变异存活；
已补充顶部和中部检查，同快照控制重新通过，五个变异均被检出。
旧实现失败、候选控制、变异日志与源码 SHA-256 保存在 `.tmp/records/filediff/`。

## 5. 追加：Filer 多选（2026-10-16）

用户补充：Filer 无法用 Ctrl 多选。基线只保存 `string | null` 形式的单个选中路径，
行的 `onMouseDown` 每次无条件替换它，没有读取修饰键。真实面板回归用例在基线失败：
先点击 file10，再 Ctrl 点击 file3，实际仅剩 file3，预期保留两项。

已实施：

- Windows/Linux Ctrl 点击添加或取消，macOS 对应 Command；Shift 按当前显示顺序选择范围。
- 列表内 Ctrl+A（macOS Command+A）全选，Escape 清除；行提供 `aria-selected`，列表提供多选语义。
- 按路径记录选择，排序和虚拟行卸载不会改变项目身份；刷新、目录/来源切换清除旧选择。
- 右键已选项保留整组，右键未选项改为单选；复制路径/名称包含整组，以换行分隔。
- 多项下载选定一个目标目录后提交完整文件/目录传输计划；取消目录选择或期间切换来源不启动任务。
- 本地拖出提交全部路径；远程多项先暂存整组，完成后交给系统；暂存中松手取消，不提交部分路径。
  macOS 单项保留现有 promised-file 路径，多项使用暂存路径。
- 删除前一次确认选中数量和完整路径，确认后逐项调用既有本地/SFTP 删除命令。
  部分失败时继续处理其他项目、刷新目录并保留失败项选择及错误；切换来源/目录关闭旧确认框。
- 普通单击已选组成员会在释放时收为单选；超过拖动阈值时保留整组，避免拖拽只带走一项。

选择模型抽到 `src/useFileSelection.ts`；面板保留操作接线，复用并扩展 `DeleteEntryDialog`。
未改动后端协议；空目录删除、传输取消和目标冲突仍遵循原有后端契约。

验证：新增 `src/components/panels/FilerSelection.test.ts` 14 项组件回归和
`src/test/filerSelection.browser.test.ts` 3 项真实 Chromium 交互回归，全部通过。
全量单元 66 文件/511 项、浏览器 7 文件/47 项通过；typecheck、build、lint 通过，
保留上述两处生成代码 lint 警告和构建大 chunk 提示。
多选截图在 `artifacts/performance/filer-selection/multiple.png`，已查看。

一次性 `.tmp/mutate/filer-selection` 中，先运行同快照控制，再破坏 Ctrl 切换、Shift 范围、
右键组复制、批量删除、本地组拖拽和批量下载接线，六项均由行为断言检出。
该 worktree 的 Vitest 临时配置允许读取主仓库依赖目录，以加载 Codicon SVG；
没有复制/链接依赖，也没有修改主工作区配置。模块加载失败不计入变异结果。
基线失败、候选控制、变异日志及源码哈希保存在 `.tmp/records/filer-selection/`。

边界：浏览器使用真实鼠标/键盘、DOM/CSS 和合成目录，IPC 被模拟，验证的是选择状态和操作参数。
未运行原生系统拖放、真实远端批量传输/删除、macOS 桌面或新的 Tauri 安装包。

## 6. 追加：Filer 连续提交下载与后台队列

用户补充：正在下载时不能选择另一份文件继续下载，也看不到排队机制。
当前 Rust 引擎已有按 endpoint 分配的两任务并行限制，其余任务等待 semaphore，支持排队时暂停/取消；
问题在于 Filer 把整个下载 Promise 的生命周期绑定到 `busy`，并复用单个进度槽。
下载命令要到任务完成才返回，所以 Filer 的选择、下载按钮被锁到结束。
上一节增加批量选择后，批次之间仍然有此限制，需单独修复。

新增回归先在修改前工作区失败：首个下载 Promise 保持未完成，下载按钮实际 disabled，
无法选择并提交第二份文件。同一用例在 `f5a1fc2` 一次性 worktree 也由行为断言复现。

已实施：

- 下载逻辑迁入 `src/useFilerDownloads.ts`，仅在选择保存位置时锁定下载入口，提交后立即释放。
  每次提交冻结源路径/目标路径并分配独立 task id，单文件、目录、多选批次统一走现有 `transferFiles`。
- 下载继续使用真实后端队列：同 endpoint 最多两个任务运行，后续任务等待，空出名额后自动开始。
  未另建前端调度器，也未更改后端并发上限和传输选项。
- Filer 新增 `FilerTransferSummary`，从后台事件快照统计当前会话的运行、排队、暂停和失败任务。
  点击可直接打开传输中心，管理每个任务的进度和暂停/恢复/取消/重试。
  传输中心开合状态放入现有 `fileTransfers` store，列表与状态栏共用同一个入口。
- 下载不再占用面板原有的单任务进度槽，不会覆盖上传、远程编辑或原生拖拽的进度/取消归属。
- 保存位置选择器串行开启，取消、面板卸载、切换来源后到达的旧选择不会提交任务。
  已提交任务不随面板卸载取消；失败报告保留源会话和文件名，用户取消不会误报下载失败。

测试证据：

- 组件测试覆盖首个任务未完成仍能提交第二个、不同 task id 与目标路径、后端快照计数、
  从 Filer 打开实际 TransferCenter 并取消 queued 任务，以及卸载后失败不干扰另一任务。
- 真实 Chromium 明暗两主题，模拟 IPC 事件：实际点击连续提交三个文件，显示两个 running/一个 queued，
  从面板打开传输中心并取消等待任务。截图在 `artifacts/performance/filer-queue/dark.png`、`light.png`，已查看。
- 新增 Rust FTP 夹具 `ftp_download_queue_advances_when_a_slot_is_released`：两个限速下载占用名额，
  之后的两个任务持续保持 queued；取消等待任务没有生成目标文件；取消一个运行任务后，
  另一个等待下载自动完成，逐字节核对本地内容，另一个运行任务保持运行。夹具和临时目录自行清理。
- 全量 `npm test`：66 文件/515 项通过；`npm run test:browser`：8 文件/49 项通过；
  `cargo test --manifest-path src-tauri/Cargo.toml --lib`：277 通过、23 ignored；
  typecheck、build、lint、`cargo fmt --check` 和 `git diff --check` 通过。
  既有生成代码的两处 any、构建大 chunk、Windows 未构造 macOS promise 事件的 Rust 警告保留。

一次性 worktree 中，同快照控制通过后，分别重新等待下载完成、移除传输中心打开接线、
取消任务改为上报失败，三项变异均由对应行为断言检出。原始日志与源码哈希位于
`.tmp/records/filer-queue/`，worktree 使用主仓库依赖且没有建立依赖链接。

边界：浏览器证明前端交互/事件接线；FTP 夹具运行真实 loopback TCP 与本地文件，但不是外部部署。
23 个 ignored 用例未视为通过；未用真实远端 SSH/FTP 服务或重新打包的桌面 WebView 验证。

## 7. 职责拆分完成记录与最终验收

第 1 节列出的十个主要生产文件已按职责拆分。保留原公共入口，调用方无需跟随目录重组改写业务；
测试夹具和静态文案仍可较长，不以所有文件都低于某个行数作为完成标准。
下表为含注释的入口文件行数，去除末尾空行。行数减少来自职责迁移，既不代表项目总代码量减少，
也不作为启动速度、吞吐或内存改善的证据。

| 原入口 | 基线行数 | 当前行数 | 已分离的职责 |
|---|---:|---:|---|
| `src/components/panels/FilerPanel.tsx` | 1883 | 623 | `useFilerDirectory`/目录缓存、`useFilerTransfer`、`useFilerUpload`、`useFilerDrag`、`useFilerActions`、行展示与类型；下载入口仍由 `useFilerDownloads` 管理 |
| `src/components/panels/SenderPanel.tsx` | 1209 | 582 | 命令库/编辑草稿、手动及重复发送、快捷条、重复发送条、命令列表 |
| `src/components/FtpPane.tsx` | 1141 | 348 | 目录请求、传输与冲突、跨栏拖拽、显式文件操作、FileBrowser 展示 |
| `src/terminal.ts` | 2939 | 1073 | GPU、语义着色、viewport/fit、行号时间、命令与补全、剪贴板、搜索、键盘；原类负责生命周期、xterm 接线和公共 API |
| `src/store.ts` | 1749 | 114 | 类型、偏好校验/存储、布局辅助，以及 profile/tab/preference/prompt action slices |
| `src/styles.css` | 5106 | 11 | 十个有序导入的领域样式文件，保持原级联顺序；主题原始样式测试同步指向 foundation |
| `src/i18n.ts` | 1991 | 101 | `locales/en.ts`、`locales/zhCN.ts`，继续由同一键类型检查完整性 |
| `src-tauri/src/session/ssh.rs` | 3467 | 50 | authentication、algorithms、host_keys、transport、shell、sftp 和 tests |
| `src-tauri/src/file_transfer/mod.rs` | 2631 | 101 | types、control、pacing、job、manager、journal、worker 和 tests |
| `src-tauri/src/commands.rs` | 1872 | 99 | profiles、sessions、binary_transfer、transfers、forwarding、inspection、local_files、desktop、remote_edit、file_drag 和 response helpers |

### 边界与生命周期

- Filer 的目录缓存仍只有一份；请求代次、来源检查、选择清理和拖拽回流识别跟随原逻辑。
  多选和下载队列的实际交互用例在拆分后继续通过。
- Sender 的命令库请求在卸载/重新加载后拒绝旧响应；编辑前草稿、行尾与作用域不因组件拆分丢失。
  重复发送仍使用面板外原有的 schedule，手动发送随面板卸载停止。
- 终端模块通过明确的 Context/Pick 类型接收依赖，读取主控制器当前状态，保持显示/隐藏、
  reflow 与高度调整的原策略。viewport 和 GPU 各自清理自己的计时器；语义 backlog、命令 marker
  和剪贴板事件的清理仍由生命周期入口触发。GPU 的六个持有者 LRU 只有一个实例。
- store 只创建一个 Zustand 实例；action slices 共享同一 set/get，语言及快捷键初始化只发布一次。
  现有偏好导入、重置和多面板同步契约保留。
- Rust 原路径继续由 facade 导出；共享私有成员仅向模块内部开放。未调整 SSH 认证顺序、
  host-key 策略、传输默认并发数、限速算法、恢复日志格式或检查点归属判断。
  Tauri/Specta 注册名称、二进制命令头和事件协议保持一致。

### 最终验证

- `npm test`：68 个文件，521 项通过。
- `npm run test:browser`：8 个文件，49 项通过；真实 Chromium，原生 IPC 使用夹具。
- `cargo test --manifest-path src-tauri/Cargo.toml --lib`：277 项通过、23 项 ignored。
- `npm run typecheck`、`npm run build`、`npm run lint`、Rust fmt 检查和 `git diff --check` 通过。
- `npm run check:bindings`：92/97 命令生成、5 个明确例外、5 个事件，生成文件与仓库完全一致。
- lint 保留生成 bindings 的两处 any 警告；生产构建保留大 chunk 提示；Rust 的平台专用代码
  在 Windows 构建有既存未使用警告。没有以删除这些保护或更改编译告警阈值来通过检查。

新增 Sender 挂载测试三项：编辑取消恢复原草稿、快捷发送保留 CRLF/当前目标、导入后刷新列表并退出旧编辑。
新增 GPU 模块测试三项：六个持有者的 LRU 淘汰、每分钟最多三次延迟恢复、dispose 立即清除恢复计时器。
GPU 测试替换了 WebGL addon，不是硬件/GPU 性能或 WebView2 真实渲染验证。
终端原有真实 xterm 缓冲、尺寸与 onResize 契约继续运行；只调整旧测试访问已迁移私有状态的位置。

### 拆分后的变异抽查

在一次性 `.tmp/mutate/responsibility` worktree 以相同快照先运行 6 项控制用例，再逐个改动生产实现。
依赖从父仓库解析，不建立 node_modules 链接；测试专用 Vite fs.allow 仅用于读取父仓库的 Codicon SVG。
最初该访问限制导致的模块加载失败不计作有效变异。下列六项均产生预期 AssertionError：

| 模块契约 | 生产变异 | 检出的断言 |
|---|---|---|
| GPU 容量/LRU | 容量从 6 改为 7 | 最久未提升的 renderer 应已被释放 |
| 恢复预算 | 恢复次数从 3 改为 4 | addon 总创建次数应为 4 |
| GPU 释放 | 移除 dispose 的 clearTimeout | dispose 后待执行计时器应立即为 0 |
| Sender 草稿 | Cancel 改为清空 text | 编辑前未完成草稿应恢复 |
| Sender 行尾 | 快捷发送强制使用 LF | CRLF 实际发送单元与行尾参数应保留 |
| 导入刷新 | 从 effect 依赖移除 libraryVersion | 实际挂载列表应显示新导入命令并退出旧编辑 |

控制、各变异日志和源文件 SHA-256 存放在 `.tmp/records/responsibility-split/`。
既有差异比较、多选、下载队列的旧实现失败证据与变异记录见第 4～6 节。

### 提交与安装包

14 个功能/拆分提交已通过逐提交 `check:commits --typecheck`，0 errors、0 warnings；
文档作为最后一个独立提交保存。

Windows x64 NSIS 安装包构建成功，版本保留仓库原有的 1.0.0：

- 路径：`src-tauri/target/release/bundle/nsis/EdgeTerm_1.0.0_x64-setup.exe`
- 大小：4138177 字节（约 3.95 MiB）
- SHA-256：`3e6e65f618627aab18f4f84185e797c5622f1db991febfff62b8bede596064ce`
- 构建代码提交：`844d124`；最后的报告提交只改变文档。
- 构建命令：`npm run tauri:build -- --bundles nsis --config .tmp/records/responsibility-split/installer-config.json`
- 临时 overlay 仅设 `bundle.createUpdaterArtifacts=false`，用于生成本地安装程序；
  不修改仓库正式更新包配置、不创建发布版本。没有配置 Windows 代码签名。
- 已检查安装包 PE 头、应用 x64 架构，旁边保存 `.sha256` 和 `build-info.json`。
  未在用户系统执行安装，也未以打包成功替代安装后连接外部服务的验证。

构建日志和各项检查日志保存在 `.tmp/records/responsibility-split/`；
变异与逐提交检查使用的一次性 worktree 已清理，主工作区不含测试变异。
