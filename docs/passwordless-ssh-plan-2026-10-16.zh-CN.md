# 免密登录专项：阶段 0 基线与范围（2026-10-16）

本文记录本次"结构化诊断、系统凭据库、公钥安装与独立验证、IPC 契约收尾"专项的
阶段 0 结论：基线检查、现状调用链核对、实施范围清单和验证环境。规则遵循
[工程规范](engineering-standards.zh-CN.md)（R1–R10）与[测试与验收方案](test-plan.zh-CN.md)。
基线提交：`392718e`（`chore: bump version to 1.1.0`），分支
`codex/edgeterm-flow181-improvements`，工作区干净、无 stash。

## 1. 基线记录（2026-10-16，Windows 11 10.0.26300，rustc 1.99.0 / node v24.19.0 / npm 11.17.0）

| 检查 | 命令 | 结果 |
|---|---|---|
| 类型 | `npm run typecheck` | 通过 |
| 静态检查 | `npm run lint` | 通过；2 条既有警告（生成文件 `src/bindings.ts:1173/1174` 生成器 helper 的 `noExplicitAny`，[IPC 契约文档](ipc-contracts.zh-CN.md)已声明原样保留） |
| 前端测试 | `npm test` | 68 文件 / 521 用例全过 |
| 构建 | `npm run build` | 通过；既有 chunk 大小警告（index 580.08 kB / gzip 184.24 kB，terminal 620.50 kB / gzip 173.40 kB，fileIcons 318.64 kB / gzip 53.42 kB） |
| 契约 | `npm run check:bindings` | 通过：92/97 命令、5 事件、5 项手写例外 |
| Rust 测试 | `cargo test --manifest-path src-tauri/Cargo.toml --lib` | 277 通过 / 0 失败 / 23 ignored（real_* 与 benchmark，需专用环境） |
| 格式 | `cargo fmt -- --check` | 通过 |
| 空白 | `git diff --check` | 通过 |

基线无失败项。浏览器验收（`npm run test:browser`、Playwright 脚本）与真实服务器
用例本环境未运行，原因见第 4 节；后续各阶段的验证记录都会区分"夹具通过"与
"真实环境通过"。

## 2. 现状调用链核对（阶段 0 要求的事实）

### 2.1 SSH 认证、连接复用、主机密钥、会话配置

- 前端 `src/api.ts` 的 `openSession()` 携带 `on_output` Channel 与 `output_token`
  调用 `open_session`；后端在 `src-tauri/src/commands/sessions.rs` 分派。
- 打开会话时按 id 或内联 profile 取配置，`Store::get` 把存储的
  password/passphrase 合并进 profile 后才进入连接层。
- 复用有两条路径：(a) 显式 `reuse_session_id` → `SshTransports` 的 session→transport
  弱引用表；(b) 自动复用 `session::reuse::ConnectionPool`（按身份摘要单飞，
  摘要含密钥文件 SHA-256；认证期间密钥变化拒绝入池，见 `real_reuse_rejects_key_rotation_*`）。
- 连接链：`session::ssh::connect_handle` → 逐跳 `connect_hop`（russh 握手 + TOFU
  known_hosts 策略）→ `authentication::authenticate`（先 `none` 探测；password /
  publickey / agent；被要求第二因子时走 `keyboard-interactive`）。
- 主机密钥变化：握手返回 `HostKeyChange` 给前端；用户确认后
  `accept_host_key` 重写该主机在 known_hosts 的全部条目；确认前不打开任何通道。
- MFA/追问：`session:auth-prompt` 事件 + `answer_auth_prompt` 命令；180 秒超时；
  后台（无 UI）prompt 直接失败，不弹窗。
- 会话配置保存：`save_profile` → `Store::save`；`sync_secrets` 把秘密拆到凭据表，
  profile 本身不落秘密。

### 2.2 凭据存储、便携模式、导入导出

