# Filer 面板 UI 审查报告

审查范围：文件管理器面板（Filer）的 UI 布局、交互逻辑、动效与文案，兼及同族界面（FtpPane、TransferCenter）的横向一致性。
审查方式：视觉设计 / 体验设计 / 前端工程三个维度并行排查，结论交叉复核后由主理人仲裁，最终状态经磁盘核验与全量测试确认。

验证结果：`npm run typecheck` 无错误；`npm test` **87 个文件 / 689 个用例全部通过**。

---

## 一、核心病灶：为什么「大小 / 修改时间」看起来是歪的

这不是观感问题，是一条四环相扣的因果链。用户看到的「列不对齐」，是最后一环的表象：

1. **每一行都是独立的 flex 容器**。`.filer-entry` 只在本行内布局，行与行之间没有共享的列宽契约。
2. **列宽等于内容宽度**。原 `src/styles/filer.styles.css:274-285` 给两列设了 `flex: 0 0 auto` —— 于是 `1.2 MB` 比 `12.4 MB` 窄，日期列的起点逐行左右跳动。
3. **列头自己也是内容宽度**。原 `:212-224` 的 `.filer-columns button { min-width: 0 }`（特异性 0,1,1）**覆盖**了 `.filer-col-size { min-width: 58px }`（特异性 0,1,0），列头与数据行双重错位。
4. **排序时错位量还会变**。`src/components/SortIndicator.tsx:15` 在非排序列返回 `null`、在排序列插入箭头，点击排序会改变列头文案宽度。

**修法**：把列宽从「内容测量」改为「容器声明的栅格轨道」，列头与数据行读同一份 `grid-template-columns`。
这个写法在本产品内已有正确先例 —— `src/styles/ftp.styles.css:144-148` 让 `.ftp-browser-columns` 与 `.ftp-file-row` 共用一条 `grid-template-columns`。本次是与既有的正确祖先对齐，不是新发明。

---

## 二、已修（已落地并验证）

### 布局与对齐

| 问题 | 位置 | 方案 |
|---|---|---|
| 三列不成列 | `filer.styles.css` | 列头与行共用 4 轨栅格 `16px minmax(0,1fr) <size> <date>` |
| 滚动条 10px 横向错位：有滚动条时列头比行宽 10px | `FilerPanel.tsx` + `filer.styles.css` | 量测 `offsetWidth - clientWidth` 写入 `--filer-sb-w`，列头 `padding-right` 加这个值。**否决了 sticky 方案**——把列头移进 `.filer-list` 会违反 `role="listbox"` 只应收 option/group 的结构约束 |
| 轨道宽度用 em 系数折算，用户改了 `--font-mono` 后会被 ellipsis 裁切 | `filer.styles.css` | 轨道改用 `ch`（`--filer-size-track: 9.4ch`、`--filer-date-track: 11.4ch`） |
| `ch` 在列头与行解析值不同（列头 `--fs-xs`、行 `--panel-font-size`） | `filer.styles.css` | 两个栅格容器统一声明 `--filer-cell-fs: max(10px, var(--fs-xs))` + `--font-mono`；名称与列头文字各自取回 `--font-ui`；计数单元格 `font-size: inherit` |
| 单元格字号下限 9px 低于可读下限 | `filer.styles.css` | 只在 Filer 两格加 `max(10px, …)` 下限；**未全局改**，否则 panelFontSize=10 时 `--fs-xs` 与 `--fs` 都是 10px，字阶消失 |
| 行距两条渲染路径不一致（flow 25px vs virtual 26px） | `filer.styles.css` | `.filer-entry + .filer-entry { margin-top: 2px }`：flow 里 1px 外边距会折叠，虚拟列表里不会 |
| 路径栏内缩左右不等 | `filer.styles.css:57` | 统一为 `var(--sp-12)` |
| 行高公式 CSS 与 TS 各写一遍 | `filer.styles.css` / `FilerPanel.tsx:269` | 提 `--filer-row-h` 令牌，由组件下发 |

### 大小列

| 问题 | 方案 |
|---|---|
| 进位越界：`1023.95 KB` 输出 `1024 KB` | 先四舍五入再判量纲，输出 `1.0 MB` |
| `512 B` 与 `1.2 KB` 的数字右端差一个字符 | `formatBytesParts` 拆出数值与单位，单位进固定槽位 `min-width: 2.2ch`；**空格放在槽外**——放在槽里会让槽宽在 2.2ch（` B`）与 3ch（` KB`）之间跳，拆分就白做了 |
| 单元格不等宽 | 计数列改等宽字体 + `tabular-nums` |
| 无 PB 档 | 补齐 |

