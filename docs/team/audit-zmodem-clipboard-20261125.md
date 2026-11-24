# 审计：ZMODEM 与剪贴板（2026-11-25 第 186 轮）

只读审计。3 条，**本轮已修 2 条，第 3 条待夹具**。

范围说明（审计者自己指出）：任务书里点名的两个文件在本 checkout 不存在——ZMODEM 后端是共用的文件 IPC 层 `src-tauri/src/commands/binary_transfer.rs`，OSC 52 的提示框是 `src/components/ClipboardWriteDialog.tsx`。审计的是真实存在的那些。

| 编号 | 问题 | 位置 | 状态 |
| --- | --- | --- |
| ~~Z3~~ | 比发送方声明的大小**短**的下载被报成已接收，两个数字从未比较 | `zmodem.ts:214-215` | 已修：与 `reportedSize` 比较，失败走既有的 `offerQueue.catch` → `failSession` 路径。**无用例**（见下） |
| ~~Z1~~ | 取消或失败一个下载，会在用户选定的路径留下**截断的文件**，而唯一提示是绿色的「transfer canceled」，且不提文件名 | `zmodem.ts:214`（唯一落盘路径）与 `:85` | 已修：控制器持有在飞写入器，取消时仍 `finish()` 并报出文件名与字节数，提示改为 error 级。**无用例** |
| Z2 | 传输占用字节流期间每个按键都被丢弃，而提示框的 Cancel 只能鼠标点，于是一个卡住的传输**没有键盘出口** | `terminal.ts:1218` 与 `:687` | **未修**：需要让传输提示可聚焦并在显示时接管焦点，属于终端提示层的改动，单独立项 |

## 用例债务（本轮新增 2 条，需明确记录）

Z1 与 Z3 都位于一次真实的 ZMODEM **接收**会话之后。现有 `zmodem.test.ts` 只覆盖**发送**的端到端往返（真实 zmodem.js），要覆盖这两条需要另建接收侧夹具：让 peer 提前结束文件（Z3），以及在下载中途取消（Z1）。本轮没有建，因此这两条修复**目前没有独立用例**——与第 160–185 轮「每条都有用例」的记录不同，这里是一个真实的倒退，记录下来而不是装作覆盖。

## 确认无缺陷

- **粘贴不会静默截断**：剪贴板读取 → 可选 PasteWarningDialog → `term.paste` → `write_session`/`write_text` → `encode_input`（`encoding.rs:32` 对 `EncoderResult::OutputFull` 循环，长 GBK 粘贴不会被切）→ `writer.write_all`。xterm 的 10 MB OSC 上限是丢弃超限 OSC，不是截断。
- **OSC 52 提示可用键盘回答且说得对**：Deny 持初始焦点，Esc 拒绝，Tab 到 Allow；正文点名会话标签；「总是允许」复选框确实改的是它声称的全局偏好。`parseOsc52` 拒绝读请求、清空和非 base64。
- **剪贴板类键两语言齐全**，占位符一致。
- 未报项（有意边界）：没有 `zmodem.*` 语言键，所有 ZMODEM 提示都是 `zmodem.ts` 里的英文字面量；相邻的传输面完全一样（「Paste failed:」等），读起来是协议提示的有意边界而非缺陷。
