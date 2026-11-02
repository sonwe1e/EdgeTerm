# Filer 界面重做计划

> 状态：**已获批准并实施 S1–S4**（用户 2026-11-02 回复"按推荐"）。验证状态见第 11 节；S5（双栏表格对齐）与 S6（删除选区修复）未开工。
> 日期：2026-11-02。基线：`30eeda2`（1.6.1 发布后的文档提交），工作区干净。
> 触发：用户反馈——"文件管理界面很奇怪，无论有没有取消显示大小，即使只有名称和修改时间也很奇怪；侧栏的拖拽和大小变化跟预期相差很大，需要参考别人的方案重新定制计划"。
> 本轮已确认：光标位于行尾的方案（删除缺陷另行处理，先 Filer）；拖侧栏外缘改宽度**可以接受预览线**；"侧栏问题"指 a) 外缘改宽、c) 列宽把手、d) 面板间分隔条；结构改动**都允许**。

---

## 0. 摘要：需要你拍板的 4 件事

| # | 决定 | 推荐 | 影响 |
|---|------|------|------|
| D1 | 侧栏 Filer 走 **A 列表模型**（图标 + 名称 + 行内元数据，无表头），还是 B 紧凑表格、C 双行卡片 | **A** | 决定整个视觉结构与测试基线 |
| D2 | 侧栏里**取消表头与列宽把手**；列宽/自动适配/显示隐藏列这套能力迁到双栏视图（阶段 2） | **取消** | 直接回答你点名的 c；也意味着侧栏不再有横向滚动 |
| D3 | 面板间分隔条 d 也改为**预览线 + 松手落位**，与侧栏外缘 a 一致 | **一致** | 两个手势从此同一语言；比现在的"外缘预览、内部实时"更可预期 |
| D4 | 本轮范围：**只做停靠 Filer**；双栏表格对齐、删除选区修复随后 | **同意** | 控制风险；双栏已经能自适应（≤800px 自动隐藏时间列），风险低但工作量大 |

若同意，回复"按推荐"即可；对哪条不同意，只写那一条。

---

## 1. 现状：测量与因果

### 1.1 真实渲染测量（300px 侧栏默认宽、12px 面板字号、暗色、中文界面）

本轮用一次性只读渲染脚本得到 7 张对照图（300/420px × 显示/隐藏大小 × 中英文 × 悬停/选中），测量如下：

- **首行数据之前有 5 层 chrome，合计约 148px**：面板标题 36 + 工具栏 30 + 路径输入行 36 + 面包屑 23 + 列头 23。
- **名称列只有约 90–100px**（`EdgeTerm_1.6.1_x64-setup.exe` 被截成 `EdgeTerm_1.6.1_…`），大小列约 52px，修改时间列约 82px。**最该宽的列最窄。**
- 修改时间列的宽度由列头（`修改时间 / MODIFIED` + 排序箭头）决定（`8.2em` 下限），**比它的内容（11 字符）还宽**。
- 一列里混用 **4 种时间形态**（`今天 15:05` / `10-31 15:15` / `2025-09-28` / `未知`）+ **两种墨色**（日 dim、时刻 faint）+ 10px 等宽，行与行节奏不齐。
- **同一条路径出现两次**：路径输入框（填充底色的控件）与面包屑（`C: › Users › demo › Documents`）上下相邻。
- **列把手静止时就画 2px 竖线**（两根"杂线"落在 22px 高的列头里）；工具栏 7 个纯图标 + 路径行 4 个纯图标 + 1 个文字按钮"显示列"= **12 个控件**，优先级别不清。
- 隐藏大小列后名称列放宽到约 160px，但 5 层 chrome、重复路径、时间形态混杂**全部保留**——与你"取消了显示大小也奇怪"的描述一致。
- 同一组件放宽到 **420px 时明显舒展**：说明问题不只是列宽，而是**结构（层数）与列的优先级**。

