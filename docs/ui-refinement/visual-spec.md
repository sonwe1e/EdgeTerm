# EdgeTerm 视觉精修规范

> 角色：视觉设计专家。范围：全应用组件级精修（应用外壳 / Sender / Filer / 状态栏 / 对话框 / Workbench）。
> 约束：不重设计、不新增主题、不引入依赖；所有方案兼容 4 套主题（dark / light / midnight(serialx-dark) / warm(serialx-light)）；优先复用 `foundation.styles.css` 既有 token。
> 依据：`src/styles/` 全部 11 个 CSS 文件、关键组件源码、`docs/screenshot-dark.png` 与 `docs/screenshot-light.png`。

---

## 0. 总则（设计原则）

1. **一套控件语言，处处一致。** 同一个尺寸类别的控件，在应用外壳、Sender、Filer、对话框、Workbench 里必须有相同的高度、圆角、hover / focus / disabled 表现。当前「组件级简陋」的核心不是缺细节，而是同一控件在五个表面有五种写法。
2. **颜色分三层，各司其职。** `--accent` 蓝 = 交互（焦点 / 主操作 / 选中）；`--panel-session|sender|filer` = 面板身份（只装点面板标题 pill 与其主图标）；`--green|yellow|red` = 状态（连通 / 运行 / 成功 / 警告 / 错误）。三层互不越界。
3. **层级靠字重 + 颜色 + 分隔线，不靠装饰。** 分组头、选中、强调都用字重与既有色阶表达；分隔线只用 `--border` 一级；elevation 只留给「浮起」的表面（菜单 / 弹层 / 对话框 / 通知）。
4. **间距走阶梯，控件走高度阶梯。** 所有内外边距落在 `--sp-*`（2/3/4/6/8/10/12/16）上；所有控件高度落在 `--h-control-xs|sm|control|lg|bar`（20/22/24/28/30）上。偶发的 26px 只在「必须与 `--row-h` 对齐」时保留，并注明理由。
5. **四主题同构。** 任何颜色方案都不得为单一主题硬编码 hex；确需新 token 时，四个 `[data-theme]` 块同改（见 §8.3 `--warn-contrast`）。

---

## 1. 全局契约（跨所有表面）

### 1.1 间距节奏

**现状问题。** `--sp-*` 阶梯已存在，但大量 11/13/14px 等 off-ladder 字面量散落各处：`.dialog-body` `padding: 14px 16px`、`.session-dialog-body` `gap: 14px`、`.session-section` `padding: 13px 14px 14px`、`.session-section-heading` `margin-bottom: 11px`、`.font-size-dialog-body` `gap: 18px`、`.filer-path` `padding: 5px 12px`、`.sender-header .panel-title.is-sender` `margin-right: 10px`。这些值彼此差 1-3px，肉眼不可辨，却破坏了「节奏可预测」。

**精修方案。** 确立三条间距规则并清除 off-ladder 字面量：

| 场景 | 规则 | token |
|---|---|---|
| 面板内容水平内边距（行 / 标题 / 工具栏统一左缩进） | 12px | `--sp-12` |
| 一组控件内部的间距（图标按钮组、行内元素） | 6px（图标按钮）/ 8px（混合控件） | `--sp-6` / `--sp-8` |
| 区块之间的间距（section 之间、表单项之间） | 10-12px | `--sp-10` / `--sp-12` |

**具体 CSS。**

```css
/* 对话框内边距落到阶梯 */
.dialog-body { padding: var(--sp-12) var(--sp-16); }      /* 14px → 12px */
.session-dialog-body { padding: var(--sp-16); gap: var(--sp-12); }  /* gap 14px → 12px */
.session-section { padding: var(--sp-12); }                 /* 13/14px → 12px */
.session-section-heading { margin-bottom: var(--sp-10); }  /* 11px → 10px */
.font-size-dialog-body { gap: var(--sp-16); }              /* 18px → 16px */

/* 面板标题右缩进与行内边距对齐（行是 margin 6 + padding 6 = 12px 内缩） */
.panel-header { padding: 0 var(--sp-12); }                 /* 右 6px → 12px，与行对齐 */
.filer-toolbar { padding: 0 var(--sp-12); }                /* 8px → 12px，与 path/columns 对齐 */
.sender-header .panel-title.is-sender { margin-right: var(--sp-8); }  /* 10px → 8px */
```

**验收要点。** 全局搜索 `padding` / `margin` / `gap` 中的 `11px|13px|14px|5px|7px` 字面量，除发丝线（1px）外应全部替换为阶梯值；面板标题、行、工具栏的左边缘在同一 x 上。

---

### 1.2 控件状态（全局控件语言）

**现状问题。** 同一状态在不同控件有不同写法：