### 修改时间列

列名原本在撒谎：只显示 `YYYY/MM/DD`，没有时间。最终定稿（列内一律数字日期，只保留一个相对词）：

| 情形 | 中文 | 英文 | 宽度 |
|---|---|---|---|
| 今天 | `今天 14:32` | `Today 14:32` | 11 字符 |
| 昨天 + 今年内 | `10-20 14:32` | `10-20 14:32` | 11 字符 |
| 跨年 | `2025-10-20` | `2025-10-20` | 10 字符 |
| 无 mtime | `未知` | `Unknown` | — |

附带修掉的：

- **日期与年份全部手拼，不走 `Intl`**。`rowDateFormats` 现在只剩 `time` 一个格式化器。原因：`Intl` 用 `{year,month,day}` 时 zh 出 `2025/10/20` 而 en-US 出 `10/20/2025` —— 同一列两种日期语法，正是要消除的问题。
- **时钟偏移守卫**：SFTP 的 mtime 是服务器时钟。服务器时钟偏快时文件会落到「未来」，且跨年档不带时刻，看起来毫无异常，静默出错。`day > today` 一律降级为今年内形状（11 字符），不会渲染未来时刻也不会撑破轨道。
- **墨色梯度**：名称 `--fg` → 日期首段 `--fg-dim` → 时刻 / 大小 `--fg-faint`。不做的话「今天」档整格只剩时刻时会是全 `--fg-faint`，变成「越新的文件墨色越弱」，与「越近越值得看」相反。
- **`null` 与 `0` 分开**：`0` 是真实 epoch 0，渲染成 1970 年真实日期。此前 `if (!seconds)` 把它当缺失显示空白，而 `fileSort.ts:71-77` 用 `=== null` 判空 —— 排序和显示是同一个 bug 的两半。
- **tooltip 给完整时间戳，并显式说明那是本机的时区**：`修改时间：2025-10-20 14:32:08（本机时间 UTC+08:00）`。SFTP 给的是无时区的 Unix 秒；只写 `UTC+08:00` 会被读成服务器时区，必须说破是这台机器的读数。

### 无障碍

| 问题 | 位置 | 方案 |
|---|---|---|
| `role="progressbar"` 吞掉取消 / 重试按钮 | `FilerPanel.tsx` | 收敛到只包进度条轨道，外层改普通容器。这是**功能障碍**：该角色的后代不进无障碍树，键盘 + 读屏用户在传输大文件时够不到「取消」 |
| 文件类型对读屏完全不可见 | `FileIcon.tsx:58`（`alt=""`）、`icons.tsx:174` | 行内加 `<span class="sr-only">{entryKindLabel(kind)}</span>`；新增全仓此前没有的 `.sr-only` |
| 列头无 `aria-sort`，且 `aria-label` 顶掉了可见列名 | `FilerPanel.tsx` | 删 `aria-label`（读屏只会念「按大小排序」，永远不念「大小」），改 `aria-sort` + `data-sort-key` + sr-only 方向说明 |
| 列头 hover 与 sorted 同色 | `filer.styles.css` | 三态：静止 `--fg-faint` / hover `--fg-dim` / sorted `--fg` |
| 选中态元数据对比度不足 | `filer.styles.css` | hover `--fg-dim`；选中 `color-mix(in srgb, var(--fg) 85%, var(--bg-active))` |
| 进度条轨道用错令牌族（`--border-strong` 对底 1.50:1、对填充 2.43:1，均不满足 3:1） | `filer.styles.css` | 改用凹槽令牌 `--bg-track` |

### 文案

新增 `filer.dateToday`（今天 / Today）、`filer.dateUnknown`（未知 / Unknown）、`filer.dateStamp`（tooltip 的整行时间戳）、`filer.tipType` / `tipSize` / `tipOwner`、`filer.oneItem` / `manyItems`。
修正：`kindLink` 链接 → 符号链接 / Link → Symbolic link；`mode` en "Mode {mode}" → "Permissions: {mode}"（中文同步加冒号）；`tr.sync.complete` "Synced" → "Sync complete"；`working` "working…" → "Working…"。

### 收尾补做

