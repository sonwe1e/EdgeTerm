# 构建记录：1.7.8（第 215 轮，2026-11-25）

第 214 轮那版（`19DBB28E…`）之后修了 i18n 审计里最重的一条。**以本记录为准。**

| 项 | 值 |
| --- | --- |
| 提交 | `7495788`（`git status` 干净） |
| 版本 | 1.7.8（未升版） |
| 安装包 | `src-tauri/target/release/bundle/nsis/EdgeTerm_1.7.8_x64-setup.exe` |
| 大小 | 4,262,343 B（4.06 MiB） |
| SHA-256 | `FC3AB7762B14785E619E189855914A3EFA161EBDC9BF6B588B2D7A1B6586148B` |

## 构建前验证（同一提交）

- `npm run test:rust`：549 通过，32 ignored。
- `npm run verify`：`VERIFY_EXIT=0` —— 单测 224 文件／2003 用例，浏览器 75 文件／351 用例。
- `npm run check:commits -- fb0566e..HEAD --typecheck`：1 commit，0 errors，0 warnings。
- `npm run tauri:build`：`BUILD_EXIT=0`。

## 与上一版（`19DBB28E…`）的差别

**只覆盖一个同名文件时，确认话术不再自相矛盾。**

重新上传一个同名文件是最常见的情况，而它打印的是 "1 item(s) already exist in this folder. Replace them?"——**数字、动词、代词三处同时不合语法**，而这正不可逆覆盖前的最后一句话，读者必须在这一句建立信任。中文本来就是对的（「此文件夹中已有 {count} 个项目。要替换它们吗？」对 1 也通），所以这个缺陷只在英文可见。

上传、下载、FTP 三条路径现在在恰好一个条目冲突时选用单数变体。

**两条既有用例断言的就是这段坏文案**（`expect.stringContaining("1 item(s)")`），已更新并把理由写进注释。

## 未验证的边界

- 只在 Windows x64 构建；未做安装／升级／卸载自动化。
- 本轮一次流程失误：第一次跑门禁时 `format:check` 失败，因为 `biome format --write` 只格式化了我手动改的三个 `.ts`，**漏了两个 locale 文件**。是完整门禁抓到的，不是我自己发现的。
- 待办 2 条（同一模式，键名与调用点已记录）：F3 导入确认的 "1 of them replace … their"、F4 另三处硬编英语复数；另 W2。
- 第 160–215 轮审计共 **86 条**，已修 **84 条**。

