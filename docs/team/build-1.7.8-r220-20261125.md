# 构建记录：1.7.8（第 220 轮，2026-11-25）

第 219 轮那版（`537D4FB6…`）之后修了代码质量审计的 C3。**以本记录为准。**

| 项 | 值 |
| --- | --- |
| 提交 | `657e1a0`（`git status` 干净） |
| 版本 | 1.7.8（未升版） |
| 安装包 | `src-tauri/target/release/bundle/nsis/EdgeTerm_1.7.8_x64-setup.exe` |
| 大小 | 4,264,370 B（4.06 MiB） |
| SHA-256 | `C3D1540F9C69F7D1365C293D156DD84E9F8197DC89312EFD758635BAE4DF185E` |

## 构建前验证（同一提交）

- `npm run test:rust`：549 通过，32 ignored。
- `npm run verify`：`VERIFY_EXIT=0` —— 单测 224 文件／2001 用例，浏览器 75 文件／351 用例。
- `npm run check:commits -- 1c3e441..HEAD --typecheck`：1 commit，0 errors，0 warnings。
- `npm run tauri:build`：`BUILD_EXIT=0`。

## 与上一版（`537D4FB6…`）的差别

**转发路由的两个助手不再有三份拷贝。**

`endpoint` 与 `forwardRoute` 被逐字复制进 `SessionDialog`、`SshConfigImportDialog` 与 `ForwardCenter`——**连两条文档注释都一字不差**。于是「IPv6 字面量要加方括号」和「动态转发不写目标」这两条规则各存三份，第四个转发界面就会复制第四遍。

现在它们在 `src/forwardRoute.ts`，三处导入。**函数体与删掉的逐字节相同，无行为变化。**

## 未验证的边界

- 只在 Windows x64 构建；未做安装／升级／卸载自动化。
- 本轮是纯移动重构，**不改变任何产品行为**。
- 代码质量审计另有 4 条未修：C1 拖拽生命周期整体重复（约 80 行）、C2 最近使用存储层写三遍、C4 save/connect 重复校验前奏、C5 112 个导出没有导入方。
- 第 160–220 轮审计共 **95 条**，已修 **90 条**。