- **focus-visible 三套并存**：全局 `outline: 2px solid var(--accent)`（按钮 / role）；`input:focus-visible` `outline: 2px color-mix(accent 65%)`；`.session-field input:focus` 用 `box-shadow: 0 0 0 3px accent 22%` 软环；`.filer-action` / `.filer-crumb` / `.filer-columns button` / `.status-dismiss` / `.status-item` 又用 `outline: 1px`。**且 `.session-field input` 键盘聚焦时 `:focus`（软环）与全局 `input:focus-visible`（2px outline）同时命中，出现双重焦点环。**
- **disabled 五档 opacity**：`.panel-power` 0.35、`.sender-send` 0.35、`.btn` 0.5、`.filer-action` 0.45、`.sender-more-item` 0.4、`.shortcut-clear` 0.3、`.wb-icon-button` 0.4。
- **`:active` 大面积缺失**：`.panel-action`、`.sender-quick-button`、`.btn`、`.wb-icon-button` 只有 hover，按下无反馈。

**精修方案。** 定义两级焦点语言 + 统一 disabled + 补 :active：

- **chrome 控件**（按钮 / 图标按钮 / 标签 / 菜单行 / 树行）：`2px solid var(--accent)` outline。有自己背景的控件 `outline-offset: -2px`（环画在内），透明背景的 `outline-offset: 1px`。
- **文本字段**（input / select / textarea）：软环 `border-color: var(--accent)` + `box-shadow: 0 0 0 3px color-mix(accent 22%)`，**不画 outline**（软环即焦点指示，避免双重环）。鼠标聚焦只换边框色（`focus-visible` 不触发，符合「鼠标用户不需要环」）。
- **disabled 统一**：`opacity: 0.4; cursor: default`，去掉所有 0.3/0.35/0.45/0.5。
- **:active 统一**：chrome 控件按下给 `background: var(--bg-active)`。

**具体 CSS。**

```css
/* —— 字段焦点：全局统一为软环，抑制 outline（消除双重环）—— */
input:focus,
select:focus,
textarea:focus {
  border-color: var(--accent);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 22%, transparent);
}
input:focus-visible,
select:focus-visible,
textarea:focus-visible {
  outline: none;               /* 软环已是焦点指示；勿与全局 outline 叠加 */
}
/* .session-field 里重复的 box-shadow 现已成为全局默认，可删去其私有规则 */

/* —— chrome 控件焦点：全部 2px（含原 1px 的几处）—— */
.filer-action:focus-visible,
.filer-crumb:focus-visible,
.filer-columns button:focus-visible,
.status-dismiss:focus-visible,
button.status-item:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}

/* —— disabled 统一 0.4 —— */
.panel-power:disabled,
.sender-send:disabled,
.sender-save-btn:disabled,
.sender-pagination button:disabled,
.filer-action:disabled,
.btn:disabled,
.wb-icon-button:disabled,
.ftp-tool-button:disabled,
.shortcut-clear:disabled {
  opacity: 0.4;
  cursor: default;
}

/* —— :active 补全（以 panel-action 为样板，其余控件同构）—— */
.panel-action:active:not(:disabled),
.sender-quick-button:active:not(:disabled),
.btn:active:not(:disabled),
.wb-icon-button:active:not(:disabled) {
  background: var(--bg-active);
}
```

**loading 词汇表**（不新增，仅固化两种）：转圈用 `.update-spinner`（18px / 2px 边 / accent 顶弧 / 0.8s）；不确定进度用 `.filer-transfer-track.is-indeterminate` / `.ftp-transfer-progress > span.is-indeterminate`。两者都已带 `prefers-reduced-motion` 降级。

**验收要点。** Tab 遍历任何控件只见一个焦点环；字段键盘聚焦是单一软环、无 outline 重影；所有 disabled 控件透明度一致；按下任何按钮有 `--bg-active` 反馈。

---

### 1.3 图标语言

**现状问题。** `.icon` 默认 16px，但 Workbench 大量 off-ladder：`.wb-dir-row .icon` / `.wb-file-name .icon` 13px、`.wb-icon-button .icon` 14px；微图标 12px（`.wb-tab-close` / `.wb-mini` / `.wb-identity` / `.wb-filter`）。13px 不在阶梯上。图标-文字间距也不统一：`.row` 6px、`.menu-entry` 10px、`.sender-command-load` 4px、`.wb-*` 4-6px 混用。

**精修方案。** 图标尺寸只用 **16 / 14 / 12** 三档，消灭 13px：

| 档 | 用途 | 示例 |
|---|---|---|
| 16px | 默认 chrome 图标、文件类型图标、树行图标、24px 图标按钮内 | `.icon`、`.filer-icon`、`.ftp-file-icon`、`.panel-action .icon` |
| 14px | 稠密工具栏图标按钮（24px 按钮内 16px 放不下时） | 仅 `.wb-icon-button` 备用 |
| 12px | 行内微图标（徽标内 / 迷你按钮 / 关闭钮） | `.wb-tab-close`、`.wb-mini`、`.wb-identity`、`.wb-filter` |

图标-文字间距：16px 图标配 `--sp-6`（6px）；12-14px 图标配 `--sp-4`（4px）。

**具体 CSS。**

```css
/* 树行图标对齐 filer-icon 的 16px（13px → 16px） */
.wb-dir-row .icon,
.wb-file-name .icon { width: 16px; height: 16px; }

/* 24px 图标按钮对齐 panel-action 的 16px（14px → 16px） */
.wb-icon-button .icon { width: 16px; height: 16px; }

/* 图标-文字间距：16px 图标 → 6px */
.sender-command-load { gap: var(--sp-6); }      /* 4px → 6px */
.menu-entry { gap: var(--sp-8); }               /* 10px → 8px，仍比其他行宽松 */
```

