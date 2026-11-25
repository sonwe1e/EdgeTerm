# 构建记录：1.7.8（第 214 轮，2026-11-25）

第 213 轮那版（`A5AA4C65…`）之后修了重跑的 i18n 审计里最便宜的三条。**以本记录为准。**

| 项 | 值 |
| --- | --- |
| 提交 | `5776704`（`git status` 干净） |
| 版本 | 1.7.8（未升版） |
| 安装包 | `src-tauri/target/release/bundle/nsis/EdgeTerm_1.7.8_x64-setup.exe` |
| 大小 | 4,263,937 B（4.06 MiB） |
| SHA-256 | `19DBB28E2313AC7EC6030CECB6F595B56C67AED8B110C4192EEA27C55E6C39B2` |

## 构建前验证（同一提交）

- `npm run test:rust`：549 通过，32 ignored。
- `npm run verify`：`VERIFY_EXIT=0` —— 单测 224 文件／2003 用例，浏览器 75 文件／351 用例。
- `npm run check:commits -- d053411..HEAD --typecheck`：1 commit，0 errors，0 warnings。
- `npm run tauri:build`：`BUILD_EXIT=0`。

## 与上一版（`A5AA4C65…`）的差别

**三处文案缺陷。**

1. 删除会话对话框读不到 Sender 命令列表时，`hintStart` 与 `cmdUnknown` 被直接拼接，而 `cmdUnknown` 是三个中间片段里唯一没有前导空格的那个，于是英文读作 **"…any stored credentials for itIts saved Sender commands go with it…"**。中文不需要分隔，所以这个缺陷**只在英文可见、在翻译里隐形**。
2. 中文主机密钥对话框的 `hintEnd` 带着英文需要的前导空格，而中文从不在「。」前留空格，于是命令与句号之间多出一个可见空隙——**恰恰在劝阻中间人攻击的那一屏上**。
3. 新建／编辑会话对话框的字幕在 Shell 协议下显示 `%COMSPEC%`／`$SHELL`，一个内部环境变量名出现在该写人话的位置，且没有中文本地化。改用应用已有的 `session.defaultShell`（"default shell"／"默认 shell"）。

## 未验证的边界

- 只在 Windows x64 构建；未做安装／升级／卸载自动化。
- 这三条**都没有用例**——是文案字符串，没有任何地方断言它们。
- 同一审计还有 3 条未修，全是同一个模式（拆 One/Many 变体）：F1 覆盖确认的 "1 item(s) already exist … Replace them?"（不可逆覆盖前最后一句话，三个调用点）、F3 导入确认的 "1 of them replace … their"、F4 另三处硬编英语复数。键名与调用点都记在 [审计备注](docs/team/audit-i18n-quality-20261125.md) 里。
- 第 160–214 轮审计共 **86 条**，已修 **83 条**。

