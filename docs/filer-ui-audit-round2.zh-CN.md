# Filer 界面 UI 审查 · 第二轮汇总（并行多代理）

> 前置阅读：第一轮未提交的审查报告见 [filer-ui-audit.zh-CN.md](filer-ui-audit.zh-CN.md)（大小/修改时间列的栅格、`ch` 轨道、进位修复、日期分级等均在该轮落地，仍在工作区未提交）。本轮在其基础上继续排查用户反馈的"仍存在设计问题"。
>
> 方法：四个代理并行，各负责一个维度（UI 布局／交互逻辑／动画效果／文案描述），先只读排查并向主理人汇报，获批后定点修复；主理人集中按序运行全部验证，并对跨代理裂缝做集成兜底。

## 验证结果

| 检查 | 结果 |
|---|---|
| `npm run typecheck` | 通过 |
| `npm test`（单元） | **87 文件 / 694 用例全部通过**（本轮新增 5 条回归） |
| `npm run test:browser` | **12 文件 / 71 用例全部通过**（含 filerColumns / filerSelection / responsiveLayout / filerDownloadQueue） |
| `npm run lint` | 通过（余 2 个 warning 在生成的 `src/bindings.ts`，预存） |
| 负向控制 | Escape 穿越 busy、Enter 单选兜底两条回归在还原旧行为后**确实失败**，修复后通过 |

未覆盖：真实桌面端（Tauri）目视复核；F1 对比度与 F5 字宽为手工测算（依据 `themes.test.ts` 同源调色板与 Consolas/Segoe UI 公开字宽），未在真实 WebView2 内测量。全部改动留在工作区未提交（与第一轮一致）。

---

## 一、UI 布局维度（7 项发现，全部已修）

| # | 问题 | 位置 | 方案 |
|---|---|---|---|
| F1 | **悬停/选中行里，日期的"时:分"不随单元格提亮**——用户点名的两列之一。`.filer-date-time` 自带颜色规则，继承永远够不到它；实测暗色悬停 4.4:1、选中 3.8:1，均低于 4.5:1 | `filer.styles.css` | 新增 inherit 规则让两个半格取单元格提亮墨色（悬停 5.1:1、选中 6.5:1），并给两个半格补 120ms 颜色过渡（继承值只跟得上进场、跟不上出场） |
| F2 | **双面板浏览器题头无滚动条补偿**：listing 超过一屏后，右两列题头比数据列偏右一个滚动条宽（10px）。与 FilerPanel 第一轮已修掉的缺陷完全同源 | `ftpPresentation.tsx` + `ftp.styles.css` | 仿 FilerPanel 模式：组件内量 `offsetWidth-clientWidth` 写 `--ftp-sb-w`，题头 `padding-right` 用它补；0px fallback 保证未量测平台与旧行为一致 |
| F3 | 新建/重命名行比数据行高 2–4px，虚拟列表里侵入下一槽位；flow 路径下把列表顶歪一个节拍 | `filer.styles.css` | 改用与数据行同一 `--filer-row-h` token，输入框 `height:100%` |
| F4 | 工具栏 `space-between` 且无 gap，7 个图标按钮随面板变宽均匀摊开（420px 时间距 39px、800px 时 103px，删除按钮漂到最右） | `filer.styles.css` | 改 `flex-start + gap: var(--sp-2)`，与 `.filer-path`、`.ftp-browser-actions` 一致；240px 下仍放得下 |
| F5 | 双面板固定 76px/130px 轨道不随面板字号缩放，13px 起日期串溢出轨道、17px 时溢出 40–60px 并带来横向滚动 | `ftp.styles.css` | 轨道改按行自身字号取 em（`calc(var(--fs-sm,11px)*6.9)` / `*11.8`），默认 11px 与旧值差 <0.3px；fallback 保证测试挂载（不在 `.app` 内）不塌栅格 |
| F6 | 窄面板下页脚摘要换行撑高，把上方列表顶下去 | `filer.styles.css` | 非传输态页脚直接子 span 加 nowrap+ellipsis；传输态页脚是块级布局，用 `:not` 排除 |
| F7 | 双面板题头按钮仍是旧无障碍模式：`aria-label` 把可见列名顶替成指令（读屏只说"按大小排序"永远不说"大小"），且无 `aria-sort` | `ftpPresentation.tsx` | 镜像 FilerPanel 既有写法：可见文字作可访问名 + sr-only 行动提示 + `aria-sort` 三态 + `data-sort-key` 稳定句柄 |

布局维度另确认 10 项健康（H1–H10，含三列轨道几何、滚动条补偿、行距节拍、2.2ch 单位槽、240px 名称列遏制、截断行为、状态布局、对比度约定、可及性结构），有测算与测试证据，未改。

## 二、交互逻辑维度（6 项缺陷 + 1 项集成裂缝，全部已修）