**验收要点。** 全局无 13px / 15px 图标；同一密度的上下文图标同号；16px 图标与相邻文字间距 6px。

---

### 1.4 阴影与 elevation

**现状问题。** 四个 `--shadow-*` token 已定义且大部分用对，但三个弹层硬编码阴影：`.transfer-center-popover` 与 `.resource-popover` `box-shadow: 0 8px 32px #0005`、`.forward-popover` `0 8px 30px #0004`（均在 `filer.styles.css` 尾部）；`.term-suggest` 用 `0 6px 18px rgba(0,0,0,0.22)`（接近 `--shadow-pop` 但非 token）。硬编码值在浅色主题下过重，且不随主题收敛。

**精修方案。** elevation 纪律——「浮起越高，token 越重」，只许四选一，禁止硬编码：

| token | 何时用 | 现有正例 |
|---|---|---|
| `--shadow-menu` | 下拉菜单 / 右键菜单（浮在 chrome 之上） | `.menu-dropdown`、`.context-menu` |
| `--shadow-pop` | 弹层 / 工具提示 / 小浮面板 | `.sender-more-menu`、`.wb-host-popover`、`.terminal-search`、`.tab-drag-ghost` |
| `--shadow-notice` | 角落通知 /  toast | `.transfer-notice`、`.wb-notice` |
| `--shadow-dialog` | 模态对话框 / 覆盖层 | `.dialog`、`.wb-quickopen`、`.wb-search`、`.wb-form-dialog` |

**具体 CSS。**

```css
/* 三个硬编码弹层归队 --shadow-pop */
.transfer-center-popover,
.resource-popover,
.forward-popover { box-shadow: var(--shadow-pop); }

/* 终端建议浮层归队（它半透明，token 的黑色分量仍成立） */
.term-suggest { box-shadow: var(--shadow-pop); }
```

**验收要点。** 全局无 `box-shadow` 硬编码 hex/rgba（除 `.btn.is-primary` 的 1px 按钮微起伏，属按钮而非 elevation）；四个 token 各就其位；浅色主题下弹层阴影明显轻于深色。

---

### 1.5 颜色纪律

**现状问题。** 大部分已守规矩，但边界需明文：

- `.filer-action:active` / `.is-open` 用 `--accent-soft`（蓝）——正确，Filer 的绿色身份不染交互态。
- `.sender-quick-button.is-primary` 用 `--panel-sender`（橙）描边——主操作用了面板身份色，与「交互 = accent」相冲突（见 §4）。
- `.wb-count` 徽标硬编码 `color: #1f1f1f`（深色墨）压在 `--yellow` 上——浅色主题 `--yellow` 是 `#8a6500`（深黄），深墨对比度约 1.5:1，不可读（见 §8.3）。
- `.window-control.is-close:hover` 硬编码 `#c42b1c` / `#fff`——不随主题（见 §3）。

**精修方案。** 三层颜色的使用边界：

1. **`--accent`（交互）**：焦点环、主按钮填充、选中底（`--bg-active` / `--accent-soft`）、链接、「开」状态。`--accent-bright` 只用于「画在 accent 淡底上的文字 / 字形」（那里 `--accent` 会发闷）。
2. **`--panel-session|sender|filer`（身份）**：只装点面板标题 pill（图标 + 文字 + 12% 淡底）与面板的主图标。**不**重染面板内的交互控件。
3. **`--green|yellow|red`（状态）**：绿 = 连通 / 运行 / 成功 / 正常；黄 = 连接中 / 警告 / 过期 / 待定；红 = 错误 / 危险 / 失败。表现形式限：文字色、图标色、边框淡色（`color-mix` 12-45%）、或实底（危险按钮）。大背景淡洗只允许 `--notice-*-bg`。

**具体 CSS。**

```css
/* 主按钮用 accent，不用面板身份色（Sender 的橙留在标题 pill） */
.sender-quick-button.is-primary {
  color: var(--accent-contrast);
  background: var(--accent);
  border-color: var(--accent);
}
.sender-quick-button.is-primary:hover { filter: brightness(1.1); }

/* 窗口关闭键归队主题色 */
.window-control.is-close:hover {
  background: var(--red);
  color: var(--danger-contrast);
}
```

**验收要点。** 面板内交互态（active / 选中 / 焦点）一律 accent 蓝，无面板身份色越界；状态色只表状态；无硬编码 hex（`--warn-contrast` 除外，见 §8.3）。

---

## 2. 应用外壳（菜单栏 / 会话树 / 标签栏）

### 2.1 现状问题

