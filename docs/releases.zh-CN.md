# 本分支历史发布索引

历史索引核对日期：2026-10-23；1.3.0 发布补记：2026-10-26。发行仓库是 [sonwe1e/EdgeTerm](https://github.com/sonwe1e/EdgeTerm)，上游是 [miskin-lee/EdgeTerm](https://github.com/miskin-lee/EdgeTerm)。两者独立发布，不能根据版本数字大小推断功能包含关系。

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

截至核对日，本分支没有公开的 macOS/Linux 安装包，也没有签名自动更新清单。上游提供这些平台的发布包，不代表本分支已完成这些平台的构建或验证。`v1.0.0` 是保留的共同基线标签，不是本分支独立发布的 Release；本地其他 `v0.*`、`v1.0.*` 标签也不能当作本分支发布记录。

## 1.3.0 构建与验证记录

前一个本分支公开版本为 1.2.8。新增文件栏各列独立调宽属于兼容功能，使用 minor 版本 1.3.0；既有安装版沿用 `com.edgeterm.desktop` 标识、配置路径和凭据存储，没有数据格式迁移。优先使用安装包退出后覆盖安装；便携包使用独立 `data` 目录，不能用便携包的空目录覆盖已有便携数据。

固定源码为 `dd012ba965c857c0a1dc2bcb25584887640f4c22`。在 Windows x64 上通过受限 runner 执行 `tauri:build --bundles nsis`，使用 Node 24.19.0、Rust 1.99.0、MSVC 和 Windows SDK 10.0.26100。安装器及程序的文件版本均为 1.3.0；安装器为 current-user 模式，便携包中的程序与 NSIS 构建输入具有相同 SHA-256：`293d9bd0cd40bf450ee46a606581d3e00e044571fe84b420ef9eac5a796b74e4`。便携包仅附程序、许可证、说明和空白配置目录说明；诊断包不含本机采样报告。

| 1.3.0 附件 | 字节数 | SHA-256 |
| --- | ---: | --- |
| `EdgeTerm_1.3.0_x64-setup.exe` | 4163203 | `dc728c15656414ae4ef10060766dfa21500373942621b4f92f995fece3b20974` |
| `EdgeTerm_1.3.0_x64-portable.zip` | 5231405 | `57c477c0427ab57e4d51bdbc17ee2456284da6123307226706959b7212288519` |
| `EdgeTerm_1.3.0_windows-diagnostics.zip` | 18505 | `2ed9779665d544da50bb2663c20760baadc5cbb8607b471d9fd4a5d34c8fe14f` |

同页 `SHA256SUMS.txt` 列出上述三个附件。Windows 本地检查：104 个前端单元测试文件 / 889 项、23 个 Edge 浏览器文件 / 123 项、439 项 Rust 测试通过，27 项专用环境或基准测试保持跳过；类型、格式、lint、生产构建通过。`66297b8..dd012ba` 的 6 个提交逐提交类型和 R8–R10 规范检查通过。生成绑定的两条 `any`、Rust 未使用代码及生产前端大 chunk 提示仍保留。

该源码的 [GitHub CI](https://github.com/sonwe1e/EdgeTerm/actions/runs/40276575716) 前端和 Rust 两项任务均成功。2026-10-26 13:59（北京时间）正式公开为 latest，非草稿、非预发布；发布前逐一核对四个附件（含校验和清单）的 GitHub 摘要与大小，并回下载计算 SHA-256，均与本地一致。发布后确认标签解引用到上述源码，未修改既有发布。

故障机用户在安装基于 `8c663d0` 的修复构建后反馈“好像没什么问题了”。这不是 1.3.0 安装器对既有用户数据的完整升级验收，也不能证明所有 Win11 / WebView2 / 显卡组合的硬卡死根因；仍未取得故障机阻塞堆栈和长期重复测量。浏览器 DPR 回归不模拟系统 DPI 消息，专用服务器测试及 macOS/Linux 桌面包不在本次验证范围。

## 历史例外：1.2.0 同版本替包

当前发布说明明确记录：2026-10-18 重新构建并替换 Windows 安装包和便携包，源码为 `9b904b4`；首次发布时间仍为 2026-10-17。当前标签与发布说明一致。本次没有移动标签、改写发布说明或替换附件。

这意味着只报告“1.2.0”不能唯一确定当时下载的程序。排查旧问题时需同时提供包的 SHA-256 或下载时间。旧包的原始摘要未在本次核对中恢复，不能把当前摘要用于证明旧包内容。

GitHub 附件元数据在核对日提供的当前摘要如下（仅核对元数据，未重新下载计算）：

| 当前 1.2.0 附件 | SHA-256 |
| --- | --- |
| `EdgeTerm_1.2.0_x64-setup.exe` | `3df4af62baba6705bac7e44d2a3e1d1268b87b8860a1f648b171e5cadc800a2b` |
| `EdgeTerm_1.2.0_x64-portable.zip` | `41aefcea8c2ca166e37086e8d55ff2e90a49c0c2c7a2a7ea858f067eb88fe7cb` |

## 出现在源码中但未公开发布的版本

| 版本 | 源码节点 | 核对日状态 |
| --- | --- | --- |
| 1.2.5 | `a4ffcbc`，独立版本提交 | 无本仓库远端标签或公开 Release；相关改动随后进入 1.2.8 |
| 1.2.6 | `bb80da1`，保存已有工作区的基线快照 | 无独立版本提交、远端标签或公开 Release；快照说明见[历史记录](history-and-branches.zh-CN.md) |
| 1.2.7 | `4a4d225`，独立版本提交 | 无本仓库远端标签或公开 Release；相关改动随后进入 1.2.8 |

这些结论不排除曾有本地构建，但不能把本地构建称为公开发布。保留跳号，不补造旧发布或回填标签。

## 当前下载入口与后续发布规则

- 从 1.3.0 开始，应用内入口为“下载与更新…”，显示当前版本、说明本分支手动升级，并在用户操作后打开本分支 Releases。没有后台版本查询，不声称已经比较出“最新版本”，也不自动安装或重启。
- 已发布的 1.2.8 及更早二进制仍包含旧上游更新入口；源码修改不能修复旧安装包。用户应直接访问本分支发布页下载安装版升级。
- Tauri 的上游更新公钥、endpoint、运行时插件注册和前端权限已移除，`createUpdaterArtifacts` 关闭。继承的 `.github/workflows/release.yml` 签名发布任务显式停用，保留作参考；不要直接开启。恢复自动更新需要本分支自己的签名身份、feed、客户端实现以及真实升级/便携版验收。现有锁定的 updater 依赖暂留，不表示功能已启用。
- 正式版本继续使用独立的 `1.x` 序列。兼容修复用 patch，新增兼容能力用 minor；破坏性变化需说明迁移方式。不为历史整理回退版本或升 major。
- 正式发布前统一使用 `version:set` 更新版本文件。开发构建在交付说明中标记基线版本和 Git SHA，不把每个任务当作一次正式版本发布。
- 已公开标签、对应源码与附件保持不变。代码或交付包需要修订时发新版本；发现历史错误通过新增说明纠正，不覆盖旧二进制。
- 每次发布补本表，写明固定源码 SHA、平台、安装方式、校验和、验证范围、已知限制及前一**本分支公开版本**。Release 正文按用户可见变化归类，不直接把所有 `git log` 标题当新功能，尤其不能把保留旧历史的合并算作新增能力。

维护边界与分支处理见[分支与历史维护](history-and-branches.zh-CN.md)。
