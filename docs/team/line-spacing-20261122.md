# 终端行间距（2026-11-22 第 10 轮）

行间距是严肃 SSH 客户端的基线能力（Xshell 的 Line spacing、SecureCRT 的行距、Windows Terminal 的 lineHeight），而本仓库把它写死在 `lineHeight: 1.25`。本轮把它变成设置：

| 选项 | 效果 |
| --- | --- |
| 100% / 115% / **125%（默认，与既有渲染一致）** / 140% / 155% | Display Settings ▸ Line spacing |

选择在两个会话之间保持（`edgeterm.lineHeight`），下次启动继续生效。

## 一、实现

- [lineHeight.ts](../../src/lineHeight.ts)：离散档位、范围 1–1.6、保留两位小数（拖拽/导入都不能存出 1.250000001）、读写 storage、百分比标签。
- store：`lineHeight` + `setLineHeight`（写入即持久化；storePreferences 统一导出，store 只从一个来源导入）。
- [TerminalPane.tsx](../../src/components/TerminalPane.tsx)：与其他显示设置同形——`useEffect` 调 `controller.setLineHeight`。
- [terminal.ts](../../src/terminal.ts)：`setLineHeight` 走与字号相同的"隐藏时暂存、显示时落地"路径，随后 `refreshFontMetrics()`——重新测量、重新 fit、行号栏的 `--gutter-cell` 跟着更新。若只改 xterm 选项而不刷新测量，行号会从各自的终端行上滑开。
- Display Settings 对话框：与光标样式同一行的表单控件；`DisplaySettings` 接口新增字段，Apply 时生效。

## 二、接入的完整性（验证时发现的两处遗漏）

一个新偏好需要同时进入**四条路径**，漏一条就会在别处表现出来：

| 路径 | 初始遗漏 | 现象 |
| --- | --- | --- |
| 重置设置 | 未清 `edgeterm.lineHeight` | `storePreferences.reset` 用例失败：「restores every preference this module defines」 |
| 数据导出/导入 | 未带该字段 | 导出再导入会丢掉行距 |
| 测试里的控制器替身 | 缺 `setLineHeight` | `WorkspaceTabFocus` 的 12 条用例全部报 `terminal?.setLineHeight is not a function` |

三处都已补上（重置同时清 storage、导出/导入带字段、(`AppSettings` 接口加字段）。

## 三、验证

- 单元 5 条：档位有序且含默认值、clamp/四舍五入、storage 往返、坏数据回退默认、百分比标签。
- 真实浏览器 1 条：改为 100% 时 `term.rows` 增大、渲染单元格高度不变小；改为 155% 时行数减少、单元格高度增大；行号栏单元格高度与渲染出的终端行高一致（±1px）；`localStorage` 记住 1.55。
- 全量：前端单测 175 文件／1724 用例、浏览器契约 47 文件／237 用例、typecheck、format:check（522 文件）、lint（仅生成绑定 2 条既有警告）、生产构建全部通过。

## 四、边界

- 只影响终端网格；面板字号/行高不变（面板本来就有独立字号）。
- 隐藏面板里的改动沿用字号那套"暂存到显示时落地"的路径。
- AI TUI、备用屏幕同样按新行距重排（这是显示设置，不是内容改变）。
- 未做逐终端（每标签）行距；目前是全应用偏好，和字号一致。