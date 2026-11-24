# 审计：终端右键菜单 / 监视词，以及托盘 / 监视浮层（2026-11-25 第 193 轮）

两个只读审计。**修 3 条，1 条修了但没能验证、已回退，3 条待办。**

## 托盘（`src-tauri/src/tray.rs`）

| 编号 | 问题 | 状态 |
| --- | --- | --- |
| T1 | `closeAction = "tray"` 时，托盘的 Quit 是应用**唯一的出口**（✕/Alt+F4 只隐藏窗口，菜单栏没有 Quit）。而有会话或传输在跑时 `hasQuitWork()` 为真，前端会在**隐藏的窗口里**打开确认对话框——点击看起来毫无反应，应用继续躲在托盘里运行。读者只能去找任务管理器 | **已修**：`MENU_QUIT` 先 `reveal(handle)` 再发事件，复用 `MENU_OPEN` 与左键同一条路 |
| T2 | 托盘的「最小化到托盘」勾选项在每次菜单重建后都显示未勾选——而应用确实还在关闭时隐藏到托盘。触发条件是启动（设置已持久化）与每次切换语言。托盘是窗口停驻后唯一可见的面，于是读者被告知功能是关的，而它开着；点它计算 `next = !false = true`，什么都不会变 | **已修**：`set_labels` 在换上新项前读旧项的 `is_checked()` 并传给新项 |

## 监视词（`src/terminalLineGutter.ts`）

| 编号 | 问题 | 状态 |
| --- | --- | --- |
| W1 | 槽在**错误的行**上画监视标记，而且滚动缓冲一旦填满就**完全不画**——那正是读者回滚去找失败原因的时候。`watchByLine` 用绝对行做键（`firstLineNumber + row`），读取时却用裸缓冲区索引；`firstLineNumber = 1` 时第 r 行的色记画在第 r+1 行，缓冲填满后偏差随裁剪数增长，超出可见窗口后标记消失，而 `watchMarkLines()` 仍报告有标记、命令面板也仍提供跳转 | **已修**：读取改用 `firstLineNumber + index`，与两行之下 `lineText` 用的换算一致 |
| W2 | 监视标记跳转把绝对行号与缓冲区相对的游标比较，于是「上一个监视标记」报告「没有标记」，「下一个」总是落在最旧的标记上 | **已修但没能验证，已回退**（见下） |

### W2 为什么回退

审计给的最小改动是在 `jumpToWatchMark` 里把 `watchLines()` 减去 `firstLineNumber`。我照做后**测试立刻报 `expected 45 to be 22`**——说明它落到了绝对行 45，而不是缓冲区行 22。读代码发现 `scrollToLine` 自己会减 `firstLineNumber`（`Math.max(0, absoluteLine - firstLineNumber)`），也就是说**它要的是绝对行**，审计那个改法方向错了。

于是改成抬升比较基准（`baseY + cursorY + firstLineNumber`），恢复 `jumpToWatchMark` 原样。**测试仍然报同样的 `expected 45 to be 22`。** 两种改法都不能让新用例通过，而现有 5 条用例两种改法下都通过——说明我写的那条用例本身可能就有问题（`landed` 与 `marks[0] - offset` 的期望关系我没推对），而不是两种修法等价。

在推对坐标关系之前**不提交任何 W2 改动**：一个我无法用红/绿证明的修改，比没有修改更危险。`src/terminal.ts` 与 `src/terminalWatchJump.test.ts` 已 `git checkout` 回到 HEAD，W2 保持「已发现、未修」，证据留在本节。

## 监视浮层（`src/components/ResourceMonitorBar.tsx`）

| 编号 | 问题 | 状态 |
| --- | --- | --- |
| M3 | 浮层主体可能**完全空白**——没有磁贴、没有提示——而样本在途或监视被关掉时就是这样。三种到达方式：样本返回前 1–3 秒打开浮层、点「刷新资源」、取消勾选「监视当前 SSH 主机」。每次都是页眉 + 两个图标按钮 + 设置行压在空白上，什么都不说 | 未修（需要加一个空状态分支，`monitor.readingResources` 键已存在） |
| M4 | 「刷新资源」**丢掉累积的趋势窗口**：一次点击让每个磁贴掉回虚线「预热中」基线，读数全部消失；主机慢时面板空白数秒（后端超时 20 s）。与 M3 同根，但趋势丢失是单独且不可逆的后果 | 未修（把重置移到只依赖身份的效果里） |
| M5 | 「监视当前 SSH 主机」描述的是按主机开关，但它写的是**全局**单键 `edgeterm.resource-monitor`。两个 SSH 标签打开时，在其中一个上取消勾选会静默关掉所有主机的监视；切标签显示「资源已关闭」，而读者从没碰过那个会话 | 未修（改两语言文案即可，或做成按主机是功能不是修复） |

## 确认无缺陷

- **右键菜单本身**：所有项都作用于正确的会话（经 `withTerminal(getController(id))`）；`claim` 在 `contextmenu` 之前的 mousedown-capture 就把右键的那个窗格设为活动，所以片段／最近命令发送打到正确的标签；禁用态与后端一致（`git.title` 镜像 `openSessionGit` 的守卫、`canCopy` 镜像 `hasSelection()` 等）；子菜单键盘可达（`levelItems` 过滤 `:disabled`）；关闭时焦点还给打开者。
- **托盘提示没有过期会话数**：提示是静态 `"EdgeTerm"`，从不计算或推送计数。
- **浮层不会在小窗口里跑出屏幕**：`.status-popover` 是 `position: fixed` 锚在视口，宽度 `min(520px, calc(100vw - 24px))`，且状态栏的祖先链上没有 `transform/filter/perspective/contain` 会造出包含块。
- **托盘没有失效项**：三项都映射到活行为。
- **度量单位与颜色不矛盾**：`usedOf` 与 `trendPointFrom` 用同一个百分比公式；后端把每个利用率夹到 ≤100；阈值分层与 `.metric-warn/.metric-crit`、`.spark.tone-*` 规则一致。
- **监视词词表与语言键**：`watchSeverity` 与其单测一致（含复数排除）；`menu.prevWatch`/`nextWatch`/`status.noWatchMark` 与 `sc.*Watch*` 两语言齐全；监视状态不在会话间共享（每个控制器一个 `TerminalLineGutter`）。

证据边界：T1/T2/W1 是代码验证的；仓库自己的构建记录（`build-1.7.8-r153-20261124.md`:37）记载托盘菜单重建没有自动化测试。M3–M5 由组件源码与样式表验证，未运行应用，因此没有观察到渲染出的空白浮层或屏幕上的 Windows 托盘菜单。
