# 审计：传输中心与设置／数据面（2026-11-24 第 154 轮）

只读审计，范围：`TransferCenter.tsx`、`fileTransfers.ts`、`transferPresentation.ts`、`transferSettings.ts`、`SettingsDialog.tsx`、`dataTransfer.ts`、`storePreferenceActions.ts`、`storePreferences.ts`、`persistKeys.ts`、`file_transfer/{manager,worker,control,job}.rs`。

## 已全部交付（第 155 轮，5 条都是「控件消失但焦点没交代」）

| 编号 | 问题 | 位置 | 代价 |
| --- | --- | --- | --- |
| ~~TC1~~ ✅ | 按下暂停／继续后，被按的那个按钮立刻消失（`pausing` 不在渲染列表里，`paused` 只渲染继续），焦点掉到页面，随后第一次 Tab 会让弹层因焦点离开而关闭 | `TransferCenter.tsx:538`、`manager.rs:263` | 小（`control()` 成功后把焦点交给同行的下一个动作，复用 `cancelConfirm` 的 `panelScope()` 写法） |
| ~~TC2~~ ✅ | 「已中断」列表里的单条 Clear 删掉持有焦点的行后不交代焦点；同一动作的批量版已经会 `focusAfterClear()` | `TransferCenter.tsx:788` vs `:262` | 极小（`forget()` 结尾补 `focusAfterClear()`） |
| ~~TC3~~ ✅ | 关闭失败文件区的 ✕ 随区块一起消失，焦点掉到页面，而持有 `aria-expanded` 的「N failed files」开关就在旁边却没被聚焦 | `TransferCenter.tsx:651`、`:625` | 小（复用本文件已有的 `detailTrigger` / `closeDetail` 写法） |
| ~~TC4~~ ✅ | 取消「Clear failed」／「Clear interrupted」确认条时，确认条连焦点一起消失，没有回到打开它的头部按钮 | `TransferCenter.tsx:494`、`:740` | 小（`requestAnimationFrame` 后聚焦 `.transfer-head-action`） |
| ~~TC5~~ ✅ | 收起传输「设置」区块会把焦点从刚按的 summary 抢到「Pin to bottom」——该 effect 的本意是弹层打开时定位焦点，却在每次 `settingsOpen` 变化时也运行 | `TransferCenter.tsx:128-129` | 小（用上一次值的 ref 守住 `else` 分支） |

## 明确「无缺陷」的部分

- **导出／导入没有漏项**：`AppSettings` 24 个字段全部导出，`applySettings` 全部应用，除两个刻意保护的键（`IMPORT_PROTECTED_SETTINGS`），并由 `dataTransfer.ts` 回报为「保留」；`preferences` 走同一份 `PANEL_PREFERENCE_KEYS` 清单。
- **恢复默认设置没有残留**：`storePreferences.ts` 导出的每个 `*_KEY` 都被移除（含本轮新增的 `CLOSE_ACTION_BEFORE_TRAY_KEY`）；唯一未被移除的 `edgeterm.workspace.v1` 是会话状态而非偏好。
- **数值与后端一致**：界面上下限与 `Options::validate` 完全一致（请求 1–32、块 16–256 KiB、文件 1–32、速率 0 或 1 KiB/s–1 GiB/s）；暂停／继续／取消／忽略的按钮矩阵与 `manager.rs::control` 的守卫逐状态对应，含 `cancelling` 与带错误的 `cancelled`。

修复（`b7fa1c1`）：暂停／继续后焦点交给同行的 Cancel；单条清除后走 `focusAfterClear()`；关闭失败文件区回到持有 `aria-expanded` 的开关；取消批量确认回到头部按钮；弹层只在打开时定位焦点，收起设置区块不再抢走焦点。

边界：以上判断来自读代码，没有在真实桌面里点检。5 条都属「控件消失必须交代焦点」这一既有约定的缺口，不是审美偏好。

