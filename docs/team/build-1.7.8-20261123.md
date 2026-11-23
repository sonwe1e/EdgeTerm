# 1.7.8 安装包构建记录（2026-11-23）

按用户要求，用第 29 轮的代码直接产出可安装的 Windows x64 安装包。

## 一、来源

- 工作树：本次会话第 1–29 轮的改动，**未提交**（123+ 路径）；
- 版本：1.7.7 已发布（2026-11-18，tag v1.7.7），因此把版本提到 **1.7.8**；`npm run version:set -- 1.7.8` 同步 package.json、package-lock.json、Cargo.toml、Cargo.lock，`version:check` 通过；
- 构建：`npm run tauri:build`（管理运行器，release profile，4m25s）。

## 二、产物

| 文件 | 大小 | SHA-256 |
| --- | --- | --- |
| `src-tauri/target/release/bundle/nsis/EdgeTerm_1.7.8_x64-setup.exe` | 4.05 MiB | FF38FCF53F2E02D91EF2C6AFB4B45105246DBFCE85416F4685D348D6137F2E66 |
| `src-tauri/target/release/bundle/msi/EdgeTerm_1.7.8_x64_en-US.msi` | 5.26 MiB | 40E73FE2A1637323A77C352FF596EAE312B1172A79806ACB79D54615942D4244 |

可执行文件元数据：FileVersion / ProductVersion 均为 1.7.8，ProductName = EdgeTerm。

## 三、边界

- **未做代码签名**（`Get-AuthenticodeSignature` 为 NotSigned）：Windows 首次运行会出 SmartScreen 提示，属预期；
- 这是本地构建，**未发布** GitHub Release、未生成更新源或校验清单文件；
- 冒烟：直接启动构建产物 `src-tauri/target/release/edgeterm.exe`（安装包内同一二进制），6 秒后仍存活、有响应、窗口标题为 EdgeTerm、工作集约 46.9 MiB，随后按 PID 结束且无残留进程。**未执行安装程序的安装步骤**，安装动作本身未经验证。
- 验证覆盖：release 构建自身跑过前端类型检查与打包；随后在构建后的工作树上跑全量——单测 182 文件／1753 用例、浏览器契约 60 文件／259 用例、format:check、lint（仅生成绑定 2 条既有警告）；**没有在真实安装后启动应用做冒烟**（本会话无法安装并运行桌面程序），安装包的可启动性未经验证。