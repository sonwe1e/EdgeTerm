# 终端输入修复：pi 滚动、标签切换与 Alt 菜单

## EdgeTerm 内的修复

- Windows/Linux 默认用 `Ctrl+Tab` / `Ctrl+Shift+Tab` 顺序循环切换标签。
  默认绑定下继续接受 `Alt+]` / `Alt+[`；显式改绑、取消绑定及其他命令占用旧键时优先用户配置。
  macOS 默认键保持原样。
- 菜单栏在捕获阶段观察 Alt 组合键，避免 xterm 截断 `Alt+Delete` 的冒泡后，
  Alt 松开被误判为单独 Alt。重复 Alt keydown 不再清掉组合键标记。
  单独 Alt 仍打开菜单，F10 保持原来的冒泡处理顺序。
- 补齐 xterm `onBinary` 到 `write_session_bytes` 的接线。
  传统鼠标报告中的高位坐标字节原样发送，避免遗漏或被 UTF-8 重编码。
  会话锁定和文件传输占用输入流时不发送这些报告。

对应行为回归是 [terminalInput.browser.test.ts](../src/test/terminalInput.browser.test.ts)；
它挂载真实 App、xterm 和样式，仅替换 native host。修改前四项中三项失败，
修复后四项通过；SGR 鼠标与普通 Shell 历史滚动项在修改前后均通过。
标签默认值、旧键兼容和显式配置优先级另由
[shortcutsWindows.test.ts](../src/shortcutsWindows.test.ts) 覆盖。

## pi 1.4.0 自身的 Windows 启动顺序

真实 Windows 验收发现，仅修复 EdgeTerm 的二进制输入通道仍无法让这个版本的 pi 滚动。
安装的 `@earendil-works/pi-tui@1.4.0` 调用顺序是：

1. `TuiBase.start()` 调用 `beforeTerminalStart()`。
2. `TuiAltScreen.beforeTerminalStart()` 写入备用屏幕与鼠标模式请求。
3. `ProcessTerminal.start()` 设置 raw mode，然后调用 Windows 原生辅助模块启用
   `ENABLE_VIRTUAL_TERMINAL_INPUT`。

在本机默认 cmd/ConPTY 会话中，第 2 步发生时 VT 输入尚未启用。
原始日志显示 pi 发出了 `1000/1002/1003/1006` 请求，但到达 xterm 的 PTY 字节没有这些请求。
原生辅助模块之后确实返回启用成功，前端却没有鼠标模式，滚轮不会生成 pi 所需的报告。
在现有 `afterTerminalStart()` 钩子中重新请求鼠标模式后，对话可上下滚动。
这与 EdgeTerm 遗漏 `onBinary` 是两个独立问题；仅更新 EdgeTerm 无法改变 pi 的这个启动顺序。

本机 pi 已应用 [patch-pi-windows-mouse.mjs](../scripts/patch-pi-windows-mouse.mjs) 的兼容补丁。
它只接受上述两个包的 1.4.0 版本和已核对的源码形状，只在 Windows 且鼠标功能开启时重发请求，
保留原来的复用器判断。原文件备份位于修改文件旁，后缀为 `.edgeterm-windows-mouse.bak`。

对另一份同版本安装，显式指定包目录后运行：

```powershell
$env:EDGETERM_PI_ROOT = '<npm 全局目录>/@earendil-works/pi-coding-agent'
./dev.ps1 script scripts/patch-pi-windows-mouse.mjs
```

重复执行不会叠加补丁。还原使用：

```powershell
./dev.ps1 script scripts/patch-pi-windows-mouse.mjs --restore
```

应用后重启 pi 会话。重新安装或更新 pi 可能覆盖本机补丁；脚本不对其他版本自动打补丁。
此修复未嵌入 EdgeTerm 启动流程，也未改动项目的 Rust PTY 依赖。

## 验证边界

[check-native-terminal-input.mjs](../scripts/check-native-terminal-input.mjs) 在明确选定的隔离便携实例中，
启动真实 pi 并离线恢复 80 组、160 条生成消息。它检查两次向上滚动及反向滚回、
`Alt+Delete` 实际删除单词且不打开菜单，以及两个真实本地会话之间的正反向标签切换。
结果包含截图、pi 与 PTY 两端的 ANSI 输出、鼠标报告和环境信息。
脚本使用独立 pi 配置，不发模型请求，也不读取用户的 pi 会话。

本机最终验收通过：Windows 11 构建 26300、WebView2 Edge 156、DPR 1.5、
调试构建和 DOM 渲染器。实际可见消息从第 80 组滚到更早记录再返回第 80 组，
编辑器将 `alpha beta gamma` 删为 `beta gamma`，两个标签正反向切换成功。
原始结果与截图保存在本机忽略目录 `.tmp/terminal-input/native-verified/`；
此前未修补 pi 时的失败和双向字节日志保存在同级 `native-07/`。
本机补丁也通过了应用、重复应用和还原后重新应用检查。
相关 7 个单元测试文件共 50 项通过；类型检查、前端及 Windows 原生构建、
修改文件的格式与 lint 检查、`git diff --check` 均通过。

浏览器结果只证明前端契约。原生验收覆盖本机 Windows、WebView2、DOM 渲染器和 pi 1.4.0；
CDP 输入不等于物理键鼠测试，也不证明其他平台、远程服务器或 pi 版本的行为。
