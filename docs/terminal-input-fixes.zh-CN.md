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

## 2026-11-05：SSH Pi 滚轮误切换输入历史

用户报告 SSH 远端 Pi 的鼠标停在对话历史上滚动，却影响输入框；无法确定从启动时
还是运行中开始。远端 Pi 版本未提供。本轮没有更改用户远端环境或本机 Pi 安装。

在 Pi 全屏备用屏幕没有开启鼠标上报时，xterm 6 会把滚轮转换成上下方向键。
Pi 将这些键用于编辑器光标和输入历史，因此对话不滚动，草稿可能被历史提示词替换。
另一个条件是 SSH 回显延迟：Enter 到达时命令尚未显示，既有识别可能错过 `pi`。
本轮修复在命令回显完整后，从普通屏幕中的原提交位置补识别，即使 Pi 已覆盖全屏；
读取有行数和长度上限，普通命令输出不会被当作新的启动命令。

已识别的 Pi 全屏会话缺少鼠标上报时，EdgeTerm 把 xterm 同步生成的滚轮方向键转成
PageUp/PageDown，让 Pi 翻动历史或当前浮层。保留 xterm 的滚轮增量和触控板过滤，
实际键盘方向键、普通屏幕滚动、其他程序、正常 SGR / legacy 鼠标报告均保持原行为。
这是一项 EdgeTerm 兼容处理，不依赖此前 Windows Pi 1.4.0 的第三方补丁。

新增回归先在旧实现上失败（1 项延迟识别、3 项浏览器滚动），修复后通过；另覆盖
换行命令、非 Pi 输出、会话锁定、普通屏幕和退出后恢复。最终相关单元测试 106 项、
真实 Edge 浏览器测试 35 项（模拟 IPC）以及定向格式/lint 均通过。真实原生对照使用官方
Pi 1.5.0 Linux x64、本机 WSL OpenSSH 专用账号、200 ms SSH 下行延迟、Windows
release/WebView2 和离线生成的 160 条消息，没有读取用户会话或请求模型。
两版均先确认正常 SGR 滚动，然后由专用 helper 向自己的 PTY 注入关闭鼠标模式的序列：

| 相同的 4 次向上滚轮 | 旧版 | 修复版 |
| --- | --- | --- |
| 送入 Pi 的输入 | 4 个方向上键 | 4 个 PageUp |
| 可见历史组 | 78–80，停在末尾 | 70–72，已向前翻页 |
| 输入草稿 | 被历史提示词替换 | 保持原样 |
| 向下滚动、恢复鼠标上报、正常退出 | 恢复 SGR 和退出通过 | 双向翻页、恢复 SGR 和退出通过 |

脚本为 [check-native-pi-ssh.mjs](../scripts/check-native-pi-ssh.mjs)，证据位于
`.tmp/pi-ssh-repro/baseline-run-20261105-151829/evidence/` 和
`.tmp/pi-ssh-repro/candidate-run-20261105-151904/evidence/`。
首次基线已复现滚轮问题，但退出步骤误用 Ctrl+U：历史导航后光标在行首，未清空输入。
脚本改为清空整行后执行 `/quit`，两版完整检查均通过，没有跳过退出断言。
此对照证明鼠标模式缺失时的修复效果；用户远端丢失鼠标模式的具体触发原因、
其他 Pi 版本、tmux/screen、多平台桌面与物理键鼠尚未据此视为验证通过。
