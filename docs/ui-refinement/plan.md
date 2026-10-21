# EdgeTerm 界面精修 · 合并实施计划

> 角色：Lead（协调与合并）。输入：`visual-spec.md`（视觉）、`interaction-spec.md`（体验）、`engineering-notes.md`（工程）。
> 用户已确认：全应用精修（外壳 / Sender / Filer / 状态栏 / 对话框 / Workbench），深度=现有 token 体系上的组件级精修，不重设计、不新增主题、不引入依赖。
> 日期：2026-10-20。

---

## 0. 合并决策记录（Lead 裁定）

| # | 议题 | 裁定 | 理由 |
|---|------|------|------|
| D1 | 标签状态编码：UX R1.6 要 spinner/警告图标 vs 视觉 §2.4 要 2px 状态边+字重 | **采视觉方案**，R1.6 暂缓 | 状态边可跨越滚动与 label 省略号存活；非文字标记只需 3:1；每 tab 常驻 spinner 有动画成本 |
| D2 | 标签斜体表「空闲」 | **弃斜体**，空闲=fg-dim 正体 | 中文无真斜体（合成发虚）；is-connecting/is-error 切回正体造成样式跳变。可一键回退（`.tab { font-style: italic }`） |
| D3 | UX R3.2 路径 Tab 补全 / R6.4 日志搜索 / R6.5 快速打开分组 | **暂缓** | 三者是新功能而非既有界面的精修，超出「简陋→精致」范围 |
| D4 | UX R5.2 对话框消失动画 | **暂缓** | UX 自己标注为大改动（需 closing 状态机），收益/风险比低 |
| D5 | UX R1.5 SSH 选项首次自动展开 | **暂缓** | 需引入持久化状态，边际收益小 |
| D6 | UX R2.4 定时器倒计时 tooltip | **暂缓**（保留 R2.9 紧凑化） | 倒计时需持续计时器，成本高于收益 |
| D7 | UX R5.1 提交按钮 Loading | **收窄**：加 `.btn.is-loading` CSS + 仅接入 SessionDialog 作范例 | 15+ 对话框逐一接线不成比例；现有禁用态已防重复提交 |
| D8 | `.wb-count` 浅色主题不可读（约 3.1:1） | **新增 token `--warn-contrast`**（四主题同步） | 与既有 `--danger-contrast`/`--accent-contrast` 同构；备选淡底徽标会牺牲显著性 |
| D9 | UX R4.1 成功消息 3s 自动消失 | **收窄纳入**（仅成功态，错误态保持手动 dismiss） | 需 store 支持 `setStatus("")` 或新增 `clearStatus`；前端先探可行性 |
| D10 | 对话框字段模式统一（视觉 §6.2.1） | **已核实为死代码**：`.field`（dialogs.styles.css:256-271，右对齐标签 grid）在全部 tsx/ts/mjs/html 中零引用；所有对话框实际用 `.session-field`/`.wb-field`/`.sender-field`（标签均在上）。W3 改为**删除死代码**，无需迁移 |

---

## 1. 波次总览

| 波次 | 内容 | 主要文件 | 来源 |
|------|------|---------|------|
| W1 全局契约 | 间距阶梯 / 控件状态语言 / 图标阶梯 / 阴影纪律 / 颜色纪律 + `--warn-contrast` | foundation + 全部域样式文件 | 视觉 §1.1-1.5 |
| W2 外壳与主工作区 | 面板标题分隔 / SSH disclosure / 会话树 / 标签 / Sender 密度 / Filer 收尾 / 状态栏分组 + 交互项 | shell/tabs/sender/filer/status/panels + 组件 | 视觉 §2-5 + UX P0/P1 |
| W3 对话框 / Workbench / 空状态 | 对话框控件统一 / Workbench 回归主系统 / 空状态三档体系 + 交互项 | dialogs/workbench + 组件 | 视觉 §6-8 + UX 收窄项 |

每波完成后：`npm run typecheck` + `npm test`（含 themes.test.ts）+ 视觉核查；W1 额外跑 `npm run test:browser`（若浏览器可用）。

---