1. **面板标题区无统一分隔**：`.panel-header` 无底边框，Session 面板的标题与下方搜索框连成一片，Filer 面板标题与工具栏之间也无界线（`panels.styles.css` `.panel-header` 无 `border`）。
2. **SSH 连接选项是裸 disclosure**：`<details class="ssh-connection-options">` 用浏览器默认三角 marker，无图标、无 chevron，与面板图标语言脱节（`SessionPanel.tsx:784`，`ftp.styles.css:750`）。
3. **会话树分组头无呼吸**：`is-section` / `is-group` 与资料行仅差标签颜色，层级全靠缩进 + caret；各 section 之间无间距，截图里「SSH Sessions」「(S)FTP Sessions」等连成一串。
4. **标签用斜体表「空闲」**：`.tab { font-style: italic }`（`tabs.styles.css:98`）。中文无真斜体（合成斜体发虚），且 `is-connecting` / `is-error` 又切回正体 600，造成样式跳变。
5. **窗口关闭键硬编码** `#c42b1c` / `#fff`（`shell.styles.css:143`）。

### 2.2 精修方案

1. `.panel-header` 统一加 1px `--border` 底边框，每个面板标题栏都被界定。
2. SSH disclosure 改为面板语言：隐藏默认 marker，用 CSS chevron（或 Codicon），`fs-sm` / `fg-dim`，展开时旋转。
3. 会话树 section 之间加顶部呼吸（首个 section 除外），保留 inset 圆角行惯例。
4. 标签弃用斜体：空闲 = `fg-dim` 正体；活跃 = 终端底 + 会话色顶边（已实现）；注意态 = 正体 600。颜色 + 顶边 / 左侧边已足够区隔。
5. 窗口关闭键用 `--red` / `--danger-contrast`。

### 2.3 具体 CSS

```css
/* 1. 面板标题栏统一分隔 */
.panel-header { border-bottom: 1px solid var(--border); }

/* 2. SSH disclosure 面板化 */
.ssh-connection-options {
  padding: var(--sp-6) var(--sp-12);
  border-bottom: 1px solid var(--border);
  color: var(--fg-dim);
  font-size: var(--fs-sm);
}
.ssh-connection-options summary {
  display: flex;
  align-items: center;
  gap: var(--sp-6);
  cursor: pointer;
  list-style: none;
}
.ssh-connection-options summary::-webkit-details-marker { display: none; }
.ssh-connection-options summary::before {
  content: "";
  width: 0;
  height: 0;
  border-top: 3px solid transparent;
  border-bottom: 3px solid transparent;
  border-left: 4px solid currentColor;
  transition: transform 120ms ease;
}
.ssh-connection-options[open] summary::before { transform: rotate(90deg); }

/* 3. section 分组呼吸 */
.row.is-section { margin-top: var(--sp-6); }
.panel-body > div:first-child > .row.is-section { margin-top: 0; }

/* 4. 标签弃斜体（空闲靠 fg-dim，不靠 italic） */
.tab { font-style: normal; }
/* .tab.is-active 的 font-style: normal 现为冗余，可删；
   .tab.is-connecting/.is-error 的 font-style: normal 保留，font-weight: 600 表注意 */

/* 5. 窗口关闭键主题化 */
.window-control.is-close:hover {
  background: var(--red);
  color: var(--danger-contrast);
}
```

### 2.4 视觉层级规则（分组头 / 分隔线 / 强调）

- **大写 + 字距**（`text-transform: uppercase` + `letter-spacing`）只用于**列头**与**侧栏 section 标签**：`.panel-title`、`.filer-columns`、`.wb-sidebar-heading`、`.wb-hosts-label`。中文已由 `:lang(zh)` 归零字距（`foundation.styles.css:381`）。
- **树行 / 内容**用句式大小写（`.row-label`、`.tab-label`），不用大写。
- **分隔线只用 `--border` 一级**；`--border-strong` 留给「可抓取的边界」（splitter）与输入框描边。菜单内部分隔用 `--menu-separator`。
- **强调**：字重 600 + `--fg`（不用颜色单独强调）；交互强调用 `--accent`；状态强调用状态色。`--fg-faint` 仅用于 hint / 元数据，不用于需读的主信息。

### 2.5 验收要点

- 四个主题下每个面板标题栏都有可见 1px 底边。
- SSH disclosure 显示可旋转 chevron，无默认三角。
- 会话树 section 之间有呼吸；首个 section 贴顶。
- 无标签使用斜体；空闲 / 活跃 / 注意仅靠颜色 + 顶边 / 左侧边区分。
- 浅色主题下窗口关闭键 hover 为 `--red`（`#cd3131`）白字，对比度达标。

---

## 3. Sender 面板

### 3.1 现状问题

1. **Quickbar 一行过挤**：标题 pill + 标签流 + 「More N ⌄」+ 目标 select + 「+ New」+ 展开钮，36px 行内 8px 间距排布 7+ 控件（`SenderQuickbar.tsx:59-185`）。
2. **控件高度不齐**：`.sender-quick-tag` / `.sender-quick-button` / `.sender-collapse` 26px，但 `.select` 是 `--h-control`（24px）——同一行 24 与 26 混排，基线微错。
3. **标签 chip 内 ellipsis 常显**：`.sender-quick-options`（22px）无分隔地贴在 load 按钮右侧，chip 读成一团 + 浮动省略号（`sender.styles.css:70-83`）。
4. **compose 行基线不齐**：textarea（min 28px）+ send（24px）+ repeat（24px）+ 分隔线 + label input（28px）+ save（28px）——24 与 28 混排。
5. **「New」主按钮用面板橙**：`.sender-quick-button.is-primary` 描边 `--panel-sender`（见 §1.5）。
6. **库标签 hover 上浮**：`.sender-command-tag:hover { transform: translateY(-1px) }`——全应用唯一的 transform-hover，与其他表面（只改 bg / border）不一致。

