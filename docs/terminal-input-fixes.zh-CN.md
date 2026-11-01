# 终端输入修复：Pi 滚动、标签切换与 Alt 菜单

## EdgeTerm 内的输入修复

检查点 `efd2faf` 保留了此前工作区的修复：

- Windows/Linux 默认用 `Ctrl+Tab` / `Ctrl+Shift+Tab` 顺序循环切换标签。
  默认绑定下继续接受 `Alt+]` / `Alt+[`；显式改绑、取消绑定及其他命令占用旧键时优先用户配置。
  macOS 默认键保持原样。
- 菜单栏在捕获阶段观察 Alt 组合键，避免 xterm 截断 `Alt+Delete` 的冒泡后，
  Alt 松开被误判为单独 Alt。重复 Alt keydown 不再清掉组合键标记。
  单独 Alt 仍打开菜单，F10 保持原来的冒泡处理顺序。
- 补齐 xterm `onBinary` 到 `write_session_bytes` 的接线。
  传统鼠标报告中的高位坐标字节原样发送，避免遗漏或被 UTF-8 重编码。
  会话锁定和文件传输占用输入流时不发送这些报告。

[terminalInput.browser.test.ts](../src/test/terminalInput.browser.test.ts) 挂载真实 App、xterm 和样式，
仅替换 native host。本轮重新执行检查点的四项回归全部通过，包含 SGR 鼠标和普通 Shell 历史滚动。
标签默认值、旧键兼容和显式配置优先级另由
[shortcutsWindows.test.ts](../src/shortcutsWindows.test.ts) 覆盖。

本轮另外确认：`TerminalKeyboard` 在查找用户快捷键之前转换了 Alt+方向键和 control-H Backspace。
改绑 Alt+方向键时，旧实现可以同时切换标签并向原 Shell 发送方向序列；
control-H 档案下将 Alt+Backspace 改为粘贴时，旧实现仍发送退格序列。
修复把显式快捷键放在这两类兼容转换之前，未改绑的 Shell 按键沿用原行为。
两项单元回归和真实 App 的额外 Shell 写入断言先在旧实现失败，候选通过。

## Pi 1.4.0 的 Windows 启动顺序与实际命令入口

源码和原生输出共同显示，Pi 1.4.0 的 fullscreen 启动顺序为：

1. `TuiBase.start()` 调用 `beforeTerminalStart()`。
2. `TuiAltScreen.beforeTerminalStart()` 写入备用屏幕与鼠标模式请求。
3. `ProcessTerminal.start()` 设置 raw mode，然后调用 Windows 原生辅助模块启用
   `ENABLE_VIRTUAL_TERMINAL_INPUT`。

在本机默认 cmd/ConPTY 会话中，第 2 步发生时 VT 输入尚未启用，鼠标模式请求没有到达 xterm。
因此仅补齐 EdgeTerm 的二进制输入通道不能让这个 Pi 版本滚动。
在已有 `afterTerminalStart()` 钩子重发鼠标模式后，对话可以上下滚动。

此前的记录还遗漏了一个入口差异：npm 包声明 `bin.pi = dist/bundle/cli.js`，
该入口加载 bundle 内独立的 `TuiAltScreen`；旧补丁只修改依赖包的 `dist/tui-alt-screen.js`，
旧原生验收则启动未打包的 `dist/cli.js`。旧记录位于 `.tmp/terminal-input/native-verified/`，
只能证明那个未打包入口，不能证明日常运行的 `pi` 命令已经修好。

本轮修正 [patch-pi-windows-mouse.mjs](../scripts/patch-pi-windows-mouse.mjs)，
同时处理 SDK 模块与实际命令加载的 bundle。脚本只接受两个包的 1.4.0 版本，
检查 `bin.pi`、CLI loader、bundle import、生命周期及两处源码形状，全部核对后才写入。
它只在 Windows 且鼠标开启时重发模式，保留复用器使用 button-motion 的原选择。
每个原文件的备份位于其旁边，后缀为 `.edgeterm-windows-mouse.bak`。
已存在的 SDK-only 补丁可直接补齐 bundle；重复运行不会叠加补丁。

对另一份同版本安装，显式指定包目录后运行：

```powershell
$env:EDGETERM_PI_ROOT = '<npm 全局目录>/@earendil-works/pi-coding-agent'
./dev.ps1 script scripts/patch-pi-windows-mouse.mjs
```

还原使用：

```powershell
./dev.ps1 script scripts/patch-pi-windows-mouse.mjs --restore
```

本机 npm 安装的 SDK 与 bundle 均已修补，重复运行检查通过；新启动的 Pi 会加载修复。
正在运行的 Pi 需要退出后重启。重新安装或更新 Pi 可能覆盖补丁，其他版本需重新审查。
此修复没有嵌入 EdgeTerm 启动流程，也没有改动 Rust PTY 依赖。

## 本轮原生验证与证据边界

