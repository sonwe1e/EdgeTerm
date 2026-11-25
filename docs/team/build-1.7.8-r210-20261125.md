# 构建记录：1.7.8（第 210 轮，2026-11-25）

第 209 轮那版（`0A50AAA9…`）之后接完了上一轮留下的半条。**以本记录为准。**

| 项 | 值 |
| --- | --- |
| 提交 | `9035392`（`git status` 干净） |
| 版本 | 1.7.8（未升版） |
| 安装包 | `src-tauri/target/release/bundle/nsis/EdgeTerm_1.7.8_x64-setup.exe` |
| 大小 | 4,263,134 B（4.06 MiB） |
| SHA-256 | `935699229178C3CAF82C0D7C3025AD7BFFCC08AE56E8B653CEF9F26ED0F34FF3` |

## 构建前验证（同一提交）

- `npm run test:rust`：549 通过，32 ignored。
- `npm run verify`：`VERIFY_EXIT=0` —— 单测 224 文件／2002 用例，浏览器 75 文件／351 用例。
- `npm run check:commits -- 773b946..HEAD --typecheck`：1 commit，0 errors，0 warnings。
- `npm run tauri:build`：`BUILD_EXIT=0`。

## 与上一版（`0A50AAA9…`）的差别

**发送面板的命令选项按钮现在会向辅助技术报告菜单的开合状态。** 上一轮给这个按钮加了 `expanded` prop 但**没接线**（是个死参数），因为「开着哪个菜单」的状态在 `SenderPanel`，比按钮低两层。本轮接线：`SenderPanel` 把 `contextMenu` 传给 `SenderQuickbar` 与 `SenderLibrary`，两者各自算 `contextMenu?.commandId === command.id`。

这个「三层透传」的代价本身记在审计备注里：如果以后还有第三处要读这个状态，就该把它挪进 store，而不是继续加 prop。

## 未验证的边界

- 只在 Windows x64 构建；未做安装／升级／卸载自动化。
- 这两条修复**都没有独立用例**（需要一次真实的读屏器或至少一次 ARIA 断言）。
- 待办 2 条：A3（发送面板手搓 `role="dialog"`，窗口快捷键穿透）、A4（停靠分隔条不报位置）；另 W2 与「i18n 文案质量审计未完成」。
- 第 160–210 轮审计共 **80 条**，已修 **78 条**。

