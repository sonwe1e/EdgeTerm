# 构建记录：1.7.8（第 154 轮，2026-11-24）

第 153 轮之后又补了两处（传输条随会话、非 SSH 标签的复制会话），所以重出安装包。版本仍是 1.7.8。

| 项 | 值 |
| --- | --- |
| 提交 | `ca3f770`（`main` 顶端，`git status` 干净） |
| 版本 | 1.7.8（未升版） |
| 安装包 | `src-tauri/target/release/bundle/nsis/EdgeTerm_1.7.8_x64-setup.exe` |
| 大小 | 4,257,830 B（4.06 MiB） |
| SHA-256 | `59BCFDA586065279B5D5252618CAA5D5573764A69D517BFE14C312F5D7D1652B` |

## 构建前验证（同一提交）

- `npm run verify`：`VERIFY_EXIT=0` —— 单测 215 文件／1942 用例，浏览器 72 文件／340 用例。
- `npm run check:commits -- 542a76a..HEAD --typecheck`：3 commits，0 errors，0 warnings。
- `npm run tauri:build`：`BUILD_EXIT=0`。

## 与 1.7.8 上一包（第 153 轮）的差别

- 文件面板底部的传输条跟随当前会话：切换会话收起，连接断开时收起并说明原因。
- 标签右键对非 SSH 标签提供「复制会话」。

## 未验证的边界

- 只在 Windows x64 构建；未做安装／升级／卸载的自动化验证。
- 本包未在真实桌面环境中人工点检；测试是 jsdom 与浏览器用例。