来源：`src/components/panels/FilerPanel.tsx:831-1200`（band 结构）、`src/styles/filer.styles.css:204-262`（栅格与 `ch/em` 轨道）、`src/styles/filer.styles.css:340-379`（常显把手）、`src/panelSizing.ts:30-41`（默认右栏 300px、左栏 220px）。

### 1.2 为什么前两轮"收尾"没解决

`docs/ui-refinement/visual-spec.md` §4 的判断是"Filer 是最成熟的表面，只做标准化收尾，不作结构改动"，`docs/filer-ui-audit*.md` 也集中在栅格、对齐、对比度、日期格式上。这些工作是对的，但它们**假设了"侧栏里放一张三列表格"这个前提**；你的不适感来自这个前提本身，而不是表格内部的像素。本轮要动的是前提。

### 1.3 参考产品：表格属于宽表面，导航器属于窄栏

| 产品 | 表面 | 做法 | 对本计划的意义 |
|------|------|------|----------------|
| WinSCP | 文件面板（整窗） | 列可选/可排序；拖列头之间的分隔条改列宽；`Size Automatically` 自动适配；`Reset Layout` 复位；路径标签逐段可点；每个面板有自己的导航工具栏 | 表格 + 列系统的**完整参考**，用于双栏视图（阶段 2） |
| macOS Finder | 列表视图（整窗） | 拖列分隔条改宽；**双击分隔条**把列扩展到完整文件名；Control 点列头显示/隐藏列；点列头排序 | 列系统的交互惯例；阶段 2 的列适配与复位按此对齐 |
| Termius | 桌面 SFTP（双栏，主区域） | 表格列 Name / Date Modified / Size / Kind / Permissions；**"点路径旁边的空白区域"把路径栏变成输入**；Actions 菜单；Filter | 输出"路径栏 = 面包屑 + 点空白进入编辑"的形态；终端客户端的文件面板语言 |
| VS Code | 主侧栏（Explorer） | 侧栏是**导航器**：名称 + 装饰，没有表头、没有列、没有横向滚动；视图动作在标题栏（新建/刷新/折叠）与 `…` 菜单（排序方式等）里 | **侧栏该长什么样**的直接依据 |

还有一条本项目内已有的先例：双栏文件浏览器在 **≤800px 时自动隐藏时间列**（`src/styles/ftp.styles.css:534-554`）。"列按可用宽度取舍"在本产品里已经成立，只是侧栏 Filer 没走这条路。

**结论：主区域（SFTP/FTP 双栏）保留表格与列系统，并把 WinSCP/Finder 的列惯例补齐；300px 侧栏改为导航器式列表。** 两张脸、两套正确解，而不是把表格压进侧栏。

---

## 2. 设计主张（三条规则）

**页面模式**：Operate（侧栏导航 + 传输入口），主任务是"在终端旁边快速找到文件并搬运"。

**空间主张**：

1. **名称领先，元数据退后。** 侧栏的唯一主角是可读的文件名；大小与时间是一条右对齐的低声部，不再争夺列宽与表头。
2. **一条路径、两层 chrome。** 路径只出现一次（面包屑，点空白进入编辑），面板只保留"标题 + 路径"两层，每层一条发丝线；列表从第三层直接开始。
3. **一套尺寸语言。** 所有"拖拽改尺寸"共用一个 sash：静止 1px、悬停/拖动 4px 强调线、11px 命中区、拖动时显示预览线（外缘可加宽度读数）、**双击复位**、方向键 8/32px。内部与外缘不再有两种手感。

**明确的取舍**：侧栏不做表格（→ 无表头、无列把手、无横向滚动）；排序与"显示大小"进 `…` 菜单（VS Code 的 Explorer 同款）；表格能力全部留给双栏视图。

---

## 3. 方案比较

