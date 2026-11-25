# 构建记录：1.7.8（第 223 轮，2026-11-25）

第 222 轮那版（`6B9BF981…`）之后修了代码质量审计 C5 的第一批。**以本记录为准。**

| 项 | 值 |
| --- | --- |
| 提交 | `8e5c159`（`git status` 干净） |
| 版本 | 1.7.8（未升版） |
| 安装包 | `src-tauri/target/release/bundle/nsis/EdgeTerm_1.7.8_x64-setup.exe` |
| 大小 | 4,263,395 B（4.06 MiB） |
| SHA-256 | `ED79721F777E5617F92F880DFEBD7AE2F3F3A51ACE3CE7D73EDAF24B3DF1E6DF` |

## 构建前验证（同一提交）

- `npm run test:rust`：549 通过，32 ignored。
- `npm run verify`：`VERIFY_EXIT=0` —— 单测 224 文件／2001 用例，浏览器 75 文件／351 用例。
- `npm run check:commits -- 0b2f52d..HEAD --typecheck`：1 commit，0 errors，0 warnings。
- `npm run tauri:build`：`BUILD_EXIT=0`。

## 与上一版（`6B9BF981…`）的差别

**八个助手不再宣称自己是模块 API。**

1,339 个非测试导出里有 112 个没有任何导入方。`export` 读作「这是模块的公开面」，于是读者分不清哪些是契约、哪些是遗留。本轮删掉 8 个的 `export` 关键字——`isRendered`、`workspaceTitle`、`entryKindLabel`、`paneCounter`、`endingText`、`sendCommandToSession`、`isFontInstalled`、`PALETTE_GROUPS`。**每个都仍在自己的模块内部被使用**（`tsc` 零错误且 `noUnusedLocals` 没响），删的只是那句宣称。`export let paneCounter = 0`  additionally 不再暴露无人消费的可变模块状态。

**审计点的第 9 个是错的。** 它报 `languageFor` 没有导入方；删掉关键字后 `tsc` 立刻报它的测试就是导入方。已还原。这不是我纠正了审计，是编译器纠正了我们两个。

## 未验证的边界

- 只在 Windows x64 构建；未做安装／升级／卸载自动化。
- 本轮只删关键字，**不改变任何产品行为**。
- **C5 只做了 8/112。** 剩下 104 个各需一次「删→跑 tsc」验证；投入产出比（读者能分清哪些 export 是契约）留待判断，本轮不硬做。
- 代码质量审计最后一条未修：C1 拖拽生命周期整体重复（约 80 行，`Splitter` 与 `FilerColumnResizer`，UI 里最微妙的正确性面）。
- 第 160–223 轮审计共 **95 条**，已修 **92 条**（C5 记 0.5，因其只做了 8/112）。

