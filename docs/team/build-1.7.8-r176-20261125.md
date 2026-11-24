# 构建记录：1.7.8（第 176 轮，2026-11-25）

第 175 轮那版（`3BBDD882…`）之后落了 Git 审计 3 条。**以本记录为准**。

| 项 | 值 |
| --- | --- |
| 提交 | `f72b59f`（`git status` 干净） |
| 版本 | 1.7.8（未升版） |
| 安装包 | `src-tauri/target/release/bundle/nsis/EdgeTerm_1.7.8_x64-setup.exe` |
| 大小 | 4,259,803 B（4.06 MiB） |
| SHA-256 | `57F502EDAE7C4B9F0415D9257C40946D86E8C10CC21C2FA3AE04D6EBFC1E4FEE` |

## 构建前验证（同一提交）

- `npm run test:rust`：547 通过，32 ignored。
- `npm run verify`：`VERIFY_EXIT=0` —— 单测 221 文件／1983 用例，浏览器 72 文件／342 用例。
- `npm run check:commits -- 4601884..HEAD --typecheck`：3 commits，0 errors，0 warnings。
- `npm run tauri:build`：`BUILD_EXIT=0`。

## 与上一版（`3BBDD882…`）的差别

- **冲突审查不再是个灰框**：合并／变基冲突走 `git diff --cc`，此前解析器只认单父差异，行号、配色、hunk 导航、并排视图整套丢失。
- **长变更列表**：选中行不再被追加到最后一行之后（顺序错乱、方向键断头）；翻到最后一页后焦点交给选中行而不是 document body。
- **冷历史回填**：查找框现在会被告知（此前高亮差一行、新行不计入结果）。

## 未验证的边界

- 只在 Windows x64 构建；未做安装／升级／卸载自动化。
- 冲突审查的修复按 `git diff --cc` 的格式推演，**未在真实冲突仓库中点检**渲染效果。
- Git 变更列表的两条**没有独立用例**（列表在 workspace 对话框里，没有 jsdom 装置）。
- 第 160–176 轮审计共 **35 条**已全部交付；仍无用例的条目逐条写在提交信息与各审计记录里。