### 3.2 精修方案

1. Quickbar 控件统一 `--h-control`（24px）：标签、按钮、select 同高基线。
2. 标签 chip 的 ellipsis 改为 hover / focus-within 显现（复用 `.row > .panel-action` 惯例），并加左侧发丝线分隔；触屏（`pointer: coarse`）常显。
3. compose 行 send / repeat 升到 `--h-control-lg`（28px），与 textarea、label input、save 同基线。
4. 「New」主按钮改 `--accent` 实底（§1.5）。
5. 去掉库标签的 translateY 上浮。

### 3.3 具体 CSS

```css
/* 1. Quickbar 控件同高 */
.sender-quick-tag,
.sender-quick-button,
.sender-collapse { height: var(--h-control); }

/* 2. 标签 ellipsis：hover 显现 + 发丝分隔 */
.sender-quick-tag .sender-quick-options {
  border-left: 1px solid var(--border);
  border-radius: 0 var(--radius-md) var(--radius-md) 0;
  opacity: 0;
  transition: opacity 80ms ease;
}
.sender-quick-tag:hover .sender-quick-options,
.sender-quick-tag:focus-within .sender-quick-options { opacity: 1; }
@media (pointer: coarse) {
  .sender-quick-tag .sender-quick-options { opacity: 1; }
}

/* 3. compose 行同基线 */
.sender-send,
.sender-repeat-toggle { height: var(--h-control-lg); }

/* 5. 去上浮 */
.sender-command-tag:hover { transform: none; }
```

### 3.4 验收要点

- Quickbar 所有交互控件同高（24px）同基线。
- 标签 ellipsis 默认隐藏、hover / 键盘聚焦显现；触屏常显。
- compose 行 send / repeat / label / save 同基线（28px）。
- 「New」为 accent 实底（四主题白字对比度达标）。
- 库标签 hover 无位移。

---

## 4. Filer 面板

> Filer 是当前最成熟的表面（grid 对齐、行高 token、滚动条补偿、状态过渡都已到位），本节只做标准化收尾，不作结构改动。

### 4.1 现状问题

1. `.filer-action:disabled` 用 `opacity: 0.45`（off 标准，见 §1.2）。
2. `.filer-action` / `.filer-crumb` / `.filer-columns button` 的 `:focus-visible` 用 `outline: 1px`（其余 chrome 是 2px，见 §1.2）。
3. `.filer-path` `padding: 5px 12px` 的 5px 是 off-ladder 手调值（为让 26px 输入框凑成 36px 行高对齐 panel-header）。

### 4.2 精修方案

1. disabled 归 0.4。
2. 焦点环归 2px。
3. path 行：输入框 26px 保留（与 `--row-h` 对齐有理由），但垂直 padding 用 `--sp-4`（4px），行高 34px——与 panel-header 的 36px 差 2px 可忽略；若严格对齐 36px，则输入框改 `--h-control`（24px）+ padding `--sp-6`（6px）。推荐后者（24px 上阶梯、36px 严格对齐）。

### 4.3 具体 CSS

```css
/* 2. 焦点环 2px（见 §1.2 全局规则，此处不重复私有 1px） */

/* 3. path 行严格对齐 36px 且输入框上阶梯 */
.filer-path { padding: var(--sp-6) var(--sp-12); }   /* 5px → 6px */
.filer-path input { height: var(--h-control); }       /* 26px → 24px，24+12=36px */
```

### 4.4 验收要点

- Filer 禁用按钮透明度与其他表面一致（0.4）。
- Filer 控件键盘焦点为 2px 环。
- path 行总高 36px，与面板标题栏对齐；输入框高度在阶梯上。

---

## 5. 状态栏

### 5.1 现状问题

1. `.statusbar` 所有项间距 `--sp-16`（16px）——24px 的细条里 16px 间距过散，各项漂开。
2. **无分组**：message | resource | forward | transfer | window | protocol | stamp 等距排布，相关项（window + protocol）与无关项同距，读不出聚类。

### 5.2 精修方案

1. 全局间距收紧到 `--sp-12`（12px）；message 仍 `flex: 1` 吸收剩余空间。
2. 会话明细簇（window / protocol / legacy / recording）包一层 `.status-group`，簇内 `--sp-8`、簇间 `--sp-12`，读作「右端一组会话信息」。

### 5.3 具体 CSS

```css
.statusbar { gap: var(--sp-12); }   /* 16px → 12px */
.status-group {
  display: inline-flex;
  align-items: center;
  gap: var(--sp-8);
}
```

> `.status-group` 需在 `StatusBar.tsx` 把会话明细项包进 `<div class="status-group">…</div>`（组件改动，前端工程专家执行）。

