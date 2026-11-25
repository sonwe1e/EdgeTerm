# 构建记录：1.7.8（第 212 轮，2026-11-25）

第 211 轮那版（`C8234D4D…`）之后修了一条中的严重一半。**以本记录为准。**

| 项 | 值 |
| --- | --- |
| 提交 | `04ac270`（`git status` 干净） |
| 版本 | 1.7.8（未升版） |
| 安装包 | `src-tauri/target/release/bundle/nsis/EdgeTerm_1.7.8_x64-setup.exe` |
| 大小 | 4,263,869 B（4.06 MiB） |
| SHA-256 | `09FD30A7050F320AA760B53FC123BCF6AA15131F36A41709374D449B8270A60E` |

## 构建前验证（同一提交）

- `npm run test:rust`：549 通过，32 ignored。
- `npm run verify`：`VERIFY_EXIT=0` —— 单测 **224 文件／2003 用例**（比上一版多 1 条），浏览器 75 文件／351 用例。
- `npm run check:commits -- 8fcdfa2..HEAD --typecheck`：1 commit，0 errors，0 warnings。
- `npm run tauri:build`：`BUILD_EXIT=0`。
- **负对照**：把选择器改回两个名字 → 新用例红、其余 3 条绿 → 恢复 → 4 条全绿。红绿都只落在新用例上。

## 与上一版（`C8234D4D…`）的差别

**窗口级快捷键不再在发送面板的「查找已存命令」浮层底下触发。**

那个浮层是全应用唯一手搓的 `role="dialog"`——一个普通 div，不是原生对话框。`surfaceOwnsKeyboard` 的选择器是 `dialog[open], .context-menu`，div[role=dialog] 两个都不匹配。于是焦点在它某一行上时，Ctrl+Tab、Alt+N、Ctrl+Shift+T、F6 **全在底下执行**，而它依然浮在结果上面。

选择器现在也认 `[role="dialog"]`。

## 这条缺陷为什么只修了一半

A3 有两半：快捷键穿透（严重）和焦点不收容（不便——Tab 从最后一行走到背后的面板且它不关）。改选择器只治前一半，但**改动面是一个字符串加一个用例**；改走 `ModalDialog` 原生原语要重写这个浮层的定位、锚点与 `sender-more-menu` 的样式钩子，风险高得多。先用一行治严重的那半是合理的次序，**剩下半条明确记录在案**。

## 未验证的边界

- 只在 Windows x64 构建；未做安装／升级／卸载自动化。
- 这条修复**没有端到端用例**（负对照是单元级的：证明选择器认这个 div，没有证明一次真实快捷键被拦下）。
- 剩下半条：这个浮层仍是 div，Tab 会漏出去。
- 第 160–212 轮审计共 **80 条**，已修 **79.5 条**。

