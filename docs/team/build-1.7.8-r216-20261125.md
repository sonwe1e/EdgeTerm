# 构建记录：1.7.8（第 216 轮，2026-11-25）

第 215 轮那版（`FC3AB776…`）之后修完 i18n 审计的最后两条。**以本记录为准。**

| 项 | 值 |
| --- | --- |
| 提交 | `c25387f`（`git status` 干净） |
| 版本 | 1.7.8（未升版） |
| 安装包 | `src-tauri/target/release/bundle/nsis/EdgeTerm_1.7.8_x64-setup.exe` |
| 大小 | 4,261,816 B（4.06 MiB） |
| SHA-256 | `34EE913C1A95D2B20DA439CF00D8AAA0E9CF7EE978D3AC125B57822FFCDC4A38` |

## 构建前验证（同一提交）

- `npm run test:rust`：549 通过，32 ignored。
- `npm run verify`：`VERIFY_EXIT=0` —— 单测 224 文件／2003 用例，浏览器 75 文件／351 用例。
- `npm run check:commits -- 2cccce6..HEAD --typecheck`：1 commit，0 errors，0 warnings。
- `npm run tauri:build`：`BUILD_EXIT=0`。

## 与上一版（`FC3AB776…`）的差别

**四处硬编英语复数的字符串改用单数变体。**

| 位置 | 旧文案 |
| --- | --- |
| 退出确认 | "Quitting will interrupt 1 unfinished file transfer(s), including paused tasks" |
 | 发送器状态行 | "skipped 1 session(s) with a file transfer or another send running" |
 | Filer 行提示 | "Size: … (1 bytes)" |
 | 导入确认 | "1 of them **replace** sessions you already have, and **their** current hosts…" |

四处都在计数为 1 时动词或代词与数字不一致。中文对 1 本来就通，所以四个中文变体只是把同样文案再写一遍以保持键集合对齐——每个键旁都注了明。

## 未验证的边界

- 只在 Windows x64 构建；未做安装／升级／卸载自动化。
- 这四处**都没有独立用例**（除导入那条有一条既有用例顺带覆盖，且它断言的正是旧文案）。
- **第 160–216 轮审计共 86 条，已修 86 条**——两个审计面（外壳无障碍 5 条 + i18n 文案 6 条）全部闭合。
- 唯一剩下的 W2（监视标记跳转坐标）已完整定位，但现有夹具的 `firstLineNumber` 恒为 1，判别不出 1 行偏差；造判别性夹具要填满并裁掉 10000 行滚动缓冲，成本超过该缺陷本身的表现（「上一个监视标记」在长会话里误报「没有标记」）。