### 5.4 验收要点

- 状态栏项间距 12px；message 吸收弹性空间。
- 会话明细在右端成簇，簇内 8px。
- 状态栏按钮焦点 2px（§1.2）。

---

## 6. 对话框

### 6.1 现状问题

1. **两套字段模式并存**：`.field`（`grid 110px 1fr`，标签右对齐）用于旧对话框，`.session-field`（标签在输入框上方）用于会话对话框。右对齐标签可读性差且与主流表单相悖。
2. **控件尺寸不齐**：`.btn` 30px / `radius-md`、`.session-field input` 30px / `radius-md`、`.shortcut-key` 26px、`.serial-refresh` 32px 宽、`.session-color-option` 20px。按 §1 半径映射（28px+ → `radius-lg`），`.btn` 与 `.session-field input` 的 30px + `radius-md` 是越界组合。
3. `.dialog-body` `padding: 14px 16px`、`.session-section` `padding: 13px 14px`、`.session-dialog-body` `gap: 14px` 等 off-ladder（见 §1.1）。
4. `.field input` 用全局字段焦点（边框 + 2px outline），`.session-field input` 用软环——§1.2 全局统一后此差异消失。

### 6.2 精修方案

1. **统一字段模式为「标签在上」**：以 `.session-field` 为标准，迁移 `.field`（标签右对齐 grid）到标签在上。字体大小对话框（`.font-size-setting`）与快捷键对话框（`.shortcut-row`）的自定义 grid 保留其多列布局，但标签同样置于控件上方或左侧统一左对齐。
2. **对话框控件统一 `--h-control-lg`（28px）+ `radius-lg`（8px）**：`.btn`、`.session-field input/select` 全部落到此规格。卡片（`.session-section`）保持更圆的 `radius-xl`（10px）——容器比控件圆，是合法层级。
3. 内边距落阶梯（§1.1）。

### 6.3 具体 CSS

```css
/* 2. 对话框控件统一 28px + radius-lg */
.btn {
  height: var(--h-control-lg);       /* 30px → 28px */
  border-radius: var(--radius-lg);   /* md → lg */
}
.session-field input,
.session-field select {
  height: var(--h-control-lg);       /* 30px → 28px */
  border-radius: var(--radius-lg);   /* md → lg */
}

/* 3. 卡片：容器比控件圆，padding 上阶梯 */
.session-section {
  padding: var(--sp-12);
  border-radius: var(--radius-xl);   /* 卡片保持 10px，与 8px 控件形成层级 */
}
```

### 6.4 验收要点

- 所有对话框按钮与输入框同高（28px）同圆角（8px）。
- 字段标签统一在控件上方（或左对齐），无右对齐 grid 标签。
- section 卡片 12px 内边距、10px 圆角，明显圆于其内控件。
- 对话框内边距全部落在 `--sp-*` 阶梯。

---

## 7. Workbench 实验台

> Workbench 是当前的「视觉孤岛」：它用 12px 字面量、13/14px 图标、3px 圆角、硬编码阴影，与外壳 / Sender / Filer 不像同一个应用。本节是回归主设计系统的对齐工作。

### 7.1 现状问题

1. **字体不随面板设置**：`.wb { font-size: 12px }` 覆盖了 `.app` 的 `var(--panel-font-size)`（`workbench.styles.css:12`）；`.wb-dialog-header strong`、`.wb-field input`、`.wb-drafts-identity` 同样硬编码 12px。Display Settings 改面板字号时 Workbench 不响应。
2. **图标 off-ladder**：`.wb-dir-row .icon` / `.wb-file-name .icon` 13px、`.wb-icon-button .icon` 14px（见 §1.3）。
3. **圆角错位**：`.wb-icon-button` / `.wb-host-chip` / `.wb-project` / `.wb-filter` / `.wb-top select` 用 `radius-xs`（3px），而外壳同尺寸控件用 `radius-md`（6px）；`.wb-server-chip` 又用 `radius-xl`（10px）、`.wb-status-pill` / `.wb-badge` 用 `radius-lg`（8px）——无规律。
4. **硬编码阴影**：`.transfer-center-popover` / `.resource-popover` `0 8px 32px #0005`、`.forward-popover` `0 8px 30px #0004`（见 §1.4）。
5. **`.wb-count` 徽标主题 bug**：`background: var(--yellow); color: #1f1f1f`——浅色主题 `--yellow` 为 `#8a6500`（深黄），深墨 `#1f1f1f` 对比度约 3.1:1，低于小字 4.5:1 门槛，不可读（见 §7.3 新 token）。
6. **细节不齐**：`.wb-run-dot` 7px（外壳 `.tab-dot` / `.row-dot` 为 8px）；`.wb-dirty-mark` `font-size: 8px` 字面量（应用 `--fs-2xs`）；`.wb-editor-tab.is-active` 顶边 1px（主标签栏 2px）；`.wb-field input:focus` 只换边框无软环（§1.2 全局统一后自动获得）。

### 7.2 精修方案

