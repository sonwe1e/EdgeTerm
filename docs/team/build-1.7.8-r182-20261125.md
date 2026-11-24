# 构建记录：1.7.8（第 182 轮，2026-11-25）

第 181 轮那版（`212D00AE…`）之后补了一条测试。**以本记录为准**。

| 项 | 值 |
| --- | --- |
| 提交 | `5aa7df8`（`git status` 干净） |
| 版本 | 1.7.8（未升版） |
| 安装包 | `src-tauri/target/release/bundle/nsis/EdgeTerm_1.7.8_x64-setup.exe` |
| 大小 | 4,262,901 B（4.06 MiB） |
| SHA-256 | `DADEED23082935D6F6E3F1FFBBCC213C6E7D06A09EC616D0F963F87AD8F9441D` |

## 构建前验证（同一提交）

- `npm run test:rust`：548 通过，32 ignored。
- `npm run verify`：`VERIFY_EXIT=0` —— 单测 223 文件／1997 用例，浏览器 73 文件／348 用例。
- `npm run check:commits -- f83f200..HEAD --typecheck`：1 commit，0 errors，0 warnings。
- `npm run tauri:build`：`BUILD_EXIT=0`。

## 与上一版（`212D00AE…`）的差别

产品行为完全一致——本轮只补测试，没有产品改动。差别是「把文件夹拖回自己行」这个无操作现在**有一条真实指针的用例**（负控制已验证：去掉 `moveEntries` 里的自放置子句即红）。

## 未验证的边界

- 只在 Windows x64 构建；未做安装／升级／卸载自动化。
- 仍无用例的 3 条：拖到盘符根（需要不同的列目录具）、传输中心取消批量清除与清除单条中断的焦点交接（现有浏览器测试都不挂载带可恢复记录的传输中心，需要新建夹具）。
- 第 160–182 轮审计共 **61 条**已全部交付。

