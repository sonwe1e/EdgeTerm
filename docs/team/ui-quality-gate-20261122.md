# 界面质量门禁与第一批可视化修复（2026-11-22）

本轮目标：在没有图像输入的前提下，把"视觉／交互细节"变成可复跑的数值判据，并用它修掉第一批实测缺陷。
约束：不引入依赖、不改业务流程、四套主题继续共用同一 token 集、不改已确认的交互契约（键盘优先、sash 规则、列表模型）。

## 一、新增能力

**[src/uiAudit.ts](../../src/uiAudit.ts)**：纯 DOM 测量，不含 React／store／IPC。

| 函数 | 判据 |
| --- | --- |
| `parseColor` / `composite` / `contrastRatio` | 计算样式与手写色值的解析、alpha 合成、WCAG 2.x 对比度（锚定 21:1、4.54:1 等公开参考值） |
| `surfaceBehind` | 沿祖先链逐层合成真实背景；渐变／滤镜／backdrop-filter 标为"不可判定"，不算通过 |
| `textContrastIssues` | 逐条直接文本的墨色对真实背景的比值；大字号按 24px 或 18.66px+bold 放宽到 3:1 |
| `targetSizeIssues` | WCAG 2.2 SC 2.5.8：24×24 或以控件为中心的 24px 圆不与其它目标相交（间距例外）；另设 16px 可用性下限，低于它即便间距干净也报告。label 包裹的输入框按标签计 |
| `clippedTextIssues` | `overflow: hidden` 且既无省略号也无 tooltip 的文字；`sr-only`（1px 盒）按设计豁免 |
| `styleCensus` | 实际绘制的字号／行高／圆角／颜色频次表，用于发现字阶与形状漂移 |

**[src/test/uiAudit.browser.test.ts](../../src/test/uiAudit.browser.test.ts)**：真实 Chromium 中挂载真实 App（合成会话与文件列表、受控 IPC），覆盖
`dark-1440×900-zh`、`light-1100×720-en`、`serialx-dark-900×560-en`；断言三个收集器全空。另有两条独立断言：

- 具名控件必须达到 24px（面包屑每个祖先、SSH 复用折叠行、面板图标按钮、标签关闭按钮），层叠 token 必须满足 `dialog > drag > popover > hud`，四套主题都必须声明 `--shadow-menu/--shadow-pop/--scrim`。
- **负向控制**：在同一棵刚通过的树上注入"旧盒子模型 + 旧墨色"，门禁必须报出命中区与对比度缺陷。这样"无问题"不是空判。

## 二、基线 → 修复后（同一门禁、同一内容）

| 配置 | 对比度违规 | 命中区违规 | 截断（排除 sr-only） |
| --- | --- | --- | --- |
| dark 1440×900 zh | 0 → 0 | 4 → **0** | 7（sr-only 误报）→ **0** |
| light 1100×720 en | 1 → **0** | 4 → **0** | 同上 → **0** |
| serialx-dark 900×560 en | 0 → 0 | 4 → **0** | 同上 → **0** |

检查量：每配置 70–71 条文本运行、47 个指针目标。基线缺陷明细：`/summary/ 196×14`、根面包屑 `5×15`（且 24px 圆与邻居相交）、`home 33×15`、`build 29×15`；light 主题 `.agent-compose-label` 4.21:1。

## 三、修复清单

| # | 位置 | 处理 |
| --- | --- | --- |
| 1 | `.filer-crumb`（[filer.styles.css](../../src/styles/filer.styles.css)） | 整条 24px 高、≥24px 宽、4px 横向内距、圆角与 hover 底色；根 "/" 不再是 5px 目标 |
| 2 | `.ssh-connection-options summary`（同上） | 14px 文本行 → 24px 可点行 |
| 3 | `.panel-action`（[panels.styles.css](../../src/styles/panels.styles.css)） | 22 → 24px（`--h-control`）并 `flex: none`：拥挤的面板头曾把声明 24px 压成 21.6px；行内 action 改为只缩放字形，目标不再随 hover 在 21.6↔24 间变化 |
| 4 | `.tab-close`（[tabs.styles.css](../../src/styles/tabs.styles.css)） | 22 → 24px |
| 5 | `.agent-compose-launch` / `.agent-inline-tabs .is-active`（[agent.styles.css](../../src/styles/agent.styles.css)） | `--accent-bright` → `--accent-ink`；light 由 4.21:1 提到约 5.57:1（`#004f98` on `#bed6ed`） |
| 6 | 层叠阶梯（[foundation.styles.css](../../src/styles/foundation.styles.css)） | 新增 `--z-menu/--z-drop/--z-hud/--z-popover/--z-drag/--z-dialog`；拖拽幽灵与状态浮层原本同为 1000，现为 1001/1000 |
| 7 | `--scrim`（四套主题）+ [dialogs.styles.css](../../src/styles/dialogs.styles.css) | 弹窗遮罩从写死 `rgba(0,0,0,.5)` 改为按调色板取值（dark .5 / light .35 / serialx-dark .62） |
| 8 | serialx-dark | 补上从未声明的 4 个阴影变量；此前回落到为 #181818 调的默认值 |
| 9 | 分隔线 `::before`（[status.styles.css](../../src/styles/status.styles.css)） | 补 `prefers-reduced-motion` 守卫（该文件此前是唯一缺失） |
| 10 | git 工作区字重（[gitWorkspace.styles.css](../../src/components/git/gitWorkspace.styles.css)） | 650／550 → 600／500，回到全站字重阶梯 |

## 四、验证

- `npm run typecheck` 通过；`npm run format:check` 502 文件通过。
- `npm test -- src/uiAudit.test.ts`：8/8（颜色数学与 DOM 路径）。
- `npm run test:browser -- src/test/uiAudit.browser.test.ts`：5/5（含负向控制）。
- 全量前端单测：168 文件／1663 用例通过。
- 全量浏览器契约：41 文件／213 用例通过（真实 Chromium，含本轮新增 5 条）。
- 结论只覆盖 Chromium + 受控 IPC；无 WebView2、无真实服务器、无中文 IME 验证。

## 五、边界与下一轮候选

- 门禁目前只覆盖 shell（菜单栏、标签条、面板、文件列表、状态栏）与三种主题组合；弹窗、双栏 FTP、git 工作区、Agent 面板尚未接入。
- 按价值排序的候选（均来自本轮调研，未实施）：
  1. **命令面板**（Ctrl+Shift+P）覆盖动作／会话／设置／传输——全库未检索到；WT／Termius／Warp 已有。
  2. **终端关键字高亮／触发器 + 命中索引**——iTerm2／SecureCRT／Xshell 有上色，未见"可点击索引"。
  3. **RTT／丢包进状态栏**——FinalShell、iTerm2 已有；EdgeTerm 只有资源趋势。
  4. **行级时间戳 + 命令块**（开始时间／耗时／退出码）。
  5. FTP 行节拍 29px 与 Filer 26px 统一；排序方向指示只有 16px 箭头。
  6. 动效 token 化（75 条动效／14 种时长／81% `ease`）与 z 阶梯全面接入。
  7. 空状态即入口（最近连接、模板、健康检查）。
