# IPC 契约生成与边界

普通命令由 Rust 源通过精确锁定的 specta / tauri-specta 2.0.0-rc.25、
specta-typescript 0.0.12 导出。`npm run bindings` 更新，`npm run check:bindings`
重新生成到临时目录并逐字比较；同时核对注册命令清单，遗漏或过期例外都会失败。
生成过程运行一个离线 Rust 测试，不创建窗口、读取用户 Store 或连接服务器。

当前注册 **103** 条命令，其中 **98** 条生成；**5** 类有结构的事件生成并断言其名字与
实际生产者常量相同。`StateEvent`、认证、录制失败监听实际使用生成事件入口；文件比较、
配置列表使用生成命令，其他 API 保留需要的流控/默认值适配。DTO 从生成文件重导出，
保留主题、UI helper 和领域约束。这个覆盖数表示可用的生成入口，不等于 98 个前端
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
- `open_local_path`：rc.25 将 Rust 参数 with 生成为 TS 保留字；保留现有显式接口，未改 wire key。

原始二进制双侧契约测试继续运行。`transfer:removed` 的 string 与 `app:quit-requested` 的
无载荷事件仍显式监听；其余结构事件在生成文件。没有真实服务器/平台 WebView 验证声明。

生成命令清单：

`list_profiles`, `credential_store_status`, `save_profile`, `duplicate_profile`, `delete_profile`, `list_session_groups`, `save_session_group`, `delete_session_group`, `list_sender_commands`, `save_sender_command`, `delete_sender_command`, `list_command_history`, `record_command`, `delete_command_history`, `clear_command_history`, `export_app_data`, `read_app_data`, `import_app_data`, `default_ssh_config_path`, `read_ssh_config`, `import_ssh_config`, `inspect_private_key`, `generate_private_key`, `install_public_key`, `verify_public_key_login`, `configure_public_key_login`, `cancel_key_check`, `accept_host_key`, `answer_auth_prompt`, `close_session`, `acknowledge_session_output`, `list_sessions`, `default_recording_dir`, `list_system_fonts`, `system_monospace_family`, `write_session`, `resize_session`, `zmodem_file_info`, `zmodem_create_file`, `zmodem_finish_file`, `sftp_home`, `sftp_list`, `sftp_canonicalize`, `sftp_mkdir`, `sftp_create_file`, `sftp_remove`, `sftp_rename`, `sftp_download`, `sftp_download_directory`, `sftp_upload`, `sftp_upload_directory`, `cancel_transfer`, `list_file_transfers`, `control_file_transfer`, `transfer_files`, `list_recoverable_transfers`, `recover_transfer`, `discard_recoverable_transfer`, `start_port_forward`, `list_port_forwards`, `stop_port_forward`, `remove_port_forward`, `discover_listening_ports`, `cancel_port_discovery`, `compare_files`, `cancel_file_diff`, `sample_resources`, `cancel_resource_sample`, `local_home`, `session_cwd`, `local_hostname`, `local_list`, `local_parent`, `local_mkdir`, `local_create_file`, `local_is_directory`, `set_startup_theme`, `show_main_window`, `finish_main_window`, `read_clipboard_text`, `write_clipboard_text`, `show_pointer`, `portable_mode`, `open_log_directory`, `export_diagnostics`, `open_with_dialog`, `remote_edit_path`, `watch_remote_edit`, `stop_remote_edits`, `drag_staging_path`, `start_file_drag`, `start_promised_file_drag`, `finish_promised_file`, `local_copy_into`, `local_rename`, `local_remove`, `list_serial_ports`, `window_control`。
