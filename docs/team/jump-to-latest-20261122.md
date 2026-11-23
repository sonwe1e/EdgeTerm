# 跳到最新输出（2026-11-22 第 24 轮）

终端在跑长任务、用户往回翻看日志时，新输出会不断把底部推开。此前唯一的回到底部方式是拖动滚动条或按 End——两者都要先把焦点放回终端。

本轮加一个只在有用时出现的入口：视口离开最新一行时，右下角浮出 **Jump to latest output** 胶囊；点击即可回到实时输出并收起自己。

## 一、实现

| 位置 | 作用 |
| --- | --- |
| TerminalController.isAtBottom() | viewportY ≥ baseY 即“在最新一行” |
| scrollToBottom() | 回到实时输出的唯一入口 |
| onScrollState(listener) | 同时监听滚动与写入：输出把底部推远时也要通知 |
| 胶囊 | 仅在离开底部时渲染；mousedown 被吞掉，点击不会把焦点从终端抢走 |

## 二、验证

jumpToLatest.browser.test.ts 1/1：

1. 实时输出时**没有**胶囊；
2. 向上滚动 40 行后出现，且 viewportY 确实小于 baseY；
3. 高度 ≥ 24px（不是发丝线），aria-label 为 Jump to latest output，且完全落在视口内；
4. 点击后 viewportY 回到 baseY，胶囊消失。

全量：前端单测 179 文件／1736 用例、浏览器契约 58 文件／257 用例、typecheck、format:check（540 文件）、lint（仅生成绑定 2 条既有警告）、生产构建全部通过。

## 三、边界

- 只覆盖终端缓冲区；文件面板的滚动不在此列；
- 没有键盘和弦（胶囊本身可 Tab 到达并回车）；
- 只覆盖 Chromium。
