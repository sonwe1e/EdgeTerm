# EdgeTerm 界面、字体与菜单交互评审（2026-10-19）

## 结论

视觉工艺这一层是合格的：四套主题共享一套完整 token，行高/圆角/阴影有统一语言，破坏性确认框默认聚焦 Cancel，`ModalDialog` 有真实的 Tab 环绕与焦点归还。**问题不在"好不好看"，在两条系统性缺口：**

1. **交互契约是鼠标独占的。** 菜单栏、标签条、会话树、文件列表、分隔条、面板拖拽，全部只有 `mousedown`/`pointerdown`/`dblclick`。键盘用户在终端里按 Tab 出不来，出来以后也点不动菜单。这不是少几个快捷键，是整条键盘路径不存在。
2. **字体与对比度没有下限，也没有比例。** 面板字号可以调到 9px，派生值 `calc(var(--panel-font-size) - 2px)` 没有 `max()` 兜底，最小档会渲染出 7px 文本；同时 153 条 `font-size` 里 106 条是硬编码 11px/10px，用户把面板字体调到 18px，面板标题、菜单、状态栏纹丝不动。

下面的问题按"会让用户做不到某件事"排序，不按文件排序。

## 核查方法

- 用 Playwright + headless Edge 155 挂真实 `App` + 真实 store + 真实 `styles.css`，Tauri IPC 用合成实现；视口 1440×900 与 900×560，语言 en / zh-CN。
- 实测项：计算样式、命中区尺寸、菜单键盘可达性、20 标签溢出、对话框在 900×560 的裁切、菜单文字截断、四套主题的 WCAG 对比度。
- 代码静态核对项：ARIA 结构、事件绑定、i18n 键、未定义 token、hover/焦点规则计数。
- 夹具在 `.tmp/ui-probe*.mjs`、`.tmp/contrast-probe.mjs`，截图在 `.tmp/ui-probe/`，未纳入产品代码；**本轮未修改任何源码**。

---

## P0：用户做不到的事

### 1. 菜单栏完全没有键盘入口（实测）

