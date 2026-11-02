# 本分支历史发布索引

历史索引核对日期：2026-10-23；1.3.0 发布补记：2026-10-26；1.4.0 发布补记：2026-10-27；1.5.0 发布补记：2026-10-28；1.5.1 发布补记：2026-10-29；1.6.0 发布补记：2026-11-02；1.6.1 发布补记：2026-11-02；1.6.2 构建记录（未发布）：2026-11-02。发行仓库是 [sonwe1e/EdgeTerm](https://github.com/sonwe1e/EdgeTerm)，上游是 [miskin-lee/EdgeTerm](https://github.com/miskin-lee/EdgeTerm)。两者独立发布，不能根据版本数字大小推断功能包含关系。

本次索引核对了 GitHub Releases 的发布时间、附件名、发布说明和远端标签；下表 SHA 是标签解引用后的 **commit SHA**，不是 annotated tag 对象 SHA。日期使用北京时间。没有重新下载历史二进制，也没有重新执行旧版本的验收；历史验证结论以对应发布说明及其环境边界为准。

## 已公开发布

| 版本 / 发布页 | 首次发布日期 | 当前标签对应源码 | 当前附件与主要范围 |
| --- | --- | --- | --- |
| [v1.1.0](https://github.com/sonwe1e/EdgeTerm/releases/tag/v1.1.0) | 2026-10-16 | [392718e](https://github.com/sonwe1e/EdgeTerm/commit/392718edf71a360b067bfccd707aac08818b5666) | Windows x64 安装包、SHA256SUMS；文件比较、Filer、终端交互及职责拆分 |
| [v1.2.0](https://github.com/sonwe1e/EdgeTerm/releases/tag/v1.2.0) | 2026-10-17 | [9b904b4](https://github.com/sonwe1e/EdgeTerm/commit/9b904b4602fede31c57c45de1e64ef9c1a03f7ea) | Windows x64 安装包、便携包、SHA256SUMS；公钥登录、凭据保护、诊断与后续修订；有同版替包，见下文 |
| [v1.2.1](https://github.com/sonwe1e/EdgeTerm/releases/tag/v1.2.1) | 2026-10-19 | [6994ccb](https://github.com/sonwe1e/EdgeTerm/commit/6994ccb297658dd287d026476fb40b6b1d1a4482) | Windows x64 安装包、便携包、SHA256SUMS；实验工作台 |
| [v1.2.2](https://github.com/sonwe1e/EdgeTerm/releases/tag/v1.2.2) | 2026-10-20 | [f34924f](https://github.com/sonwe1e/EdgeTerm/commit/f34924f0551b375f2ba3ea7f1bff7f6e92b4f949) | 同上；启动降级、键盘可达性、连接及界面改进 |
| [v1.2.3](https://github.com/sonwe1e/EdgeTerm/releases/tag/v1.2.3) | 2026-10-20 | [c15e09b](https://github.com/sonwe1e/EdgeTerm/commit/c15e09b9f785916e2d4fa7b87d4c66f538e68074) | 同上；文件面板列布局、状态、键盘与文案修复 |
| [v1.2.4](https://github.com/sonwe1e/EdgeTerm/releases/tag/v1.2.4) | 2026-10-21 | [9bdb1f6](https://github.com/sonwe1e/EdgeTerm/commit/9bdb1f639fbced66957273514980b25fd3125cf4) | 同上；界面精修、SSH 配置转发导入与 SOCKS5 |
| [v1.2.8](https://github.com/sonwe1e/EdgeTerm/releases/tag/v1.2.8) | 2026-10-23 | [e3e920a](https://github.com/sonwe1e/EdgeTerm/commit/e3e920a6a85998788a8be64e46c2c7405e850155) | 同上；上游 1.0.1–1.0.4 的选择性移植与本地改进，见[移植记录](upstream-ports.zh-CN.md) |
| [v1.3.0](https://github.com/sonwe1e/EdgeTerm/releases/tag/v1.3.0) | 2026-10-26 | [dd012ba](https://github.com/sonwe1e/EdgeTerm/commit/dd012ba965c857c0a1dc2bcb25584887640f4c22) | Windows x64 安装包、便携包、独立诊断工具、SHA256SUMS；文件栏各列独立调宽、拖动与显示缩放适配、搜索响应性，见[发布说明](release-1.3.0.zh-CN.md) |
| [v1.4.0](https://github.com/sonwe1e/EdgeTerm/releases/tag/v1.4.0) | 2026-10-27 | [82acfb7](https://github.com/sonwe1e/EdgeTerm/commit/82acfb7b4983b033688ce2856b7a3a89220f1867) | Windows x64 安装包、便携包、独立诊断工具、SHA256SUMS；内置文件编辑器、后台传输队列、连接表单与工作台改进，见[发布说明](release-1.4.0.zh-CN.md) |
| [v1.5.0](https://github.com/sonwe1e/EdgeTerm/releases/tag/v1.5.0) | 2026-10-28 | [a9df679](https://github.com/sonwe1e/EdgeTerm/commit/a9df679ce590fd64c148f7dbf531d2f5416352ea) | Windows x64 安装包、便携包、独立诊断工具、SHA256SUMS；多终端显示与性能、文件和传输操作、Sender 及工作台改进，见[发布说明](release-1.5.0.zh-CN.md) |
| [v1.5.1](https://github.com/sonwe1e/EdgeTerm/releases/tag/v1.5.1) | 2026-10-29 | [4cbf773](https://github.com/sonwe1e/EdgeTerm/commit/4cbf773ceaaa5edce4bf12727eba46a794fbd04f) | Windows x64 安装包、便携包、独立诊断工具、SHA256SUMS；严格 SFTP 服务器保存、重读输入保护、日志 traceback 跳转与慢链路 SFTP 预算，见[发布说明](release-1.5.1.zh-CN.md) |
| [v1.6.0](https://github.com/sonwe1e/EdgeTerm/releases/tag/v1.6.0) | 2026-11-02 | [42d01f0](https://github.com/sonwe1e/EdgeTerm/commit/42d01f0f29ea61c2362b716685fb36a2e8ffb492) | Windows x64 安装包、便携包、独立诊断工具、SHA256SUMS；终端文件路径跳转、Filer 跟随终端目录、远端 localhost 地址经 SSH 转发打开、远程 HTML 报告预览，见[发布说明](release-1.6.0.zh-CN.md) |
| [v1.6.1](https://github.com/sonwe1e/EdgeTerm/releases/tag/v1.6.1) | 2026-11-02 | [fe8976b](https://github.com/sonwe1e/EdgeTerm/commit/fe8976be5fb486fec27e9104aa19562e1b2d762f) | 同上；输入行选区直接删除/替换、Alt+点击不再弹出菜单栏，见[发布说明](release-1.6.1.zh-CN.md) |

截至 2026-10-28，本分支没有公开的 macOS/Linux 安装包，也没有签名自动更新清单。上游提供这些平台的发布包，不代表本分支已完成这些平台的构建或验证。`v1.0.0` 是保留的共同基线标签，不是本分支独立发布的 Release；本地其他 `v0.*`、`v1.0.*` 标签也不能当作本分支发布记录。

## 1.6.2 构建记录（未发布）

前一个本分支公开版本为 1.6.1。本版内容为一项兼容修复（输入行选区第二次编辑失效，`66835ba`）加两项兼容调整（停靠 Filer 改为列表、三处尺寸拖拽统一，`f833eed`、`9b9df02`），版本 1.6.2；安装版沿用 `com.edgeterm.desktop` 标识、配置路径和凭据存储，没有数据格式迁移。便携包自带用于启用便携模式的 `data` 目录和说明；升级已有便携副本时应保留原有 `data`，不能用新包的空目录覆盖。

应用二进制构建自 `1e2f379`（含 `66835ba` 修复与 1.6.2 版本号提交），发布说明提交为 `a7252d532e9ef712f7893a4990b3ccbf9b36a143`；本地标签 `v1.6.2` 指向该发布说明提交，**尚未推送**。在 Windows x64 上通过受限 runner 执行 `tauri:build --bundles nsis`，使用 Node 24.19.0、rustc/cargo 1.99.1、MSVC 和 Windows SDK；程序和安装器的文件版本均为 1.6.2。便携包中的 `EdgeTerm.exe` 与该 NSIS 构建输入一致，SHA-256 为 `400d41f6aacd630d48a70831a863138c8b4b3d2fb4bfc272301933ee71f720cc`。安装器和程序均未做 Windows 数字签名，校验和不代替发布者签名验证。

| 1.6.2 附件（本地 `artifacts/release-1.6.2/`） | 字节数 | SHA-256 |
| --- | ---: | --- |
| `EdgeTerm_1.6.2_x64-setup.exe` | 4096750 | `9b06155e9272ef763d5ce636b3fcaab36faa7b84dcf69c53bfd45a6a643ed842` |
| `EdgeTerm_1.6.2_x64-portable.zip` | 5100413 | `0f8d84423fcd2d7fd5a84808c41ab197c8f1bd38e05efbc5a7a5a9bb090e271e` |
| `EdgeTerm_1.6.2_windows-diagnostics.zip` | 5471 | `ce6f542afcfa1150d5913404707a99cea1a255d88a476d42221f64f9f1f2e4db` |

同页 `SHA256SUMS.txt` 列出上述三个附件，`npm run release:package -- --check` 逐个比对通过（3 attachments match）。本轮只推送 `main` 分支提交，**不推送标签、不创建 GitHub Release**；因此远端没有 `v1.6.2` 标签、Release 或对应的 CI run，附件的远端状态留待正式发布时核对。

Windows 本地检查：112 个前端单元测试文件 / 1046 项、29 个浏览器测试文件 / 137 项（真实 Edge，含新增的列表布局契约与第二次拖选删除用例）、451 项 Rust 测试通过、28 项按配置跳过；TypeScript、Biome 格式、lint、前端生产构建通过；`66835ba` 与 `1e2f379` 两条提交在整棵树上通过类型检查。lint 保留生成绑定中的两条既有 `any` 警告，Rust 保留既有 4 条未使用代码警告。浏览器回归使用模拟 IPC 与真实 Edge；选区修复的端到端用例模拟 shell 重绘，未在真实 pwsh 或 SSH bash 会话内人工复验；开发版窗口在真实 WebView2 上启动并完成首帧，但安装包本身未在作者机器上执行安装升级验收。

## 1.6.1 构建与验证记录

前一个本分支公开版本为 1.6.0。本版内容为兼容修复（Alt+点击后菜单栏误弹出，`79a6b64`）加一项兼容新能力（输入行选区删除/替换，`fce6752`），按维护者决定使用补丁版本 1.6.1（先例 1.5.1）；安装版沿用 `com.edgeterm.desktop` 标识、配置路径和凭据存储，没有数据格式迁移。便携包自带用于启用便携模式的 `data` 目录和说明；升级已有便携副本时应保留原有 `data`，不能用新包的空目录覆盖。

固定源码为 `fe8976be5fb486fec27e9104aa19562e1b2d762f`（含 `33d5f9c` 版本、`959af4c` 产物记录与 `fe8976b` 发布说明）。在 Windows x64 上通过受限 runner 执行 `tauri:build --bundles nsis`，使用 Node 24.19.0、rustc/cargo 1.99.1、MSVC 和 Windows SDK；程序和安装器文件版本均为 1.6.1。便携包中的 `EdgeTerm.exe` 与该 NSIS 构建输入一致，SHA-256 为 `fb6ebe9d8e56165676bc96b7977592671c316039347c6c0973305ca10d3454ef`。便携包不含用户设置或凭据，诊断包只含 `diagnose-hang.cmd`、`diagnose-hang.ps1` 与说明。安装器和程序均未做 Windows 数字签名，校验和不代替发布者签名验证。

| 1.6.1 附件 | 字节数 | SHA-256 |
| --- | ---: | --- |
| `EdgeTerm_1.6.1_x64-setup.exe` | 4098396 | `9f7db9b83f9bd083f23a7521917c99f509b38829050266bdcef4f5c257f3c92e` |
| `EdgeTerm_1.6.1_x64-portable.zip` | 5092743 | `fdc101d785a62e88ae5e01bf792e0082ecb332e2ca8d6901748080a3c4c10d6b` |
| `EdgeTerm_1.6.1_windows-diagnostics.zip` | 5471 | `d9ee8815b2282371791bdd84845ad4c97863ecd350955d479f4d06ad299cc55a` |

同页 `SHA256SUMS.txt` 列出上述三个附件。发布后从该页回下载四个附件并逐个计算 SHA-256，与本地文件一致。2026-11-02 14:38（北京时间）公开为 latest，非草稿、非预发布；发布后确认远端标签解引用到上述源码，四个附件大小一致。

Windows 本地检查：111 个前端单元测试文件 / 1051 项、30 个浏览器测试文件 / 160 项（真实 Edge，含本轮新增的 Alt+点击 1 项与输入行选区编辑 3 项端到端指针用例）、451 项 Rust 测试通过，28 项按配置跳过。Rust 全量首跑有一条 `closing_a_pending_remote_forward_cancels_its_late_allocation` 在并行负载下断言 `stopping`≠`stopped` 失败，单独重跑与全量重跑均通过，判定为既有用例的时序抖动；本版未改动 Rust 代码。TypeScript、Biome 格式、lint、前端生产构建通过；`79a6b64` 与 `fce6752` 两条代码提交逐个独立验证（fix 提交在独立树上通过 typecheck 与自身浏览器套件），菜单栏修复的回归用例先在旧实现上运行并失败。lint 保留生成绑定中的两条既有 `any` 警告。浏览器回归使用模拟 IPC 与 Playwright/真实 Edge；未在真实 Tauri/WebView2 窗口内验收 Alt+点击、选区编辑与中文输入法组合态，未覆盖 zsh 自动建议与 OpenCode/Vim/tmux 程序内的选区场景，也未在用户现有安装上执行安装器升级。该源码的 [GitHub CI](https://github.com/sonwe1e/EdgeTerm/actions/runs/41401149489) 的 checks 工作流通过。

## 1.6.0 构建与验证记录

前一个本分支公开版本为 1.5.1。本版为兼容性新功能（终端对文件、目录、服务与报告的直连，以及鼠标定位契约），按独立版本序列使用 minor 版本 1.6.0；安装版沿用 `com.edgeterm.desktop` 标识、配置路径和凭据存储，没有数据格式迁移。便携包自带用于启用便携模式的 `data` 目录和说明；升级已有便携副本时应保留原有 `data`，不能用新包的空目录覆盖。

固定源码为 `42d01f0f29ea61c2362b716685fb36a2e8ffb492`。在 Windows x64 上通过受限 runner 执行 `tauri:build --bundles nsis`，使用 Node 24.19.0、rustc/cargo 1.99.1、MSVC 和 Windows SDK；程序和安装器文件版本均为 1.6.0。便携包中的 `EdgeTerm.exe` 与该 NSIS 构建输入一致，SHA-256 为 `c04acff0954182cc246c9e0daad37116a0a57f7294516fbdd40134497ae69add`。便携包不含用户设置或凭据，诊断包只含 `diagnose-hang.cmd`、`diagnose-hang.ps1` 与说明。安装器和程序均未做 Windows 数字签名，校验和不代替发布者签名验证。

| 1.6.0 附件 | 字节数 | SHA-256 |
| --- | ---: | --- |
| `EdgeTerm_1.6.0_x64-setup.exe` | 4097199 | `fa963c165f1003d771ca95fd712b65ea86d4643705e7547158cc6a3ab79ef6b3` |
| `EdgeTerm_1.6.0_x64-portable.zip` | 5097433 | `ed361ee31a63e35d11fc30ac24e26c5b0f57d469cc77dfef12f9260c17ae2187` |
| `EdgeTerm_1.6.0_windows-diagnostics.zip` | 5471 | `e2e841260726ca0705dc400dcdce1303ec5490bd621e8690ae48733e7eaef0bc` |

同页 `SHA256SUMS.txt` 列出上述三个附件。发布后从该页回下载四个附件并逐个计算 SHA-256，与本地文件一致。2026-11-02 08:19（北京时间）公开为 latest，非草稿、非预发布；发布后确认远端标签解引用到上述源码，四个附件大小一致。

Windows 本地检查：110 个前端单元测试文件 / 1026 项、29 个浏览器测试文件 / 156 项、451 项 Rust 测试通过，28 项 Rust 测试按配置跳过；另有一条针对真实 sshd 的远程预览验收用例通过（本机 WSL Ubuntu sshd，`127.0.0.1:2222`）。TypeScript、Biome 格式、lint、前端生产构建、Rust 格式和 Rust/前端绑定一致性检查（97/102 命令）通过；`48a12a0..42d01f0` 的 4 个提交逐个通过提交规范与类型检查。lint 保留生成绑定中的两条既有 `any` 警告；Rust 保留既有未使用代码警告。浏览器回归使用模拟 IPC；Rust 回环用例使用本地目录源，真实 SFTP 行为只由那条 ignored 的真实 sshd 用例覆盖。该源码的 [GitHub CI](https://github.com/sonwe1e/EdgeTerm/actions/runs/41366374494) 的 frontend 与 rust 两个 job 均通过。未在真实 Tauri/WebView2 窗口内验收鼠标定位、Ctrl+点击、跟随按钮与右键预览菜单，未覆盖 OpenCode/Vim/tmux 的真实鼠标行为、中文输入法组合态、系统浏览器实际打开、应用窗口内的隧道端到端、高输出性能、并发与上限边界、macOS/Linux 桌面环境，也未在用户现有安装上执行安装器升级。

## 1.5.1 构建与验证记录

