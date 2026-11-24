# 构建记录：1.7.8（第 166 轮，2026-11-24）

第 165 轮那版（`6D3C4419…`）之后又落了「重开关闭的标签落在自己的窗格并带回名字」这一条，审计队列至此清空。**以本记录为准**。

| 项 | 值 |
| --- | --- |
| 提交 | `79166a5`（`git status` 干净） |
| 版本 | 1.7.8（未升版） |
| 安装包 | `src-tauri/target/release/bundle/nsis/EdgeTerm_1.7.8_x64-setup.exe` |
| 大小 | 4,261,271 B（4.06 MiB） |
| SHA-256 | `85E0B117A07ACEA4A9D966D25BE572A936BBC5B66444DBBFD5EC2D60D7ACC0FD` |

## 构建前验证（同一提交）

- `npm run test:rust`：545 通过，32 ignored。
- `npm run verify`：`VERIFY_EXIT=0` —— 单测 216 文件／1958 用例，浏览器 72 文件／342 用例。
- `npm run check:commits -- acadd4b..HEAD --typecheck`：2 commits，0 errors，0 warnings。
- `npm run tauri:build`：`BUILD_EXIT=0`。

## 与上一版（`6D3C4419…`）的差别

- **重开关闭的标签**：从某个窗格的菜单打开时落在该窗格（窗格还在的话），并带回用户改过的标签名；窗格随最后一个标签关闭而消失时，回落到当前活动窗格。

## 未验证的边界

- 只在 Windows x64 构建；未做安装／升级／卸载自动化。
- 未在真实桌面环境人工点检。
- 第 160–166 轮的审计共 21 条已全部交付，但其中**十余条没有独立用例**，逐条写在提交信息与审计记录里；`docs/team/STATE.md` 记着哪些是纯文案、哪些只靠负控制验证过一次。

