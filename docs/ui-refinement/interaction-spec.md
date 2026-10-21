# EdgeTerm 交互精修规范

> 版本：1.0 · 作者：体验设计专家 · 日期：2026-09-29
>
> 本规范覆盖应用外壳（会话树/标签栏/菜单栏）、主工作区（Sender/Filer/状态栏）、全部对话框和 Workbench 实验台。所有建议基于现有设计 token 体系（`foundation.styles.css`），不新增主题、不引入新依赖、不破坏现有快捷键与 i18n 机制。

---

## 总则

### 设计原则

1. **可发现性优先**：任何可交互元素必须在静止状态下就能被识别为可交互，或通过一致的视觉语言（悬停态、焦点环）快速揭示。
2. **状态即反馈**：每个操作从触发到完成必须有可见的状态变化——悬停、按下、进行中、成功、失败五个阶段不可省略。
3. **空状态即引导**：空状态不是"什么都没有"，而是"下一步可以做什么"。
4. **键盘等价**：任何鼠标可达的操作，键盘必须可达；任何键盘可用的快捷键，不得与现有体系冲突。
5. **渐进披露**：默认展示最常用的信息层级，次要信息通过悬停、展开或"更多"按钮按需呈现。

### 现有 token 速查

| 用途 | Token | 说明 |
|------|-------|------|
| 面板强调色 | `--panel-session` / `--panel-sender` / `--panel-filer` | 各面板标题 pill 的 tint |
| 语义色 | `--green` / `--yellow` / `--red` | 成功/警告/错误 |
| 交互色 | `--accent` / `--accent-bright` / `--accent-soft` | 焦点、选中、激活 |
| 表面色 | `--bg-panel` / `--bg-panel-alt` / `--bg-field` / `--bg-hover` / `--bg-active` | 层级表面 |
| 文字色 | `--fg` / `--fg-dim` / `--fg-faint` | 主/次/弱文字 |
| 控件高度 | `--h-control-xs`(20) / `--h-control-sm`(22) / `--h-control`(24) / `--h-control-lg`(28) | 高度阶梯 |
| 圆角 | `--radius-xs`(3) / `--radius-sm`(4) / `--radius-md`(6) / `--radius-lg`(8) / `--radius-xl`(10) | 圆角阶梯 |
| 间距 | `--sp-2` ~ `--sp-16` | 2/3/4/6/8/10/12/16px |
| 字号 | `--fs-2xs` ~ `--fs-md` | 跟随 `--panel-font-size` 缩放 |

### 交互状态词汇表

所有组件统一使用以下状态类名约定：

| 状态 | 类名/属性 | 视觉表现 |
|------|-----------|----------|
| 悬停 | `:hover` | `--bg-hover` 背景 + `--fg` 文字 |
| 按下 | `:active` | `--accent-soft` 背景 + `--accent-bright` 图标 |
| 焦点 | `:focus-visible` | 2px `--accent` outline |
| 禁用 | `:disabled` | `opacity: 0.45` + `cursor: default` |
| 激活/选中 | `.is-active` / `.is-selected` | `--bg-active` 或 accent tint |
| 打开 | `.is-open` | `--accent-soft` 背景 |
| 进行中 | `.is-running` | `--green` 色调 |
| 错误 | `.is-error` | `--red` 色调 |
| 警告 | `.is-warning` | `--yellow` 色调 |

---

## 一、应用外壳

### 1.1 会话树（SessionPanel）

#### 现状痛点

1. **行内按钮不可发现**：`panels.styles.css:228-236` 将会话行的编辑/删除按钮默认设为 `opacity: 0`，仅在 `:hover`、`.is-active` 或 `:focus-visible` 时显示。鼠标用户必须精确悬停到行上才能发现操作入口。
2. **状态仅靠颜色圆点**：`SessionPanel.tsx:657-663` 的 `row-dot` 仅用背景色区分会话状态（红=断开、绿=连接、黄=连接中、蓝/紫=分组）。色觉障碍用户无法区分，且无文字辅助。
3. **电源按钮无进行中反馈**：`SessionPanel.tsx:746` 电源按钮在 `connecting` 时 `disabled`，但没有任何视觉指示说明"正在连接中"——按钮只是变灰。
4. **过滤无结果无引导**：`SessionPanel.tsx:841-845` 过滤无匹配时仅显示文字，没有"清除过滤"按钮或建议。
5. **SSH 连接选项可发现性差**：`SessionPanel.tsx:784-787` 使用 `<details>` 折叠 SSH 复用设置，用户不知道展开后有什么。

#### 目标交互模型

- 行内操作按钮在键盘焦点到达时立即可见（已有 `:focus-visible` 处理），鼠标悬停时以 80ms 淡入显示。
- 会话状态在颜色之外增加形状或图标编码：连接中=脉冲动画、断开=空心圆、错误=红色边框。
- 电源按钮在 connecting 时显示脉冲动画而非禁用。
- 过滤无结果时提供"清除过滤"快捷按钮。
- SSH 连接选项在首次使用时自动展开一次，之后记住用户选择。

#### 具体交互规则

**R1.1 行内按钮淡入**
```css
/* 已有规则增强：从 opacity 0 改为 opacity 0 + scale(0.9)，悬停时弹入 */
.row > .panel-action {
  opacity: 0;
  transform: scale(0.9);
  transition: opacity 80ms ease, transform 80ms ease;
}
.row:hover > .panel-action,
.row.is-active > .panel-action,
.row > .panel-action:focus-visible {
  opacity: 1;
  transform: scale(1);
}
```

**R1.2 会话状态多通道编码**
- 在 `row-dot` 旁增加状态图标（仅 connecting/error 时显示）：
  - `connecting`：黄色圆点 + 脉冲动画（`wb-pulse` keyframe 已有）
  - `error`：红色圆点 + 1px 红色外环
  - `connected`：绿色实心圆点（现状）
  - `closed`：灰色空心圆点（`border: 1px solid currentColor; background: transparent`）
- 屏幕阅读器通过 `aria-label` 或 `title` 获取状态文字。