[check-native-terminal-input.mjs](../scripts/check-native-terminal-input.mjs) 现在读取 npm 的 `bin.pi`
并启动实际命令入口，结果也记录该入口与 bundle 补丁状态。
它在明确选定的隔离便携实例中离线恢复 80 组、160 条生成消息；
使用独立 Pi 配置，不发模型请求、不读取用户 Pi 会话。

本轮 Windows x64 调试构建、Windows 11 构建 26300、WebView2 156、DPR 1.75、DOM 渲染器：

| 场景 | 旧 bundle | 修补 bundle |
| --- | --- | --- |
| npm 命令实际入口 | `dist/bundle/cli.js` | 相同入口 |
| 鼠标模式到达 xterm | 没有 `enable-mouse-events`，验收失败 | 模式开启 |
| 对话向上滚动两次 | 未通过鼠标模式前提，不计为滚动通过 | 可见末组从 80 到 78，再到 76 |
| 对话向下滚回 | 未通过 | 返回第 80 组 |
| 编辑器 Alt+Delete | 本次基线在前置失败处停止 | `alpha beta gamma` 删为 `beta gamma`，不打开菜单 |
| 两个真实本地会话双向切换 | 本次基线在前置失败处停止 | 通过 |

修复前后为同一 EdgeTerm 测试程序、相同生成历史和实际 Pi 命令，差异是 bundle 补丁。
原始 JSON、截图、Pi 与 PTY ANSI 输出及鼠标报告位于 `.tmp/bug-sweep/native-before/` 和 `native-after/`。

[patch-pi-windows-mouse.test.mjs](../scripts/patch-pi-windows-mouse.test.mjs) 另验证两种入口、
复用器模式、重复应用、逐字节还原、补齐旧补丁，以及源码被外部改动时拒绝写入。
新增实际命令用例在 `efd2faf` 的旧脚本上失败；一次性 worktree 中移除 bundle 修补后再次失败。

## 退出 Pi 后整段历史刷回 Shell

2026-11-01 后续复现确认：Pi 1.4.0 的 `fullscreenExitOutput` 默认是 `transcript`。
正常退出时，`stopInteractiveTui()` 先切到 regular 模式，再重绘整个对话到 Shell。
这是 Pi 在退出时主动输出，不能靠清空 EdgeTerm 历史或丢弃普通终端输出来修复。
此前原生脚本直接关闭整个测试终端，没有经过 Pi 的正常退出路径，遗漏了这一行为。

本机 `C:\Users\Sonwe\.pi\agent\settings.json` 已添加 Pi 原有设置：

```json
"fullscreenExitOutput": "resume-hint"
```

本机原配置旁保留 `.edgeterm-exit-20261101.bak` 备份，核对其他设置未变化。
Pi 自身的 `SettingsManager.create()` 读取该配置，确认有效值为 `resume-hint`。
当前已启动的 Pi 需要执行 `/reload` 后再退出；以后新启动自动加载该设置。
项目自己的 `.pi/settings.json` 若显式设置了此字段，则按 Pi 原有规则覆盖全局设置。
此修复使用已有配置，没有增加 bundle 补丁，也没有改变 EdgeTerm 的输出处理。

原生验收现在增加正常退出、会话文件及 Shell 恢复检查：

| 同一 160 条生成消息 | Pi 原默认值 | `resume-hint` |
| --- | --- | --- |
| 退出备用屏幕后 TUI 写入量 | 151,877 字节 | 14 字节终端恢复序列 |
| TUI 写入中历史标记次数 | 640 | 0 |
| 正常退出路径 | Ctrl+D 复现回放并使检查失败 | Ctrl+D、`/quit`、两次 Ctrl+C 均通过 |
| 会话消息 | 160 条仍保存 | 160 条内容与原记录逐项相同 |
| 返回 Shell、关闭鼠标报告、显示恢复命令 | 已检查 Shell 和鼠标恢复 | 三种退出均通过 |

恢复提示由 `process.stdout.write()` 直接打印，不在 `PI_TUI_WRITE_LOG` 中，
因此脚本用 TUI 日志判断历史来源，同时用 PTY 字节判断最终画面、恢复提示和鼠标恢复。
上表 14 字节只计 TUI 的最后恢复序列，不把它写成包含恢复提示的完整退出输出量。

本轮使用隔离便携 Windows 调试实例、实际 npm `bin.pi`、WebView2 156、DPR 1.75 和 DOM 渲染器，
没有读取用户会话或调用模型。证据保存在 `.tmp/pi-exit/native-default/`、`verified-ctrl-d/`、
`verified-quit/` 和 `verified-ctrl-c-recheck/`。一次 Ctrl+C 场景曾在退出前采样到未稳定的初始画面，
已改为等待并记录同一次满足条件的历史快照，再执行完整场景。没有跳过退出断言。

浏览器回归证明前端契约；原生验收覆盖本机 Windows、WebView2、DOM 渲染器和 Pi 1.4.0。
CDP 输入不等于物理键鼠测试，也不能证明其他平台、真实远程服务器或其他 Pi 版本。
