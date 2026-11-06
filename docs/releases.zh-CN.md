# 本分支历史发布索引

历史索引核对日期：2026-10-23；1.3.0 发布补记：2026-10-26；1.4.0 发布补记：2026-10-27；1.5.0 发布补记：2026-10-28；1.5.1 发布补记：2026-10-29；1.6.0 发布补记：2026-11-02；1.6.1 发布补记：2026-11-02；1.6.2 构建记录（未发布）：2026-11-02；1.7.0 发布补记：2026-11-05；1.7.2 发布补记：2026-11-06。发行仓库是 [sonwe1e/EdgeTerm](https://github.com/sonwe1e/EdgeTerm)，上游是 [miskin-lee/EdgeTerm](https://github.com/miskin-lee/EdgeTerm)。两者独立发布，不能根据版本数字大小推断功能包含关系。

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
| [v1.7.0](https://github.com/sonwe1e/EdgeTerm/releases/tag/v1.7.0) | 2026-11-05 | [399702f](https://github.com/sonwe1e/EdgeTerm/commit/399702f959dd4d9b5834f6a3597033b8c8c542f9) | Windows x64 安装包、便携包、独立诊断工具、SHA256SUMS；Agent 提示词、终端选区引用与撤销，以及未公开发布的 1.6.2 改进，见[发布说明](release-1.7.0.zh-CN.md) |
| [v1.7.2](https://github.com/sonwe1e/EdgeTerm/releases/tag/v1.7.2) | 2026-11-06 | [84221bc](https://github.com/sonwe1e/EdgeTerm/commit/84221bc8f76e072397cec3ae8cdabb2bd07eedf4) | Windows x64 安装包、便携包、独立诊断工具、SHA256SUMS；工作区恢复、OpenCode 状态和 Pi 滚轮兼容，见[发布说明](release-1.7.2.zh-CN.md) |

截至 2026-10-28，本分支没有公开的 macOS/Linux 安装包，也没有签名自动更新清单。上游提供这些平台的发布包，不代表本分支已完成这些平台的构建或验证。`v1.0.0` 是保留的共同基线标签，不是本分支独立发布的 Release；本地其他 `v0.*`、`v1.0.*` 标签也不能当作本分支发布记录。

## 1.7.2 构建与发布记录

前一个公开版本为 1.7.0。按用户指定，本次公开版本号为 1.7.2，包含工作区恢复、OpenCode 状态修复以及此前 1.7.3 本地构建中的 Pi 滚轮修复。此前同名的 1.7.2 本地安装包内容和哈希不同，详见下方历史记录；本次没有替换任何已公开附件。安装版沿用应用标识和配置目录，工作区从本版开始记录，不会恢复旧版从未保存的标签，也不会续跑原来的程序。

固定源码及远端标签解引用提交为 `84221bc8f76e072397cec3ae8cdabb2bd07eedf4`。在干净的 Windows x64 工作树中以 `./dev.ps1 tauri:build --bundles nsis` 构建，使用 Node 24.19.0、rustc/cargo 1.99.1、MSVC 和 Windows SDK；程序与安装器文件版本均为 1.7.2。便携包中的程序与 NSIS 构建输入一致，SHA-256 为 `bae1efbedc532101b151f219b7ba2ca85906572dcab210522767b2efaaefb3af`。便携包只含程序、说明和空 `data/`，诊断包只含两个诊断脚本与说明；程序和安装器均未签名。

| 正式附件 | 字节数 | SHA-256 |
| --- | ---: | --- |
| `EdgeTerm_1.7.2_x64-setup.exe` | 4115462 | `4189a18fb6cbe06609f713ab12f5bb17176f36112216fad09dedd5e41d98effe` |
| `EdgeTerm_1.7.2_x64-portable.zip` | 5115660 | `a1ebda89a98e57ff69a930220e914532f8ddf901464a33871e02fec9f9ae5cb2` |
| `EdgeTerm_1.7.2_windows-diagnostics.zip` | 5471 | `f1db4a676bee77f7b2db22af9232d6d5454520cede978da75a4098283c3e8333` |
| `SHA256SUMS.txt` | 298 | `a9e9025f23b92c1e6e069fdbb77a240dd31270348d29299fbc1d39c39afb501b` |

草稿中的四个附件回下载后逐个计算 SHA-256，与本地构建和 GitHub 记录一致。2026-11-06 08:43:32（北京时间）公开为 latest，非草稿、非预发布；公开后核对了附件大小和 GitHub 摘要。固定源码的 [GitHub checks 工作流](https://github.com/sonwe1e/EdgeTerm/actions/runs/42065265453)通过。发布记录由后续文档提交补充，不移动标签。

Windows 上相同功能源码在最终版本号调整前通过前端 115 文件 / 1106 项、真实 Edge 浏览器 31 文件 / 160 项及 Rust 455 项测试，另有 29 项 Rust 测试按环境条件忽略；格式、lint、TypeScript 和前端生产构建通过。最终 1.7.2 源码通过版本一致性检查、Windows release 构建，以及 5 个提交逐一类型和提交规范检查。OpenCode 和 Pi 的独立提交分别通过 40 / 20 项单元和 16 / 10 项浏览器测试；这些工作树仅为引用主仓库依赖放宽 Vite 文件访问边界。保留既有 Rust/链接器警告。

浏览器测试使用模拟 IPC；本机 Windows ConPTY、WSL OpenSSH、OpenCode 2.2.5 和 Pi 1.5.0 的先前原生验收与边界分别见下方历史记录。未连接用户远端主机或调用模型，未在用户现有安装上执行升级，也未实测本次正式安装器的原生重启恢复。

## 1.7.3 本地安装包（未发布）

2026-11-05 用户反馈 SSH 远端 Pi 的滚轮影响输入框而无法滚动对话。本版补识别延迟到达的
启动命令回显，并在已识别 Pi 的全屏会话缺少鼠标上报时，把 xterm 的滚轮方向键兜底改为
PageUp/PageDown，让历史翻页并保留草稿。实际方向键、正常鼠标上报、普通屏幕和其他程序
保持原行为，详见[终端输入修复](terminal-input-fixes.zh-CN.md#2026-11-05ssh-pi-滚轮误切换输入历史)。
这是兼容修复，保留 OpenCode SSH 状态修复与标签、两类目录恢复，无新增配置迁移。

4 项新增回归先在旧实现上失败。最终相关单元测试 106 项、真实 Edge 浏览器测试
35 项（模拟 IPC）、定向格式/lint 和生产构建内的 TypeScript 检查通过。另用官方 Pi 1.5.0
Linux x64、本机 WSL OpenSSH、200 ms SSH 下行延迟及 Windows release/WebView2 做对照：
人工注入鼠标模式丢失后，旧版发方向键、替换草稿且对话仍在末尾；修复版双向翻页并保留
草稿，恢复鼠标上报后 SGR 滚动与正常退出通过。使用离线生成历史，未读取用户会话或调用模型。
这证明鼠标模式缺失场景的兼容修复，不证明用户远端丢失模式的具体原因；未连接用户主机、
测试其他 Pi 版本或执行安装升级。原生测试程序使用独立应用标识和预发布版本号；基线为
修复前的功能源码，不是交付的 1.7.2 安装文件。最终安装器使用正常应用标识。

源码为 `99b0adb4bb1eaf79663408929e284c3eebab62c5` 加当时尚未提交的工作区变更；2026-11-05
15:28–15:32（北京时间）通过 `./dev.ps1 tauri:build --bundles nsis` 构建。应用和安装器版本
均为 1.7.3，载荷为 Windows x64；构建前后源文件清单一致，交付副本与构建输出哈希一致。
目录 `artifacts/EdgeTerm-1.7.3-99b0adb-pi-scroll/` 含来源清单、构建日志、校验和、
原生对照 JSON 与截图；应用载荷 SHA-256 为
`c28b4350e5cb411c9e05c4783c18f05278521fdc94d3483dba147ce97ad77d7e`。
保留既有 Rust/链接器警告。安装包未签名；未发布 GitHub Release、创建标签或覆盖旧产物。

| 文件 | 字节数 | SHA-256 |
| --- | ---: | --- |
| `EdgeTerm_1.7.3_x64-setup.exe` | 4116489 | `c1dac0c048a6bbfaa67325f4df55b0a67912535b6f4bc721703a34a5a344673a` |

## 1.7.2 本地安装包（历史构建，非正式附件）

这一节记录的是此前仅供本机使用的安装包。后续正式发行的 1.7.2 使用新的源码提交和附件，
并包含上面的 1.7.3 本地构建中的 Pi 滚轮修复；两者同名但 SHA-256 不同。

2026-11-05 用户反馈直接在 SSH 运行 OpenCode 2.2.5 时，1.7.1 仍会保持活动动画。
确认此前实现只接受已识别 Agent 的状态：Enter 先于 SSH 命令回显到达时，会把 OpenCode
当作普通长命令并忽略其空闲报告。1.7.2 将 OSC 7501 接收与命令识别解耦，使用有效的
`app` 字段补识别，并让第一次空闲报告清除原来的运行态。保留 1.7.1 的标签和两类目录恢复。
这是本地兼容修复构建，不覆盖先前交付物或已公开附件，不新增配置迁移。

新增三条回归先在 1.7.1 实现上失败；最终相关单元测试 140 项、真实 Edge 浏览器回归
20 项（模拟 IPC）、类型检查和定向格式/lint 均通过。另用官方 OpenCode 2.2.5、
本机 WSL OpenSSH 专用账号、真实 release/WebView2，以及 200 ms SSH 下行延迟做对照：
旧版收到真实空闲报告仍显示“命令运行中”；修复版立即空闲，未提交草稿维持空闲，
退出 OpenCode 后普通 `sleep 2` 的开始／结束提示正常。此验证未调用模型；真实模型、
授权与多任务负载未实测，其状态切换由协议用例覆盖。未连接用户 SSH 主机或执行安装升级。

源码基线为 `99b0adb4bb1eaf79663408929e284c3eebab62c5` 加当时尚未提交的工作区变更。
本机产物目录为 `artifacts/EdgeTerm-1.7.2-99b0adb-opencode-ssh/`。
测试程序使用独立应用标识以避开正在运行的用户实例，交付安装器使用正常应用标识；
版本、哈希、源文件清单和测试边界记录在相邻 `build-info.json`、`source-manifest.json`，
原生对照结果及截图为 `ssh-before.*` 和 `ssh-after.*`。该历史构建当时未发布 GitHub Release 或标签。

最终通过 `./dev.ps1 tauri:build --bundles nsis` 生成 Windows x64 NSIS 安装器，
应用及安装器版本均为 1.7.2；构建前后源码清单哈希一致，交付副本与构建输出一致。
安装包未签名，保留既有 Rust/链接器警告。

| 文件 | 字节数 | SHA-256 |
| --- | ---: | --- |
| `EdgeTerm_1.7.2_x64-setup.exe` | 4116155 | `5cd3c6fc254d6f71aca05e0daa9a352fcf9aed3b6d6c98c5123b4de14a768325` |

## 1.7.1 本地构建记录（未发布）

2026-11-05 按用户要求生成 Windows x64 独立可执行文件，包含 OpenCode 空闲后标签流动条仍运动的修复，详见 [Agent 状态说明](coding-agents.zh-CN.md)。通过 `version:set` 将应用、前后端包清单与锁文件统一为 1.7.1；这是兼容修复，没有配置迁移。

构建来源为 `99b0adb4bb1eaf79663408929e284c3eebab62c5` 加本轮尚未提交的修复与版本变更。2026-11-05 09:49（北京时间）通过受管入口 `./dev.ps1 tauri:build --no-bundle` 完成 release 构建。产物位于本机 `artifacts/EdgeTerm-1.7.1-99b0adb-working/`，没有创建标签或 GitHub Release，也没有替换已发布的 1.7.0 附件。

| 本地文件 | 字节数 | SHA-256 |
| --- | ---: | --- |
| `EdgeTerm_1.7.1_x64.exe` | 10089984 | `67f73314741de7d6ffcd5107f23c7924df2d288e330a0034c0d5015b76eb8cf3` |

文件版本与产品版本均为 1.7.1，PE 架构为 x64，交付副本与构建输出的 SHA-256 一致。相邻 `build-info.json`、`source-manifest.json`、`SHA256SUMS.txt` 与构建日志保存来源和验证证据；源码清单 SHA-256 为 `6c96729a69fc553dadd1f46768d1071617557f76468088dc4fd53a0e79bde3d6`，构建前后各输入文件哈希一致。

修复阶段相关单元测试 132 项、真实 Edge 浏览器回归 20 项通过，浏览器使用模拟 IPC，包含本地与模拟 SSH 标签；1.7.1 构建时版本检查、TypeScript、前端生产构建和 Windows release 编译通过。保留既有构建警告。没有启动此交付 EXE 做桌面验收，没有连接用户 SSH/OpenCode 2.2.5 会话，也未测试安装升级或 macOS/Linux。

这是可直接运行的 EXE。运行前从菜单完全退出旧程序，避免单实例机制激活旧版本；已有便携版应将 EXE 放在原 `data` 目录旁并保留其中内容。

同一轮用户随后指定需要安装程序，并追加“重启后恢复上次标签和目录”，明确要求终端工作目录、文件面板目录都恢复。最终安装包继续使用用户指定的 1.7.1，独立保存至 `artifacts/EdgeTerm-1.7.1-99b0adb-workspace/`；前述初次产物保留，仅包含活动条修复，不能用来验证工作区恢复。源码基线仍为 `99b0adb4bb1eaf79663408929e284c3eebab62c5`，加本轮未提交变更。

新增工作区记录保存标签顺序、重复会话、快捷编号、选中标签、分屏布局和独立的终端 / Filer / FTP 双栏目录。正常退出前补采工作目录；运行期间记录路径变化并每 10 秒查询一次未能直接报告的工作目录。启动等待配置和认证事件就绪后重连，React StrictMode 不会重复打开；关闭标签会同步移除记录。目录已删除时回到对应主目录，连接失败保留标签供重试。保存内容使用字段白名单，不写入密码、私钥口令、终端输出或运行中的命令。

工作区从此版本开始记录，首次从旧版升级无法恢复旧版从未保存的标签。Windows 常规交互式 cmd / PowerShell 通过提示符报告当前目录，不修改用户配置文件；带自定义 `-Command` / `-File` 等参数的启动命令保持原行为。SSH 使用 OSC 目录报告或 Linux `/proc` 查询，并以每通道 token 区分复用连接；服务端拒绝 `LC_EDGETERM_SESSION` 且有多个未报告目录的通道时，不猜测其他标签的路径。非 POSIX SSH、自定义启动脚本、WSL 及无目录报告的环境不保证恢复终端工作目录。重新打开会话不等于续跑退出前的程序或 Agent 任务。

恢复功能验证：全量前端 1094 项通过；补充 FTP 双栏恢复/删除目录回退及目录查询竞争保护后，最终工作区和 FTP 定向 16 项通过。真实 Edge 浏览器中，完整 App 连续启动两次、重复标签、选中状态、分屏、关闭标签、两个目录分别恢复及目录删除回退 2 项通过，另有相关活动条 20 项通过；浏览器边界均为模拟 IPC。Rust 会话 130 项通过（7 项依赖专用环境的测试当时忽略），包含真实 Windows ConPTY cmd / PowerShell 改目录报告；之后单独执行真实 OpenSSH 用例通过，使用本机 WSL 专用测试账号和临时目录，覆盖共享连接中的不同目录、含空格/引号/中文/命令符号的路径、`cd` 后更新以及删除目录回退，测试清理自己的临时目录。没有连接用户 SSH/OpenCode 2.2.5 会话，安装升级和本次最终安装器的原生 WebView2 重启尚未实测。

2026-11-05 10:31（北京时间）通过 `./dev.ps1 tauri:build --bundles nsis` 完成最终安装包。安装器与应用文件版本均为 1.7.1，应用载荷为 x64；构建前后源码清单各项哈希一致，交付副本与 NSIS 输出一致。前端生产构建、类型检查、版本一致性和定向格式/lint 均通过，保留既有 Rust/链接器警告。安装包未签名，未创建公开 Release 或标签，未覆盖历史产物。

| 最终文件（`artifacts/EdgeTerm-1.7.1-99b0adb-workspace/`） | 字节数 | SHA-256 |
| --- | ---: | --- |
| `EdgeTerm_1.7.1_x64-setup.exe` | 4116391 | `150dc67b8afa813682d5bc5d90b3121f4405c858757ef9699819540da5bdb576` |

对应应用载荷 SHA-256 为 `ff73e18c0e70bdbcea7e9841acf48c861d9832bd0d0f5d6b0eae7142cbcc1006`。目录内 `build-info.json`、`source-manifest.json`、`SHA256SUMS.txt`、构建与最终定向测试日志记录本次来源和验证边界。

## 1.7.0 构建与验证记录

前一个本分支公开版本为 1.6.1。本版增加 Agent 提示词草稿、选区与文件路径引用，按兼容功能使用 minor 版本 1.7.0，并纳入此前仅作本地构建的 1.6.2 改进。安装版沿用 `com.edgeterm.desktop`、配置目录和凭据存储，没有数据格式迁移。便携模式密码与口令只保留在当前进程内，升级应保留已有 `data` 目录；本版同步更正便携包内的旧说明。

固定源码及标签解引用提交为 `399702f959dd4d9b5834f6a3597033b8c8c542f9`。在干净的 Windows x64 工作树中通过受限 runner 执行 `tauri:build -- --bundles nsis`，使用 Node 24.19.0、rustc/cargo 1.99.1、MSVC 和 Windows SDK；程序与安装器文件版本均为 1.7.0。便携包的 `EdgeTerm.exe` 与 NSIS 构建输入一致，SHA-256 为 `fe3b5ddc25f958fc77457496d83eec161391348d8fc373509d79c7585a890b91`。便携包只含程序、说明及空 `data/`，诊断包只含两个诊断脚本与说明。程序和安装器未做 Windows 数字签名，校验和只用于核对完整性。

| 1.7.0 附件 | 字节数 | SHA-256 |
| --- | ---: | --- |
| `EdgeTerm_1.7.0_x64-setup.exe` | 4111456 | `fc3db99164b6e85dab17920168d0c9d94ee967c98581c62f4aec5c61ca18bbf8` |
| `EdgeTerm_1.7.0_x64-portable.zip` | 5111722 | `04afb31849c3041279be72eefd66b692c962dd9d7fe35d9e6e67367bd8a8f98a` |
| `EdgeTerm_1.7.0_windows-diagnostics.zip` | 5471 | `6da5046003a51b0971b8a65e48df04c9506c9e76447ba70e8aa78980f49e6d5b` |

`SHA256SUMS.txt` 列出上述三个附件，自身 298 字节、SHA-256 为 `5bb7e35a42a743684eacfc3220294adeb7e1cf94722681cd95a06ce826ee4efb`。上传到 GitHub 草稿后回下载四个附件，逐个计算 SHA-256 与本地比对一致；2026-11-05 08:20:59（北京时间）公开为 latest，非草稿、非预发布。公开后再次核对 latest 记录、四个附件的大小及 GitHub SHA-256，与上述结果一致。`v1.6.2` 仍只保留为原有本地标签，没有补发该版本或改写任何已发布标签。发布记录在固定构建提交之后补充，不移动 `v1.7.0` 标签。

Windows 本地检查：113 个前端单元测试文件 / 1060 项通过（首轮两个 Windows 系统工具用例受到沙箱权限限制，相关 2 文件 / 7 项在沙箱外重跑通过）；30 个真实 Edge 浏览器测试文件 / 151 项通过；Rust 451 项通过、28 项按条件跳过。TypeScript、版本一致性、Biome 格式、lint、Rust 格式、Rust/前端绑定（98/103 命令、5 事件、5 条显式例外）与生产构建通过；`dfc7b98..399702f` 的 8 个提交逐个通过规范与类型检查。更正便携包说明后，打包脚本 5 项测试再次通过。lint 保留生成绑定中两条既有 `any` 警告，Rust 构建保留未使用代码与链接器信息警告。固定源码的 [GitHub checks CI](https://github.com/sonwe1e/EdgeTerm/actions/runs/41880823513) 通过。

浏览器套件使用模拟 IPC。实际 Codex 0.166.0 / Windows WebView2 / ConPTY 的 6 项验收在独立应用标识、隔离 Codex 配置与本地固定回复环境通过，覆盖普通拖选、Shift 高亮保留、引用、Ctrl+Z / Ctrl+Shift+Z 和新建命令入口；没有使用用户会话或真实模型请求。旧实现的普通拖选引用失败，浏览器回归也确认旧版选区、高亮、撤销和模式切换问题。正式构建使用相同功能源码加版本与说明变更，未把开发验收程序当作正式附件。其他 Agent 版本、真实 SSH、安装器升级、macOS/Linux 桌面未据此视为验证通过。任务完成状态仍是终端活动推断，Agent 自动互联尚未实现，详见[功能说明](coding-agents.zh-CN.md)。

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