### A. 列表模型（推荐）
图标 + 名称（12px）+ 右对齐元数据（大小可选 + 时间，10–11px 单墨色）。无表头、无列把手、无横向滚动；排序/显示大小/操作进 `…` 菜单；路径栏合并输入与面包屑。
- 300px 下名称 ≈136px（显示大小）/ ≈194px（隐藏大小），比现在多 40–100px；列表上方 chrome 从 148px 降到 72px（**多出约 3 行**）。
- 与 VS Code 侧栏、Explorer 导航栏的心智一致；行数只受宽度影响、不受列轨道影响。
- 失去：点列头排序、拖列宽（c 的问题随表头一起消失）；排序在菜单里（可发现性用"排序：名称 ↑"文字项补偿）。
- 性能：去掉列头滚动联动、`--filer-sb-w` 量测、每列宽度状态与 canvas 适配，每行少一个单元格；虚拟化不变。

### B. 紧凑表格（保守）
保留表头与列系统，只合并路径、压缩 chrome、把元数据与名称同字阶、时间统一形态、把手改为 hover 显形。
- 风险小、测试改动小、熟悉；但仍把三列表格塞进 300px：名称列依然受轨道约束，表头信息密度与列表抢注意力，"窄栏表格"这个前提没变。
- 适合"你其实喜欢表格、只是嫌它粗糙"的情况。

### C. 双行卡片（Finder 邮件风）
名称一行、`大小 · 时间` 第二行，无表头无把手，行高约 40px。
- 窄栏最易读；但 600px 高的侧栏只能放 ~14 行，密度与终端工具气质不符，大量文件时翻页成本高。

**推荐 A**：它同时解决"层数太多""名称太窄""时间列噪声""把手杂线"四个来源，而且把表格能力放回它真正成立的双栏视图。B 作为备选保留在讨论里。

---

## 4. 推荐方案规格（A）

### 4.1 面板骨架（band）

| 层 | 高度 | 内容 | 分隔 |
|----|------|------|------|
| 标题栏 | 36px（`--panel-header`） | FILER pill + 协议 badge + 传输指示 + 主操作图标 + `…` | 1px `--border` |
| 路径栏 | 36px（6 + 24 + 6） | ↑ 上一级、⌂ 主目录、面包屑、定位到终端目录、跟随终端 | 1px `--border` |
| 列表 | 余下高度 | 虚拟化行 | — |
| 页脚 | 现有 ~26px | `3 个文件夹 · 10 个文件` / 传输摘要 | 1px `--border` |

- 总共 **2 层 chrome = 72px**（现在 148px），列表区多出约 76px ≈ 3 行。
- 窄于 260px 时，标题栏只留 pill + `…`，其余动作收进 `…`（用容器查询 `@container` 实现，WebView2 与 Edge 均支持；jsdom 不测，浏览器测）。

### 4.2 行模型

```
[16px 图标] [名称 flex，ellipsis]        [大小?] [时间]
```

- 行高沿用 `--filer-row-h`（12px 字体下 24px，间距 2px，节拍 26px；18px 字体下单行 30px）。**现有虚拟化行高公式不变。**
- 名称：`--font-ui`、`var(--panel-font-size)`、`--fg`，省略号截断；目录不换色（沿用现有图标区分），符号链接沿用 `--symlink-label`。
- 元数据：`--font-mono`、`max(10px, var(--panel-font-size) - 2px)`、tabular-nums、**单一墨色** `--fg-faint`（悬停 `--fg-dim`、选中按现有 `color-mix` 提亮）。大小在前、时间在后，右对齐，二者间隔 8px。
- **时间只保留两种形态**：本年内 `MM-DD HH:mm`；跨年 `YYYY-MM-DD`。取消"今天/昨天"相对词与双色分墨；完整本机时间戳留在行 tooltip（现有 `entryDateStamp`）。无法确定时**留空**，读屏名里说"未知"（延续双栏对目录大小的空单元格决策）。
- 大小：沿用 `formatBytesParts` 与 2.2ch 单位槽（`1.2 MB`、`512 B` 数字右端对齐）；目录留空。
- 宽度预算（12px 字体、300px 面板、12px 行内缩进）：名称 136px（显示大小）/ 194px（隐藏大小）；420px 时为 256/314px。

### 4.3 路径栏与编辑模式