**R1.3 电源按钮 connecting 态**
```css
.panel-power.is-connecting {
  color: var(--yellow);
  animation: wb-pulse 1.4s ease-in-out infinite;
}
.panel-power.is-connecting:disabled {
  opacity: 1; /* 覆盖默认 disabled 的 0.35 */
  cursor: default;
}
```
在 `SessionPanel.tsx` 中为电源按钮添加 `is-connecting` 类名（当 `activeTab.state === "connecting"` 时）。

**R1.4 过滤无结果引导**
在 `panel.noMatches` 文字下方添加清除按钮：
```tsx
{filtering && sections.every((section) => section.count === 0) && (
  <div className="panel-empty">
    <span>{t("panel.noMatches", { filter: filter.trim() })}</span>
    <button
      type="button"
      className="panel-empty-action"
      onClick={() => setFilter("")}
    >
      {t("panel.clearFilter")}
    </button>
  </div>
)}
```

**R1.5 SSH 选项首次展开**
在 `SessionPanel` 中增加 `useEffect`：首次渲染时如果用户从未交互过 `<details>`，则设置 `open = true`；用户手动折叠后不再自动展开。可用 `localStorage` 或 store 持久化。

#### 验收要点

- [ ] 鼠标悬停会话行时，编辑/删除按钮在 80ms 内淡入且可点击。
- [ ] Tab 键到达会话行时，行内按钮立即可见（不等悬停）。
- [ ] connecting 状态的会话，电源按钮显示黄色脉冲动画，不禁用。
- [ ] error 状态的会话，圆点有红色外环，与 connected 的绿色圆点形状可区分。
- [ ] 过滤无结果时，显示"清除过滤"按钮，点击后过滤框清空且列表恢复。
- [ ] 首次打开面板时 SSH 连接选项展开；手动折叠后刷新不再自动展开。

---

### 1.2 标签栏（TabStrip）

#### 现状痛点

1. **状态编码过于微妙**：`tabs.styles.css:403-429` 用 `font-weight: 600` + 左侧 2px 色条区分 connecting/error 状态。在 12px 字号下，weight 600 与 400 的差异很小，色条也只有 2px。
2. **关闭按钮不可发现**：`tabs.styles.css:454-465` 关闭按钮 `visibility: hidden`，仅在悬停/激活/焦点时显示。新用户不知道标签可以关闭。
3. **拖拽反馈优秀但缺文字提示**：拖拽时有 ghost、drop marker、edge scroll，反馈很好，但首次使用的用户不知道可以拖拽。

#### 目标交互模型

- 标签状态在颜色+字重之外，增加图标或更明显的形状标记。
- 关闭按钮在触屏设备始终可见（已有 `@media (pointer: coarse)`），桌面端保持悬停显示但增加 focus-visible 时的可见性（已有）。
- 拖拽功能通过首次使用的微提示引导。

#### 具体交互规则

**R1.6 标签状态增强**
- connecting：在 `tab-index` 后显示旋转的加载图标（小尺寸 spinner），替代仅靠字重。
- error：在标签前显示红色警告图标。
- 实现方式：在 `TabStrip.tsx` 的 tab 渲染中，根据 `tab.state` 条件渲染 `<Icon>`。

**R1.7 关闭按钮触屏适配（已有，确认不回退）**
- 桌面端：悬停/焦点时显示（现状保持）。
- 触屏端：始终可见（现状保持）。
- 增强：桌面端首次悬停到标签时，关闭按钮以 100ms 淡入（已有 `visibility` 切换，可加 `transition: visibility 100ms`）。

**R1.8 拖拽提示**
- 在标签栏首次出现 3 个以上标签时，在"所有会话"下拉按钮的 tooltip 中追加"可拖拽排序"提示。
- 不增加额外 UI 元素，仅增强现有 tooltip 文字。

#### 验收要点

- [ ] connecting 标签显示旋转加载图标，不依赖字重变化。
- [ ] error 标签显示红色警告图标。
- [ ] 触屏设备上关闭按钮始终可见。
- [ ] 桌面端悬停标签时关闭按钮平滑淡入。
- [ ] 3 个以上标签时，"所有会话"按钮 tooltip 包含拖拽提示。

---

### 1.3 菜单栏（MenuBar）

#### 现状痛点

1. **键盘导航模型完善**：已有 Alt/F10、方向键、Escape、Tab 的完整处理（`MenuBar.tsx:811-1027`）。这是现有实现中交互最完整的部分。
2. **窗口控制按钮无焦点环**：`MenuBar.tsx:200-215` 窗口控制按钮有 `tabIndex={0}` 和 `onMouseDown` preventDefault，但 `shell.styles.css:121-146` 没有为 `.window-control` 定义 `:focus-visible` 样式。

#### 目标交互模型

- 保持现有键盘导航模型不变。
- 为窗口控制按钮补充焦点可见性。

#### 具体交互规则

**R1.9 窗口控制按钮焦点环**
```css
.window-control:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: -2px;
}
```

#### 验收要点

- [ ] Tab 键可以到达窗口控制按钮，且焦点环清晰可见。
- [ ] 现有 Alt/F10 打开菜单、方向键导航、Escape 关闭的行为不回退。

---

### 1.4 面板停靠与分隔条（PanelDocks / Splitter）

#### 现状痛点

1. **分隔条反馈良好**：`status.styles.css:151-233` 分隔条有 hover 时的 accent 线、拖拽时的全局 cursor 覆盖、键盘焦点处理。实现质量高。
2. **面板拖拽停靠有视觉反馈**：`shell.styles.css:522-536` 有 `panel-drop-area` 和 `panel-drop-line`。

#### 目标交互模型

- 保持现状，无需重大修改。

#### 具体交互规则

**R1.10 面板头部拖拽光标**
- 面板头部（`panel-header`）作为拖拽手柄时，添加 `cursor: grab`，拖拽中变为 `grabbing`（参考 `shell.styles.css:517-520` 的 `dock-slot.is-dragging` 模式）。

#### 验收要点

- [ ] 悬停面板头部时显示 grab 光标。
- [ ] 拖拽面板时全局显示 grabbing 光标。