## 2. W1 全局契约（视觉 §1.1-1.5）

### 2.1 间距阶梯（§1.1）
- `.dialog-body` padding 14/16 → `--sp-12`/`--sp-16`；`.session-dialog-body` gap 14 → `--sp-12`；`.session-section` padding 13/14 → `--sp-12`；`.session-section-heading` margin-bottom 11 → `--sp-10`；`.font-size-dialog-body` gap 18 → `--sp-16`
- `.panel-header` padding 右 6 → `--sp-12`（与行内缩对齐）；`.filer-toolbar` padding 8 → `--sp-12`；`.sender-header .panel-title.is-sender` margin-right 10 → `--sp-8`
- 全局清除 `11px|13px|14px|5px|7px` 间距字面量（发丝线 1px 除外）

### 2.2 控件状态语言（§1.2）——本波核心
- **字段焦点统一软环**：`input/select/textarea:focus` → 边框 accent + `box-shadow 0 0 0 3px color-mix(accent 22%)`；`:focus-visible` → `outline: none`（消除 `.session-field input` 双重环 bug）；删 `.session-field` 私有 box-shadow
- **chrome 焦点统一 2px**：`.filer-action`/`.filer-crumb`/`.filer-columns button`/`.status-dismiss`/`button.status-item` 的 1px → 2px，`outline-offset: 1px`
- **disabled 统一 0.4**：`.panel-power`/`.sender-send`/`.sender-save-btn`/`.sender-pagination button`/`.filer-action`/`.btn`/`.wb-icon-button`/`.ftp-tool-button`/`.shortcut-clear` 的 0.3/0.35/0.45/0.5 → 0.4 + `cursor: default`
- **:active 补全**：`.panel-action`/`.sender-quick-button`/`.btn`/`.wb-icon-button` 按下给 `--bg-active`
- 新增 `.btn.is-loading`（spinner 伪元素，供 W3 接入）

### 2.3 图标阶梯（§1.3）
- 消灭 13px：`.wb-dir-row .icon`/`.wb-file-name .icon` 13 → 16px；`.wb-icon-button .icon` 14 → 16px
- 图标-文字间距：`.sender-command-load` gap 4 → `--sp-6`；`.menu-entry` gap 10 → `--sp-8`

### 2.4 阴影纪律（§1.4）
- `.transfer-center-popover`/`.resource-popover`/`.forward-popover` 硬编码 → `--shadow-pop`；`.term-suggest` → `--shadow-pop`

### 2.5 颜色纪律（§1.5）
- `.sender-quick-button.is-primary` → accent 实底白字（面板橙留给标题 pill）
- `.window-control.is-close:hover` → `--red` + `--danger-contrast`

### 2.6 新 token（D8）
- `foundation.styles.css` 四个主题块各加 `--warn-contrast`：dark/serialx-dark `#1f1f1f`，light/serialx-light `#ffffff`
- `.wb-count` 的 `color: #1f1f1f` → `var(--warn-contrast)`

### W1 验收
- [x] Tab 遍历任何控件只见一个焦点环；字段键盘聚焦单一软环无重影
- [x] 所有 disabled 控件 opacity 0.4；按下任何按钮有 `--bg-active`
- [x] 全局无 13px 图标、无硬编码 box-shadow（elevation 四选一）
- [x] `npm test -- src/themes.test.ts` 通过；typecheck 通过
- [x] 四主题下 `.wb-count` 可读（重点浅色主题）

### W1 复核结论（视觉专家裁决，2026-10-20）
实现放行。机械验证：typecheck exit 0、全量单测 695 通过、浏览器布局契约 71 通过、themes 5/5、`git diff --check` 干净。视觉逐条接受 10 条偏差（含 `.filer-toolbar` 窄面板权衡、workbench 私有 outline 删除）。两处随修：
1. **实底按钮 :active bug**：通用 `:active` 曾把 `.is-primary`/`.is-danger` 实底按成 `--bg-active` navy → 排除实底按钮，改 `filter: brightness(0.9)`
2. **`.filer-path input` 26→24px**（`--h-control`）：与 panel-header 36px 严格对齐（Filer 数据行本就是 `--filer-row-h` 24px，双理由成立）

