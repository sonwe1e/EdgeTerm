# 审计：传输中心（2026-11-25 第 181 轮）

只读审计，范围：`TransferCenter.tsx` 及其组合的组件、`transfer*.ts`、两语言 `transfer.*` 键。3 条，**本轮已修 3 条**。

| 编号 | 问题 | 位置 | 状态 |
| --- | --- | --- |
| ~~TC1~~ | 取消「清除中断？」这个批量问题，键盘焦点掉到 document | `TransferCenter.tsx:787` 的 Cancel 没有交还焦点 | 已修：触发器加 `data-clear-interrupted`，Cancel 在 `requestAnimationFrame` 里把焦点还给它。**注意**：上一轮记录与提交信息声称 TC4 已同时覆盖两个批量横幅，实际只接了「清除失败」那条——本条修正那个不实 claim |
| ~~TC2~~ | 清除**一条**中断记录后，焦点被送到一个无关控件（置顶按钮，或几行之外的另一个清除），而不是下一条中断记录 | `focusAfterClear`（`:357-366`）只知道任务队列的目标 | 已修：新增 `focusAfterInterruptedClear`，先回该分区自己的动作，列表空了才回落到原链路 |
| ~~TC3~~ | 一个失败文件被报成「1 failed files」 | `en.ts:1354` 只有复数形式，且 `transferSettings.browser.test.ts:113` 把这个wart 钉住了 | 已修：加 `transfer.failedFilesCountOne`（两语言），`count === 1` 时选用；同步更新那条测试 |

## 确认无缺陷（有证据）

- ETA/速率算式：remaining 只数 running/queued/retrying，rate 只数 running（0ba5aee）；`transferBytes` 在 1024.0 KiB 边界带单位（ed2e0f5）。
- 文件计数与行一致：`sftp.rs:1018-1020` 与 `ftp.rs:227-229` 在第一个字节前就登记了每个计划文件。
- 暂停/恢复/重试/取消/清除按钮矩阵与 `manager.rs::control` 的守卫逐状态对应，含 cancelling 与带错误的 cancelled（「重试清理」会重跑 `worker.rs:22-35` 的清理）。
- 已完成任务不会显示不确定进度条（`transferIndeterminate` 要求 status 为 running）。
- `transfer.active` 与 `quit.transfers`（「包括暂停的任务」的差别是有意的。
- 每个 `transfer.*` 键两语言都有且占位符一致；设置上下限与 `Options::validate`（1-32／16-256／1-32／0 或 1 KiB/s–1 GiB/s）相符。

## 边界与未报项

- `VirtualFileRows` 只对 200 行以上开窗，且任务滚动容器不可键盘聚焦，所以 201+ 排队任务时窗口外的行无法单用键盘到达——但审计者无法构造出真实的 200+ 任务路径（一个任务对应一次 Filer 选择），且该组件 Filer 也在用，故不作猜测性上报。
- 重试时 `sftp.rs` 的 `plan()` 会在每条lane 恢复检查点前把每个文件按 offset 0 重新登记，所以行的字节数与进度条会 visibly 归零再爬回——这是后端如实的记账，不在本轮文件范围。
- `transferForward.browser.test.ts` 的夹具用 status `failed`，而后端只发 `error`，导致 `STATUS_LABEL`/`STATUS_TONE` 对该夹具走兜底——仅测试内，用户不可见。

