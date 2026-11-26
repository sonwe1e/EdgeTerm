# EdgeTerm 1.8.1

本版解决了 1.8.0 发布审计发现的全部 7 项开发依赖告警（3 高、4 中）。Vitest 及其浏览器测试组件升至 4.1.12，Vite 升至 7.3.8，Undici 升至 8.13.1，source-map-js 升至 1.2.4。

Windows 已按锁文件重新安装依赖并构建发行包。GitHub 对发布提交执行的完整 npm 审计为 0 项，前端、浏览器和 Rust 作业均通过。[GitHub Actions 验证记录](https://github.com/sonwe1e/EdgeTerm/actions/runs/45796644271)

已在隔离的 Windows 桌面运行便携版，验证深目录导航、两个真实 cmd 会话的广播开关、Sender 多目标执行，以及本地二进制文件读写。安装包已解包核对主程序。

## Windows x64 下载

- 常规安装使用 `EdgeTerm_1.8.1_x64-setup.exe`。
- 便携版使用 `EdgeTerm_1.8.1_x64-portable.zip`。升级时保留现有的 `data` 目录。
- 诊断工具单独提供。可用 `Get-FileHash <文件名> -Algorithm SHA256` 与同页 `SHA256SUMS.txt` 比对。

程序和安装包均未签名。本次在独立目录验收，未对现有安装执行覆盖升级。