1. 字体：`.wb` 及各处 12px 字面量改 `var(--panel-font-size)` / `var(--fs)`，跟随面板字号设置。
2. 图标：13/14px 归 16px（树行 / 图标按钮），12px 微图标保留（见 §1.3）。
3. 圆角：交互控件统一 `radius-md`（6px，对齐外壳）；chip / pill / badge 统一 `radius-lg`（8px）。
4. 阴影：三个弹层归 `--shadow-pop`（§1.4）。
5. `.wb-count` 引入 `--warn-contrast`（§7.3）。
6. 细节：dot 归 8px、dirty-mark 归 `--fs-2xs`、编辑器标签顶边归 2px。

### 7.3 新 token：`--warn-contrast`（实底黄上的墨色）

**理由**：`.wb-count` 是需引起注意的计数徽标，用实底 `--yellow`。实底状态色上的可读墨色在深浅主题间必须翻转（深主题黄底用深墨、浅主题黄底用白墨），与既有 `--danger-contrast`（实底红上的墨）、`--accent-contrast`（实底 accent 上的墨）同构。四套主题值：

| 主题 | `--yellow` | `--warn-contrast` | 对比度 |
|---|---|---|---|
| dark (`:root`) | `#cca700` | `#1f1f1f` | ≈7:1 |
| light | `#8a6500` | `#ffffff` | ≈5.3:1 |
| serialx-dark | `#e0b070` | `#1f1f1f` | ≈8:1 |
| serialx-light | `#8a6500` | `#ffffff` | ≈5.3:1 |

**具体 CSS。**

```css
/* foundation.styles.css：四个主题块各加一行 */
:root { --warn-contrast: #1f1f1f; }
:root[data-theme="light"] { --warn-contrast: #ffffff; }
:root[data-theme="serialx-dark"] { --warn-contrast: #1f1f1f; }
:root[data-theme="serialx-light"] { --warn-contrast: #ffffff; }

/* workbench.styles.css */
.wb-count {
  background: var(--yellow);
  color: var(--warn-contrast);   /* #1f1f1f 硬编码 → token */
}
```

> 若不愿新增 token，备选是把 `.wb-count` 改成淡底徽标（`background: color-mix(in srgb, var(--yellow) 20%, transparent); color: var(--yellow)`），与 `.wb-badge.is-variant` 完全一致，无需新 token，但显著性下降。推荐用 token以保留「计数徽标应醒目」。

### 7.4 具体 CSS（其余对齐）

```css
/* 1. 字体跟随面板设置 */
.wb { font-size: var(--panel-font-size); }
.wb-dialog-header strong { font-size: var(--fs); }
.wb-field input,
.wb-field select,
.wb-field textarea { font-size: var(--fs); }
.wb-drafts-identity { font-size: var(--fs); }

/* 3. 圆角：控件 md，chip/pill lg */
.wb-icon-button,
.wb-host-chip,
.wb-project,
.wb-filter,
.wb-top-context select,
.wb-top-actions select { border-radius: var(--radius-md); }
.wb-tab-close { border-radius: var(--radius-sm); }
.wb-server-chip { border-radius: var(--radius-lg); }

/* 6. 细节归队 */
.wb-run-dot { width: 8px; height: 8px; }      /* 7px → 8px */
.wb-dirty-mark { font-size: var(--fs-2xs); }  /* 8px 字面量 → token */
.wb-editor-tab.is-active { box-shadow: inset 0 2px 0 var(--accent); }  /* 1px → 2px */
```

### 7.5 验收要点

- Display Settings 改面板字号，Workbench chrome 文字随之缩放。
- 无 13/14px 图标；树行 / 图标按钮 16px，微图标 12px。
- Workbench 控件圆角 6px、chip 8px，与外壳一致。
- 三个弹层用 `--shadow-pop`，浅色主题下不过重。
- `.wb-count` 在四主题可读（重点验证浅色主题白字 on `#8a6500`）。
- dot 8px、dirty-mark 用 `--fs-2xs`。

### 7.6 窄工作台的信息分配（2026-10-28）

在紧凑布局中，标题与操作在容纳得下时同排，否则自然换行；导航按标签内容分配宽度，不强制长短不同的文字等分。运行摘要将时长与状态、实验放在一起，将代码版本与检查时间放在一起，以减少空行，保留操作和日志。

`25em` 是基于 18px 字号、320px 与 380px 实测画面的工作假设：其下文件路径单独占一行，避免同步状态和操作挤住路径。冲突及草稿警告在自身区域内换行、滚动，焦点进入其按钮时不应把编辑器标签和工具栏滚走。额外的路径行会占用高度：320px、英文 18px、运行控制台展开的夹具中，编辑区域由原始的 84px 变为 77px；需要更多编辑空间时仍可收起控制台。

---

## 8. 空状态（跨表面统一）

### 8.1 现状问题

六种以上互不一致的空状态处理：

