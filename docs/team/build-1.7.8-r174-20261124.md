# 构建记录：1.7.8（第 174 轮，2026-11-24）

第 173 轮那版（`D78C699B…`）之后修掉了历史审计最后一条 H1。**以本记录为准**。

| 项 | 值 |
| --- | --- |
| 提交 | `467891d`（`git status` 干净） |
| 版本 | 1.7.8（未升版） |
| 安装包 | `src-tauri/target/release/bundle/nsis/EdgeTerm_1.7.8_x64-setup.exe` |
| 大小 | 4,262,940 B（4.06 MiB） |
| SHA-256 | `9CC7A413AA4FE701556739EA75ED912763DF4D0DA6989A2CF54A8F0DFF06E26D` |

## 构建前验证（同一提交）

- `npm run test:rust`：547 通过，32 ignored。
- `npm run verify`：`VERIFY_EXIT=0` —— 单测 219 文件／1974 用例，浏览器 72 文件／342 用例。
- `npm run check:commits -- 4c8bab7..HEAD --typecheck`：2 commits，0 errors，0 warnings。
- `npm run tauri:build`：`BUILD_EXIT=0`。

## 与上一版（`D78C699B…`）的差别

- **行号在重排后不再虚高**：改变窗口宽度把满缓冲的旧行挤出顶部时，排水沟行号现在跟着前进；OSC 7 的目录归属也不再因此把旧输出算到后来进入的目录上。这是本轮唯一一条对**所有用户**生效的修复。

## 未验证的边界

- 只在 Windows x64 构建；未做安装／升级／卸载自动化。
- 重排行号的判据来自「逻辑行数差」，在 jsdom 的 xterm 里验证过；未在 20 万行真实缓冲上点检。
- 第 160–174 轮审计共 **30 条**已全部交付；其中约十余项**没有独立用例**，逐条写在提交信息与各审计记录里。