- **`aria-setsize` / `aria-posinset`**：`FilerRow` 收 `setSize` / `posInSet`，由面板的行索引下发。5000 文件不再被报成「共 15 项」。
- **语言切换不刷新**：`FilerRow` 收 `t`（`useT()` 按语言 memo，所以切换时正好失效重渲染），`entryTitle` / `entryKindLabel` / `formatEntrySummary` 改为接收 `Translate`，`entrySummary` 的 memo 依赖加 `t`。sr-only 类型词现在跟着切。
- **tooltip 的四个值各自带标签**：`类型：文件 · 大小：12.4 KB · 权限：0644 · 所有者：root:root`，不再只靠顺序才能读懂。
- **传输汇总的 live region**：原先 `role="status"` 嵌在 `<button>` 里 —— `button` 是 children-presentational 角色，这个区域**永远不会被宣告**。移到 button 外层。
- **上传名不再硬编码 `${n} items`**（中文界面会漏出英文），改走 `filer.manyItems`。

---

## 三、已定位、方案已定、本轮未做

| # | 问题 | 位置 | 方案 |
|---|---|---|---|
（第 1、2 项已在收尾阶段完成，见第二节末尾「收尾补做」。）
| 3 | 空 / 离线 / 错误态三个 `div` 是 `role="listbox"` 的直接子节点 | `FilerPanel.tsx` | 移出 listbox |
| 4 | 首屏闪「此文件夹为空」（初始 `path === ""`） | `FilerPanel.tsx` | 空态加 `path !== ""` 前提，复用**已存在**的 `filer.noFolderOpen`（`zhCN.ts:633` / `en.ts:703`） |
| 5 | 排序方向只有 16px 箭头，色弱 / 低视力用户难辨 ↑↓ | `SortIndicator.tsx` | 需新增两个内联 SVG（升序实心三角 / 降序空心三角）。**属图标资产，需你决定**：读屏通道已由 sr-only 方向说明覆盖，剩下的是低视力通道；要不要为它新增资产是设计取舍，本轮未做。附带可做的纯 CSS 版本：`.sort-caption` 包层 + 排序列头加 2px `--accent` 下划线 |
| 6 | `en.ts` `filer.replaceConfirm`「{count} item(s) already exist」会输出 `1 item(s)` | `en.ts` + `useFilerActions.ts` | 加 `replaceConfirmOne` 并在调用处分叉 |
| 7 | `useFilerUpload.ts:82` 硬编码 `` `${n} items` ``，未进 catalog | `useFilerUpload.ts` | 进 i18n |
| 8 | 拖拽被拒提示误用 `role="alert"` 且带无用的「重试」 | `useFilerDrag.ts`、`useFilerUpload.ts` | 只留在页脚；alreadyHere 走 `role="status"` 无按钮分支 |
| 9 | `Enter` 无单选兜底，与 F2 / Delete 口径不一致 | `FilerPanel.tsx` | 对齐 F2 的取行逻辑 |
| 10 | `busy` 时键盘全死，Esc 也失效 | `FilerPanel.tsx` | 至少放行 Esc 与焦点移动 |
| 11 | `connecting` 态无指示器 | `FilerPanel.tsx` | 补连接中提示 |
| 12 | 传输开始 / 完成 / 失败 / 取消无 aria-live 宣告 | `FilerPanel.tsx` | 独立 polite 区域，只在 `transfer.status` 变化时写一次短句（进度本身**不要** live，会刷屏） |
| 13 | `FilerTransferSummary.tsx:27` 的 `role="status"` 嵌在 `<button>` 内，live region 永不宣告 | `FilerTransferSummary.tsx` | 移到 button 外层 |
| 14 | 无上下文菜单键（`Shift+F10`） | `FilerPanel.tsx` | 补 `case "ContextMenu"` |
| 15 | `ftpPresentation.tsx` `ROW_DATE` 未指定 `2-digit`，单 digit 时刻宽度不一致；FTP 行高 29px 与 Filer 26px 不一致 | `ftpPresentation.tsx`、`ftp.styles.css` | 与 Filer 统一 |
| 16 | 术语：`filer.home` 中文「主目录」与同域「文件夹」术语打架（en 是 "Home folder"）；`tr.stage.complete`「可以放下了」偏口语 | locales | 统一术语，改动面涉及多处 tooltip |
| 17 | 触控行高 24px < 32px 目标 | `filer.styles.css`、`FilerPanel.tsx` | 平板形态需同步改 `rowHeight` |

---

## 四、本轮被否决的方案（附依据）

