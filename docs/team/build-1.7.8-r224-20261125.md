# 构建记录：1.7.8（第 224 轮，2026-11-25）

第 223 轮那版（`ED79721F…`）之后修了代码质量审计的最后一条。**以本记录为准。**

| 项 | 值 |
| --- | --- |
| 提交 | `8a6e023`（`git status` 干净） |
| 版本 | 1.7.8（未升版） |
| 安装包 | `src-tauri/target/release/bundle/nsis/EdgeTerm_1.7.8_x64-setup.exe` |
| 大小 | 4,263,694 B（4.06 MiB） |
| SHA-256 | `FB2790562FCA352EEBCACE4C19C08AC12B8AFEB58F90C76DFB8CCA69666A430C` |

## 构建前验证（同一提交）

- `npm run test:rust`：549 通过，32 ignored。
- `npm run verify`：`VERIFY_EXIT=0` —— 单测 224 文件／2001 用例，浏览器 75 文件／351 用例。
- `npm run check:commits -- 3a4ae99..HEAD --typecheck`：1 commit，0 errors，0 warnings。
- `npm run tauri:build`：`BUILD_EXIT=0`。

## 与上一版（`ED79721F…`）的差别

**拖拽指针释放的收尾只写一遍，不再是两遍。**

`Splitter` 与 `FilerColumnResizer` 各带一份逐字相同的指针捕获收尾——先退役再释放 capture 的次序、window 回退与 lostpointercapture 的竞态、释放时冲刷 vs 中断时取消、卸载清理——**连两行注释都一字不差**，约 80 行。这是 UI 里最微妙的正确性面，改一份必须手工移植到另一份。

`releaseDrag` 现在持有共有的核心。**各处差异原样留在调用方、顺序不变**：`Splitter` 的 `ended()` 仍在整个块之后，列宽器的 `live` 引用仍在 flush/cancel 之后清空。

**至此第 219 轮代码质量审计的 6 条全部处理完毕**（C1–C6；C5 只做了审计点名的 9 个里的 8 个，第 9 个被编译器证明审计有误）。

## 未验证的边界

- 只在 Windows x64 构建；未做安装／升级／卸载自动化。
- 本轮是提取重构，**刻意不改变任何产品行为**；没有为 `releaseDrag` 新增独立用例——两侧的既有拖拽生命周期测试原样通过，是这次「行为未变」的证据。
- C5 剩下的 104 个无导入方导出未逐个验证。
- 第 160–224 轮审计共 **95 条**，已修 **92 条**。

