# 审计：设置与菜单的键盘可达性（2026-11-24 第 158 轮）

只读审计，范围：ModalDialog.tsx、SessionDialog.tsx、SettingsDialog.tsx、MenuBar.tsx、ContextMenu.tsx、FilerPanel 菜单。5 条，**本轮全部交付**（第 159 轮）。

| 编号 | 问题 | 位置 | 代价 |
| --- | --- | --- | --- |
| ~~SK1~~ ✅ | ModalDialog 的 Tab 陷阱不认 `<summary>`，焦点落到会话对话框的「高级」「组织」折叠标题后，正向 Tab 被拦回第一个可聚焦元素（关闭按钮），下半个表单和页脚的保存／连接按钮**永远 Tab 不到** | `ModalDialog.tsx:308` 的 `[tabindex]` 列表 vs `SessionDialog.tsx:1495` | 小（选择器补 `summary`，已有的 `getClientRects()` 过滤会正确排除折叠中的） |
| ~~SK2~~ ✅ | 「恢复默认设置」的确认文案点了一个已不存在的「工作台状态」，却没提它真正会清掉的两样：**发送命令库**和**每个会话的启动命令** | `en.ts:407`／`zhCN.ts:391`、`storePreferenceActions.ts:390-391`、`settings.restoreNote` | 小（改写一句确认文案，两语言各一份） |
| ~~SK3~~ ✅ | 小窗口高度下菜单下拉没有高度上限也不滚动，「视图」菜单最后的「设置…」「键盘快捷键…」画在窗口外，**键盘也够不到** | `MenuBar.tsx:1406`、`shell.styles.css:198` | 小（`max-height: calc(100vh - 40px); overflow-y: auto`） |
| ~~SK4~~ ✅ | 在会话对话框按「保存」时，右侧的**连接**按钮变成「正在连接…」并转圈，而刚按的保存按钮只是变灰 | `SessionDialog.tsx:1653` vs `:1643` | 小（记录哪个动作在跑，各用各的文案） |
| ~~SK5~~ ✅ | 两个对话框的 `aria-labelledby` 指向含关闭按钮的标题栏，屏幕阅读器念出的名字末尾带一个「Close」 | `SessionDialog.tsx:970`、`SettingsDialog.tsx:262` | 小（给标题文本自己的 id） |

## 审计确认「无缺陷」的部分

- ContextMenu 与 FilerPanel 菜单：外部滚动关闭、内部滚动重新定位、方向键不跑出菜单、Delete/F2/Enter 都走确认。
- 保存中不会被误关：`SessionDialog.onClose` 的守卫覆盖 Esc、背景与标题栏，页脚取消按钮也禁用。

修复：SK1／SK4／SK5 = `9096299`（Tab 陷阱收 `summary`；`busyAction` 让被按的按钮报等待；标题自己带 id），SK2 = `0107d77`（两语言文案），SK3 = `fd38442`（下拉限高并滚动）。五条都**没有独立用例**：Tab 陷阱在本仓库没有单测装置，文案与样式也没有。

边界：静态读代码，未在真实屏幕阅读器或 768p 窗口下复现。