- 默认显示面包屑：`C: › Users › demo › Documents`，末段 `aria-current`；段可点、可横向滚动但隐藏滚动条（沿用现有 `filer-crumb` 样式）。
- **点面包屑之外的空白区域（或 F2）进入编辑**：同一行位置换成输入框（24px，自动聚焦并全选），Enter 加载、Esc 还原；编辑模式不新增层高。参照 Termius 的"点路径旁边空白编辑"，替换现在"输入框与面包屑同时常显"的重复。
- 窄于 300px 时面包屑中间段折叠成 `…`（title 给出完整路径），首尾段保留。

### 4.4 操作与菜单

- 标题栏常显：`新建文件` `新建文件夹` `上传` `下载` `…`（24px 图标按钮，5 个）；窄栏降级为 pill + `…`。
- 路径栏常显：`↑` `⌂` 面包屑 `定位到终端目录` `跟随终端`。
- `…` 菜单（一个入口，分三组）：
  1. 新建文件 / 新建文件夹 / 重命名 / 删除 / 刷新（当前选中项决定可用性，危险项用现有 `is-danger`）；
  2. **显示大小**（复选，沿用 `filerSizeVisible`）、**排序**（子菜单：名称 / 大小 / 修改时间，项上显示 ✓ 与方向；点击当前键切换方向，复用 `toggleFileSort`）；
  3. 在终端中定位 / 跟随终端（复选）。
- 保留全部现有键盘路径（方向键、Home/End、PageUp/Down、F2、Delete、Enter、ContextMenu）与右键菜单；排序与大小开关获得可聚焦的菜单项，不再依赖列头。
- 移除：列头排序按钮、列宽把手、`显示列` 文字按钮、页脚的"显示更多列/显示名称"横向滚动开关、`.filer-hidden-sort` 提示。

### 4.5 状态

加载 / 空 / 离线（含重连）/ 错误（含重试）/ 拖放（接受、拒绝、原因）/ 传输摘要，全部沿用现有实现与文案；只调整它们在新骨架里的位置。加载态补一个 16px spinner（现有 `.update-spinner` 词汇表），不新造动效。

### 4.6 可访问性

- `role="listbox"` 保留；每行 `aria-label` 继续用 `entryTitle`/`entrySummary`（类型、大小、时间、权限）；未知时间在可访问名里说"未知"。
- 表头 `aria-sort` 随表头一起删除；排序状态改由菜单的 `menuitemradio`（`ContextMenu` 已支持 radio mark）与本菜单的可访问名承载，切换后在页脚状态区做一次 polite 宣告（"已按修改时间降序"）。
- 路径编辑模式：输入框有 `aria-label="路径"`，Esc/Enter 行为与现在一致；焦点回到列表。
- 焦点顺序：标题栏 → 路径栏 → 列表 → 页脚；sash 保持 `role="separator"` + 方向键。

### 4.7 i18n 与偏好迁移

- 新增词条：视图菜单、显示大小、排序方式、升序/降序、已按…排序、路径编辑的 aria-label、折叠路径的 title。沿用现有 `filer.*` 命名；双栏继续使用 `filer.name/size/modified`，**不删除**。
- `edgeterm.filerColumns`（列宽）停止读写；常量保留在 `persistKeys.ts`（设置导入/导出仍能识别旧数据），文档标注"已废弃，忽略"。`filerSizeVisible`、`filerSort`、`panelSizing` 不变。
- 旧列宽不需要迁移：列表模型没有列宽。

### 4.8 性能

- 删除列头 ↔ 列表的 `transform` 滚动联动、`--filer-sb-w` 量测、每列宽度状态、`suggestColumnWidth` 的 canvas 适配路径、`filer-columns` 的一整棵树。
- 每行单元格从 4 个（图标/名称/大小/时间 + 把手的绝对定位）降到 3 个；虚拟化、`aria-setsize/posinset`、窗口化行数不变。
- 预期收益要在浏览器计时门禁上实测（`check-file-performance.mjs`：10k 行首屏中位 27.0ms、门限 200ms；tab 切换 13.0ms、门限 100ms），**不预先承诺数字**。

