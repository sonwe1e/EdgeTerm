# 构建记录：1.7.8（第 209 轮，2026-11-25）

第 208 轮那版（`2AE06F1D…`）之后修了一条中的一半。**以本记录为准。**

| 项 | 值 |
| --- | --- |
| 提交 | `69d0f91`（`git status` 干净） |
| 版本 | 1.7.8（未升版） |
| 安装包 | `src-tauri/target/release/bundle/nsis/EdgeTerm_1.7.8_x64-setup.exe` |
| 大小 | 4,263,154 B（4.06 MiB） |
| SHA-256 | `0A50AAA93C3822A1E44BE054A0D8F8DEC8EB6F4B68CE5B5B2BF82B8F178817F3` |

## 构建前验证（同一提交）

- `npm run test:rust`：549 通过，32 ignored。
- `npm run verify`：`VERIFY_EXIT=0` —— 单测 224 文件／2002 用例，浏览器 75 文件／351 用例。
- `npm run check:commits -- fb73684..HEAD --typecheck`：1 commit，0 errors，0 warnings。
- `npm run tauri:build`：`BUILD_EXIT=0`。

## 与上一版（`2AE06F1D…`）的差别

**Git 工作区的分支按钮现在会向辅助技术报告自己的开合状态。** 它带着 `aria-haspopup="dialog"` 却从不报 `aria-expanded`，于是读者激活它时得不到「有界面打开了」的信号，关闭时也没有。40 行之下的文件夹菜单按钮三个属性齐全，所以这是**同一个页眉内部的内部不一致**，不是房屋风格。

同一发现里的另一个按钮（发送面板的命令选项）**没有修**：它的两个调用点手里只有 `setContextMenu` 这个 setter，状态本身在更上层的 `SenderPanel`，所以「加一个 prop」实际是三层透传。已在组件里加好可选 prop 但**未接线**——不接线它是死参数，接线要动三层，本轮预算不足。这个「加了没接」的状态在审计备注里写明了，没有装作修好。

## 未验证的边界

- 只在 Windows x64 构建；未做安装／升级／卸载自动化。
- 这条修复**没有独立用例**（需要一次真实的读屏器或至少一次 ARIA 断言）。
- 待办 3 条：A3（发送面板手搓 `role="dialog"`，窗口快捷键穿透）、A4（停靠分隔条不报位置）、A5 的 Sender 半条；另 W2 与「i18n 文案质量审计未完成」。
- 第 160–209 轮审计共 **80 条**，已修 **77.5 条**。

