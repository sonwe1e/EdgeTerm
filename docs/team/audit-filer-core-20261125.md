# 审计：Filer 面板核心（2026-11-25 第 181 轮）

只读审计，范围：`FilerPanel.tsx` 及其驱动的 hook（`useFilerDirectory`／`useFilerActions`／`useFilerDrag`／`useFilerUpload`／`useFilerDownloads`／`useFilerTransfer`／`filerPresentation`／`VirtualFileRows`／`useFileSelection`／`fileSort`／`useFileListKeyboard`／`FileIcon`），与既有测试及后端 `fs_local.rs`／`session/mod.rs` 的契约对照。3 条，**本轮已修 3 条**。

| 编号 | 问题 | 位置 | 状态 |
| --- | --- | --- | --- |
| ~~F1~~ | 在文件夹行上按下并抖动几像素，该行就成为**自己的放置目标**，松手后发起一个「把文件夹移进自己」的重命名，报错而不是什么都不做 | `useFilerDrag.ts:387` 的几何命中 + `useFilerActions.ts:587` 只排除「已在该文件夹」 | 已修：`moveEntries` 的过滤加一条「目标等于自身」即视为「已在该文件夹」。同情境的父级面包屑早已是安静的无操作并有测试，这是那条规则没覆盖的另一半 |
| ~~F2~~ | 在「此电脑」可以把一个盘拖到另一个盘上，等于要求后端**把整个卷重命名成另一个盘上的文件夹** | `useFilerActions.ts:571` 的 `moveEntries` 没有 `atDrivesRoot` 守卫 | 已修：`moveEntries` 开头加 `if (atDrivesRoot) return;`。该标志本就在 `Options` 里，且相邻手势（`useFilerDrag.ts:270`／`:153`）早已用它 |
| ~~F3~~ | UNC 路径的第一个面包屑指向相对的 `server\` 而不是共享本身，点它导航到一个不存在的路径 | `filerPresentation.tsx:305` 的 `target = ""` 只对盘符正确 | 已修：UNC 路径的第一个停止点改为共享本身（`\\server\\share`），后续从共享继续拼接。新增用例 |

## 确认无缺陷

- 跨目录的选择：所有导航都经 `load`（`clearSelection()`），离线分支也清；`useFileSelection` 按路径为键，旧路径不可能匹配新列表。
- 排序稳定性：`sortFileEntries` 是全序（目录优先、键、再 `compareNames` 的精确拼写决胜），刷新不会换行；`sameListing` 在无变化时保持数组同一性。
- 键盘跳行：`moveActive` 与 `useFileListKeyboard.moveTo` 都夹在 `[0, length-1]`，`revealActiveRow` 先滚动再指向 `aria-activedescendant`。
- 重命名/删除目标：`commitRename` 用 `draft.entry.path` 作源，目标由 `joinRemote`/`joinLocal` 构建（会去掉尾部分隔符），所以目标始终落在该条目自己的目录里。
- 语言：`filer.*` 键两语言 1:1（各 167 个），离线/错误/空文件夹/无匹配四态都配了消息与动作，盘符根哨兵已本地化而比较仍用内部常量。

边界：静态读源码，未在真实桌面点检；F1/F2 的拖拽行为未在浏览器测试里复现（需要真实的指针放置序列）。