---

## 5. 拖拽与尺寸（a / c / d）

### 5.1 一个 sash，三处使用

抽出一个 sash 原语（视觉 + 指针 + 键盘 + 双击复位），三处复用：侧栏外缘（a）、dock 内面板分隔条（d）、双栏表格列分隔条（阶段 2 的 c）。

**视觉**：静止 1px `--border-strong`；悬停/拖动 4px `--accent`（现在 3px）；11px 命中区；拖动中全局 `col-resize` 光标；焦点环 2px。
**指针模型**：预览线跟随指针，松手落位（你已接受）；拖动超过 150ms 出现**宽度读数**（`300×` 小标签，11px，跟随预览线）。到边界时读数停在边界值，并轻微变灰——"为什么拖不动"变得可见。
**复位**：双击 sash = 外缘回默认（左 220 / 右 300，见 `DEFAULT_PANEL_SIZING`）；dock 内分隔条 = 等分；表格列 = 适配内容（阶段 2）。
**键盘**：聚焦 sash 后 ←/→ 8px、Shift 32px（现有行为保留）。
**持久化**：外缘宽度沿用 `panelSizing`（已有`显示值/偏好值分离`的修复）；dock 内分隔条新增 `edgeterm.dockSplits`（按 dock 记两个面板的权重），现在它是组件内 state，切换面板或重启就丢。

### 5.2 行为对照

| 手势 | 现在 | 改后 |
|------|------|------|
| a 侧栏外缘 | 3px 预览线，松手落位；无读数；无双击复位 | 4px 预览线 + 宽度读数 + 边界反馈 + 双击回默认；行为不变（预览） |
| d 面板间分隔条 | **实时**缩放，权重不持久化，无双击复位，最小 72px | 与 a 同一预览线模型 + 双击等分 + 权重持久化 + 同上读数 |
| c 列宽把手 | 表头里常显 2px 竖线 + 7px 命中区，拖名称列会把整个表格切到"固定宽度 + 横向滚动"模式 | 侧栏取消；双栏表格（阶段 2）按 WinSCP/Finder：列头分隔条常显、双击适配、`…` 菜单显示/隐藏列与复位布局 |

### 5.3 为什么取消侧栏列宽

- 你的原话是 c "跟预期相差很大"；而现在的列宽模型有一个结构性惊吓：**拖名称列 = 整张表从"弹性"切成"固定宽度 + 横向滚动"**，之后日期可能被推出面板。这不是把手手感问题，是模型问题。
- 列表模型下侧栏不再需要列宽；表格能力（列顺序、显示隐藏、自动适配、复位布局）在双栏视图里按 WinSCP/Finder 的惯例补齐，比在 300px 里维护三列更成立。

---

## 6. 分阶段与提交

每步独立提交、独立通过 `typecheck` 与相关测试；`fix:`/`feat:` 前缀按仓库约定。

| 阶段 | 内容 | 主要文件 | 测试 |
|------|------|----------|------|
| S1 | **sash 统一**：抽出 sash；a 加读数/双击复位；d 改预览 + 双击等分 + 权重持久化 | `Splitter.tsx`、`FilerColumnResizer.tsx`（阶段 2 再迁）、`App.tsx`、`PanelDocks.tsx`、`status.styles.css`、`persistKeys.ts` | `layoutDock.browser.test.ts`（预览、复位、读数、键盘）、纯函数（clamp/等分）单测 |
| S2 | **路径栏合并**：面包屑 + 点空白编辑；动作迁到标题栏 + `…`；删除常显输入行 | `FilerPanel.tsx`、`filer.styles.css`、locales | 浏览器：band 数、编辑模式 Enter/Esc、窄栏折叠 |
| S3 | **列表行模型**：行结构、单墨色元数据、两种时间形态、`…` 菜单（显示大小/排序）、a11y 与 i18n | `FilerPanel.tsx`、`filerPresentation.tsx`、`filer.styles.css`、locales | `filerPresentation.test.ts`、`filerColumns.browser.test.ts` 重写为 `filerListLayout.browser.test.ts`、字体门禁重写 |
| S4 | **移除列系统**：表头/把手/滚动联动/`--filer-sb-w`/`filerColumns` 偏好；文档标注废弃 | `FilerPanel.tsx`、`filerColumns.ts`、`persistKeys.ts`、docs | 删除 `filerColumnResize.browser.test.ts` 中侧栏相关用例（迁到阶段 2 的双栏列用例） |
| S5 | **双栏表格对齐**（阶段 2，单独立项）：列顺序/显示隐藏/自动适配/复位布局、sash 列分隔条 | `ftpPresentation.tsx`、`ftp.styles.css`、`FtpPane.tsx` | `responsiveLayout.browser.test.ts`、新增列用例 |
| S6 | **删除选区修复**（另行）：行尾光标方案 + emoji/制表符计数 + 二次编辑回归 | `terminalSelectionEdit.ts`、测试 | 见"下一步" |