---

## 二、Sender 面板

### 2.1 紧凑模式（SenderQuickbar）

#### 现状痛点

1. **命令标签无发送中反馈**：`SenderQuickbar.tsx:79-100` 命令标签在 `running` 时 `disabled`，但仅靠 `sender-command-load:disabled` 的 `cursor: default`（`sender.styles.css:655-657`）表示，没有视觉变化说明"正在发送中，暂时不可点击"。
2. **快捷栏溢出无提示**：`sender.styles.css:20-33` 快捷标签区域 `overflow-x: auto` 且隐藏滚动条，但没有边缘渐隐或"更多"提示（虽然有"更多"按钮，但用户不知道快捷栏可以横向滚动）。
3. **停止按钮出现/消失突兀**：`SenderQuickbar.tsx:138-148` 停止按钮仅在 `running` 时渲染，出现和消失都是瞬间的，没有过渡动画。
4. **重复定时器状态不够明显**：`SenderQuickbar.tsx:149-159` 定时器按钮在 `schedule` 存在时显示，用 `is-running` 类（绿色），但用户可能不理解绿色手表图标的含义。

#### 目标交互模型

- 发送中：命令标签显示脉冲动画 + tooltip 说明"正在发送"。
- 快捷栏溢出：左右边缘渐隐提示（参考 TabStrip 的 fade 模式）。
- 停止按钮：以 140ms 淡入动画出现。
- 定时器状态：绿色 + 脉冲点，tooltip 显示下次发送倒计时。

#### 具体交互规则

**R2.1 发送中命令标签反馈**
```css
.sender-quick-tag .sender-command-load:disabled {
  cursor: default;
  opacity: 0.6;
  position: relative;
}
/* 发送中：左侧显示脉冲条 */
.sender-quick-tag.is-sending .sender-command-load::before {
  content: "";
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: 2px;
  background: var(--green);
  animation: wb-pulse 1.4s ease-in-out infinite;
}
```
在 `SenderQuickbar.tsx` 中为正在发送的命令标签添加 `is-sending` 类名。需要 `useSenderSend` hook 暴露当前正在发送的命令 ID。

**R2.2 快捷栏边缘渐隐**
```css
.sender-quickbar {
  position: relative;
}
.sender-quick-tags {
  /* 已有 overflow-x: auto */
  mask-image: linear-gradient(
    to right,
    transparent 0,
    black 12px,
    black calc(100% - 12px),
    transparent 100%
  );
}
```
注意：`mask-image` 在 WebKit 中需要 `-webkit-mask-image` 前缀。或者使用更简单的方案：在快捷栏容器上监听 scroll 事件，动态添加 `can-scroll-left` / `can-scroll-right` 类名，用 `::before` / `::after` 伪元素显示渐隐（参考 TabStrip 的 `tabstrip-fade-left` 模式）。

**R2.3 停止按钮淡入**
```css
.sender-quick-button.is-stop {
  animation: sender-fade-in 140ms cubic-bezier(0.2, 0, 0, 1);
}
@keyframes sender-fade-in {
  from { opacity: 0; transform: scale(0.95); }
  to { opacity: 1; transform: scale(1); }
}
```

**R2.4 定时器状态增强**
- 在 `is-running` 的手表图标前增加一个脉冲圆点（复用 `wb-pulse` 动画）。
- tooltip 中显示"下次发送：N 秒后"（需要 `useSenderSend` 暴露 `schedule.nextAt` 和当前时间）。

#### 验收要点

- [ ] 发送中时，对应命令标签显示左侧绿色脉冲条，且 tooltip 说明"正在发送"。
- [ ] 快捷栏内容溢出时，左右边缘有渐隐效果。
- [ ] 停止按钮以 140ms 淡入动画出现，消失时同理。
- [ ] 定时器运行时，按钮显示脉冲圆点，tooltip 显示下次发送时间。

---

### 2.2 展开模式（SenderPanel）

#### 现状痛点

1. **发送无进度反馈**：`SenderPanel.tsx:304-324` 发送按钮在 `running` 时变为停止按钮，但多行命令逐行发送时，用户不知道当前发送到第几行、还剩几行。
2. **命令库空状态无引导**：`SenderLibrary.tsx:73-74` 空状态仅显示 `emptyMessage` 文字，没有引导用户创建第一个命令。
3. **保存范围选择不够直观**：`SenderPanel.tsx:419-442` 保存时弹出范围选择菜单（radio），但用户可能不理解"范围"的含义——是保存到哪个层级？
4. **编辑状态反馈不足**：`SenderPanel.tsx:362-384` 编辑模式下按钮变为"更新"和"取消"，但命令输入框本身没有视觉变化说明"正在编辑已保存的命令"。

#### 目标交互模型

- 发送中：在发送按钮旁显示"第 N/M 行"的进度文字。
- 空状态：显示引导文字 + "新建命令"按钮。
- 保存范围：在选择菜单中增加说明文字（如"保存到：当前会话 / 所有 SSH 会话 / 全局"）。
- 编辑模式：命令输入框边框变为虚线 + accent 色，明确表示编辑状态。

#### 具体交互规则

**R2.5 发送进度反馈**
在 `SenderPanel.tsx` 的 `sender-compose` 区域，当 `running` 且命令包含多行时，在发送按钮左侧显示进度文字：
```tsx
{running && totalLines > 1 && (
  <span className="sender-progress" role="status">
    {t("sender.sendingLine", { current: currentLine, total: totalLines })}
  </span>
)}
```
需要 `useSenderSend` hook 暴露 `currentLine` 和 `totalLines`。

**R2.6 命令库空状态引导**
```tsx
{pageCommands.length === 0 ? (
  <div className="sender-library-empty">
    <p>{emptyMessage}</p>
    <button
      type="button"
      className="sender-save-btn"
      onClick={openComposer}
    >
      {t("sender.createFirst")}
    </button>
  </div>
) : (
  // ... 现有标签渲染
)}
```