可跟进非阻塞：三个状态栏 popover 的 `font-size: 12px` 应 tokenize（W2+）；`.btn.is-loading` 采用时组件必须同时置 `disabled`（W3 注意）。

---

## 3. W2 外壳与主工作区（视觉 §2-5 + UX 收窄项）

### 3.1 应用外壳（视觉 §2）
- `.panel-header` 加 1px `--border` 底边框
- SSH disclosure 面板化：隐藏默认 marker，CSS chevron（`fs-sm`/`fg-dim`，展开旋转 120ms）
- 会话树 section 呼吸：`.row.is-section` `margin-top: var(--sp-6)`（首个 section 除外）
- 标签弃斜体（D2）
- 窗口控制按钮焦点环（UX R1.9）；面板头部 grab 光标（UX R1.10）；关闭按钮 100ms 淡入（UX R1.7）

### 3.2 会话树交互（UX）
- **R1.2 状态多通道编码**（P0）：connecting=黄点+脉冲、error=红点+外环、closed=空心圆；圆点加 `aria-label`/`title`
- **R1.3** 电源按钮 connecting 脉冲不禁用
- **R1.4** 过滤无结果「清除过滤」按钮（+i18n `panel.clearFilter`）
- **R1.1** 行内按钮 80ms 淡入（opacity+scale）

### 3.3 Sender（视觉 §3 + UX）
- Quickbar 控件统一 `--h-control`（24px）；compose 行 send/repeat 升 `--h-control-lg`（28px）
- 标签 ellipsis 改 hover/focus-within 显现 + 发丝分隔；触屏常显
- 库标签去 translateY 上浮
- **R2.1 发送中标签反馈**（P0）：`is-sending` 类 + 左侧绿色脉冲条（需 `useSenderSend` 暴露当前命令 ID，前端先探可行性；不可行则降级为 tooltip 文案）
- **R2.5 发送进度**（P1）：多行发送显示「第 N/M 行」（需 hook 暴露 currentLine/totalLines；不可行则暂缓并记录）
- **R2.7** 保存范围菜单加描述后缀（+i18n）；**R2.8** 编辑模式虚线边框；**R2.9** 定时器状态紧凑化；**R2.10** 频率过低警告（+i18n `sender.everyTooFast`）
- **R2.6** 命令库空状态引导按钮（+i18n `sender.createFirst`）

### 3.4 Filer（视觉 §4 + UX）
- path 行：输入框 26 → `--h-control`（24px），padding 5 → `--sp-6`（行高严格 36px 对齐 panel-header）
- **R3.1** 离线按钮 `is-offline` 黄色调；**R3.4** 文件图标 title；**R3.6** 面板标题传输指示器；**R3.7** 传输摘要失败红色

### 3.5 状态栏（视觉 §5 + UX）
- gap 16 → `--sp-12`；会话明细包 `.status-group`（组件改动，簇内 `--sp-8`）
- **R4.1**（D9 收窄）成功消息 3s 自动消失；**R4.2** 成功/错误视觉区分；**R4.3** 展开按钮 accent 边框

### W2 验收
- [ ] Quickbar/compose 行控件同高同基线；ellipsis 默认隐藏
- [ ] connecting/error/closed 会话状态形状可区分（不依赖颜色）
- [ ] 状态栏右端会话明细成簇；成功消息 3s 消失、错误保持
- [ ] 离线上传/下载按钮有黄色调 + tooltip 原因
- [ ] typecheck + 全量单测通过

---

## 4. W3 对话框 / Workbench / 空状态（视觉 §6-8 + UX 收窄项）

### 4.1 对话框（视觉 §6）
- **删除死代码**：`.field` / `.field > label` / `.field input, .field select`（dialogs.styles.css:256-271，零引用，见 D10）
- `.btn`/`.session-field input/select` 统一 `--h-control-lg` + `radius-lg`；`.session-section` padding `--sp-12` + `radius-xl`
- **R5.1**（D7 收窄）`.btn.is-loading` 接入 SessionDialog；**R5.3** 批量删除数量提示（+i18n `deleteEntry.hintMany`）