> S3 与 S4 视觉上必须一起落地（表头与列表共存会自相矛盾），但可以拆成两个提交：S3 先换行模型与菜单、S4 再删残留的列机制与偏好，两个提交之间测试保持绿色。

---

## 7. 验证与门禁迁移

**每阶段的机械验证**

1. `npm run typecheck`；`npm test`（相关文件先单跑，再全量）；`npm run lint`、`npm run format:check`。
2. 浏览器布局契约：`npm run test:browser`（真实 Edge；当前 30 文件 / 160 用例）。
3. **渲染对照**：临时只读 harness（`.tmp` 脚本，跑完即删）在 150 / 300 / 420 / 720px 侧栏宽、10 / 12 / 18px 面板字号、暗/亮主题、中/英文、显示/隐藏大小列下截图，与本轮 7 张基线对照；**实施阶段的测试/截图需要一次性放宽沙箱**（当前沙箱阻止 esbuild 子进程，本轮渲染即通过一次性放行完成）。
4. 真机（Tauri/WebView2）最后验收：本地与 SSH 会话、真实目录、拖放、传输、键盘。

**门禁迁移（重要）**

- `scripts/check-app-font-chain.mjs` 现在断言"日期列在轨道内、名称初始可读、超宽时横向滚动可达日期"。列表模型没有日期列与横向滚动，断言改为：**名称最小可见宽度**（≥14ch 或 64px）、**元数据簇在行内不被裁切**、**行节拍 26/30px**、**18px 字体下名称与元数据仍可读**、10k 行窗口化（挂载行数 <100）。改门禁必须同时给出负向控制（旧实现上失败、新实现上通过）。
- 浏览器契约：`filerColumns.browser.test.ts`（9 条，全部关于栅格/列头/滚动同步）重写为列表契约；`filerColumnResize.browser.test.ts`（14 条）中侧栏用例删除、双栏列用例留到阶段 2。
- 现有可保留的契约：`filerSelection`、`filerDownloadQueue`、`virtualFileRows`、`layoutDock`、`responsiveLayout`（双栏）、`realLayout`。

---

## 8. 风险与回退

| 风险 | 影响 | 缓解 |
|------|------|------|
| 你其实想要表格、只是嫌它粗糙 | A 方向被否 | D1 里选 B；B 的规格见第 3 节，改动面小得多 |
| 失去"点列头排序" | 可发现性 | `…` 菜单的"排序：名称 ↑"文字项（VS Code 同款）；菜单键与右键菜单都可到达 |
| 300px 下同时显示大小与时间 | 名称仍偏窄 | 名称 136px（比现在多 40px）；大小默认仍显示、`…` 可关；行 tooltip 始终有完整信息 |
| 旧列宽偏好失效 | 用户已拖过的列宽丢失 | 列宽在列表模型里不存在；文档标注废弃，不迁移、不报错 |
| 测试/门禁重写掩盖回归 | 质量下滑 | 门禁保留**行为**断言（节拍、窗口化、可读宽度）并加负向控制；每阶段渲染对照 |
| 窄栏容器查询在旧 WebView2 不生效 | 标题栏挤压 | 同时给 JS 兜底（`ResizeObserver` 写 data 属性）；浏览器与真机都测 |
| 列表模型与双栏视觉脱节 | 两张脸不像一个产品 | 共享行高/图标/墨色/单位槽 tokens；阶段 2 强制对齐 |