| # | 问题 | 方案 |
|---|---|---|
| P1 | F2 的 JS 侧（见上） | `listRef` 判空后量测（测试渲染 FileBrowser 不传 listRef，不判空会崩） |
| P2 | 键盘导航 `scrollIntoView` 无平滑行为 | 两处加 `behavior`，按 `prefers-reduced-motion` 降级为 auto；直写 `scrollTop` 的分支保持瞬时（行未渲染出来，无可滑向的目标）。刻意不用 CSS `scroll-behavior:smooth`——会连带影响虚拟列表重置跳转与拖拽边缘滚动 |
| P3-a | Enter 无单选兜底：右键选一项或 Ctrl+A 后按 Enter 无反应（F2/Delete 都有兜底，口径不一致） | 与 F2 取行逻辑对齐 |
| P3-b | `busy` 时键盘全死，连 Escape 都不能取消选择 | Escape 分支提到 busy 判断之前（input 检查仍排第一）；其余键仍等待 |
| P3-c | 无上下文菜单键，键盘用户完全打不开行菜单 | `ContextMenu` / `Shift+F10` 分支，在目标行上派发真实 `contextmenu` 事件复用既有 handler（openMenu 契约零改动）；放在空列表判断之前，空文件夹也能开文件夹菜单 |
| P4 | 新建草稿不随目录切换清理（rename 有、creating 没有）：程序化导航（⌘J）后草稿活到新目录，文件会建到用户后来跳去的目录 | 与 rename/pendingDelete 对称补 `setCreating(null)`；指针导航本就先 blur 提交，此 effect 只是兜底 |
| P5 | Up 按钮 `localParent` 失败被 `void` 丢弃，静默无提示 | 包 try/catch 走 setError，与 goHome 一致 |
| P6 | 首屏加载失败时错误行的 Retry 变成 `load("")`，永远失败 | 三级回退：retryTransfer → path → draft → goHome |
| R15 | **集成裂缝**：布局代理移除 FTP 题头 `aria-label` 后，`VirtualFileRows.test.ts:190` 的旧选择器会失配 | 补 `data-sort-key` 稳定句柄并更新选择器；连带修好 `scripts/` 下三个诊断脚本的同款失配（`check-file-performance.mjs`、`check-review-ui.mjs`、`compiler-experiment.mjs`） |

交互维度另确认 9 项健康（R8–R14、R16：拖出阈值、上传菜单 toggle、工具栏禁用条件、Ctrl+方向键与平台惯例、排序持久化三方共享、虚拟窗口下 aria-activedescendant 生命周期、放置判定分级、store 持久化键对称），逐条核对未改。

## 三、动画效果维度（16 处 motion 声明 + 3 段 keyframes + 2 个扩展 reduced-motion 块）

**修前状态**：整个文件浏览界面只有 3 处动效（拖拽环/列表着色 100ms、进度条 80ms linear、不确定态扫动），其余状态切换全部瞬时硬跳。

| 对象 | 方案 |
|---|---|
| Filer 行（悬停/选中/拖出变暗） | 基态 `transition: background-color+opacity 120ms ease`（背景规则在 panels.styles.css，transition 挂行上，拖出变暗双向淡入） |
| 大小/修改时间两列（用户点名） | `.row-meta` 颜色 120ms，日期两个半格各补 120ms（出场同步） |
| 行内新建/重命名行出现 | `filer-row-in` 140ms cubic-bezier(0.2,0,0,1)，淡入+3px 上升，与 dialog-in 同一 idiom；只动 opacity/translate 不触发重排 |
| 加载/错误/空态、传输卡、队列摘要出现 | `filer-fade-in` 140ms |
| 面包屑/列题头悬停、路径框焦点边框 | 120/120/100ms，对齐应用既有档位 |
| 双面板整行反馈（此前**零过渡**，最高危项） | `.ftp-file-row` 120ms 覆盖 hover/选中/拖出/放置目标四态；列表窗格、题头、工具钮（80ms 对齐 panel-action）、传输钮（100ms 对齐 .btn）、路径框、消息淡入逐一补齐 |

时长词汇表：80ms 图标钮／100ms 按钮与边框／120ms 面状态／140ms 出现动效。`prefers-reduced-motion` 下全部 animation 置 none，颜色/透明度类 transition 依 `.panel-action` 既有先例保留。进度条 80ms linear 两侧一致且对速率传达正确，判定健康不改；排序重排维持瞬时（虚拟窗口下 FLIP 成本高且用户主动排序期望立即重排）。

## 四、文案描述维度（6 项 + 1 项授权补充，全部已修）