- `credentials.json` 现状（v1）：`HKDF-SHA256(machine_id + 用户名 + 随机盐) →
  ChaCha20-Poly1305`，信封字段 `encrypted/kdf/cipher/salt/nonce/ciphertext`；
  密钥派生自机器标识与账户名，从不落盘，同机同账户免提示打开。
- 平台机器标识：macOS `IOPlatformUUID`、Windows `MachineGuid`、Linux
  `/etc/machine-id`；缺失时退化为仅账户名（`eprintln!` 提示）。
- 文件权限：Unix 0600；Windows 无额外 ACL（依赖用户配置目录 ACL）。
- 旧数据迁移：加载 `sessions.json` 时内嵌的 password/passphrase 搬入凭据表；
  明文布局的 `credentials.json` 在下次保存时封装成信封。
- 导入导出：`Store::snapshot()` 经 `redact_profile` 剥离秘密；`import_data` 忽略
  文件中的凭据字段。`credentials.json` 不参与导出。
- 便携模式：exe 同级存在 `data/` 即启用，所有配置文件与 WebView2 用户数据都在
  该目录；`credentials.json` 同样受机器绑定密钥保护（不随文件夹跨机可用）。

### 2.3 诊断与既有环境

- 目前**没有** tracing/日志设施：仅有少量 `eprintln!`（凭据打不开、清理失败、
  NVIDIA 兼容）。没有日志目录、滚动、容量上限或诊断导出。
- 错误跨 IPC 是扁平字符串：`AppError(String)`，`Throw` 模式 rejected Promise。
- 诊断脚本：`scripts/README.md` 登记 Playwright/CDP/静态检查工具；`check:commits`
  支持逐提交 typecheck。
- 真实服务器夹具：`real_*` 用例（Rust，默认 ignored）需要
  `EDGETERM_REAL_SSH_ADDR/USER/KEY/ROOT`（SFTP/转发/复用/监控，ROOT 内 `sshd.log`
  用于认证次数核对）与 `EDGETERM_REAL_FTP_ADDR/USER/PASS/ROOT`。
  `feature_ipc_tests` 用 MockRuntime 走真实生产命令分派。

## 3. 实施范围清单

保留计划中的技术选择；React Compiler、SQLite、虚拟列表替换、X/ZMODEM 下沉 Rust
维持"条件性评估"，不作为本次交付前提。按阶段拆分的提交如下（每个提交各自可编译，
测试随实现提交）：

1. **本提交**：基线文档（本文件）。
2. **诊断基础设施**：`tracing` 落盘（应用数据目录 `logs/`、滚动、容量上限、
   非阻塞写入、写入失败不影响连接），请求开始/结束/耗时与阶段事件。
3. **结构化错误**：`AppError` 增加 `code/message/operation/request_id`；序列化保持
   字符串兼容旧前端，新结构通过 Specta 导出；首批覆盖 SSH 连接/认证、公钥安装/
   验证、凭据读写/迁移、文件传输公共错误；前端兼容新旧两种形状。
4. **凭据存储接口**：Rust 后端 `CredentialStore`（读取/写入/删除/可用性/迁移），
   会话配置只保留引用与元数据。
5. **系统凭据后端与迁移**：随机主密钥存入 OS 凭据库（keyring；Windows 凭据管理器、
   macOS Keychain、Linux Secret Service），保留 ChaCha20-Poly1305 与文件布局，新增
   文件版本与密钥来源字段；可恢复迁移流程（读旧 → 取新密钥 → 写临时文件 → 验证 →
   提交 + 备份）；便携/凭据库不可用时的显式行为（会话内使用，不落盘，不降级明文）。
6. **本地密钥检查与生成**：读取私钥、必要时口令、派生公钥与指纹（SHA-256 风格）；
   生成 Ed25519 默认、不覆盖现有文件、权限 0600、可选口令（复用阶段 2 凭据）。
