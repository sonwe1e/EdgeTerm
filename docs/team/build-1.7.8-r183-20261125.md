# 构建记录：1.7.8（第 183 轮，2026-11-25）

第 182 轮那版（`DADEED23…`）之后补了一条测试。**以本记录为准**。

| 项 | 值 |
| --- | --- |
| 提交 | `cc86079`（`git status` 干净） |
| 版本 | 1.7.8（未升版） |
| 安装包 | `src-tauri/target/release/bundle/nsis/EdgeTerm_1.7.8_x64-setup.exe` |
| 大小 | 4,263,557 B（4.06 MiB） |
| SHA-256 | `BDFB1917E2887761E2D27F874882B9B617398B063255C3846E916297C104307C` |

## 构建前验证（同一提交）

- `npm run test:rust`：548 通过，32 ignored。
- `npm run verify`：`VERIFY_EXIT=0` —— 单测 223 文件／1997 用例，浏览器 74 文件／349 用例。
- `npm run check:commits -- ca38a70..HEAD --typecheck`：1 commit，0 errors，0 warnings。
- `npm run tauri:build`：`BUILD_EXIT=0`。

## 与上一版（`DADEED23…`）的差别

产品行为完全一致——本轮只补测试。差别是「取消批量清除后焦点回到触发按钮」这条现在**有一个真实夹具**：面板单独挂载 + stub `listRecoverableTransfers`，所以恢复分区和它的问题是真实的。

负控制已验证：去掉焦点交接 → 焦点落在 `<body>` → 测试红。

## 未验证的边界

- 只在 Windows x64 构建；未做安装／升级／卸载自动化。
- 仍无用例的 2 条：拖到盘符根（需要不同的列目录具）、传输中心「清除单条中断记录」的焦点交接（该行由 `VirtualFileRows` 渲染，本轮没能在挂载的面板里让它出来，所以没有猜选择器，用例留空）。
- 第 160–183 轮审计共 **61 条**已全部交付。

