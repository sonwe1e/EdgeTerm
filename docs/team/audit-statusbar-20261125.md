# 审计：状态栏与资源监视（2026-11-25 第 177 轮）

只读审计，范围：状态栏、资源监视、`src/monitor/*`、两语言 monitor.*/status.* 键。2 条，**本轮已修**。

| 编号 | 问题 | 位置 | 状态 |
| --- | --- | --- |
| ~~SB1~~ | 压力色**永远到不了数字**：CPU 96%／内存 98% 时，大字读数、加速器行读数、状态栏簇数字都还是普通前景色，只有那块 30×12 的装饰性迷你图变琥珀/红 | `ResourceMonitorBar.tsx:85,145,399` 的 `metric-${tone}` 在 `monitor.styles.css` 里**没有对应规则** | 已修：补 `.metric-warn`/`.metric-crit`（复用 `.spark.tone-*` 已有的 token）；`ResourceMonitorBar.test.ts` 直接读样式表断言规则存在（删掉规则即红）。规则曾在实验 workbench 的样式表里存在过，workbench 被删时没跟过来 |
| ~~SB2~~ | 每台普通 Linux 服务器的资源浮层都写着「GPU 不可用 · NPU 不可用」，而代码自己的注释说「设备缺席应当沉默」 | `ResourceMonitorBar.tsx:54-57` 与 42-43 的映射 | 已修：只有传感器真的被拒绝或查询失败才显示该行；新用例断言 `unsupported` 时浮层不提「不可用」（去掉门槛即红），既有的 `denied` 用例证明该行仍为真失败而存在 |

## 确认无缺陷

- 迷你图与数字一致：`usedOf` 与 `trendPointFrom` 用同一套百分比算法；最后一个历史点恒等于显示值；后端所有利用率路径都夹到 ≤100，`sparkPaths` 的夹取不会与 `percent()` 矛盾。
- 采样间隔文案与调度器一致（1..30 秒）；`TREND_LIMIT = 60` 没有被任何文案说成一段时间跨度。
- 读数不会静默变旧：`document.hidden` 路径在恢复时清空样本与历史，而不是显示一个死数字；轮询失败会置 `error`、`is-stale` 与浮层原因。
- 重连后的趋势：重连只从 `closed`/`error` 触发，会翻转 `eligible` 并重置趋势；后端拒绝跨传输的差值，`sparkPaths` 在 null 处断线而不是搭桥。
- 两语言 28 个 monitor.* 与所有 status.* 键都存在且一致。
- 提示文案：`detailTitle` 点名 Disk I/O 与发送方向，那正是它的职责（「一行放不下的都在这」）。

边界：静态读源码 + `git log -S` 考古；SB1 的真实视觉效果（琥珀/红是否可读）未在实机点检。

