# 侧栏拖拽卡死：诊断与修复边界

## 1. 已知事实与未知项

症状：拖动侧栏分隔线时界面不再响应；松手后整个 EdgeTerm 仍显示双向箭头；通过任务栏也无法关闭。

当前源码能确认两件事，但不能仅凭这两个症状判断硬卡死根因：

- [全局光标样式](../src/styles.css#L3443-L3453)由 `.splitter.is-dragging` 触发。旧版 [Splitter](../src/components/Splitter.tsx) 只在自身 `pointerup`/`pointercancel` 中结束拖拽，没有处理丢失捕获、失焦、隐藏或 Escape。缺失终止事件会残留拖拽状态；这也可能是主线程已经堵塞、终止事件无法执行的结果。
- [窗口关闭回调](../src/App.tsx#L299-L312)在有活动会话时阻止直接关闭，并通过前端显示确认框。因此“任务栏关闭无效”不等同于“Rust 已死锁”；需同时确认前端及宿主是否仍响应。

2026-10-26 用户进一步确认：故障机为 Windows 11，在系统“显示设置”修改缩放；整窗持续无响应，菜单、键盘均不可用，通常需结束进程，并且经常发生。EdgeTerm 的精确版本、系统构建号、CPU/GPU、显卡驱动、WebView 版本仍未知。“版本较新”不能证明包含当前工作区的补丁；新的收集方式见第 8 节。

## 2. 先收集最小复现信息

记录以下项目，不要先更换多个变量：

- EdgeTerm 版本/提交、debug 或 release、安装包来源。
- OS/构建号、CPU、内存、GPU/驱动版本、实际 WebView 运行时版本；不是系统默认浏览器版本。
- 拖动左/右侧栏宽度，还是底栏高度；是否拖出窗口、Alt+Tab、最小化、触控或鼠标操作。
- 会话类型、标签数、分屏数、历史行数、是否有持续输出，以及是否在远程桌面环境。
- 松手后终端输出、菜单、键盘、窗口拖动是否仍响应；分别记录应用宿主、renderer、GPU 进程的 CPU/内存。

只用可丢弃的本地会话复现。不要把生产 SSH 会话、传输或未保存配置当测试负载。

## 3. 区分拖拽残留与真正阻塞

先松开鼠标，按一次 Escape，切换到其他应用再回来。新补丁会处理这些恢复路径；旧版没有对应保证。若仍不响应，先抓证据，不要继续反复拖动。

若专用实例的 DevTools/远程调试仍能执行 JavaScript，在松手后读取：

```javascript
({
  time: performance.now(),
  visibility: document.visibilityState,
  focused: document.hasFocus(),
  dragging: [...document.querySelectorAll(".splitter.is-dragging")].map(el => ({
    className: el.className,
    cursor: getComputedStyle(el).cursor,
  })),
});
```

| 观察结果 | 下一步；不是根因结论 |
|---|---|
| JavaScript 能响应，仍有 `is-dragging` | 优先核对 pointer 生命周期；记录 `pointerup`、`pointercancel`、`lostpointercapture`、`blur` 是否到达 |
| JavaScript 能响应，没有残留状态，但画面不更新 | 查看 Performance trace 和 GPU/渲染相关进程，不能靠改 cursor 判断恢复 |
| JavaScript 不能响应，renderer CPU 高 | 提前录制 Performance，分析长任务/调用栈；resize、样式计算、布局、终端绘制均只是候选 |
| 宿主窗口消息也不响应，或各进程低 CPU 长时间等待 | 捕获宿主与相关 WebView 子进程 dump，分析线程栈和等待链 |

不要把手动删除 `.is-dragging` 当修复：那只修改 DOM 样式，不会清理 React 状态、指针捕获或排队的 resize。JavaScript 心跳超时只能提供线索；WebView 隐藏节流、调试暂停也可能影响计时。

## 4. 老平台的低风险对照

在能正常操作的专用实例中，进入 **View → Display Settings… → GPU rendering**，取消 **Enabled** 后点 **Apply**。这是已有的终端渲染开关，不是关闭整个 WebView 的硬件加速。入口见 [显示设置](../src/components/FontSizeDialog.tsx#L241-L257)，应用路径见 [App](../src/App.tsx#L290-L297)。

同一台机器、同一版本、同一负载对比：

1. GPU 开 / 关，每组记录拖动方向、次数和能否复现。
2. 先单标签、少量历史且不持续输出，再逐步加入原始工作负载。
3. 分别尝试侧栏宽度与底栏高度；不要同时改字体、历史上限和标签数。
4. 在支持范围内单独对照运行时或显卡驱动版本，保留原版本信息。不要盲目给旧 OS 安装不受支持的最新版本。

关闭 GPU 后不复现只能缩小嫌疑范围，不能单独证明显卡驱动根因；未关闭的 WebView 合成路径仍可能涉及 GPU。不要用额外 `requestAnimationFrame` 包装或提高防抖时间来代替阻塞栈分析。

## 5. Windows：卡住时先留 dump，再结束确切进程

如果实际系统不是 Windows，本节不适用，需按该平台的 WebView/线程采样方式取证。

仓库的 [diagnose-hang.ps1](../scripts/diagnose-hang.ps1) 已于 2026-10-26 更新，可从应用外部检查原生窗口消息响应、窗口 DPI、子窗口尺寸/region、该实例的 WebView2 进程和版本，以及两次 CPU/内存采样。它不重启或终止应用，不截图、不读取终端内容、不导出完整命令行。无参数时仅接受唯一的 `edgeterm.exe`；多个实例必须指定 PID：

```powershell
Get-Process edgeterm | Select-Object Id, Path, MainWindowHandle
# 在仓库根目录运行，1234 替换为上一步确认的故障实例 PID：
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\diagnose-hang.ps1
# 多个实例时：
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\diagnose-hang.ps1 -ProcessId 1234
```

解释输出时只把它作为线索：

- `nativeMessageProbe.responded=false`：所选窗口的消息未返回或 API 失败；同时查看 `lastError`，需要 dump；不能直接证明 COM 死锁。探测超时上限为 2 秒，整个收集还包含系统查询和采样。
- 原生消息、JavaScript 均响应，却只有鼠标操作异常：查看边框子窗口是否可见、覆盖内容区、region 是否异常。需要确认命中测试和依赖版本后，才考虑修复 Tauri/tao/wry 的原生 resize 路径。
- `regionType=0` 是 API 错误/缺少 region 的结果，不能证明它覆盖或拦截了内容区；脚本已移除旧的 `VERDICT CANDIDATE` 根因推断，也不证明子窗口一定在最上层。

不要拿会启动/结束应用的旧复现脚本替代原地取证。

随后可在任务管理器的“详细信息”中，对核实 PID 的 EdgeTerm 进程选择“创建转储文件”；对属于该实例的 WebView renderer/GPU 进程也保留转储。菜单名称随 Windows 版本可能不同。可先用下面的只读命令核对路径与进程关系：

```powershell
Get-Process | Where-Object { $_.ProcessName -match 'edgeterm' } |
  Select-Object Id, ProcessName, Path, Responding, CPU, WorkingSet64
Get-CimInstance Win32_Process |
  Where-Object { $_.Name -match 'edgeterm|msedgewebview2' } |
  Select-Object ProcessId, ParentProcessId, Name, ExecutablePath, CommandLine
```

不要终止所有 `msedgewebview2.exe`；其他应用也可能使用它。先核对父子进程关系及该实例路径。`Responding` 也不能单独证明 JavaScript 健康。

如果机器上已有与该 OS 兼容的 Microsoft ProcDump，可抓三份间隔 5 秒的完整 dump。先将提示中的 PID 核实为目标进程，再运行：

```powershell
$targetPid = [int](Read-Host '输入已经核实的 EdgeTerm 进程 PID')
Get-Process -Id $targetPid | Select-Object Id, ProcessName, Path
New-Item -ItemType Directory -Force .\hang-dumps | Out-Null
.\procdump.exe -ma -n 3 -s 5 $targetPid .\hang-dumps
```

对相关 renderer/GPU PID 分别重复；保留与故障时间对应的日志/trace。不要只依赖 `-h` 自动触发：它看窗口消息是否超时，不等同于页面 JavaScript 挂起。当前 ProcDump 官方支持列表为 Windows 11+/Server 2016+；更老系统不能默认使用最新版，应优先使用系统已有的转储能力或组织认可的兼容工具。

确认取证完成且可以丢弃会话后，才在任务管理器结束该 EdgeTerm 进程。强制退出会中断连接/传输并可能丢失未保存状态。dump 可能包含终端文本、凭据及其他内存数据，勿直接上传公开 issue。

参考：[ProcDump 官方说明](https://learn.microsoft.com/en-us/sysinternals/downloads/procdump)、[WebView2 线程模型](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/threading-model)。WebView2 依赖宿主 UI 消息泵；只有实际线程栈才能判断本次是否发生了阻塞。

## 6. 2026-10-16：拖拽中断补丁与验证记录

基线为 `15d4fad`；补丁已提交为 `e1e5078`。以下保留当时的验证记录，不代表当前完整测试规模或故障机器上的验证。验证使用 Node.js 24.19.0、npm 11.17.0、Vitest 4.1.11 / jsdom；不是故障机器上的 WebView。

[Splitter](../src/components/Splitter.tsx)的改动：

- 通过 ref 记录活动 pointerId、目标元素和坐标；拒绝右键、非主指针及并发覆盖。
- 在 `window` 捕获阶段接收 `pointerup`/`pointercancel`，并处理捕获丢失、失焦、Escape、页面隐藏、卸载及方向切换。
- 鼠标移动时发现主键已松开则取消，避免漏掉松手后继续调整尺寸。
- 先退役活动状态、移除监听器、释放捕获，再提交最后一帧；异常路径也执行清理。
- 正常松手提交最后一帧。中断仅丢弃尚未执行的帧，不回滚已经应用的尺寸。

[组件回归测试](../src/components/Splitter.test.ts)挂载真实 React 组件并使用真实 frameBatch；仅模拟 jsdom 缺失的指针捕获边界和帧时钟。首轮 16 个用例在旧实现上 3 通过、13 失败；修改后全部通过，之后补充捕获异常和监听清理共 19 个用例。

本轮已运行：完整前端 60 文件/480 用例通过；TypeScript 检查通过；生产前端构建通过；`git diff --check` 通过。构建仍提示大 chunk；jsdom 下出现预期的 WebGL 不支持、回退 DOM 提示。

未运行：Playwright 浏览器指针/实际 CSS 交互验证（本机未提供 Playwright）、老平台真实 WebView/显卡复现、Tauri 安装包构建、Rust 测试（未修改后端）。本次没有在用户故障机器上抓到 dump 或 trace，不能宣称“原始硬卡死已解决”。

实机验收需同时满足：正常横/纵拖动尺寸正确；松手、Alt+Tab、Escape、隐藏恢复和拖出窗口后无残留光标/捕获；反复拖动后终端持续响应；有活动会话时任务栏关闭能显示确认框、取消后能继续操作；确认退出正常结束。

仓库现有诊断工具的权限、目标选择和局限见 [scripts/README.md](../scripts/README.md#L50-L67)。CDP 工具须指定专用实例的 `EDGETERM_CDP_TARGET_ID`，不能把任意第一页或生产会话作为目标；合成 pointer 事件不是 OS 鼠标拖动。

## 7. 2026-10-26：显示缩放与重复测量回归

用户补充：另一台电脑在拖动侧栏、调整显示屏缩放比例时都会卡死。该机器的具体版本、缩放方式（系统设置、跨屏移动或应用内字号）、运行时与 GPU 尚未确认；没有取得其 dump/trace。下面是当前源码中独立复现的缺陷，不能据此断言就是那台机器的硬卡死根因。

基线为 `9087a88`。新增 [terminalDisplay.browser.test.ts](../src/test/terminalDisplay.browser.test.ts) 使用本机 Windows、受限任务 runner、Vitest 4.1.11 与系统 Edge 的无头 Chromium，真实 xterm 6.0.0、真实 CSS 和 DOM/WebGL 渲染器；数据为合成终端输出。通过 CDP 设置 DPR，并向测试 iframe 派发 `resize` 进入 xterm 的实际窗口事件链。此路径验证前端行为，不模拟 Windows 的原生 DPI 消息或 WebView2/驱动。

| 触发条件 | 基线观察 | 修改后的行为 |
|---|---|---|
| 挂载真实 SessionPane，宽度从 900px 改为 900.25px，终端网格未变化 | `proposeDimensions` 调用 4 次 | 保留实际 host 的唯一尺寸监听；网格未变时跳过重复 fit，测量 1 次 |
| 可见 GPU 终端写入 300 行，在 CSS 容器大小不变时从 DPR 1 调到 1.25 | 行列数未重新适配：104 列，实际 proposal 为 114 列 | 显示度量更新后立即适配终端；1、1.25、1.5、2 的往返覆盖 GPU 与 DOM，保留输出内容且行号间距与终端一致 |
| 隐藏的 GPU 终端先改为 DPR 1.5，再改为 2 | 隐藏时仍执行 2 次渲染器 DPR 更新 | 隐藏时只记录待更新状态，再次显示时按最新比例更新一次 |

调用链依据：xterm 6.0.0 的 `RenderService.handleDevicePixelRatioChange()` 不经过普通 resize 的隐藏暂停路径，直接重新测量字符并通知渲染器。应用原先只根据容器尺寸 fit，DPR 改变但 CSS 尺寸不变时没有对应的适配入口。修复在 `open()` 后包装该版本的 DPR 入口，沿用 xterm 自身测量和渲染逻辑；同帧合并、隐藏时延后、显示时冲刷、dispose 时恢复原函数并取消排队任务。该兼容代码依赖固定版本的私有接口，升级 xterm 时必须运行本节回归。

侧栏拖动原有的逐帧合并与大缓冲列调整等待策略不变：少于 200 行立即调整两维；大缓冲行变化立即应用，列变化等待最后一次事件后的 100ms。此次移除外层 pane 与内部 host 的重复监听，并在行列数未变时跳过非强制 fit。显式首次显示、字体和 DPI fit 仍重新同步度量。

新增回归还覆盖：同帧重复通知、排队后隐藏、重新显示、排队后销毁。相关终端 fit、GPU 缓存淘汰、布局和 Splitter 测试用于防止改变既有显隐与尺寸契约。以上测量次数只说明该夹具中的重复工作减少，实际拖动帧率和故障机器上的稳定性仍待验证。

本轮验证：新增浏览器 5 用例通过；连同终端 fit、GPU 缓存淘汰和 dock 布局共 4 文件/19 用例通过；完整单元测试 103 文件/888 用例通过。TypeScript、生产前端构建、格式检查及 `git diff --check` 通过；lint 仅保留生成的 `bindings.ts` 中两条既有 `any` 警告，构建仍有大 chunk 提示。日志与 125% GPU/DOM 截图在本机忽略目录 `artifacts/ui-display/`。未进行故障机验证、原生 Tauri 打包或 Rust 测试（本轮未改后端）。

故障机复核时先记录实际缩放操作和变更前后比例；单独对比侧栏拖动与缩放，保留当前应用版本以及 GPU 开关状态。若仍卡死，按第 3–5 节区分前端长任务、GPU 绘制与原生消息阻塞并保留对应证据。

## 8. 2026-10-26：Windows 11 系统缩放后持续无响应

用户已确认系统设置缩放，以及需要结束进程的持续无响应。菜单属于同一个 WebView 前端，因此该表现还不能单独区分 JavaScript 主线程阻塞、GPU 绘制停滞与原生窗口消息泵阻塞。

本次核对了锁定的 tao 0.37.1、wry 0.57.0、tauri-runtime-wry 2.12.1：tao 的 Windows DPI 初始化已尝试 Per Monitor V2；其 Windows 11 `WM_DPICHANGED` 路径采用系统建议的矩形，窗口尺寸交给 wry 的 WebView2 controller。应用的 `resize_session` 只向会话队列发送消息，没有同步等待 PTY 或 SSH。窗口记忆在读取窗口状态之后加锁，并由独立线程写盘；本项目未使用 `tauri-plugin-window-state`。以上源码事实没有证明故障机的具体阻塞点，不据此修改原生依赖或禁用沙箱。

微软文档说明 WebView2 的 UI 回调依赖消息泵，阻塞和不支持的重入可导致停滞；这个机制需要实际堆栈确认，不能套用为本次结论：[WebView2 线程模型](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/threading-model)。

故障机先在仍能操作时记录应用版本；再次卡住时，可直接双击随测试包提供的 `diagnose-hang.cmd`。脚本把 JSON 保存到桌面的 `EdgeTerm-diagnostics` 目录，窗口会显示路径。如果检测到多个应用实例，它会列出 PID 并拒绝自动猜选，改用第 5 节的指定 PID 命令。

报告包含所选程序的路径、SHA-256、文件版本、Windows 构建、显卡驱动、窗口 DPI，以及限定到该实例的 WebView2 进程版本和两次累计 CPU 秒数。累计 CPU 秒数不是占用百分比；原生消息返回也不表示 JavaScript 正常。若消息超时，或报告仍不能解释卡死，继续保留相同 PID 的宿主和相关 WebView2 转储，不能只靠报告猜根因。

取证工具的回归使用自行创建的隐藏原生窗口，分别运行正常消息循环与故意阻塞的消息处理，验证真实 `SendMessageTimeoutW` 的超时；另外覆盖进程歧义、WebView2 家族隔离、PID 重用排除、JSON 输出和命令行隐私。该夹具没有制造或证明用户的原始 WebView2 故障。

同日后续反馈：提供基于 `8c663d0` 的 Windows x64 安装包后，用户反馈“好像没什么问题了”，并同意准备 1.3.0。安装包沿用正式安装版标识和配置路径，区别于使用独立 `data` 目录的开发便携包。此反馈支持交付本轮修复，但尚无故障机阻塞堆栈、精确驱动版本或长期重复测量；不将其升级为硬卡死根因已确认或所有硬件组合均已通过验收。1.3.0 的检查与发布范围见[发布说明](release-1.3.0.zh-CN.md)。
