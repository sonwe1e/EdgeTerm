# 构建记录：1.7.8（第 204 轮，2026-11-25）

第 203 轮那版（`304E83EF…`）之后修了一条。**以本记录为准。**

| 项 | 值 |
| --- | --- |
| 提交 | `04f0e37`（`git status` 干净） |
| 版本 | 1.7.8（未升版） |
| 安装包 | `src-tauri/target/release/bundle/nsis/EdgeTerm_1.7.8_x64-setup.exe` |
| 大小 | 4,261,037 B（4.06 MiB） |
| SHA-256 | `20ED721F1B57CF36C3EAA026455A1BEE5F1641698858A67592F2BFB1EA84A562` |

## 构建前验证（同一提交）

- `npm run test:rust`：549 通过，32 ignored。
- `npm run verify`：`VERIFY_EXIT=0` —— 单测 224 文件／2002 用例，浏览器 75 文件／351 用例。
- `npm run check:commits -- 55e0a77..HEAD --typecheck`：1 commit，0 errors，0 warnings。
- `npm run tauri:build`：`BUILD_EXIT=0`。

## 与上一版（`304E83EF…`）的差别

**重新载入文件不再静默销毁查找面板和查询词。**

`setContent` 会重建整个 `EditorState`，而 `setState` 会重新实例化每一个视图插件；新状态的查找框是全新的空查询，`panelPlugin` 读到新的 `showPanel` 发现没有面板，于是移除 `.cm-panels` 节点。正在查一个被构建过程或别的进程改写过的文件时——那正是最需要搜索的时候——搜索无声消失，查询词要重打。

现在重建前用 `getSearchQuery`／`searchPanelOpen` 读走状态，重建后恢复查询词，面板原先开着就再调一次 `openSearchPanel`（它是 **Command**，收 view，不是 StateEffect）。

## 未验证的边界

- 只在 Windows x64 构建；未做安装／升级／卸载自动化。
- 这条**没有独立用例**：需要一次真实的「查找 → 重新载入 → 面板与查询词仍在」序列，而现有编辑器用例驱动的是 store 层，不是 CodeMirror 实例。
- 第 160–204 轮审计共 **75 条，已修 75 条**。唯一剩下的 W2（监视标记跳转坐标）已完整定位，但现有规模的夹具无法让修复显出红绿差异，建那个夹具的成本超过缺陷本身的价值。