**R2.7 保存范围菜单增强**
在 `SenderPanel.tsx:424-431` 的范围菜单中，为每个选项增加描述性后缀：
```tsx
...chain.map((scope) => ({
  label: `${labelOf(scope)}${describeScope(scope)}`,
  checked: sameScope(scope, preselected),
  mark: "radio" as const,
  action: () => pickSaveScope(scope),
})),
```
其中 `describeScope` 根据 scope 类型返回：
- profile: "（仅此会话）"
- group: "（此分组）"
- kind: "（所有同类会话）"
- global: "（全局）"

**R2.8 编辑模式视觉反馈**
```css
.sender-command textarea.is-editing {
  border-style: dashed;
  border-color: var(--accent);
}
```
在 `SenderPanel.tsx:266` 的 textarea 上添加 `className={editing ? "is-editing" : ""}`。

#### 验收要点

- [ ] 多行命令发送时，显示"第 N/M 行"进度文字。
- [ ] 命令库为空时，显示引导文字和"新建命令"按钮。
- [ ] 保存范围菜单中，每个选项有描述性后缀说明适用范围。
- [ ] 编辑模式下，命令输入框边框为虚线 + accent 色。

---

### 2.3 重复定时器（SenderRepeat）

#### 现状痛点

1. **定时器运行状态信息密度低**：`SenderRepeat.tsx:38-56` 运行时显示一行文字（重复内容、频率、已发送次数、下次时间），但文字较长，在窄面板中可能溢出。
2. **定时器参数无实时验证反馈**：`SenderRepeat.tsx:60-85` 频率和次数输入框没有实时验证（如频率过低时警告）。

#### 目标交互模型

- 运行时状态用紧凑的图标 + 数字展示，详细信息通过 tooltip 提供。
- 参数输入有实时验证反馈。

#### 具体交互规则

**R2.9 定时器运行状态紧凑化**
将运行时的一行文字改为：
```tsx
<span className="sender-repeat-text">
  <Icon name="watch" />
  <code>{firstLine(schedule.spec.text)}</code>
  <span className="sender-repeat-count">
    {schedule.sent}{schedule.spec.times > 0 ? `/${schedule.spec.times}` : ""}
  </span>
  {schedule.nextAt !== null && (
    <span className="sender-repeat-next">
      {t("sender.nextIn", { seconds: Math.max(0, Math.ceil((schedule.nextAt - now) / 1000)) })}
    </span>
  )}
</span>
```

**R2.10 参数验证**
在频率输入框旁显示验证提示：
```tsx
{repeat.every < 5 && (
  <span className="sender-repeat-warning">{t("sender.everyTooFast")}</span>
)}
```

#### 验收要点

- [ ] 定时器运行时，状态信息紧凑显示，不溢出窄面板。
- [ ] 频率设置过低时，显示警告提示。

---

## 三、Filer 面板

### 3.1 工具栏与路径栏

#### 现状痛点

1. **离线状态工具理由此不明显**：`FilerPanel.tsx:658-663` 上传/下载按钮在非远程时 disabled，tooltip 显示"connected SSH sessions only"，但按钮本身只是变灰，用户不知道为什么不能用。
2. **路径输入框无自动补全**：`FilerPanel.tsx:760-767` 路径输入框需要手动输入完整路径，没有 Tab 补全或历史记录。
3. **面包屑在深路径时溢出**：`filer.styles.css:99-114` 面包屑 `overflow-x: auto` 且隐藏滚动条，但深路径时用户看不到完整路径。

#### 目标交互模型

- 离线时，上传/下载按钮显示黄色警告图标 + tooltip 说明原因。
- 路径输入框支持 Tab 补全（基于当前目录列表）。
- 面包屑溢出时，中间段折叠为"…"按钮，点击展开完整路径。

#### 具体交互规则

**R3.1 离线按钮状态增强**
```css
.filer-action.is-offline {
  color: var(--yellow);
  opacity: 0.6;
}
.filer-action.is-offline:hover {
  background: color-mix(in srgb, var(--yellow) 12%, transparent);
}
```
在 `FilerPanel.tsx` 中为离线时的上传/下载按钮添加 `is-offline` 类名。

**R3.2 路径输入 Tab 补全**
在路径输入框的 `onKeyDown` 中处理 Tab 键：
```tsx
onKeyDown={(event) => {
  if (event.key === "Enter") void load(draft);
  if (event.key === "Escape") setDraft(path);
  if (event.key === "Tab") {
    event.preventDefault();
    // 基于当前目录列表补全
    const matches = entries.filter((e) => e.name.startsWith(lastSegment(draft)));
    if (matches.length === 1) {
      setDraft(joinPath(dirname(draft), matches[0].name));
    }
  }
}}
```

**R3.3 面包屑折叠**
当面包屑超过容器宽度时，中间段折叠：
```tsx
{breadcrumbs.length > 4 && (
  <>
    <button className="filer-crumb" onClick={() => void load(breadcrumbs[0].target)}>
      {breadcrumbs[0].label}
    </button>
    <span className="filer-crumb-separator">›</span>
    <button className="filer-crumb filer-crumb-more" title={breadcrumbs.slice(1, -2).map(s => s.target).join("\n")}>
      …
    </button>
    <span className="filer-crumb-separator">›</span>
    {/* 最后两级 */}
  </>
)}
```

#### 验收要点

- [ ] 离线时，上传/下载按钮显示黄色色调，悬停时背景为黄色 tint。
- [ ] 路径输入框按 Tab 键可补全目录名。
- [ ] 深路径时，面包屑中间段折叠为"…"，悬停显示完整路径。

---

### 3.2 文件列表

#### 现状痛点

1. **键盘导航完善**：`FilerPanel.tsx:475-606` 已有完整的方向键、Home/End、PageUp/Down、F2、Delete、Enter、ContextMenu 键盘导航。这是现有实现中键盘支持最完善的部分。
2. **文件类型仅靠图标**：`filerPresentation.tsx` 的 `FilerEntryIcon` 用不同图标区分文件类型，但色觉障碍用户可能难以区分某些颜色编码的图标。
3. **拖放反馈优秀**：`useFilerDrag` 有完整的拖放状态处理（accept/blocked/reason），面板有 `is-drag-over` / `is-drag-blocked` 视觉反馈。