7. **远端公钥安装**：`authorized_keys` 合并（按类型+数据去重、保留原内容、末尾无
   换行处理、权限、symlink/属主检查、并发修改检测、带限制选项的同一公钥不追加
   无限制副本）；优先 SFTP，远程命令走严格参数。
8. **独立公钥认证验证**：新建真实连接、绕过连接池、仅公钥（密码不回退）、沿用
   主机密钥与跳板路径、超时与取消；结果区分成功/需额外因素/失败/超时/主机密钥变化。
9. **会话配置更新与前端流程**：仅验证成功后更新认证方式与私钥路径；失败恢复文案
   （含"已安装但未验证"）；会话菜单入口 + 对话框 + i18n + 状态刷新。
10. **真实 SSH 测试与桌面验证**：第 7 节矩阵的真实夹具执行；Windows/macOS/Linux
    平台记录（重点：私钥权限、系统凭据库行为）。
11. **剩余普通 IPC 适配器迁移**：新增命令全部走生成契约；按覆盖面迁移手写
    `invoke<T>()`；保留原始二进制与 Channel 例外并登记。

明确的非目标（本专项内不做）：react compiler 默认开启、SQLite、TanStack Virtual、
X/ZMODEM 下沉、协议库替换、便携主密码跨机方案的完整交付（先以显式状态 + 会话
模式覆盖，单独实现与验证）。

## 4. 验证环境说明

| 环境 | 现状 | 说明 |
|---|---|---|
| 前端单元（jsdom） | 可用 | `npm test`；不含真实终端渲染 |
| 浏览器契约 | 可用（需 Playwright 浏览器） | `npm run test:browser`；默认 Playwright Chromium，可用 `PERF_BROWSER` 走系统 Edge |
| Rust 单元/夹具 | 可用 | `cargo test --lib`；277 通过 / 23 ignored |
| Tauri IPC（MockRuntime） | 可用（需真实 SSH 夹具） | `feature_ipc_tests` 默认 ignored |
| 真实 OpenSSH 夹具 | **未配置** | 本机有 OpenSSH 客户端（`C:\Windows\System32\OpenSSH\ssh.exe`），无 sshd；`EDGETERM_REAL_SSH_*` 未设置。后续阶段建立专用 loopback 夹具（Windows 上可装 OpenSSH Server，或使用隔离容器/虚拟机）后运行 |
| 真实 FTP 夹具 | **未配置** | 需要 pyftpdlib（本机 Python 3.12 可用）与 `EDGETERM_REAL_FTP_*` |
| Linux 凭据服务 | **未验证** | 需要 Linux 目标机（gnome-keyring/KWallet 存在与不存在两种情况） |
| macOS | **未验证** | 需要 macOS 目标机（Keychain 行为、私钥权限） |
| 桌面端到端 | 未运行 | `tauri:dev`/`tauri:build` 产物验证，随阶段 3 的 UI 交付补测 |

真实夹具的验收口径（沿用测试方案）：环境未配置、用例被过滤或 ignored 都不算
通过；每项结果记录基线/候选提交、日期、环境、命令、预期、实际。

## 5. 验收入口映射（阶段 0 完成标准）

每个后续修改都有对应测试入口，能区分新增问题与既有问题：

| 修改领域 | 回归入口 |
|---|---|
| 诊断/日志 | Rust 单元（初始化、轮转、容量、敏感串不落盘、写失败不影响） |
| 结构化错误 | Rust 序列化夹具 + 前端新旧形状处理用例 |
| 凭据存储/迁移 | `store.rs` 模块测试（含中断/失败注入）+ 前端状态展示 |
| 本地密钥 | Rust 单元（解析、指纹、生成、权限、口令） |
| 远端安装 | `authorized_keys` 合并纯函数测试 + SFTP 夹具 + 真实 OpenSSH |
| 独立验证 | ReuseKey 隔离、禁回退、跳板路径；真实夹具重连矩阵 |
| IPC 契约 | `npm run check:bindings` + 各命令一侧序列化测试 |
