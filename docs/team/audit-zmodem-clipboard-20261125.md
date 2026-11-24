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

## 第 188 轮：试着补用例，没补上，原因记下来

本轮的目标就是给 Z1/Z3 补用例。**没做成**，过程如下，以免下一轮重走：

- 已有 `zmodem.test.ts` 只驱动**发送**的端到端往返（两个真实控制器经 `writeSessionBytes` 交叉）。要覆盖 Z1/Z3 需要驱动**接收**侧：本地建目标文件、然后取消或让 peer 提前结束。
- 我在同一文件里加用例时，`String.replace` 的锚点**静默没匹配上**（biome 已重排过文件），我以为改成功了，实际把旧坏代码和新代码叠在一起；连续两次之后文件已坏。两次都靠 `git checkout --` 恢复。
- 改成**独立文件** `src/zmodemReceive.test.ts`（自带完整夹具）后，类型错误只剩一个，运行时错误是 `zmodemFinishFile` **一次都没被调用**——也就是说取消路径的 `activeWrite.writer.finish()` 没有跑起来。最可能的原因：`zmodemWriteBytes` 在传输完成前从未触发（`BufferedFileWriter` 要攒满 1 MiB 才落盘，而整个往返在少数几次 `consume` 里就跑完了），于是 `receiver.cancel()` 落在会话结束之后，`activeSession` 已为 null。
- 想加一行诊断时我又一次改坏了文件（`no tests`）。**此时停手**，删掉未完成的文件，保持工作树干净。

结论：Z1/Z3 **仍然没有独立用例**。这是第 186 轮我欠下的债，第 188 轮尝试偿还失败。要接着做，正确入口是**先读 `BufferedFileWriter` 的落盘时机与 `FILE_CHUNK_SIZE`**，确认接收侧在一次 `consume` 里到底落盘几次，再决定取消点——而不是继续猜选择器和猜时机。

## 第 189 轮：读到了真正的阻塞点

按第 188 轮自己留下的入口，先读了 `src/terminalTransfer.ts` 再动手。**阻塞点找到了，而且不是我猜的那个。**

- `BufferedFileWriter.push()` 只在 `buffered === FILE_CHUNK_SIZE`（**1 MiB**）时才 `flushBuffer()`；`finish()` 才会把不足 1 MiB 的余量落盘。所以「下载中取消」要拿到「已落盘一部分」，必须先过 **1 MiB**。
- 真正的错误是 **`Maximum call stack size exceeded`**：测试夹具的 `writeSessionBytes` 是**同步重入**的——`target.consume(bytes)` 立刻又产生出向字节，再次调用 `writeSessionBytes`，无限递归。现有的发送测试之所以没事，是因为它把出向字节切成 4093 字节的小片，递归深度不同。
- 把泵改成异步（每次 hop 前 `setTimeout(0)`）后栈溢出消失，但 3 MiB 的文件要跑几千个 hop，20 s 超时先到，`cancelled` 始终没置位。**两种极端都不对。**

### 下一轮的正确做法（这次是读过代码之后的结论）

不要再调「取消时机」。要做的是**换一种驱动方式**：让发送侧一次 `zmodemReadBytes` 就给足 1 MiB 以上（`FILE_CHUNK_SIZE * 2`），并且**只把接收方向的 hop 变成异步**（发送方向的 `writeSessionBytes` 保持同步，避免几千次 hop）。这样一次 flush 就能触发取消点，整个传输在两三个 hop 内结束。

或者更直接：**绕过双控制器往返**，直接用一个最小的假 `Offer` 驱动 `receiveOffer`——但那条路会绕开真实 zmodem.js，判别力弱于往返，列为次选。

Z1/Z3 **仍然没有独立用例**。本轮无产品改动，无新测试。