- **目录「大小」显示「N 项」**：取 N 项要为每个目录多一次 `sftpList`，`/var` 下 500 个目录就是 500 次往返；且列头是「大小」，填「N 项」会让列语义分裂、排序键与显示值不一致。保留空单元格。
- **列头 sticky（移入 `.filer-list`）**：违反 `role="listbox"` 只应收 option/group 的结构约束，且会污染待加的 `aria-setsize` / `aria-posinset`。改用 `--filer-sb-w` 运行时补偿。
- **保留「昨天 / Yesterday」相对词**：这两格是等宽字体，字符宽约 0.6em，`Yesterday 14:32` 是 15 字宽 ≈ 9.0em，超出轨道（视觉侧提的 8.5em、工程侧落地的 7.8em 都装不下），会被裁成 `Yesterday 14:3…`。一个被截断的英文单词比一个数字日期更糟。
  —— 连带地，原「未来时间戳给完整 `YYYY-MM-DD HH:mm`」也作废：16 字符 ≈ 8.8–9.6em，同样会被裁。改走今年内形状。
- **`--fs-xs` 全局抬到 10px**：panelFontSize=10 时 `--fs-xs` 与 `--fs` 都是 10px，字阶消失。只在 Filer 两格加下限。
- **`role="grid"` 改造**：三列 + 可排序列头 + 多选本质是表格，`columnheader` 原生支持 `aria-sort`，虚拟化可用 `aria-rowcount`/`aria-rowindex`。但改动面大、要引入单元格间焦点移动，本轮先做 listbox 版最小修复，列为技术债。
- **此刻引入 `Intl.PluralRules`**：两种语言、六个词条，收益不抵改动面。沿用 `one*` / `many*` 约定。

---

## 五、实际改动（未提交，留在工作区）

| 文件 | 改动 |
|---|---|
| `src/styles/filer.styles.css` | 栅格轨道、`ch` 化、`--filer-cell-fs`、`.sr-only`、单位槽、墨色梯度、列头三态、对比度、路径栏内缩、`--bg-track`、行距、`--filer-row-h` |
| `src/components/panels/filerPresentation.tsx` | `formatDateParts` / `formatDate` 重写、`formatBytes` 进位修复、`formatBytesParts` + `FilerSize`、`FilerDate`、sr-only 类型词、tooltip 时区 |
| `src/components/panels/FilerPanel.tsx` | `--filer-sb-w` 量测、`--filer-row-h` 下发、`aria-sort` + `data-sort-key` + 去 `aria-label`、`role="progressbar"` 收敛、行高令牌 |
| `src/locales/zhCN.ts`、`src/locales/en.ts` | 新增 `dateToday` / `dateUnknown`；修正 `kindLink`、`mode`、`tr.sync.complete`、`working` |
| `src/components/panels/FilerSelection.test.ts`、`src/components/panels/filerPresentation.test.ts`、`src/test/filerColumns.browser.test.ts` | 断言同步到新规格，并补时钟偏移、跨 locale 等宽等回归 |

遗留：`src/test/filerColumns.browser.test.ts` 需要浏览器环境（Playwright），本轮未执行，其结论未经验证。

---

## 六、三条值得进 review 检查项的通例

本次排查里，同一类错误在不同人手上各犯了一次，值得立成规则：

1. **等宽格子的字宽一律按 `ch` 数字符个数，不做单位换算。**
   `ch` 的好处恰恰是它不需要推导：N 个字符就是 N `ch`。一旦换算成 em 或 px，就要假设「一个字符多宽」，而这个假设在 `--font-mono` 用户可自定义（`fonts.ts:150`）时根本不成立。本轮在日期轨道宽度上换算错了三次。

2. **用 `ch` 定轨时，容器的 font-size 必须等于被测量文本的 font-size。**
   `ch` 按元素自身字体解析。列头原本是 `--fs-xs`、行是 `--panel-font-size`，两端算出两个值；把单元格写成 `font-size: inherit`、让容器声明 `--filer-cell-fs`，尺子和被量的字才是同一把。最小字号下这个偏差会直接变成裁切。

3. **只适用于一端的样式必须收窄到 `.filer-entry` 或 `.filer-columns` 下。**
   列头按钮与行内单元格**完全同名**（都叫 `filer-col-size` / `filer-col-date`），裸写的 `.filer-col-*` 规则会串台到另一端。这次串的是 `gap`，下次可能是 `min-width` / `text-align` / `display`，而症状会表现成「列头箭头位置怪了」，很难联想到是某条行内样式引起的。

**本次由此发现的真回归**：日期轨道 `11.4ch`（62.7px）装得下 11 字符的日期串，但装不下列头 `MODIFIED` 加 16px 排序箭头（实测 75.8px），英文下列头会被 ellipsis 裁掉。修法是 `max(11.4ch, calc(var(--filer-cell-fs) * 8.2))` —— `ch` 保证内容宽度，em 下限把列头纳入预算，字号变大时两端同步缩放。
