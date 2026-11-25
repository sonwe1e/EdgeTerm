# 构建记录：1.7.8（第 203 轮，2026-11-25）

第 202 轮那版（`A8DBD732…`）之后修了两条。**以本记录为准。**

| 项 | 值 |
| --- | --- |
| 提交 | `f040904`（`git status` 干净） |
| 版本 | 1.7.8（未升版） |
| 安装包 | `src-tauri/target/release/bundle/nsis/EdgeTerm_1.7.8_x64-setup.exe` |
| 大小 | 4,260,053 B（4.06 MiB） |
| SHA-256 | `304E83EF36A0B3DC2EC6E37DA2DA2695F0E03F162FB7674031B1972E009CB9FC` |

## 构建前验证（同一提交）

- `npm run test:rust`：549 通过，32 ignored。
- `npm run verify`：`VERIFY_EXIT=0` —— 单测 224 文件／**2002** 用例，浏览器 75 文件／351 用例。
- `npm run check:commits -- 7a127df..HEAD --typecheck`：1 commit，0 errors，0 warnings。
- `npm run tauri:build`：`BUILD_EXIT=0`。

## 与上一版（`A8DBD732…`）的差别

**一、互为主父的两个文件夹不再连同里面的会话一起消失。** `effectiveParentId` 的规则本来覆盖父级「不存在」「跨类」「是自己」，据此把组放到类型根而不是让它 silent 消失——但没覆盖「父级自己的链成环」。`childGroups` 从类型根往下走、只穿过有效父级为 `null` 的组，环里两组都不合格，于是树永远访问不到它们。连锁后果全在同一个失败里：文件夹消失且没有空状态、会话也消失而分区计数不再与后端一致、无法从面板连接那些会话也无法右键修复、`SessionDialog` 的分组下拉显示「(无分组)」。现在父级链走不到类型根就视为「无父级」，与后端 `detach_invalid_parents` 同规则。

**二、编辑器正文重新进入 Tab 环。** 对话框的 Tab 环由一个选择器列表构件，而 CodeMirror 的正文是 `div.cm-content`——只有 `contenteditable="true"`／`role="textbox"`、**没有 `tabindex`**，匹配不上任何一项；应用又装了 `indentWithTab`，正文里 Tab 只插缩进。可达路径：Ctrl+F 打开查找面板后 Tab 走到页脚的 Reload/Close/Save，之后 Tab 只在页脚里循环，所有编辑器快捷键全部失效（Ctrl+F 的处理器挂在编辑器 DOM 上，不是页脚按钮的祖先）。此时唯一的回头键 Escape 会弹出「放弃未保存的更改并关闭编辑器？」——一次本能的 Enter 毁掉草稿。

## 未验证的边界

- 只在 Windows x64 构建；未做安装／升级／卸载自动化。
- 分组环的**可达性是代码路径推断，不是端到端复现**：UI 自身造不出环（`save_group` 拒绝把父级设成自己子树里的组），需要手改或外部写入 `session_groups.json`。这个代码库明确为手改文件设计，所以这条路真实存在，但我没有在实机上跑出来。
- 编辑器那条**没有独立用例**（需要一次真实的 Tab 序列）。
- 待办 1 条：E2（重新载入文件会静默销毁查找面板并清掉查询词），属编辑器状态保存，单独立项。
- 第 160–203 轮审计共 **75 条**，已修 **74 条**。

