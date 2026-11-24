# 审计：编码与粘贴（2026-11-24 第 158 轮）

只读审计，范围：osc52.ts、terminal.ts 收发路径、terminalClipboard.ts、terminalPaste.ts、session/** GBK 处理、project.rs / local_text.rs 的读写。2 条，本轮全部交付。

| 编号 | 问题 | 交付 |
| --- | --- | --- |
| **EN1** | GBK／Big5／Shift_JIS 会话里，程序用 OSC 52 复制的内容一律按 UTF-8 解码，剪贴板拿到一堆替换字符；Allow 对话框预览的就是已经损坏的文本，用户可能批准一次根本读不了的复制 | 载荷改用会话自己的解码器（`parseOsc52(data, label)`，标签随 `setEncoding` 保存）；`osc52.test.ts` 新增 GBK 用例，负控制（改回 UTF-8）即失败 |
| **EN2** | UTF-16 文件（记事本「Unicode」、PowerShell 5.1 重定向的产物）被判成「不是 UTF-8」或「二进制」，且不给出口——而 diff 视图早已把同样的 BOM 当文本 | 两个打开入口都在解码前检查 UTF-16 BOM，消息点明编码并给出路（转 UTF-8 或外部编辑）；`local_text` 新增用例，负控制（检查放回解码之后）即失败 |

## 审计确认「无缺陷」的部分

- 输入编码：按键与粘贴都走文本路径（`write_text` → `encode_input`），没有 UTF-8 漏进 GBK 会话；唯一的字节路径是 xterm 的旧式鼠标报告。
- 粘贴换行：xterm 自己把 `\r?\n` 归一成 `\r`，Windows 剪贴板不会让每行提交两次；`terminalPaste` 的规则与它一致且有用例。
- 括号粘贴：多行粘贴与 agent 输入框都在同一个 `\x1b[200~…\x1b[201~` 帧里，没有任何粘贴路径裁掉结尾换行。
- 编辑器保存：读什么编码写回什么编码，EOL 先归一再应用，CRLF 不会翻倍；本地编辑两侧都是 UTF-8。
- 非 UTF-8 会话不会被塞一个 UTF-8 的 `LANG`，shell 与终端对编码的认知一致。

边界：xterm 的换行归一结论是读 `xterm.mjs` 得出的，没有实际运行验证。