### 4.2 Workbench 回归（视觉 §7）
- `.wb` 及 12px 字面量 → `var(--panel-font-size)`/`var(--fs)`（跟随面板字号设置）
- 圆角归队：交互控件 `radius-md`，chip/pill `radius-lg`；`.wb-tab-close` `radius-sm`
- 细节：`.wb-run-dot` 7 → 8px；`.wb-dirty-mark` → `--fs-2xs`；`.wb-editor-tab.is-active` 顶边 1 → 2px
- `.wb-count` → `--warn-contrast`（W1 已加 token）

### 4.3 空状态三档体系（视觉 §8）
- CSS：`.panel-empty` 块级基类（flex 列居中 / `--sp-8` gap / min-height 80px）+ `.panel-empty-icon`(32px) / `.panel-empty-title` / `.panel-empty-hint` / `.is-error` 红色
- 英雄态：`.term-empty` 图标 64 → 48px、标题 22px 字面量 → `calc(var(--panel-font-size) + 6px)`；`.wb-editor-empty`/`.wb-onboarding` 图标 34 → 32px、标题 → 同公式；`.ftp-session-state strong` 同
- 组件接入：`R2.6`（Sender 库）、`R6.2`（Workbench 未连接重试按钮）、`R6.6`（无项目创建按钮，+i18n `wb.noProjects`/`wb.createProject`）

### 4.4 Workbench 键盘导航（UX R6.1，P0）
- `wb-tree` 改 `role="tree"` + `aria-activedescendant` + 方向键导航（参考 SessionPanel 实现）
- 文件行操作按钮焦点可见（R6.3）

### W3 验收
- [ ] 对话框按钮/输入框同高（28px）同圆角（8px）；标签在上
- [ ] Display Settings 改面板字号，Workbench 文字随之缩放
- [ ] `.wb-count` 四主题可读
- [ ] 空状态共享 `.panel-empty` 结构；英雄态标题随字号缩放
- [ ] Workbench 文件树方向键导航可用（↑↓移动、→展开、←折叠、Enter 打开）
- [ ] typecheck + 全量单测通过

---

## 5. 暂缓清单（交付时向用户明示）

| 项 | 来源 | 暂缓理由 |
|----|------|---------|
| R3.2 路径 Tab 补全 | UX | 新功能 |
| R6.4 日志搜索 | UX | 新功能 |
| R6.5 快速打开分组 | UX | 新功能 |
| R5.2 对话框消失动画 | UX | 大改动（closing 状态机） |
| R1.5 SSH 选项自动展开 | UX | 需持久化状态 |
| R2.4 倒计时 tooltip | UX | 需持续计时器 |
| R1.6 标签状态图标 | UX | 被视觉 §2.4 状态边方案取代（D1） |

---

## 6. 验证方案

1. **每波机械验证**：`npm run typecheck` + `npm test`（themes.test.ts 必过；CSS 改动跑全量单测）
2. **W1 布局契约**：`npm run test:browser`（12 个真实布局测量契约；若浏览器不可用则记录缺口）
3. **视觉核查**：`./dev.ps1 script scripts/check-app-font-chain.mjs app-font-refine-<date>`（真实生产 bundle 驱动整个 App，1100px/760px 截图）
4. **对话框/Workbench 视觉**：`./dev.ps1 tauri:dev` + 本地 ConPTY 会话（唯一覆盖路径；占用 managed task 槽，最后执行）
5. **性能纪律**（工程 §4）：动画仅 transform/opacity 且 ≤200ms；`prefers-reduced-motion` 降级；不给 TabStrip/Workspace 加订阅；动 TransferCenter 前先补 memo；新偏好注册 `persistKeys.ts`

## 7. 分工

- **frontend**：W1→W2→W3 实现；每波自验后汇报（改动文件清单 + 验证结果 + 可行性发现）
- **visual**：W1、W3 完成后按规范复核（spec 合规性）
- **ux**：W2 完成后按规范复核（交互项合规性）
- **lead**：合并裁定、机械验证、视觉核查、交付
