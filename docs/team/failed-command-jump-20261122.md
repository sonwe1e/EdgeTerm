# 跳到失败命令（2026-11-22 第 29 轮）

上一轮给失败命令留了侧栏标记，但日志一长仍然要靠眼睛找。本轮把「跳到上一个失败」做成命令，复用既有的命令跳转语义。

## 一、行为

| 入口 | 说明 |
| --- | --- |
| Terminal 菜单 → Previous/Next Failed Command | 有图标、无默认和弦（可在设置里绑定） |
| 命令面板 → 同名命令 | 与菜单同一条派发路径 |
| 走到底 | 状态栏说 No failed command to jump to，而不是静默无反应 |

语义与既有的命令跳转一致：从光标处开始走，落在上次落点的下一次继续走（连按两次是两条），不回绕。

## 二、实现

- `jumpToCommand` 的走查逻辑抽成 `jumpToLines(lines, direction)`；命令跳转与失败跳转共用同一套「参考行 + 落点记忆 + 闪烁提示」；
- `TerminalCommands.commandFailures()` 提供失败命令的起始行（第 28 轮已有），控制器新增 `jumpToFailedCommand` 与只读的 `failedCommandLines()`；
- 快捷键表新增 `prevFailed` / `nextFailed`，默认 `null`（不绑键）：命令跳转已占用 `Ctrl/⌘+Shift+↑/↓`，失败走查频率低，留给用户自己决定；
- 菜单与命令面板都由快捷键表驱动，因此即使没有默认和弦，两条入口都自动存在。

## 三、验证

单测 terminalCommandExit.test.ts 4/4（新增 1 条）：写入一条失败命令与一条成功命令后，`failedCommandLines()` 只列失败的那条；`jumpToFailedCommand(-1)` 把视口移到该行；再按一次返回 false（没有更早的失败），`+1` 也返回 false（落点之后没有失败）——不存在的跳转必须**报告走不通**，而不是原地打转。

浏览器 commandExitStatus 2/2（第二条）：用真实和弦 `Ctrl+Shift+P` 打开命令面板，输入 previous failed 后**列表里确实有** Previous Failed Command（无默认和弦的命令照样进面板），点击后视口落在失败命令行；再走一次则状态栏说 No failed command to jump to。这一条第一次尝试用的是猜测的选择器（`.palette input`），失败后按真实 DOM（`.command-palette-*`）重写，并把语言在用例内固定为英文——否则标签是中文，按英文找必然落空。

## 四、边界

- 默认不绑键（可在设置里绑定）；
- 只在当前活动标签内走查；
- 没有「失败命令列表」面板。