#### 目标交互模型

- 保持现有键盘导航不变。
- 文件类型图标增加文字辅助（通过 `title` 或 `aria-label`）。
- 拖放反馈保持现状。

#### 具体交互规则

**R3.4 文件类型图标辅助**
确保每个文件图标有 `title` 或 `aria-label` 说明文件类型：
```tsx
<FilerEntryIcon
  name={entry.name}
  isDir={entry.isDir}
  theme={theme}
  title={entry.isDir ? t("filer.folder") : t("filer.file")}
/>
```

#### 验收要点

- [ ] 悬停文件图标时，tooltip 显示文件类型（文件夹/文件/符号链接）。
- [ ] 现有键盘导航（方向键、F2、Delete、Enter 等）行为不回退。

---

### 3.3 空状态与错误状态

#### 现状痛点

1. **空状态处理完善**：`FilerPanel.tsx:878-921` 已有 offline（含重连按钮）、error（含重试按钮）、空文件夹、加载中四种状态。实现质量高。
2. **加载状态不够明显**：`FilerPanel.tsx:918-920` 加载中仅显示文字"加载中"，没有 spinner 或骨架屏。

#### 目标交互模型

- 保持现有四种状态不变。
- 加载中增加 spinner 动画。

#### 具体交互规则

**R3.5 加载中 spinner**
```tsx
{!offlineReason && !error && entries.length === 0 && creating === null && (
  <div className="panel-empty" role={busy ? "status" : undefined}>
    {busy ? (
      <>
        <span className="filer-spinner" aria-hidden="true" />
        {t("filer.loading")}
      </>
    ) : (
      t("filer.emptyFolder")
    )}
  </div>
)}
```
```css
.filer-spinner {
  display: inline-block;
  width: 14px;
  height: 14px;
  margin-right: 8px;
  border: 2px solid var(--border-strong);
  border-top-color: var(--accent);
  border-radius: 50%;
  animation: update-spin 0.8s linear infinite;
  vertical-align: middle;
}
```

#### 验收要点

- [ ] 加载中时，显示旋转 spinner + "加载中"文字。
- [ ] 离线、错误、空文件夹状态的行为和视觉不回退。

---

### 3.4 传输状态

#### 现状痛点

1. **传输进度条在底部，容易被忽略**：`FilerPanel.tsx:998-1104` 传输进度条在面板底部，小尺寸显示。用户可能不知道有传输在进行。
2. **传输摘要条可发现性差**：`FilerTransferSummary.tsx:24-33` 传输摘要条在列表和底部之间，只有有传输时才出现，用户可能不知道它的存在。
3. **暂停/继续/取消/重试按钮小巧**：`filer.styles.css:666-672` 传输操作按钮只有 20px，在密集的底部区域可能难以点击。

#### 目标交互模型

- 传输进行中时，在 Filer 面板标题栏显示一个小的进度指示器（如标题旁的数字百分比）。
- 传输摘要条在首次出现时以 140ms 淡入（已有 `filer-fade-in` 动画）。
- 传输操作按钮保持 20px 但确保有足够的间距。

#### 具体交互规则

**R3.6 面板标题传输指示器**
在 `FilerPanel.tsx:619-625` 的面板标题中，当有活跃传输时显示进度：
```tsx
<div className="panel-title is-filer">
  <Icon name="folder" />
  {t("panel.filer")}
  <span className="panel-badge">
    {remote || offline ? tab?.info.protocol : t("filer.local")}
  </span>
  {transfer && (
    <span className="panel-badge is-transfer" title={transfer.name}>
      {transferPercent !== null ? `${transferPercent}%` : t("filer.transferring")}
    </span>
  )}
</div>
```

**R3.7 传输摘要条增强**
在 `FilerTransferSummary.tsx` 中，当有失败传输时，摘要条文字变为红色：
```tsx
const label = t("filer.transferQueueSummary", counts)
  + (counts.paused ? t("filer.transferQueuePaused", { count: counts.paused }) : "")
  + (counts.failed ? t("filer.transferQueueFailed", { count: counts.failed }) : "");
// 在 button 的 className 中根据 counts.failed 添加 is-error
```

#### 验收要点

- [ ] 传输进行中时，Filer 面板标题栏显示进度百分比或"传输中"。
- [ ] 传输摘要条在首次出现时淡入。
- [ ] 有失败传输时，摘要条文字为红色。

---

## 四、状态栏（StatusBar）

#### 现状痛点

1. **状态消息可能被忽略**：`StatusBar.tsx:75-93` 状态消息在左侧，有 `role="status"` 或 `role="alert"` 和 `aria-live="polite"`，但视觉上只是文字，成功和普通状态没有区别。
2. **错误状态有 dismiss 按钮但成功状态没有自动消失**：`StatusBar.tsx:82-92` 错误有手动 dismiss 按钮，但成功消息会一直显示直到下一条消息覆盖。
3. **资源监控/转发/传输按钮的展开状态反馈不够明显**：`status.styles.css:89-91` 展开时背景为 `--bg-active`，但与其他状态的区分度不够。

#### 目标交互模型

- 成功消息显示 3 秒后自动淡出（或直到用户交互）。
- 错误消息保持显示直到手动 dismiss。
- 资源监控等按钮展开时，增加图标旋转或边框高亮。

#### 具体交互规则

**R4.1 成功消息自动消失**
在 `StatusBar.tsx` 中增加 `useEffect`：当 `status` 非空且 `error` 为空时，3 秒后清除 status。
```tsx
useEffect(() => {
  if (!status || error) return;
  const timer = setTimeout(() => setStatus(""), 3000);
  return () => clearTimeout(timer);
}, [status, error, setStatus]);
```
注意：需要 store 暴露 `setStatus`。如果 store 的 `setStatus` 不接受空字符串，需要添加一个 `clearStatus` action。

**R4.2 成功/错误视觉区分**
```css
.status-message:not(.is-error) .status-message-text {
  color: var(--fg-dim);
}
.status-message.is-error .status-message-text {
  color: var(--red);
  font-weight: 500;
}
```