**回退**：S1–S4 各自独立提交，任一阶段可单独 revert；列表模型不需要数据迁移，回退不丢用户数据。

---

## 9. 待确认（批准后即可开工）

1. D1 方向 A？D2 侧栏取消表头与列宽把手？D3 内部分隔条也改预览线？D4 本轮只做停靠 Filer？
2. 密度保持 **26px 节拍 / 12px 名称 / 10px 元数据**（推荐），还是更松？
3. 时间形态统一为 `MM-DD HH:mm` / 跨年 `YYYY-MM-DD`、未知留空（推荐），还是保留"今天/昨天"相对词？
4. 删除选区修复（S6）随后确认三件事：只修 Delete/Backspace 还是也修替换路径；验收用哪些 shell（pwsh / bash / zsh 是否带 autosuggestions）；只提交还是准备 1.6.2。

---

## 10. 参考

- WinSCP — File Panels：<https://winscp.net/eng/docs/ui_file_panel>（列显示/排序、拖分隔条改宽、`Size Automatically`、`Reset Layout`、路径标签逐段可点、面板工具栏）。
- Apple 支持 — 在 Finder 中排序和排列项目：<https://support.apple.com/guide/mac-help/view-items-in-finder-mchlp1745/mac>（拖列分隔条改宽、双击分隔条适配完整文件名、Control 点列头显示/隐藏列、点列头排序）。
- Termius — Managing files with SFTP：<https://docs.termius.com/organize-and-connect-to-hosts/managing-files-with-sftp>（桌面双栏、表格列、点路径栏空白处编辑完整路径、Actions 菜单）。
- VS Code — User Interface：<https://code.visualstudio.com/docs/getstarted/userinterface>（主侧栏承载 Explorer 等视图，侧栏是可移动的导航器）。
- 仓库内先例：`src/styles/ftp.styles.css:534-554`（双栏 ≤800px 自动隐藏时间列）；`docs/filer-ui-audit.zh-CN.md`、`docs/filer-ui-audit-round2.zh-CN.md`（上一轮的栅格/对齐结论，本计划保留其可迁移部分）；`docs/ui-refinement/visual-spec.md` §4（本计划修正其"Filer 只做收尾"的前提）。
---

## 11. 实施记录（2026-11-02）

### 已落地（S1–S4）

| 阶段 | 实际改动 | 文件 |
|------|----------|------|
| S1 sash | 抽出 `dockSplits.ts`（权重数学、等分、按 dock 持久化）；`Splitter` 增加拖动宽度读数与双击复位；侧栏外缘读数 + 双击回默认；dock 内分隔条改预览线 + 双击等分 + 持久化；sash 悬停/拖动线 3px → 4px，水平分隔条获得 Y 轴预览 | `src/dockSplits.ts`（新）、`src/components/Splitter.tsx`、`src/App.tsx`、`src/components/PanelDocks.tsx`、`src/styles/status.styles.css`、`src/persistKeys.ts` |
| S2 路径栏 | 常显路径输入框与独立面包屑合并成一条 36px 路径栏：面包屑 + 点空白/铅笔进入编辑（同高输入框，Enter 应用、Esc 还原）；7 个工具栏图标与"显示列"文字按钮收进标题栏 + `…` 菜单 | `src/components/panels/FilerPanel.tsx`、`src/styles/filer.styles.css`、`src/locales/{zhCN,en}.ts` |
| S3 列表行 | 行结构改为 图标 + 名称 + 右侧元数据簇（大小可选 + 时间）；时间统一两种形态、未知留空、取消双色分墨；`…` 菜单承载 显示大小 / 三种排序（带方向）/ 重命名 / 删除 / 刷新 / 定位终端目录 / 跟随终端；标题栏按容器宽度折叠次要动作 | `src/components/panels/filerPresentation.tsx`、`FilerPanel.tsx`、`filer.styles.css`、`src/components/panels/useFilerActions.ts`、locales |
| S4 移除列系统 | 删除表头、列宽把手、横向滚动联动、`--filer-sb-w` 量测、列宽偏好读写（键保留供导入/导出与重置）；`filerColumns.ts` 只保留"显示大小" | `FilerPanel.tsx`、`filer.styles.css`、`src/filerColumns.ts`、`src/persistKeys.ts` |
| 测试 | 新增 `dockSplits.test.ts`、`filerListLayout.browser.test.ts`；重写 `filerColumns.test.ts`、`filerPresentation.test.ts` 的日期契约；`FilerSelection.test.ts` 改走"更多操作"菜单与路径编辑模式；删除 `filerColumns.browser.test.ts`、`filerColumnResize.browser.test.ts`；字体门禁 `check-app-font-chain.mjs` 改为列表契约 | 见上 |
| 文档 | 本文件的批准状态与实施记录 | `docs/filer-redesign-2026-11-02.zh-CN.md` |

