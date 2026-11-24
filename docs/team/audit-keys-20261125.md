# 审计：全局快捷键与键位表（2026-11-25 第 178 轮）

只读审计，范围：窗口级 keydown、`src/shortcuts.ts`、快捷键参考界面、两语言 sc.*/keys.* 键。5 条，**本轮已修 4 条，1 条（K5 的实机 Mac 验证）留待说明**。

| 编号 | 问题 | 位置 | 状态 |
| --- | --- | --- | --- |
| ~~K1~~ | 右键菜单或菜单栏下拉打开时，全局快捷键照样触发，而菜单**不被关闭**——窗口在菜单脚下变了，菜单的锚点与各项的启用状态还是打开时那一快照 | `App.tsx:810` 只挡 `dialog[open]`；两种菜单都是 portal 里的 div | 已修：抽出 `surfaceOwnsKeyboard`（`menuKeyboard.ts`）供 App 与 MenuBar 共用；ContextMenu 增加「自己不处理的键即关闭」。`menuKeyboard.test.ts` 三条用例 |
| ~~K2~~ | Windows 的保留和弦表是**空的**，录制器接受 Win+key、Alt+Tab、Alt+F4、Ctrl+Esc、Alt+Space、Ctrl+Alt+Del——命令静默死亡，而设置对话框、菜单、命令面板都还在宣传它 | `shortcuts.ts:518` 的 `: []` | 已修：补 6 条 Windows 条目，复用既有 `sc.reserved` 文案与新的 `sc.ownerWindows*` 键；`parseShortcuts` 的拒绝路径同时覆盖已存与导入的表 |
| ~~K3~~ | 快捷键参考里「文件列表」那一组列了 F2／Delete／Backspace／Ctrl+A，而 FTP/SFTP 双栏文件列表**一个都没绑** | `keyReference.ts:32-63` | 已修：组名改为「Filer 面板按键」（该组描述的确实是 Filer 面板的键）。**未**给 FTP 列表补绑定——那是一个功能改动，不是缺陷修复，单独立项 |
| ~~K4~~ | 三个面板切换的提示写着「左侧／右侧／底部面板」，而面板可以拖到任何 dock，动过一次之后提示就与和弦实际做的事相反 | `en.ts:1253-1257` | 已修：改为「{panel} 面板」，用 `panel.sessions/filer/sender` 填充 |
| ~~K5~~ | 编辑器提示硬编码「Ctrl+S 保存，Ctrl+F 查找」，而编辑器绑的是 CodeMirror 的平台感知 Mod——Mac 上是 Cmd+S/Cmd+F | `en.ts:710-713` | 已修：改为 `{save}`／`{find}` 占位符，用菜单同一个 `chordLabel` 填充。**Mac 实机未验证**（本分发只出 Windows x64 包） |

## 确认无缺陷（有证据，非推测）

- 两语言 105 个 sc.*/keys.* 键完全一致，没有参考行会渲染出裸键。
- 两个平台的默认和弦互不冲突：按 `SHORTCUT_COMMANDS` 顺序走 `MAC_DEFAULTS` 与 `OTHER_DEFAULTS`，各得 33 个不同标签；四个未指派命令在两个平台都未指派（`shortcutCensus.test.ts` 断言）。
- Windows 上不会渲染 Mac 专用符号：src 里每个 ⌘/⌥/⇧/⌃ 都在 `IS_MAC` 分支或注释里。
- 没有依赖按键顺序的和弦：`chordMatches` 比较修饰键快照；MenuBar 的 Alt 跟踪器在 Ctrl/Shift/Meta 已按下时标记 altChord，并且对之后的任意键也标记，所以 Alt+N、Ctrl+Alt+Arrow、AltGr 两种顺序都能压制菜单切换。
- 录制器与对话框不打架：`ModalDialog` 默认 closeOnEscape 为 true，而 `onRecordedKey` 在原语的分支测试 `!event.defaultPrevented` 之前先 preventDefault，所以 armed 状态按 Escape 只取消录制（有用例）。
- 快捷键在会重载它们的界面上也活着：数据导入走 `store.applySettings -> setShortcuts -> setActiveShortcuts`；恢复默认设置会删 `SHORTCUTS_KEY`，命令式匹配器不会与 store 失步。
- 参考界面为 Filer 面板宣传的每个键都真的绑着：F2、Delete、Backspace、Enter、Ctrl+A 在 `FilerPanel.tsx` 都有分支，且都限定为无修饰键。

边界：静态读源码。K1 的「菜单在脚下关闭」未在真实桌面点检；K5 的 Mac 修饰键未实机验证。

