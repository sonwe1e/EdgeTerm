# 复制上一条命令 / 它的输出（2026-11-22 第 7 轮）

终端里最高频的二次操作是"把刚才那条命令的输出拿走"——贴进工单、发给同事、写进笔记。此前只能先用鼠标精确划选，多行输出常常连提示符一起复制走。本轮补上两条命令：

| 命令 | 结果 |
| --- | --- |
| 复制上一条命令的输出 | 只复制命令打印的行，不含回显的命令行、不含随后出现的提示符 |
| 复制上一条命令行 | 只复制命令本身 |

入口：**Edit 菜单**与**命令面板**（中英文都可搜到）。两条命令在无可用内容时给出状态栏说明，而不是静默失败。

## 一、实现

- **范围用 marker 记录，不用行号**（[terminalCommands.ts](../../src/terminalCommands.ts)）：提交时记下命令行的 marker；提示符返回时再记一个 marker 指向新提示符的行。marker 会随回滚裁剪、历史前置一起移动；被裁剪掉时 marker 自己报告 `isDisposed`，命令返回 null 而不是复制别的行。
- **只针对 shell 命令**：agentic CLI 的一轮对话不算"我跑的命令"，不记录。
- **边界由行确定**：输出 = `(命令行, 新提示符行)` 之间的行；空输出直接拒绝（返回 false → 状态栏说明），**不清空剪贴板**——一条没有输出的命令不该抹掉上一次复制。
- **行分隔符保留 CRLF**：与终端内容和其他客户端一致。
- 剪贴板写入走与 Copy 相同的 `writeSystemClipboard`（Windows/macOS 由进程写）。

## 二、验证中发现的真实缺陷

初版用了 `selectLines(start, length)`，**实际签名是 `selectLines(start, end)`，两端都是 0 基闭区间**（xterm 的 typings 写明"between 2 lines"）。单行输出时 `(1, length=1)` 恰好等价，测试会误通过；两行输出的用例立刻暴露了问题（复制到空行）。已改为 `selectLines(first, last)`，并在测试里固定"两行输出 + 提示符"的形态。

另外：`Copy Last Command` 与 `Copy Last Command Output` 共享前缀，命令面板对同一查询会并列匹配；把前者改名为 **Copy Last Command Line**，靠标签本身消除歧义，而不是依赖排序。

## 三、验证

- `src/test/commandCopy.browser.test.ts` 3/3：真实 App + 真实 xterm + 真实键入（夹具扮演 shell 的回显与提示符）；复制输出、复制命令行、随最新命令更新、CRLF 保留、无命令时拒绝并给状态。
- 全量：前端单测 174 文件／1719 用例、浏览器契约 46 文件／235 用例、typecheck、format:check（519 文件）、lint（仅生成绑定 2 条既有警告）、生产构建全部通过。

## 四、边界

- 命令结束依赖提示符识别（`terminalPrompt.ts` 的启发式），未接入 shell integration 的远端 shell 也按同样规则工作；程序重画提示符导致的提前结束是既有行为。
- 命令滚出回滚缓冲后返回 null（拒绝复制），不会复制错位文本。
- 暂无快捷键；入口是 Edit 菜单与命令面板。
