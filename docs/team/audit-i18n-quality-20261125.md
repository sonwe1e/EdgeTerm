# 审计：语言目录文案质量（2026-11-25 第 214 轮重跑）

第 205 轮同一个审计**完成前失败、零产出**。本轮重跑，方法：读完两份目录各 1531 键，程序化对比占位符集合，再逐个 grep 所有 `t("…", {…})`、模板字面量与 `+` 拼接，并把每处数字插值回溯到产出它的守卫。

## 6 条发现

| 编号 | 问题 | 状态 |
| --- | --- | --- |
| F1 | 覆盖确认在恰好一个文件重名时打印 **"1 item(s) already exist in this folder. Replace them?"**——数字、动词、代词三处同时不合语法，而这正是不可逆覆盖前的最后一句话。三个调用点（上传／下载／FTP）都会走到 | **未修**（需加 `…One` 键并在三处选） |
| F2 | 新建／编辑会话对话框的字幕在 Shell 协议下显示 `%COMSPEC%`／`$SHELL`——内部环境变量名出现在该写人话的地方，且没有中文本地化。应用已有正确的 `session.defaultShell` 键 | **已修**：改用 `t("session.defaultShell")` |
| F3 | 导入确认在只替换 1 条会话时说 "1 of them **replace** … **their** current hosts" | **未修**（需拆 One/Many） |
| F4 | 另三处硬编英语复数："1 unfinished file transfer(s)"、"skipped 1 session(s)"、"(1 bytes)" | **未修**（需拆 One/Many） |
| F5 | 删除会话对话框读不到 Sender 命令列表时，两句话被拼成 **"…for itIts saved Sender commands go with it…"**——`cmdUnknown` 少了前导空格，而 `cmdOne`／`cmdMany` 都有。中文不需要分隔所以只在英文可见 | **已修**：补前导空格 |
 | F6 | 中文主机密钥对话框在句号前多一个空格："…ssh-ed25519 。接受将替换…"——英文 `hintEnd` 需要前导空格（它跟在命令后面），中文不需要 | **已修**：去掉 |

## 明确查过没有问题的两类

**「后端可能给出 0 或负数、而措辞假设为正」——没有。** 逐处回溯：命令退出码用 `/^\d+$/` 解析且只在 `exit !== 0` 时呈现，所以 `status.commandFailed` 不可能打出 0 或负；`bytesPerSecond` 有 `Math.max(0, …)` 兜住；每个 `transfer.etaRemaining` 都有 `rate > 0 && remaining > 0` 守卫；`status.moreFailures` 有 `errorRest > 0` 守卫。

**「英文与中文含义不一致」——没有。** 两份目录键数相同、占位符集合零差异，通读比对未发现一侧说了另一侧没说的事。

另有一处审计者主动降级：`common.characters`（"{count} characters"）没有长度守卫，理论上 1 字符的 OSC 52 写入会打出 "1 characters"，但**没有观察到有程序发出 1 字符的 OSC 52 载荷，所以不作为缺陷上报**。

## 本轮只修了三条最便宜的

F1、F3、F4 都是同一个模式（拆 One/Many 变体），F1 还要改三个调用点。本轮预算修完 F2／F5／F6 三条就收，剩下三条连精确的键名与调用点都记在这里，下一轮可直接照做。
