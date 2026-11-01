# 项目状态

## 本轮：目录与打包整理、缺陷修复（2026-11-01）

- 基线 `b4ba925`，工作区干净。协作约定见 [TEAM.md](../../TEAM.md)：本轮由 Lead 派两个只读审计任务（打包一致性、前端缺陷），修复与验证由 Lead 完成；审计者无写权限，结论逐条由 Lead 复核并给出可执行证据。
- 提交：`3536ebe` 受管入口在受限主机上的降级、`613c54b` 版本一致性守卫、`1e54e02` 手工发版产物忽略 + bump 脚本不再推送、`97d22e3` 文档索引与发版清单、`9ba681d` Sender 重复计数与状态本地化、`38d9800` 面板宽度偏好、`210e166` 传输设置写入失败、`e1012fa` 一条命令装配发版附件。

### 修复与证据

| 问题 | 修复 | 证据 |
| --- | --- | --- |
| 受限主机拒绝 CPU affinity 时，所有受管任务在启动前失败 | affinity/优先级降级为警告，doctor 报告真实预算；doctor 的版本探测不再经管道捕获 | `3536ebe`；`./dev.ps1 doctor` 由 “Exception setting ProcessorAffinity: Access is denied” 变为 `cpuMask: unbounded` 并继续执行；入口契约用例只接受“有预算”或“降级且告警” |
| 四个版本文件没有自动一致性校验（原校验随停用 workflow 失效） | 只读 `scripts/check-version.mjs` + `npm run version:check`，接入 CI | `613c54b`；漂移副本退出码 1 并指出 Cargo.toml 1.5.0 ≠ 1.5.1 |
| 手工发版产物未被忽略；`version-bump.sh` 会直接 push | 增加忽略规则；脚本只改版本、跑校验并打印提交命令 | `1e54e02` |
| Sender 在没有可写会话时仍计一次重复，并虚报 “repeated … done” | 只有 sendUnits 真正写入至少一个会话才计数；三条状态改走语言目录 | `9ba681d`；旧实现一个 tick 后 `getSchedule()` 变 null 且状态含 done，新实现保持等待；中文界面断言 “发送器：命令已重复 1 次，完成” |
| 窗口缩放后的面板宽度被当作偏好写回，放大窗口也回不去 | 偏好与显示值分离（`loadPanelSizingPreference`），底栏同一规则 | `38d9800`；500/500 在 1000px 窗口打开后仍能在 1600px 恢复 |
| 存储写入失败时 `saveTransferOptions` 把异常抛给 UI | 与其余偏好一致地捕获 | `210e166`；旧实现抛 QuotaExceededError |

### 出包链路（本轮追加）

发版附件过去只存在于停用 workflow 和人工步骤里，本轮把它变成一条可复现的命令，并在当前树上真实跑通：

| 项目 | 结果 |
| --- | --- |
| 真实出包 | `./dev.ps1 tauri:build --bundles nsis` → `EdgeTerm_1.5.1_x64-setup.exe` 4,184,827 B（3.99 MiB） |
| 附件装配 | `npm run release:package` → 安装包 + 便携包 5,212,734 B + 诊断包 5,471 B + `SHA256SUMS.txt`，0.9 s；`--check` 三个附件全部匹配 |
| 还原验证 | 便携包经 Windows `Expand-Archive` 还原出 `EdgeTerm.exe`、空 `data/`、`README.txt`，exe 的 SHA-256 与源一致；诊断包还原出两个脚本与说明 |
| 阻塞与绕法 | Tauri 的 NSIS 工具链下载在本机失败（CLI 报 `Peer disconnected`；PowerShell/curl 走 Schannel 报 `SEC_E_NO_CREDENTIALS`；Node 能连）。用 Node 分块下载并按 tauri-cli v2.12.1 源码里的 SHA-1 校验后预置到 `%LOCALAPPDATA%\tauri\NSIS`，重跑成功 |

### 验证

- 单元：113 文件 / 955 用例通过（基线 111 / 944；新增 3 条 Sender 重复、2 条面板偏好、1 条传输设置、5 条发版归档）。
- 浏览器：`PERF_BROWSER=msedge` 32 文件 / 172 用例通过（真实 Edge）。
- Rust：`./dev.ps1 test:rust` 459 通过、27 ignored、0 失败；本轮未改 Rust。
- 类型检查、Biome lint（仅生成绑定里两条既有 `any` 警告）、`format:check`、前端生产构建通过。
- 新增回归用例先在旧实现上运行并失败，修复后通过（逐条见上表）。
- 未验证：真实 Tauri 窗口内的面板拖拽与 Sender 重复（jsdom 与浏览器用例只覆盖状态机、纯布局函数和既有界面契约）；安装包未做安装、卸载与签名验证。

### 边界与后续

- 发版第 5、6 步已由 `scripts/package-release.mjs` 承担，步骤见[发布索引](../releases.zh-CN.md#发版步骤可复现清单)。`artifacts/release-1.5.1/` 只是本地验证产物：版本号仍是 1.5.1，但源码已比已发布的 1.5.1 多 9 个提交，不能按 1.5.1 发布；正式发版要先 `npm run version:set`。
- 只读审计已报告但本轮未做：`check:icons` 只校验 dist 里的文件图标、不校验 `bundle.icon`；CI 不跑 `build`/`check:bindings`；`.cmd` 文件在 `.gitattributes` 下统一为 LF。
- 上一轮的输入、剪贴板与 Pi 修复细节见[终端输入修复](../terminal-input-fixes.zh-CN.md)、[侧栏诊断](../sidebar-freeze-diagnostics.zh-CN.md)，提交范围 `b6b5527..8353e4c`。