**R4.3 展开按钮状态增强**
```css
button.status-item[aria-expanded="true"] {
  background: var(--bg-active);
  box-shadow: inset 0 0 0 1px var(--accent);
}
```

#### 验收要点

- [ ] 成功消息显示 3 秒后自动消失。
- [ ] 错误消息保持显示，有红色色调和手动 dismiss 按钮。
- [ ] 资源监控/转发/传输按钮展开时，有 accent 色边框。

---

## 五、对话框

### 5.1 通用对话框行为（ModalDialog）

#### 现状痛点

1. **焦点管理完善**：`ModalDialog.tsx` 有完整的焦点管理（初始焦点、焦点返回、Tab 包含、Escape 处理、背景点击区分）。这是现有实现中质量最高的部分。
2. **对话框无"进行中"状态**：所有对话框的提交按钮没有 loading 状态——点击后按钮禁用，但没有 spinner 或文字变化说明"正在处理"。
3. **对话框出现/消失动画一致**：`dialogs.styles.css:155` 有 140ms 的 `dialog-in` 动画，但消失时没有动画。

#### 目标交互模型

- 保持现有焦点管理不变。
- 提交按钮增加 loading 状态（spinner + 禁用）。
- 对话框消失时增加淡出动画。

#### 具体交互规则

**R5.1 提交按钮 Loading 状态**
为 `.btn.is-primary` 增加 loading 变体：
```css
.btn.is-loading {
  color: transparent;
  pointer-events: none;
  position: relative;
}
.btn.is-loading::after {
  content: "";
  position: absolute;
  inset: 0;
  margin: auto;
  width: 14px;
  height: 14px;
  border: 2px solid var(--accent-contrast);
  border-top-color: transparent;
  border-radius: 50%;
  animation: update-spin 0.8s linear infinite;
}
```
在各对话框的提交处理中，点击后立即添加 `is-loading` 类名，完成或失败后移除。

**R5.2 对话框消失动画**
```css
.dialog-backdrop {
  transition: opacity 100ms ease;
}
dialog.dialog-backdrop:not([open]) {
  opacity: 0;
  pointer-events: none;
}
```
注意：这需要 `ModalDialog` 在关闭时先播放动画再移除 `open` 属性。当前实现是直接移除，需要增加一个 closing 状态。这是一个较大的改动，可以作为后续优化。

#### 验收要点

- [ ] 对话框提交按钮点击后显示 spinner，防止重复提交。
- [ ] 现有焦点管理（Tab 包含、Escape、焦点返回）行为不回退。

---

### 5.2 确认对话框（CloseSessionDialog / DeleteEntryDialog）

#### 现状痛点

1. **安全焦点设计优秀**：`CloseSessionDialog.tsx:47` 和 `DeleteEntryDialog.tsx:61` 都使用 `initialFocus=".btn:not(.is-danger)"`，确保取消按钮获得初始焦点，防止误操作。这是最佳实践。
2. **键盘提示清晰**：两个对话框都在 footer 显示 `<kbd>Esc</kbd> 取消` 提示。
3. **批量操作列表展示合理**：`CloseSessionDialog.tsx:38` 超过 6 个标签时汇总显示。

#### 目标交互模型

- 保持现有安全焦点设计不变。
- 批量删除时，在确认对话框中显示将删除的文件数量预估。

#### 具体交互规则

**R5.3 批量删除数量提示**
在 `DeleteEntryDialog.tsx` 中，当 `multiple` 时，在 hint 中显示更具体的后果：
```tsx
<span className="confirm-dialog-hint">
  {multiple
    ? t("deleteEntry.hintMany", { count: entries.length })
    : hint}
</span>
```
确保 `deleteEntry.hintMany` 的文案包含数量信息（如"将删除 N 个条目，此操作不可撤销"）。

#### 验收要点

- [ ] 确认对话框打开时，取消按钮自动获得焦点。
- [ ] 批量删除对话框显示将删除的条目数量。
- [ ] Esc 键和取消按钮的行为不回退。

---

### 5.3 快捷键对话框（ShortcutsDialog）

#### 现状痛点

1. **录制模式反馈清晰**：`ShortcutsDialog.tsx:118-134` 录制中按钮显示"按下按键..."文字 + accent 色边框 + `is-recording` 类。
2. **冲突检测完善**：`ShortcutsDialog.tsx:61-75` 有冲突检测和提示。
3. **重置默认按钮位置合理**：`dialogs.styles.css:923-925` 重置按钮在 footer 左侧（`margin-right: auto`）。

#### 目标交互模型

- 保持现状，无需重大修改。

#### 具体交互规则

**R5.4 录制中禁用其他交互**
在录制模式下，给对话框添加 `is-recording` 类名，禁用除录制按钮外的所有交互：
```css
.shortcuts-dialog.is-recording .shortcut-row:not(.is-recording) {
  opacity: 0.5;
  pointer-events: none;
}
```

#### 验收要点

- [ ] 录制模式下，其他行变灰且不可点击。
- [ ] 现有冲突检测和重置行为不回退。

---

## 六、Workbench 实验台

### 6.1 资源管理器（ExplorerPanel）

#### 现状痛点

1. **文件树无键盘导航**：`ExplorerPanel.tsx:202-241` 的 `renderDir` 渲染目录和文件按钮，但没有方向键导航——用户只能用 Tab 逐个按钮切换，效率极低。
2. **文件行操作按钮不可发现**：`workbench.styles.css:809-818` 文件行的比较按钮 `opacity: 0`，仅在悬停或聚焦时显示。
3. **未连接状态提示简单**：`ExplorerPanel.tsx:90-91` 未连接时仅显示"请连接"文字，没有引导用户如何连接。
4. **Git 更改列表无键盘导航**：`ExplorerPanel.tsx:140-162` Git 更改行是按钮，但同样缺少方向键导航。

#### 目标交互模型