- 五个菜单标题是 `<div>`，`tabIndex` 全为 `-1`，无 `role`、无 `aria-expanded`、无 `aria-haspopup`；`.menubar` 本身也没有 `role="menubar"`。[MenuBar.tsx:756](src/components/MenuBar.tsx#L756)
- 实测：按 `Alt` 后焦点仍在 `BODY`，菜单不打开；再按 `↓`/`→` 无反应。
- 菜单项的激活绑在 `onMouseDown` 上，[MenuBar.tsx:886](src/components/MenuBar.tsx#L886)。实测把焦点放到"Filer"条目上按 `Enter` 和 `Space`，面板状态不变、菜单不关；鼠标点击同一个条目则正常切换。
- 菜单打开后按 `Esc` **不关闭**——`MenuBar` 只注册了 `document` 的 `mousedown` 关闭逻辑，[MenuBar.tsx:305](src/components/MenuBar.tsx#L305)，没有任何 keydown 监听。
- 下拉容器没有 `role="menu"`，[MenuBar.tsx:826](src/components/MenuBar.tsx#L826)，但里面的条目有 `role="menuitem"`/`menuitemradio`。`menuitem` 不在 `menu` 里，ARIA 结构无效，屏幕阅读器不会把它当菜单播报。

**后果**：Export Data、Import SSH Config、Language、Restore Defaults、Check for Updates 这些只存在于菜单栏的命令，键盘和读屏用户永远够不到。

**最小修法**：标题改 `<button>` + `role="menubar"`/`menuitem` + `aria-haspopup="menu"` + `aria-expanded`；`onKeyDown` 处理 `Alt`/`F10`、`←→`、`↓`、`Esc`、`Home/End`；条目动作从 `onMouseDown` 移到 `onClick`（顺带修掉"按下后拖开仍然执行"，对 Restore Defaults 这类危险项尤其重要）。

### 2. 标签条永远不溢出，20 个会话退化成"数字 + 圆点"（实测）

- `.tab` 有 `max-width: 220px` 和 `overflow: hidden`，但没有 `min-width`，[tabs.styles.css:77](src/styles/tabs.styles.css#L77)；`.tab-label` 也没有 `min-width: 0`，[tabs.styles.css:389](src/styles/tabs.styles.css#L389)。flex 的自动最小尺寸让标签可以被压到 0。
- 实测 1440px 下 20 个标签：`scrollWidth === clientWidth`（1219 = 1219），**不溢出**；每个标签 59–62px，标签文字宽度 **0px**。截图里只剩编号和状态点，`can-scroll-left/right` 两个类都没有，边缘渐隐和"全部会话"下拉（[TabStrip.tsx:564](src/components/TabStrip.tsx#L564)）因此永不出现。
- 900px 下 8 个标签：每个 85px，文字可见宽度 10px。
- 关闭按钮 18×18，且 `visibility: hidden`，只有 hover 或当前标签才显示，[tabs.styles.css:394](src/styles/tabs.styles.css#L394)；它的处理同样只认 `onMouseDown`，[TabStrip.tsx:543](src/components/TabStrip.tsx#L543)，键盘 Enter 无效。

**后果**：会话一多，用户既看不到会话名，也看不到关闭按钮，也没有"全部会话"列表兜底。这是"多开会话"这一核心用法上的直接失效。

**最小修法**：`.tab { flex: 0 0 auto; min-width: 112px }`，`.tab-label { min-width: 0 }`，`.tab-close { flex: 0 0 18px }` 并改 `onClick`；溢出逻辑就能按原设计工作。

### 3. 终端是键盘陷阱：Tab 出不去（代码确认）

`terminalKeyboard` 在匹配完快捷键表后 `return true`，[terminalKeyboard.ts:172](src/terminalKeyboard.ts#L172)，把 Tab 交给 xterm，而 xterm 对 Tab 是 `preventDefault` 后发 `HT`。`SHORTCUT_COMMANDS` 里没有任何"把焦点移出终端/切到下一个区域"的命令，[shortcuts.ts:75](src/shortcuts.ts#L75)；`Ctrl+Alt+←/→/↓` 只切换面板显隐，不移动焦点。

**后果**：一旦进入会话（打开标签即自动聚焦），键盘用户无法到达标签条、面板、状态栏。这是 P0 级可达性缺陷，也是第 1、2 条修好之后仍然卡住的原因。

**最小修法**：`F6`/`Ctrl+Tab` 循环区域并让 Tab 在有修饰键时才交给 shell；把 `focusRegion` 加进快捷键表。

### 4. `dismissable={false}` 不挡 Escape，填了一半的表单会被一键清空（实测）

`ModalDialog` 的 Escape 分支无条件调用 `onClose`，[ModalDialog.tsx:261](src/components/ModalDialog.tsx#L261)；`dismissable` 只用在背景点击上。实测在 900×560 打开 New Session（`dismissable={false}`），按一次 `Esc`，对话框计数归零——已填内容全部丢弃。

受影响：SessionDialog、FontSizeDialog、ShortcutsDialog、SshConfigImportDialog、PublicKeyLoginDialog、AuthPromptDialog。

另有一处更直接：`GroupNameDialog` 没有传 `dismissable`，默认 `true`，[ModalDialog.tsx:78](src/components/ModalDialog.tsx#L78)，而 `dialogAttention.ts` 的注释明确写着"表单对话框不能在背景点击时关闭（issue #33）"。改名/新建组时点一下旁边，名字就没了。

**最小修法**：Escape 尊重 `dismissable`（或新增 `closeOnEscape`）；`GroupNameDialog` 补 `dismissable={false}`。

### 5. 快捷键对话框在 900×560 把 Apply/Cancel 裁掉，且没有滚动条（实测 + 截图）

`.shortcuts-dialog` 是 `overflow: hidden` + `max-height`，[dialogs.styles.css:736](src/styles/dialogs.styles.css#L736)，内部没有 flex 撑开的滚动容器。实测：对话框 560px 高（顶到视口），内容 928px，页脚 `top = 890`，**在视口外**，内部可滚动元素为 0 个。截图里 18 行快捷键直接切断，看不到任何按钮。

对比：同尺寸下 SessionDialog 是正确的——页脚 `top = 488` 可见，`.session-dialog-body` 是滚动容器。说明正确做法在代码库里已有，只是没推广。

**最小修法**：把 `.session-dialog` 的 flex 三段式（header `flex:0 0 auto` / body `min-height:0; overflow-y:auto` / footer `flex:0 0 auto`）提升为 `.dialog` 的默认。

### 6. 字号体系没有下限，也没有比例（实测）

- 面板字体可设 9–18px，[storePreferences.ts:18](src/storePreferences.ts#L18)。
- 三处派生值直接减 2px，无 `max()`：`.filer-col-date`（[filer.styles.css:214](src/styles/filer.styles.css#L214)）、filer 传输元信息、`sender-command-tooltip span`（[sender.styles.css:690](src/styles/sender.styles.css#L690)）。最小档 = **7px**。同文件的 FTP 侧写了 `max(8px, …)`，说明作者知道要兜底，只是没统一。
- 实测渲染档位 9 个：8/9/10/11/12/13/14/15/22px。`body` 声明 12px，[foundation.styles.css:306](src/styles/foundation.styles.css#L306)，但 153 条声明里 106 条是 11px/10px，**实际正文是 11px**。
- 10px 不只用在徽章上，还用在表格数据（Filer 日期列）、表单提示（`.session-field-hint`）、运行详情（`.wb-run-detail dd`）、控制台时间戳。9px 用于 `.tab-workspace` 和 `.wb-sync small`（同步详情）。
- 实测把 `panelFontSize` 调到 18：`.row` 文字 18px，但 `.panel-title` 仍 11px、菜单 12px、状态栏 11px、`.row-h` 仍 26px。**用户调"面板字体"只调到了列表行，没调到面板本身。**

**最小修法**：定 `--fs-xs/--fs-sm/--fs/--fs-md` 阶梯，`--fs-sm`、`--fs-xs` 由 `--panel-font-size` 派生并 `max()` 兜底；把 106 条硬编码换掉。

---

## P1：明显的专业缺陷

### 7. 对比度：四套主题里仍有 3 处系统性不达标

用 WCAG 相对亮度计算（非猜测）：

| 组合 | 比值 | 位置 |
|---|---|---|
| serialx-light `--fg-dim` `#86868f` on `--bg-app` `#f4f4f2` | **3.28:1** | 整个状态栏、窗口标题 |
| 白字 on serialx-dark `--red` `#ef8a83` | **2.43:1** | 危险按钮、危险菜单行 |
| `--gutter-time-fg` on `--bg-terminal` | **2.25–2.89:1**（四个主题全中） | 终端时间戳 |
| `--scrollbar-thumb` on `--bg-panel` | **1.64–1.92:1** | 所有滚动条 |
| light `--yellow` `#bf8803` on `#f8f8f8` | **2.93:1** | "连接中"标签、传输状态、workbench 警告 |
| serialx-light `--panel-*` 三色 | 3.76–4.23:1 | 三个面板标题 |

`--accent` 作为**文字**时在 dark 主题只有 3.92:1（`shell.styles.css:306` 的勾选标记、`filer.styles.css:31` 的路径高亮），但作为边框/底色是合规的——需要区分对待，不能一刀切。

### 8. 焦点可见性：88 条 `:hover` 规则，只有 24 条 `:focus-visible` 声明

实测统计（`src/styles/*.css` + `fileDiff.styles.css`）：`:hover` 规则 88 条；`:focus-visible` 声明 24 条，其中 10 条是同一个菜单项的内部元素（`.menu-check`/`.menu-icon`/`.menu-shortcut` 等），**真正覆盖的界面只有 15 处**。

有 `:hover` 却没有 `:focus-visible` 的选择器包括 `.panel-action`、`.tab`、`.tab-close`、`.row`、`.window-control`、`.menu-item`、`.ftp-tool-button`、`.sender-*` 与 `.wb-*` 的大部分。

三个输入框 `outline: none` 且**没有任何替代**：`.wb-filter input`（[workbench.styles.css:640](src/styles/workbench.styles.css#L640)）、`.sender-more-search input`（[sender.styles.css:165](src/styles/sender.styles.css#L165)）、`.wb-quickopen > input`（[workbench.styles.css:1317](src/styles/workbench.styles.css#L1317)）——Tab 进去屏幕毫无变化。这三处是纯静态结论，不依赖运行。

> 说明：本轮的脚本化焦点探测（程序化 `.focus()` 后比对计算样式）对 `:focus-visible` 不可靠——Chromium 只在键盘或启发式判定时才匹配该伪类，程序化聚焦往往不匹配。因此"某控件聚焦零变化"这类结论一律以 CSS 规则是否存在为准，未采信该探测结果。

### 9. ARIA 结构：容器缺角色，标签悬空

- 菜单栏：无 `role="menubar"`，下拉无 `role="menu"`，标题无 `aria-expanded`（见 P0-1）。
- 标签条：无 `role="tablist"`/`role="tab"`、无 `aria-selected`、`tabIndex` 全为 `-1`（实测）。
- 会话树：行是 `<div>`，无 `role="tree"`/`treeitem`/`aria-expanded`，[SessionPanel.tsx:444](src/components/panels/SessionPanel.tsx#L444)。
- 文件列表：`role="listbox"` 有了，但只有 `Ctrl+A` 和 `Esc` 两个键，[FilerPanel.tsx:433](src/components/panels/FilerPanel.tsx#L433)；行是 `role="option"` 却不可聚焦、无 `aria-activedescendant`。键盘用户无法选中单个文件，于是上传/下载/删除按钮永远 `disabled`。
- 分隔条：无 `role="separator"`、无 `tabIndex`、无 `aria-valuenow`，[Splitter.tsx:128](src/components/Splitter.tsx#L128)。不可拖拽的用户只能接受默认布局。
- 全库 **零** `aria-invalid` / `aria-describedby` / `required`；错误信息是同级 `<div>`，不指向出错字段。
- 两个 SessionDialog 控件没有程序化标签：录制目录输入框、串口选择框，用的是裸 `<span class="session-field-label">`。
- `GroupNameDialog` 在真实 `<dialog>` 里又套了一层 `role="dialog" aria-modal="true"`，[GroupNameDialog.tsx:69](src/components/GroupNameDialog.tsx#L69)。

### 10. 菜单文字被 224px 硬宽截断（实测）

`.menu-item > .menu-dropdown { width: 224px }`，[shell.styles.css:197](src/styles/shell.styles.css#L197)。实测：

- "Programs Can Set Clipboard" 需要 149px，可用 129px → 截断
- "Reveal Working Directory in Filer" 需要 172px，可用 72px → 严重截断

即应用自己的命令名放不进自己的菜单。固定宽度的初衷（指针移动时面板不跳动）可以保留，但应该用 `min-width` 而不是 `width`。

### 11. `--terminal-font-family` 从未定义，diff 永远是 generic monospace（代码确认）

`fileDiff.styles.css:121` 写的是 `font: 12px/20px var(--terminal-font-family, monospace)`；全库唯一引用就是这一处，生产代码从未定义它（真实 token 是 `--font-mono`，由 `fonts.ts` 发布）。用户选了 JetBrains Mono，终端和编辑器是，diff 不是。

同类问题：`.file-diff-empty` 直接写死 `monospace`。

### 12. 对比视图按钮样式作用域错位（代码确认）

`.file-diff-dialog button` 定义了一套按钮外观（[fileDiff.styles.css:22](src/components/fileDiff.styles.css#L22)），但 workbench 的 Compare 对话框传的是 `contentClassName="wb-compare-dialog"`，[CompareDialog.tsx:100](src/workbench/CompareDialog.tsx#L100)。结果：上一处/下一处/首行/末行/换行 五个按钮在工作台里是**裸文字**，与旁边所有按钮完全不同。

### 13. 工作台固定宽度超出小窗，且只有一个断点（代码确认）

`.wb-sidebar` 260px + `.wb-explorer` 280px + `.wb-run-detail` 430px = **970px 固定栏**，而唯一的响应式规则是 `@media (max-width: 1100px)`。900px 窗口下编辑区被压到接近 0，没有任何折叠或抽屉。

同时 `.wb-hosts` 是 `overflow-y: hidden`（[workbench.styles.css:162](src/styles/workbench.styles.css#L162)），主机详情浮层 `position: absolute` 放在它里面 → 打开即被裁掉。两个独立评审都指向同一处。

### 14. 命中区普遍小于 24px（实测）

22×22（面板动作按钮、分屏按钮）、18×18（标签关闭）、16×16（状态栏关闭）、13×13（SSH 复用复选框）、19/15px 高的状态栏按钮。桌面端可以用 24px 作为下限；18px 的关闭按钮还叠加"仅 hover 可见"。

### 15. 状态栏信息设计

- `REC` 是硬编码英文，[StatusBar.tsx:87](src/components/StatusBar.tsx#L87)，且它是按钮（点了打开目录）却长得像指示灯。
- `Window {rows}×{cols}` 输出 "Window 24×80"，[en.ts:813](src/locales/en.ts#L813)，与终端界"列×行"的通行写法相反。
- 协议名是裸 token（`ssh`/`sftp`），无标签。
- 每秒重渲染，但显示到分钟。

### 16. 菜单里 `Session` 与 `Session` 重名

顶层第一个菜单叫 Session，View 菜单里切换会话面板的条目也叫 Session（`menu.panelSessions`）。同理 Filer/Sender。应该叫 "Sessions Panel" 之类，说明它切换的是面板。

---

## P2：一致性与细节

| 项 | 证据 | 影响 |
|---|---|---|
| 4 个无限动画不理会 `prefers-reduced-motion` | `update-spin`、`filer-transfer-indeterminate`、`ftp-transfer-indeterminate`、`wb-pulse` | 关掉动效偏好的用户仍在看循环动画 |
| 危险色白字硬编码 `#ffffff` | [dialogs.styles.css:579](src/styles/dialogs.styles.css#L579)、[panels.styles.css:327](src/styles/panels.styles.css#L327) | serialx-dark 2.43:1 |
| light 主题 `--menu-highlight` 是白色 | `foundation.styles.css:130` | 白底白边，菜单顶部高光失效 |
| `--bg-knob` / `--shadow-knob` 四套主题都定义、全库零引用 | `foundation.styles.css:54-55, 134-135, 205-206, 265-266` | 死 token |
| 右键菜单有前导图标，菜单栏没有 | `MenuAction` 有 `icon` 字段并渲染 `MenuLeading`，`Entry` 没有 | 同一个 Copy 在两处长得不一样，两套菜单语言 |
| 标签 tooltip 泄漏内部枚举 | `tab.message ?? tab.state`，[TabStrip.tsx:527](src/components/TabStrip.tsx#L527) | 中文界面显示 `error` |
| 行高 4 种、控件高度 8 种、padding 74 种 | 22/26/29/30px 行高；22/23/24/25/26/28/30/32px 控件 | 面板之间密度对不齐 |
| 面板标题 11px + 大写 + 0.06em 字距 + 不换行 | [panels.styles.css:34](src/styles/panels.styles.css#L34) | 德语等长词会撞到按钮；CJK 白吃字距 |
| 分隔条 1.16:1，静息态不可见 | `--border` on `--bg-terminal` | 找不到分隔条，也不知道能拖 |
| workbench 选中态 = hover 态 | `.wb-run-row:hover, .wb-run-row.is-active` 同一底色 | 指针移开就分不清选中哪一行 |
| 状态栏错误信息是唯一可压缩项 | `flex-shrink: 0` 给资源/隧道/传输，`min-width: 0` 给错误 | 窄窗口下错误被省略号吃掉 |

---

## 建议修复顺序

**第一批（一周内，都是局部改动，收益最大）**
1. 菜单栏键盘化：`role` + `tabIndex` + `onClick` + `Esc`/方向键 + `aria-expanded`。
2. `.tab` 加 `min-width`、`.tab-label` 加 `min-width: 0`、关闭按钮改 `onClick` 并放大到 22px。
3. `.dialog` 采用 SessionDialog 的 flex 三段式，修掉 ShortcutsDialog 裁切。
4. Escape 尊重 `dismissable`；`GroupNameDialog` 补 `dismissable={false}`。
5. 所有 `calc(var(--panel-font-size) - Npx)` 包 `max()`。
6. `--terminal-font-family` → `--font-mono`；`.file-diff-dialog button` 作用域改到 `.file-diff-view button`。

**第二批（一两周，系统性）**
7. 加一条全局 `:focus-visible` 规则，再逐个表面微调 `outline-offset`。
8. 补对比度：serialx-light `--fg-dim`、danger 白字、`--gutter-*-fg`、`--scrollbar-thumb`、light `--yellow`。
9. 定义字号阶梯 token，替换 106 条硬编码。
10. 终端加 `focusRegion`（F6 / Ctrl+Tab），解除键盘陷阱。

**第三批（需要设计决策）**
11. 标签条/会话树/文件列表的 roving tabindex 与方向键导航。
12. 分隔条的 `role="separator"` + 方向键调整。
13. 工作台 900px 断点与主机浮层的 portal 化。
14. 菜单栏与右键菜单统一图标语言。

---

## 已确认做对的部分（对照用）

- `ModalDialog` 的 Tab 环绕与焦点归还是真的实现了，[ModalDialog.tsx:265-292](src/components/ModalDialog.tsx#L265)、`:167-172`，不是摆设。
- 破坏性确认（删除条目/主机/会话/退出/主机密钥）全部把初始焦点放在 Cancel，[DeleteEntryDialog.tsx:59](src/components/DeleteEntryDialog.tsx#L59) 等。
- `--fg` 在四套主题里都过 4.5:1；`--fg-dim` 与 `--fg-faint` 除 serialx-light 的 `--fg-dim`（3.28:1）外也都过线。`--panel-*` 三色在 serialx-light 略低（3.76–4.23:1），属于边缘情况。
- 菜单行 28px 高、12px 字、快捷键 11px 右对齐，密度与 VS Code 一致。
- 标签的"后台命令完成"动效、`prefers-reduced-motion` 在标签与部分面板上是照顾到的。
- 四套主题的 token 集合完整，没有"某主题少一个变量"的结构性问题。

---

## 验证边界

- 全部渲染证据来自 headless Edge 155 + 合成 IPC。它证明的是这个 harness 下的 DOM、计算样式与组件行为，**不证明 WebView2 的实测表现、GPU 合成、真实 SSH/FTP 会话**。
- 未运行真实屏幕阅读器；ARIA 结论来自结构阅读，`role="progressbar"` 内嵌按钮、`listbox`→`option` 层级这两条属于"结构上无效"，实际播报未验证。
- 未运行 `npm run build` / `npm test`；本轮不改代码，改动后的回归需要另外执行。
- `.tmp/ui-probe*.mjs` 与 `.tmp/ui-probe/` 是本轮夹具与截图，未纳入产品。