| # | 问题 | 方案 |
|---|---|---|
| P1 | 行 tooltip 属主是唯一无标签项（裸 `root:root`，而类型/大小/权限全有标签），且 `filer.tipOwner` 是死键 | 启用带标签输出；`filer.mode` 统一用品传入的 `t` |
| P2 | 日期戳中文"（本机时间 +08:00）"把"时间"与偏移量混在一起，易读成"服务器 mtime 就是本机时间" | 改"（本机时区 +08:00）"，说清这是本机解读；en 不动 |
| P3 | 上传/下载按钮 `title` 带"仅 SSH"后缀而 `aria-label` 不带，读屏用户拿不到禁用原因 | aria-label 同样走 `remoteTitle()` |
| P4 | 双面板未知日期显示 `—`，与 Filer 列刻意说出的 "Unknown/未知" 自相矛盾 | 改说 `filer.dateUnknown` |
| P5 | 中文删除多项确认"删除这 {count} 个选中项目？"拗口 | "删除选中的 {count} 个项目？" |
| P6 | stage 完成态"可以放下了"是口语祈使，其余状态全是陈述句 | "拖拽已就绪" |
| R1（授权补充） | 删除对话框中文渲染出 ASCII 空格（"删除 文件 nginx？"） | 按语言连接：中文去空格，en 逐字节不变 |

主理人追加裁决：双面板文件夹大小的 `—` 改为空单元格，与 Filer 行及第一轮"保留空单元格"的既定决策一致（无测试断言该串）；`filerPresentation.tsx` 中因此变为真实的注释同步修正。

## 五、已定位、本轮未修（按影响面排序）

| # | 问题 | 影响 | 备选修法 |
|---|---|---|---|
| R3 | **双面板浏览器完全没有键盘操作**：list 有 `role="listbox"` 但无 tabIndex/activedescendant/keydown，行不可聚焦。键盘用户在 FTP/SFTP 双面板里无法选择、无法激活任何条目 | 中高，本轮最大交互缺口 | 引入光标 + activedescendant + 焦点管理，镜像 FilerPanel；改动面大，建议单独立项 |
| R1 | 新建/重命名的 blur 提交与点击选择竞争：提交后 `load` 清掉刚点的那一行选择 | 中 | commit 前快照 `selection.paths`、load 后 replace（`removeEntries` 已是这个模式）；或给 load 加"保留选择"参数（改 hook 契约） |
| R2 | 三个状态 div 与新建行是 `role="listbox"` 直接子节点，既非 option 也非 group（第一轮第 3 项） | 中 | 移出 listbox；牵连布局 CSS 与 revealActiveRow 的 offset 计算，需专项 |
| R4/R6 | 被阻止的放置/复制提示误走 `role="alert"` 且带无用的 Retry；传输开始/完成/失败/取消无 aria-live 宣告 | 低 | 错误行加"是否可重试"区分；独立 polite 区域只在 status 变化时写一次短句（进度本身不要 live，会刷屏） |
| R5 | 无 type-ahead（首字母跳转），千行虚拟列表里定位文件名只能滚或排序 | 低 | 累积 buffer + 超时重置 + 大小写不敏感 + 从光标后循环匹配 |
| R7 | 重名检查大小写敏感，Windows/macOS 上 "File.txt" vs "file.txt" 漏过（后端会报错，影响有限） | 低 | 比较时统一大小写 |
| U3 | 菜单键/F2 在光标行被滚出虚拟窗口时静默无响应 | 已知限制 | 与 F2 现状一致故保持；方向键移动时会 reveal，纯键盘路径不受影响 |
| — | 第一轮文档第三节的其余未做项（首屏空态闪烁、排序列方向图标资产、`replaceConfirm` 的 "1 item(s)"、传输 aria-live、`filer.home` 术语、触控行高 24px） | — | 状态未在本轮重新核实，以第一轮文档为准；其中第 9/10/14 项已在本轮关闭 |

## 六、跨代理协作中拦住的集成问题（本次方法的实证）

1. **R15**：布局代理改动打破交互代理写的测试选择器——只读清单阶段抓不到，靠交互代理通读全部测试时发现；主理人集中验证前完成修复。
2. **lint 错误**：交互代理新增的 hook 依赖被 Biome 拦截，主理人验证时按仓库 `biome-ignore` 约定修复（首行注释须紧贴代码，多行注释会使抑制失效——第一版写错，重跑后纠正）。
3. **注释矛盾**：FTP 文件夹大小 `—` 与 Filer 注释声称"双面板显示空格"互相矛盾，由主理人裁决统一并修正注释。
4. **死键激活**：文案代理发现 `filer.tipOwner` 自第一轮起就是死键，修 P1 时启用。

## 七、改动文件清单

源码：`src/styles/filer.styles.css`、`src/styles/ftp.styles.css`、`src/components/panels/FilerPanel.tsx`、`src/components/panels/filerPresentation.tsx`、`src/components/panels/useFilerDirectory.ts`、`src/components/ftpPresentation.tsx`、`src/components/DeleteEntryDialog.tsx`、`src/locales/zhCN.ts`（en.ts 本轮零改动、键名零变化）。
测试与脚本：`src/components/panels/FilerSelection.test.ts`（+5 回归）、`src/components/VirtualFileRows.test.ts`（选择器）、`scripts/` 三个诊断脚本（选择器）。