- 文件树支持方向键导航（上下移动、左右展开/折叠、Enter 打开）。
- 文件行操作按钮在键盘焦点到达时可见（已有 `:focus` 处理）。
- 未连接时，提示文字旁增加"连接"按钮。
- Git 更改列表支持方向键导航。

#### 具体交互规则

**R6.1 文件树键盘导航**
将 `wb-tree` 改为 `role="tree"` + `aria-activedescendant` 模式（参考 SessionPanel 的实现）：
```tsx
<div
  className="wb-tree"
  role="tree"
  aria-activedescendant={activeId ?? undefined}
  tabIndex={0}
  onKeyDown={onTreeKeyDown}
>
```
键盘处理：
- `ArrowUp` / `ArrowDown`：移动活跃行
- `ArrowRight`：展开目录或进入子目录
- `ArrowLeft`：折叠目录或返回父目录
- `Enter`：打开文件或切换目录展开
- `Home` / `End`：跳到第一个/最后一个可见行

**R6.2 未连接引导**
```tsx
{!connected ? (
  <div className="wb-explorer-note">
    <p>{t("wb.connectHint")}</p>
    <button
      type="button"
      className="wb-quickopen-retry"
      onClick={() => void refreshFiles(workspace.id)}
    >
      {t("common.retry")}
    </button>
  </div>
) : /* ... */}
```

**R6.3 文件行操作按钮焦点可见**
```css
.wb-row-action {
  opacity: 0;
  transition: opacity 80ms ease;
}
.wb-file-row:hover .wb-row-action,
.wb-row-action:focus-visible {
  opacity: 1;
}
```

#### 验收要点

- [ ] 文件树中按上下方向键可移动活跃行，当前行有视觉高亮。
- [ ] 按右方向键展开目录，左方向键折叠。
- [ ] 按 Enter 打开文件。
- [ ] 未连接时，显示"重试"按钮。
- [ ] Tab 到达文件行时，比较按钮立即可见。

---

### 6.2 运行控制台（RunConsole）

#### 现状痛点

1. **日志无搜索功能**：`RunConsole.tsx:276-293` 日志视图是纯 `<pre>` 显示，没有搜索或过滤功能。长日志中查找特定内容困难。
2. **stale 检测反馈良好**：`RunConsole.tsx:112-114` 有 30 秒 stale 检测，显示黄色警告。
3. **运行状态 pill 清晰**：`RunConsole.tsx:119-122` 状态 pill 有颜色编码 + 文字 + 脉冲点。
4. **日志跟随逻辑完善**：`RunConsole.tsx:92-96` 有自动跟随滚动，用户手动滚动时停止跟随。

#### 目标交互模型

- 日志视图增加搜索功能（Ctrl+F 打开搜索框，高亮匹配项）。
- 保持现有 stale 检测和跟随逻辑。

#### 具体交互规则

**R6.4 日志搜索**
在日志视图头部添加搜索按钮：
```tsx
<div className="wb-log-head">
  <span>{t("wb.runConsole")}</span>
  <span>{log ? transferBytes(log.length) : "0 B"}</span>
  <button
    type="button"
    className="wb-icon-button"
    title={t("wb.searchLog")}
    onClick={() => setLogSearchOpen(true)}
  >
    <Icon name="search" />
  </button>
</div>
{logSearchOpen && (
  <div className="wb-log-search">
    <input
      autoFocus
      value={logQuery}
      onChange={(e) => setLogQuery(e.target.value)}
      placeholder={t("wb.searchInLog")}
    />
    <span>{matchCount > 0 ? `${matchIndex + 1}/${matchCount}` : t("search.noResults")}</span>
    <button onClick={() => setLogSearchOpen(false)}><Icon name="close" /></button>
  </div>
)}
```
搜索时高亮匹配行：
```tsx
<pre className="wb-log-view">
  {log.split("\n").map((line, i) => (
    <div
      key={i}
      className={line.toLowerCase().includes(logQuery.toLowerCase()) && logQuery ? "is-match" : ""}
    >
      {line}
    </div>
  ))}
</pre>
```

#### 验收要点

- [ ] 日志视图头部有搜索按钮，点击后显示搜索框。
- [ ] 搜索时匹配行高亮显示。
- [ ] 显示"当前/总数"匹配计数。
- [ ] 现有自动跟随滚动和 stale 检测行为不回退。

---

### 6.3 快速打开（QuickOpen）

#### 现状痛点

1. **键盘导航完善**：`QuickOpen.tsx:50-64` 有上下方向键、Enter、Escape 处理。
2. **空状态处理合理**：`QuickOpen.tsx:77-88` 有加载中、无结果、错误+重试三种状态。
3. **结果无分组**：`QuickOpen.tsx:89-102` 所有结果平铺显示，没有按目录分组或按修改时间排序。

#### 目标交互模型

- 保持现有键盘导航和空状态处理。
- 结果按目录分组显示，增强可扫描性。

#### 具体交互规则

**R6.5 结果分组**
```tsx
const grouped = useMemo(() => {
  const groups = new Map<string, string[]>();
  for (const path of results) {
    const dir = path.split("/").slice(0, -1).join("/") || "/";
    if (!groups.has(dir)) groups.set(dir, []);
    groups.get(dir)!.push(path);
  }
  return groups;
}, [results]);
```
渲染时按目录分组，每组前显示目录名标题。

#### 验收要点

- [ ] 搜索结果按目录分组显示。
- [ ] 现有键盘导航（上下、Enter、Escape）行为不回退。

---

### 6.4 Workbench 整体空状态

#### 现状痛点

1. **无项目时无引导**：Workbench 打开时如果没有项目，侧边栏为空，没有引导用户创建项目。
2. **编辑器空状态有但简单**：`workbench.styles.css:1119-1152` 有 `wb-editor-empty` 和 `wb-onboarding` 样式，但需要确认实际使用情况。

#### 目标交互模型

- 无项目时，侧边栏显示"创建项目"按钮。
- 编辑器空状态显示引导文字 + 快捷操作。

#### 具体交互规则

