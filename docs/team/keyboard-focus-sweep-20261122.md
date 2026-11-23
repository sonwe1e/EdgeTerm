# 键盘焦点扫查（2026-11-22 第 3 轮）

目标：键盘用户能否**看见**焦点，是"交互细节"里最容易被忽略、也最能量化的一项。本轮把它变成可复跑判据，并用它验收 shell 与两个真实对话框。

## 一、新增能力

**[src/uiAudit.ts](../../src/uiAudit.ts) 的 `focusRingIssues`**：逐个聚焦真实焦点停靠点，比较元素与其两级祖先在 10 个可见属性（outline、box-shadow、背景、边框、文字色等）上的计算样式差。方法上有三条硬约束，缺一条结论就不可信：

1. **先发一次真实 Tab**：Chromium 只在这之后让脚本聚焦继承 `:focus-visible`；没有键盘模态时，脚本聚焦的按钮不算"可见"。
2. **冻结过渡**：字段焦点环用 80–120ms 淡入，同步快照会读到插值中间值（实测同一颜色序列化成 `oklab(...)`）。扫查期间注入 `transition: none`，验完即撤。
3. **只评真正拿到焦点的元素**：`aria-activedescendant` 列表里的行是 `tabIndex=-1`，不是 Tab 停靠点；关闭的 `<details>` 里的控件也不可聚焦。收集器在 `focus()` 后检查 `document.activeElement`，不成立就跳过。

**[src/test/focusSweep.browser.test.ts](../../src/test/focusSweep.browser.test.ts)**：5 条真实 Chromium 契约

| 用例 | 断言 |
| --- | --- |
| shell | 20 个焦点停靠点（含展开后的 SSH 复用复选框）全部有可见变化 |
| 新建会话对话框 | 经命令面板打开，≥8 个停靠点全部有可见变化 |
| 显示设置对话框 | 经命令面板打开，≥5 个停靠点全部有可见变化 |
| 负向控制（菜单） | 中和 `.menu-item:focus-visible` 后，扫查必须报出该控件 |
| 负向控制（复选框） | 中和复选框焦点环后，扫查必须报出它 |

## 二、实测发现与处置

| 现象 | 判定 | 处理 |
| --- | --- | --- |
| 会话面板的 `.row` 没有焦点样式 | **误报**：行是 activedescendant 目标，容器才是 Tab stop | 先加的 `.row:focus-visible` 在确认 `tabIndex=-1` 后删除，不留死规则 |
| 原生复选框没有可见焦点 | **真实缺口**：Chromium 保留原生字形，字段软环画不上去 | [foundation.styles.css](../../src/styles/foundation.styles.css) 给 checkbox/radio 加 accent outline；测试直接断言 `outlineStyle=solid`、`outlineColor=rgb(0,120,212)`，并做中和负向控制 |
| 第一个菜单项被报"无变化" | 收集器把已聚焦元素当作未聚焦快照 | 先 `blur()` 再取快照 |
| 新建会话字段被报"无变化" | 过渡中间值 | 冻结过渡后消失 |

## 三、验证

- `src/test/focusSweep.browser.test.ts`：5/5（含两条负向控制）。
- 全量：前端单测 170 文件／1699 用例、浏览器契约 43 文件／220 用例、typecheck、format:check（509 文件）、lint（仅生成绑定 2 条既有警告）、生产构建全部通过。

## 四、边界

- 只覆盖 Chromium + 受控 IPC；WebView2、真实 IME、自定义列表的 roving tabindex 语义未验。
- "可见"以计算样式变化为准，不判断环本身的对比度；非文本 3:1 由后续的对比度门禁扩展。
- 其余对话框（快捷键、全部设置、关于、更新、git 工作区、传输/转发中心）尚未接入扫查，是下一轮的直接候选。
