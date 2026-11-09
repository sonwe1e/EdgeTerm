# IPC 契约生成与边界

普通命令由 Rust 源通过精确锁定的 specta / tauri-specta 2.0.0-rc.25、
specta-typescript 0.0.12 导出。`npm run bindings` 更新，`npm run check:bindings`
重新生成到临时目录并逐字比较；同时核对注册命令清单，遗漏或过期例外都会失败。
生成过程运行一个离线 Rust 测试，不创建窗口、读取用户 Store 或连接服务器。

当前注册 **110** 条命令，其中 **104** 条生成、**6** 条显式手写例外（2026-11-10 核对）；**5** 类有结构的事件生成并断言其名字与
实际生产者常量相同。`StateEvent`、认证、录制失败监听实际使用生成事件入口；文件比较、
配置列表使用生成命令，其他 API 保留需要的流控/默认值适配。DTO 从生成文件重导出，
保留主题、UI helper 和领域约束。这个覆盖数表示可用的生成入口，不等于 104 个前端
调用适配器均已替换。

`SessionProfile` 采用 Rust 输入形状且要求前端 id；`SavedCommand`、`SessionGroup`、
`SessionInfo` 等将实际输出必带的默认字段用 Required 收窄。rc.25 对部分默认字段的
serialize 别名仍较宽，不能据此声称输出字段可缺失。传输状态保留现有前端领域联合，
其余字段来自 Rust Snapshot。文件比较的 kind/status 为 Rust serde 枚举，wire 字符串不变。

前端设置原本就是 opaque JSON，明确映射为 unknown；直接反射递归 serde_json::Value
会使该版本 exporter 栈溢出，原始失败记录保留。没有关闭 serde phases，保留 null、
默认字段、rename、tagged enum 与条件省略的区分。Backspace 只导出 delete/controlH；
旧文件中的未知字符串按既有默认 DEL 行为归一为 delete，再保存成为合法值。

u64/i64/usize 保留现有 JSON number 传输；超过 2^53 仍有 JS 精度边界，未静默改变
为 bigint 或 string。业务 Result 的失败继续 rejected Promise（Throw 模式），没有
改成 {status,data}。专用 bindings feature 才启用反射依赖，默认发布不启用。
生成器自带 helper 有两处显式 any lint 警告，原样保留供升级审查，未全局抑制。

手写接口例外：

- `open_session`：原始终端输出 Channel<InvokeResponseBody>；保留 ArrayBuffer 消费与流控。
- `write_session_bytes`：Request 原始字节和 headers。
- `zmodem_read_bytes`：Response 原始字节。
- `zmodem_write_bytes`：Request 原始字节和 headers。
- `preview_image_file`：Response 原始图片字节，前端消费 ArrayBuffer 后只读预览，不转换为 JSON。
- `open_local_path`：rc.25 将 Rust 参数 with 生成为 TS 保留字；保留现有显式接口，未改 wire key。

原始二进制双侧契约测试继续运行。`transfer:removed` 的 string 与 `app:quit-requested` 的
无载荷事件仍显式监听；其余结构事件在生成文件。没有真实服务器/平台 WebView 验证声明。

命令清单以 [`src-tauri/src/lib.rs`](../src-tauri/src/lib.rs) 的注册表、
[`src-tauri/src/bindings.rs`](../src-tauri/src/bindings.rs) 的导出表及
[`scripts/bindings.mjs`](../scripts/bindings.mjs) 的显式例外为准，避免复制长清单后失同步。
CI 在 Rust 测试后执行真实生成对比；差异会输出有界的已知文件 diff 并保持失败，
不会自动覆盖已提交绑定或将缺失 Rust 工具链当作通过。脚本单元测试仅验证检查门的
成功／失败行为，不能代替 Rust 生成结果的新鲜度验证。