**R6.6 无项目引导**
在 `ProjectSidebar.tsx` 中，当项目列表为空时：
```tsx
{projects.length === 0 ? (
  <div className="wb-sidebar-note">
    <p>{t("wb.noProjects")}</p>
    <button
      type="button"
      className="wb-quickopen-retry"
      onClick={onCreateProject}
    >
      {t("wb.createProject")}
    </button>
  </div>
) : (
  // ... 现有项目列表
)}
```

#### 验收要点

- [ ] 无项目时，侧边栏显示"创建项目"按钮。
- [ ] 点击按钮后打开项目创建对话框。

---

## 七、横切关注点

### 7.1 键盘可达性总检查

#### 现有快捷键体系（不得破坏）

| 命令 | macOS | Windows/Linux |
|------|-------|---------------|
| 新建会话 | ⌘N | Alt+N |
| 关闭会话 | ⌘W | Ctrl+Shift+W |
| 查找 | ⌘F | Ctrl+Shift+F |
| 查找下一个 | ⌘G | Ctrl+Shift+G |
| 清除 | ⌘K | Alt+K |
| 显示终端目录 | ⌘J | Ctrl+Shift+J |
| 上一个/下一个标签 | ⌘[ / ⌘] | Alt+[ / Alt+] |
| 右/下分屏 | ⌘\ / ⌘⇧\ | Ctrl+Shift+\ / Ctrl+Alt+\ |
| 上一个/下一个窗格 | ⌘⌥[ / ⌘⌥] | Ctrl+Alt+[ / Ctrl+Alt+] |
| 复制/粘贴/全选 | ⌘C / ⌘V / ⌘A | Ctrl+Shift+C / Ctrl+Shift+V / Ctrl+Shift+A |
| 切换面板 | ⌘⌥← / ⌘⌥→ / ⌘⌥↓ | Ctrl+Alt+← / Ctrl+Alt+→ / Ctrl+Alt+↓ |
| 焦点区域循环 | F6 | F6 |
| 切换到标签 N | ⌘1-9 | Alt+1-9 |

#### 本规范新增的键盘交互（不冲突）

| 位置 | 按键 | 行为 |
|------|------|------|
| Filer 路径输入框 | Tab | 目录名补全 |
| Workbench 文件树 | ↑/↓/←/→/Enter | 树导航 |
| Workbench 日志 | Ctrl+F | 打开日志搜索 |

#### 验收要点

- [ ] 所有现有快捷键行为不回退。
- [ ] 新增键盘交互不与现有快捷键冲突。
- [ ] 所有新增交互元素可通过 Tab 键到达且有可见焦点环。

---

### 7.2 i18n 兼容性

#### 要求

- 所有新增 UI 文字必须通过 `useT()` hook 获取，不得硬编码。
- 新增文案需要同时添加到 `src/locales/en.ts` 和 `src/locales/zhCN.ts`。
- 文案长度变化不应破坏布局（使用 `text-overflow: ellipsis` 或 `overflow-wrap: anywhere`）。

#### 本规范需要新增的 i18n key

```
panel.clearFilter
sender.createFirst
sender.sendingLine
sender.everyTooFast
filer.folder (确认已有)
filer.file (确认已有)
wb.searchLog
wb.searchInLog
wb.noProjects
wb.createProject
```

#### 验收要点

- [ ] 所有新增文字通过 `useT()` 获取。
- [ ] 英文和中文语言包都包含新增 key。
- [ ] 切换到中文后，新增文字正确显示。

---

### 7.3 无障碍属性增强

#### 要求

- 所有新增交互元素必须有适当的 ARIA 属性（`role`、`aria-label`、`aria-expanded`、`aria-pressed` 等）。
- 动态内容变化必须通过 `aria-live` 区域通知屏幕阅读器。
- 颜色不能作为唯一的状态编码方式（必须配合图标、文字或形状）。

#### 本规范涉及的 ARIA 增强

| 位置 | 增强 |
|------|------|
| Sender 发送进度 | `role="status"` + `aria-live="polite"` |
| Filer 标题传输指示器 | `role="status"` |
| Workbench 文件树 | `role="tree"` + `aria-activedescendant` |
| Workbench 日志搜索 | `role="search"` |
| 会话状态圆点 | `aria-label` 或 `title` 说明状态 |

#### 验收要点

- [ ] 所有新增交互元素有正确的 ARIA 属性。
- [ ] 屏幕阅读器可以获取所有状态信息。
- [ ] 颜色不是唯一的状态编码方式。

---

### 7.4 性能约束

#### 要求

- 所有动画使用 CSS transform/opacity，不触发 layout。
- 动画时长不超过 200ms（现有体系已遵守）。
- `prefers-reduced-motion: reduce` 时禁用所有动画。
- 新增的 `useEffect` 必须有正确的 cleanup。

#### 验收要点

- [ ] 所有动画使用 transform/opacity。
- [ ] `prefers-reduced-motion: reduce` 时动画禁用。
- [ ] 无内存泄漏（所有 effect 有 cleanup）。

---

## 附录：实施优先级

| 优先级 | 项目 | 原因 |
|--------|------|------|
| P0 | R1.2 会话状态多通道编码 | 色觉障碍用户无法使用 |
| P0 | R2.1 发送中命令标签反馈 | 核心功能状态不明 |
| P0 | R6.1 文件树键盘导航 | 键盘用户无法高效使用 |
| P1 | R1.1 行内按钮淡入 | 可发现性基础 |
| P1 | R2.5 发送进度反馈 | 多行发送体验差 |
| P1 | R3.1 离线按钮状态增强 | 用户困惑为什么不能用 |
| P1 | R5.1 提交按钮 Loading | 防止重复提交 |
| P2 | R1.4 过滤无结果引导 | 空状态优化 |
| P2 | R2.6 命令库空状态引导 | 空状态优化 |
| P2 | R3.5 加载中 spinner | 加载反馈 |
| P2 | R6.4 日志搜索 | 功能增强 |
| P3 | R1.8 拖拽提示 | 微优化 |
| P3 | R2.9 定时器状态紧凑化 | 信息密度优化 |
| P3 | R6.5 快速打开分组 | 可扫描性优化 |
