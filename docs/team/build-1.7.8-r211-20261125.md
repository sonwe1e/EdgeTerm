# 构建记录：1.7.8（第 211 轮，2026-11-25）

第 210 轮那版（`93569922…`）之后修了一条。**以本记录为准。**

| 项 | 值 |
| --- | --- |
| 提交 | `3fa3c45`（`git status` 干净） |
| 版本 | 1.7.8（未升版） |
| 安装包 | `src-tauri/target/release/bundle/nsis/EdgeTerm_1.7.8_x64-setup.exe` |
| 大小 | 4,264,807 B（4.06 MiB） |
| SHA-256 | `C8234D4D1B3629B69A25701297E80B942E824A55FEB383D62BA7B5FA5B4EDA45` |

## 构建前验证（同一提交）

- `npm run test:rust`：549 通过，32 ignored。
- `npm run verify`：`VERIFY_EXIT=0` —— 单测 224 文件／2002 用例，浏览器 75 文件／351 用例。
- `npm run check:commits -- 19669a3..HEAD --typecheck`：1 commit，0 errors，0 warnings。
- `npm run tauri:build`：`BUILD_EXIT=0`。

## 与上一版（`93569922…`）的差别

**四个停靠分隔条现在会说出自己停在哪。** 它们是可聚焦的 `separator`，只有一个 `aria-label`：`aria-valuenow` 与 `aria-valuetext` 都因为没传 `value` 而被丢掉。用键盘调整侧栏或底部停靠时，读者听到的是「调整窗格」而没有数字——而同一窗口里的窗格分隔条是报占比的。

做法分两半：左右下三个传「像素 ÷ 窗口尺寸」的占比；停靠内部那个板间分隔条传的是**权重比**，助手放在 `dockSplits.ts`（`weightOf` 所在处）。

## 未验证的边界

- 只在 Windows x64 构建；未做安装／升级／卸载自动化。
- 这条修复**没有独立用例**（需要一次真实的读屏器或至少一次 ARIA 断言）。
- 待办 1 条：A3（发送面板手搓 `role="dialog"`，窗口快捷键穿透）；另 W2 与「i18n 文案质量审计未完成」。
- 第 160–211 轮审计共 **80 条**，已修 **79 条**。

