# 常用命令有了自己的快捷键（2026-11-23 第 69 轮）

常用命令此前只能从命令行面板、终端右键菜单或菜单栏进——对每天要用十几次的面板来说，记一个键盘组合才是常态。

## 一、交付

| 位置 | 变化 |
| --- | --- |
| 快捷键表 | 新增 `snippets` 命令：Windows / Linux 为 **Ctrl+Shift+S**，macOS 为 **⌘⇧S**；可在「键盘快捷键」里改绑 |
| `App.tsx` | 分发到 `requestSnippetsOpen()`，与菜单打开的是同一个对话框 |
| 命令行面板 | 不重复列出这条：面板里已有「Saved Commands」动作行 |

## 二、为什么是 Ctrl+Shift+S

终端里 `Ctrl+Shift+字母` 是安全家族：**Shift 不参与控制字节**，shell 收到的与 `Ctrl+字母` 相同，所以占用它不损失任何按键；这也是 VS Code、WindTerm、MobaXterm 共同的约定。`S` 与「保存」的语义一致，且与已占用的 `P/B/O/L/W/T/Z/F/G/J/C/V/A` 都不冲突。

## 三、验证

| 用例 | 断言 |
| --- | --- |
| `shortcuts.test.ts` + `commandPalette.test.ts`（50） | 默认表含新命令且无冲突；标签/提示齐全 |
| `snippets.browser.test.ts`（22，新增 1） | 在真实页面按 Ctrl+Shift+S → 常用命令弹层打开 |

## 四、边界

- 只加了一个默认组合；读者改绑、清除都在既有快捷键设置里，无需新界面。
- 面板不重复列出，避免同一动作两行。