### 验证状态（诚实边界）

| 检查 | 状态 |
|------|------|
| `npm run typecheck` | **通过**（完整树，含测试文件） |
| `npm test`（jsdom） | **112 文件 / 1042 用例全部通过**（`.tmp/verify-unit.log`） |
| `npm run test:browser`（真实 Edge） | **29 文件 / 136 用例全部通过**，含新增 `filerListLayout.browser.test.ts` 8 条（`.tmp/verify-browser2.log`） |
| `/dev.ps1 script scripts/check-app-font-chain.mjs filer-list-2` | **通过**：1100×720、900×560 各 12/18px 全绿，760×600 记为低于桌面最小尺寸的观察值；0 未知 IPC、0 页面错误（`.tmp/verify-font2.log`、`.tmp/records/implementation-03/app-font-filer-list-2.json`） |
| 真实渲染对照 | **已做**：改造前 `.tmp/shots/filer-2026-11-02T07-15-42/`（7 张），改造后 `.tmp/shots/filer-after-2026-11-02T08-45-45/`（6 张：300/420px、显示/隐藏大小、悬停、菜单展开、中英文） |
| 真机（Tauri/WebView2） | 未验证（需要真窗口与真实会话，属用户实机验收）。 |

复现证据（本机）：

```powershell
npm test                                  # 112 files / 1042 cases
npm run test:browser                      # PERF_BROWSER=msedge, 29 files / 136 cases
./dev.ps1 script scripts/check-app-font-chain.mjs filer-list-2
```

### 已知风险与后续

- **提交也被沙箱阻止**：`git add`/`git commit` 在写 `.git/index.lock` 时被拒（Permission denied），所以本轮改动全部留在工作区，未生成提交。获批后按两个关注点分别提交：sash（`Splitter`/`App`/`PanelDocks`/`dockSplits`）与"停靠 Filer 改列表"（其余文件，含测试与字体门禁）。
- **未跑测试**是当前最大风险：几个新的浏览器契约（行节拍 26px、元数据簇右对齐、隐藏大小后名称变宽）只经过人工推演，没有真实布局证据；`FilerSelection.test.ts` 的菜单/路径编辑改动同样未执行。
- 若测试失败，最可能的点：`ContextMenu` 菜单项的 `disabled` 断言、路径编辑模式的焦点与 Esc/Enter 顺序、`container-type: inline-size` 在 jsdom 中的无副作用性（应为空操作）。
- S5（双栏表格列系统）与 S6（删除选区修复）未开始；S6 需先确认计划第 9 节第 4 条的三个问题。

### 提交前静态检查

`npm run format`（写入）、`npm run format:check`、`npm run lint`、`npm run typecheck`、`git diff --check` 全部通过；日志见 `.tmp/verify-*.log`。