| 选择器 | 图标 | 排版 |
|---|---|---|
| `.panel-empty` | 无 | 居中，`fg-faint`，`line-height 1.6` |
| `.sender-quick-empty` | 无 | 行内文字，`fs-sm`，ellipsis |
| `.sender-library-empty` | 无 | `padding 10px 0`，`fs-sm` |
| `.term-empty` | 64px | `h1` 22px 字面量 |
| `.wb-editor-empty` / `.wb-onboarding` | 34px | `h2` 15px 字面量 |
| `.ftp-session-state` | 无 | `strong` 14px 字面量 |
| `.wb-quickopen-empty` / `.wb-explorer-note` | 无 | `margin 8-12px`，`fs-sm` |

图标从无到 34px 到 64px，标题从 `fs-sm` 到 22px，无共享结构。

### 8.2 精修方案

定义三档空状态，全部复用 `.panel-empty` 为「块级空态」基类：

- **行内空态**（列表 / quickbar 内）：单行 `fg-faint` `fs-sm` 文字 + ellipsis。`.sender-quick-empty`、`.sender-library-empty`、`.wb-explorer-note`。
- **块级空态**（面板体无数据）：居中，可选 32px 图标（`fg-faint` / opacity 0.7）+ 可选标题（`fg-dim` / `fs` / 500）+ 说明（`fg-faint` / `fs-sm` / `line-height 1.5` / `max-width 280px`）+ 可选动作按钮。`.panel-empty`、`.wb-quickopen-empty`、`.ftp-browser-message`。
- **英雄空态**（整工作区无会话）：居中，48px 图标 + 标题 `calc(var(--panel-font-size) + 6px)`（默认 18px，随面板字号缩放）+ 说明。`.term-empty`、`.wb-editor-empty`、`.wb-onboarding`、`.ftp-session-state`。

### 8.3 具体 CSS

```css
/* 块级空态：.panel-empty 为共享基类 */
.panel-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--sp-8);
  min-height: 80px;
  padding: var(--sp-16) var(--sp-12);
  color: var(--fg-faint);
  text-align: center;
}
.panel-empty-icon {
  width: 32px;
  height: 32px;
  color: var(--fg-faint);
  opacity: 0.7;
}
.panel-empty-title {
  color: var(--fg-dim);
  font-size: var(--fs);
  font-weight: 500;
}
.panel-empty-hint {
  max-width: 280px;
  font-size: var(--fs-sm);
  line-height: 1.5;
}
.panel-empty.is-error,
.panel-empty.is-error .panel-empty-title { color: var(--red); }

/* 英雄空态：图标 48px，标题随面板字号缩放 */
.term-empty { gap: var(--sp-12); }
.term-empty-icon { width: 48px; height: 48px; }        /* 64px → 48px */
.term-empty h1 { font-size: calc(var(--panel-font-size) + 6px); }  /* 22px 字面量 → 缩放 */
.wb-editor-empty .icon,
.wb-onboarding .icon { width: 32px; height: 32px; }    /* 34px → 32px */
.wb-editor-empty h2,
.wb-onboarding h2,
.ftp-session-state strong { font-size: calc(var(--panel-font-size) + 6px); }  /* 15/14px → 缩放 */
```

### 8.4 验收要点

- 所有块级空态共享 `.panel-empty` 结构（图标 + 标题 + 说明 + 可选动作）。
- 英雄空态图标 48px、标题随面板字号缩放。
- 行内空态为单行 `fs-sm` `fg-faint`。
- 错误空态统一 `--red`。
- 空态随面板字号设置缩放。

### 8.5 空工作区构图补充（2026-10-28）

无会话时，品牌、创建会话和启动提示组成一组；文件面板、Sender 和工作台的入口组成另一组。宽工作区两组并排、顶边对齐，保留创建会话作为唯一的实色主操作；窄工作区纵向排列，并在内容放不下时允许滚动，键盘焦点也应能滚入可见区域。活动终端、停靠面板、主题色和原有入口行为不受这项构图调整影响。

内容区上限 720px、两栏各至少 300px 是基于中英文真实文案和 12–18px 面板字号的工作假设，不是通用标准。两栏间距 16px，入口之间为 6px，以区分任务组和组内选项；外侧留 12px。按盒模型，两栏需要至少 `2 × 300 + 16 + 2 × 12 = 640px` 的工作区宽度，低于此宽度改为单栏。900×560 窗口、两侧停靠和 18px 英文时内容超过可用高度，滚动是必要的；同条件下首项可见，键盘到达最后入口时应完整显示其焦点环。

---

## 9. 实施优先级建议

按「影响面 × 改动成本」排序，供 Lead 协调三人分工：

1. **全局控件语言**（§1.2 焦点 / disabled / :active，§1.1 间距字面量）——影响每个表面，纯 CSS，先行。
2. **Workbench 回归**（§7）——视觉孤岛，改动集中在一个样式文件 + 一个新 token。
3. **面板标题区分隔**（§2.1）+ **对话框控件统一**（§6）——结构清晰、验收明确。
4. **Sender quickbar 密度**（§3）——需配合组件微调（ellipsis hover 逻辑）。
5. **空状态统一**（§8）——需组件配合包结构。
6. **状态栏分组**（§5）——需组件包 `.status-group`。
7. **标签弃斜体**（§2.4）——需产品确认（斜体是既有「空闲」语义，弃用需权衡）。
