# 构建记录：1.7.8（第 222 轮，2026-11-25）

第 221 轮那版（`ED08EB77…`）之后修了代码质量审计的 C2。**以本记录为准。**

| 项 | 值 |
| --- | --- |
| 提交 | `8baeda3`（`git status` 干净） |
| 版本 | 1.7.8（未升版） |
| 安装包 | `src-tauri/target/release/bundle/nsis/EdgeTerm_1.7.8_x64-setup.exe` |
| 大小 | 4,261,970 B（4.06 MiB） |
| SHA-256 | `6B9BF981BDE6F9B7567FF8854E47E7E1B71AEAA1D474B617FE308A2A2A964AF2` |

## 构建前验证（同一提交）

- `npm run test:rust`：549 通过，32 ignored。
- `npm run verify`：`VERIFY_EXIT=0` —— 单测 224 文件／2001 用例，浏览器 75 文件／351 用例。
- `npm run check:commits -- 055479f..HEAD --typecheck`：1 commit，0 errors，0 warnings。
- `npm run tauri:build`：`BUILD_EXIT=0`。

## 与上一版（`ED08EB77…`）的差别

**「最近使用」的存储层只写一遍，不再是三遍。**

`recentProfiles`、`quickConnectRecents`、`commandPalette` 各带一份**逐字节相同**的 `safeStorage`、同一个加载循环、同一套封顶写入——约 125 行存储管线。更贵的是**三个测试文件各自在重测同一套规则**：非字符串丢弃、重复丢弃、封顶生效、读失败返回 []、写失败被吞。任何规则变更（裁剪、键版本化）都要改三遍、重测三遍。

现在共用一个 `src/recentIds.ts`，三个模块只留自己的键与上限。存储参数保持可注入形状，**三套既有测试一条没改就全绿**。

## 未验证的边界

- 只在 Windows x64 构建；未做安装／升级／卸载自动化。
 - 本轮是去重重构，**不改变任何产品行为**。
- 代码质量审计另有 2 条未修：C1 拖拽生命周期整体重复（约 80 行）、C5 112 个导出没有导入方。
- 第 160–222 轮审计共 **95 条**，已修 **92 条**。

