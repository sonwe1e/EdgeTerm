# 构建记录：1.7.8（第 225 轮，2026-11-25）

第 224 轮那版（`FB279056…`）之后修好了挂了几轮的 W2。**以本记录为准。**

| 项 | 值 |
| --- | --- |
| 提交 | `4ef6d42`（`git status` 干净） |
| 版本 | 1.7.8（未升版） |
| 安装包 | `src-tauri/target/release/bundle/nsis/EdgeTerm_1.7.8_x64-setup.exe` |
| 大小 | 4,263,506 B（4.06 MiB） |
| SHA-256 | `41315839AD5E90790CECA4E5D9AAAE63287EE23D82F6701FA109252DD5EFAFD5` |

## 构建前验证（同一提交）

- `npm run test:rust`：549 通过，32 ignored。
- `npm run verify`：`VERIFY_EXIT=0` —— 单测 **224 文件／2002 用例**（比上一版多 1），浏览器 75 文件／351 用例。
- `npm run check:commits -- fbfca4f..HEAD --typecheck`：1 commit，0 errors，0 warnings。
- `npm run tauri:build`：`BUILD_EXIT=0`。
- **负对照**：把 `reference` 改回缓冲区相对坐标，新用例立刻红（`expected false to be true`），其余 3 条仍绿。

## 与上一版（`FB279056…`）的差别

**「上一个监视标记」不再在标记就在眼前时报「没有更早的标记」。**

`jumpToLines` 拿 `watchLines()`（**绝对行号**）去比一个由 `buffer.baseY + buffer.cursorY`（**缓冲区相对行**）构造的 `reference`，后者比绝对坐标小 `firstLineNumber`。只有**首次**跳转受影响，因为 `commandJumpLine` 从第二次起存的就是绝对目标。

于是光标正下方那一行上的监视标记被跳过，「上一个监视标记」报告无可落脚之处——而标记就在那儿。修法是让起点坐标与它搜索的坐标一致。

完整分析（三个坐标空间、为什么前三轮找不到判别性用例、负对照为何第一次是假的）见 [W2 记录](docs/team/W2-watch-mark-jump.md)。

## 未验证的边界

- 只在 Windows x64 构建；未做安装／升级／卸载自动化。
- 只在 jsdom + xterm 真实缓冲区里验证，**没有在真实桌面、真实长会话上验证**。
- 第 160–225 轮审计共 **95 条，已修 93 条**。唯一剩下的 C5 余项（104 个无导入方导出未逐个验证）是可读性改进，不是缺陷。

