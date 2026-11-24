# 构建记录：1.7.8（第 176 轮·二，2026-11-25）

第 176 轮早先那版（`57F502ED…`）只含 Git 三条。**以本记录为准**。

| 项 | 值 |
| --- | --- |
| 提交 | `76d6a0c`（`git status` 干净） |
| 版本 | 1.7.8（未升版） |
| 安装包 | `src-tauri/target/release/bundle/nsis/EdgeTerm_1.7.8_x64-setup.exe` |
| 大小 | 4,260,274 B（4.06 MiB） |
| SHA-256 | `1B14B7AB9A907C322362A8FEDBBAB7D878F5EAA53B59373237C1EF1ABDB93715` |

## 构建前验证（同一提交）

- `npm run test:rust`：548 通过，32 ignored。
- `npm run verify`：`VERIFY_EXIT=0` —— 单测 221 文件／1983 用例，浏览器 72 文件／342 用例。
- `npm run check:commits -- e604426..HEAD --typecheck`：2 commits，0 errors，0 warnings。
- `npm run tauri:build`：`BUILD_EXIT=0`。

## 与上一版（`57F502ED…`）的差别

- **本地文件可以真正覆盖了**：此前点「覆盖此文件」永远返回同样的冲突，草稿无路可走。
- **Ctrl+S 真的到处都能用**：此前焦点一离开编辑器正文（比如刚点了「重新载入」）就静默失效。
- **覆盖后焦点回到正文**：此前按钮消失、焦点掉到 document body，紧接着的输入全部丢失。
- **「跳转到行」说中文了**；覆盖提示不再承诺一个并不存在的 `.bak`。

## 未验证的边界

- 只在 Windows x64 构建；未做安装／升级／卸载自动化。
- ED1 的修复有 Rust 用例（带 `force` 落盘／不带仍返回 Conflict）；**ED2／ED4／ED5 没有用例**，它们需要真实 CodeMirror 视图的 jsdom 装置。
- 第 160–176 轮审计共 **40 条**已全部交付；仍无用例的条目逐条写在提交信息与各审计记录里。

