# EdgeTerm 1.8 — Filer 预览与 SFTP 基准验收卡

本轮用户确认 **AAC**，继续稳定性精修：Filer 图片按需预览、大日志只读分页与可选跟随、SFTP 小文件及大文件性能基线。**A2 冷历史保持关闭，不进行底层重构**。不改变现有文件编辑器 4 MiB 限制、SFTP 传输默认参数或终端历史策略。

## 行为与安全边界

| 项目 | 本轮行为 | 不能推断为 |
| --- | --- | --- |
| 图片预览 | Filer 菜单按需打开 PNG/JPEG/GIF/WebP；最多 16 MiB、单边最多 16384 像素、最多 3200 万像素；SSH 只读，不建立可回传的编辑缓存 | 动画多帧内存/CPU 压力已通过真机验证 |
| 大日志 | 本地或已连接 SSH 的普通文件，按字节窗口 **256 KiB** 查看；可翻页、搜索当前窗口、手动开启/关闭 Follow（3 秒轮询）；默认不轮询；支持 UTF-8、GBK、GB18030、Big5 手动指定 | 全文件搜索、完整流式索引或编码自动识别 100% 正确 |
| SFTP 基准 | 仅显式启用的**隔离 OpenSSH 测试账户**可执行：512×1 MiB、1×512 MiB、4×128 MiB，每场景上传/下载；校验逐文件大小与 SHA-256；结果记录到 JSONL | 已获得真实吞吐数字，或已经有证据需要修改引擎 |

SFTP 基准的操作说明、安全目录校验、容量要求和参数请见 [scripts/README.md](../../scripts/README.md)。它会产生新的可定位的远程测试文件，**不会自动删除**；没有专用测试账户时不要执行。

## 已完成的可重复检查

在基于 `origin/main` `a898fdb3` 的集成分支执行：

- `tsc --noEmit`：通过。
- 全量 Vitest JS 单测：**123 个文件 / 1206 项通过；2 文件 / 7 项跳过**。隔离 worktree 需临时放行父仓库 `node_modules` 的 Vite FS 访问；不修改正式配置。
- 图片及日志定向 JS 单测：**4 个文件 / 15 项通过**。
- Biome：修改过的关键 TS/TSX 文件检查通过。
- Vite 生产构建：通过；有既存的 >500 KiB chunk 警告。
- 独立 Agent 只读复核：Rust IPC / TS binding、两种 Filer 入口、CSS、UTF-8 边界与 GBK 分页、FIFO 与 benchmark 路径检查；未发现新增 P0/P1 静态阻断。

**未验收，不能标记通过：** 本执行环境无 `cargo/rustc`，Rust 编译与单测未执行；Chromium browser runner 因运行环境 socket 权限不能启动；未连接任何真实 SSH 测试服务器，没有 SFTP 吞吐实测或 Windows 11/WebView2 真机交互结果。本 PR 应先保持 **Draft**。

## 需要在 Windows 11 / WebView2 补齐的最小测试

使用隔离配置及可清理的 OpenSSH 测试目录；终端显示设置确认 **A2 OFF**。对每项保存结果（通过 / 失败 / 受阻）、构建 SHA、Windows/WebView2/SSH 版本；不要上传服务器密钥或原始敏感日志。

1. **Rust 门禁**：`./dev.ps1 doctor` → `./dev.ps1 test:rust`，确保图片头解析、UTF-8/GBK 分页、SFTP benchmark 安全测试通过；再运行 `./dev.ps1 test:browser`。
2. **图片预览**：本地及 SSH PNG/JPEG/GIF/WebP（含动画、损坏头、过限文件）；连续快速切换图片、断开 SSH/关闭窗口；确认无旧内容串入、Blob URL 释放、无文件回传或长时间阻塞。
3. **大日志**：分别打开 4 MiB 以上、1 GiB 以上、无扩展名、空文件、UTF-8 含跨窗 Emoji 与 GBK 中文日志；多次“上一片段/下一片段/最新”，搜索只在当前片段、UTF-8/GBK 手选后翻页无漏字。内容始终只读。
4. **Follow 与会话隔离**：默认 OFF；手动开启后追加日志、截断/轮换、更改编码、连接断开再关闭窗口；两台 SSH 主机相同路径交替打开，无旧数据串入；较长时间运行内存不持续增加。
5. **SFTP 基准**：按 `scripts/README.md` 在专用账户、专用已有目录逐一运行 3 场景×2 方向，每组至少 3 次；记录真实中位数、样本范围、文件数、Hash 校验、RTT、盘类型与资源占用。无有效结果前不修改默认并发或传输实现。

放行规则：Rust 门禁、真实 WebView2/SSH 基础用例和需执行的 benchmark 安全验证完成后，才能讨论 Ready for review / 合并。性能变化要以相同环境和有效样本支持；若失败，先提供最小复现而不是扩大重构范围。
