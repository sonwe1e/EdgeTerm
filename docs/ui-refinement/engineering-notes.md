# 工程审计笔记（EdgeTerm 界面精修 · 第一轮）

审计人：前端工程专家（frontend）
日期：2026-10-20
范围：只读代码 + 本文件；未修改任何源码，未运行重活（tauri:dev / build / test:browser 均未执行）。

---

## 1. 工程事实清单

### 1.1 CSS 导入架构

CSS 只有一个入口，不存在第二处 `import "./styles.css"`：

| 位置 | 内容 |
| --- | --- |
| `src/main.tsx:8` | `import "./styles.css";` — 全应用唯一入口 |
| `src/styles.css`（12 行） | 11 条 `@import`，按级联顺序引入 `src/styles/*.styles.css` |

`src/styles.css` 的导入顺序（文件首行注释写着 *"Keep imports in cascade order. Component styles live beside their domain."*）：

```
foundation → shell → panels → tabs → terminal → ftp → sender → status → dialogs → filer → workbench
```

补充事实：

- `src/styles/foundation.styles.css:1` 还有一条 `@import "@xterm/xterm/css/xterm.css";`，即 xterm 自带样式也走这条链。
- `src/themes.test.ts:5` 用 `import STYLES from "./styles/foundation.styles.css?raw"` 把 foundation 当纯文本读进来做 token 断言。**这是唯一被测试直接读取的样式文件。**
- 组件里没有散落的 CSS import；所有样式都走这一条链。

### 1.2 组件清单（行数）

统计口径：`src/components/`、`src/components/panels/`、`src/workbench/` 下的 `.ts` + `.tsx`（含测试文件）。

| 目录 | 文件数 | 总行数 |
| --- | --- | --- |
| `src/components/` | 58 | 12,506 |
| `src/components/panels/` | 20 | 6,771 |
| `src/workbench/` | 36 | 8,731 |
| **合计** | **114** | **28,008** |

行数最大的实现文件（非测试）：

| 文件 | 行数 | 说明 |
| --- | --- | --- |
| `src/components/MenuBar.tsx` | 1,409 | 菜单栏 + 全部下拉/子菜单 |
| `src/components/SessionDialog.tsx` | 1,397 | 会话编辑对话框（lazy 加载） |
| `src/workbench/store.ts` | 1,196 | Workbench 独立 store |
| `src/components/panels/FilerPanel.tsx` | 1,127 | Filer 面板 |
| `src/components/panels/SessionPanel.tsx` | 948 | 会话树面板 |
| `src/components/TabStrip.tsx` | 682 | 标签栏 |
| `src/components/panels/SenderPanel.tsx` | 594 | Sender 面板 |
| `src/workbench/Workbench.tsx` | 591 | 实验台外壳 |
| `src/components/panels/filerPresentation.tsx` | 556 | Filer 行渲染（含 4 个 memo 子组件） |
| `src/components/PanelDocks.tsx` | 430 | 面板停靠区 |
| `src/components/FtpPane.tsx` | 427 | FTP/SFTP 双栏工作区 |
| `src/components/ftpPresentation.tsx` | 423 | FTP 行渲染 |
| `src/components/ModalDialog.tsx` | 418 | 对话框原语 |
| `src/components/TerminalPane.tsx` | 348 | 终端宿主 |
| `src/App.tsx` | 854 | 应用外壳组装 + 全部对话框挂载点 |

应用外壳的组装关系（`src/App.tsx`）：

```
.app
├── MenuBar                     ← 菜单栏
├── .app-body
│   ├── .main
│   │   ├── DockArea(left)      ← SessionPanel / FilerPanel / SenderPanel
│   │   ├── Splitter
│   │   ├── .center
│   │   │   ├── Workspace 或 Workbench   ← 主工作区（二选一）
│   │   │   └── SearchOverlay
│   │   ├── Splitter
│   │   └── DockArea(right)
│   └── DockArea(bottom)        ← Sender 常驻底部
├── StatusBar                   ← 状态栏（含 ResourceMonitorBar / ForwardCenter / TransferCenter）
└── 全部对话框（条件挂载）
```

面板与停靠位的映射在 `src/panelDock.ts`；三个面板名是 `PanelName = "filer" | "sessions" | "sender"`（`src/storeTypes.ts:110`）。

### 1.3 状态管理

**两个互相独立的 Zustand store：**

| Store | 定义位置 | Hook | 状态类型 | 行数 |
| --- | --- | --- | --- | --- |
| 主 store | `src/store.ts` | `useStore` | `AppStore`（`src/storeTypes.ts`，398 行） | 114 |
| Workbench store | `src/workbench/store.ts` | `useWorkbench` | `WorkbenchState`（同文件 231–303 行） | 1,196 |

主 store 的组装方式（`src/store.ts:58-111`）：`create<AppStore>` 里先写初始 state，再展开四个 action factory：

```
...createProfileActions(set, get, store)   // src/storeProfileActions.ts
...createTabActions(set, get, store)       // src/storeTabActions.ts
...createPreferenceActions(set, get, store)// src/storePreferenceActions.ts
...createPromptActions(set, get, store)    // src/storePromptActions.ts
```

`AppStore` 的字段分组（按 `storeTypes.ts` 的声明顺序）：profiles/groups、tabs/activeId、panes/layout/activePaneId、draggingTabId/dropTarget、panelPreferencesRevision、filerSort、theme/language、字号与字体族、终端参数（scrollback/cursor/gpu）、布尔偏好（sshAutoReuse/suggestionsEnabled/pasteWarning/copyOnSelect）、各类 prompt（pastePrompt/clipboardPrompt/hostKeyPrompt/sshConfigImport/authPrompts/closePrompt/filerTarget）、senderLibraryVersion，以及约 60 个 action。

**选择器使用模式（重要，直接影响精修时的重渲染行为）：**

- 主流写法是**细粒度单字段选择器**：`useStore((s) => s.xxx)`。全仓 `src/components/**/*.tsx` 有 104 处 `useStore(` 调用，绝大多数是这种形式。
- **没有任何组件用无选择器的 `useStore()` 订阅整个 store**（已 grep 确认 0 处）。
- 共享 hook：`useActiveTab()`（`src/store.ts:113-114`），内部是 `useStore((s) => s.tabs.find(...))`。StatusBar、ForwardCenter 用它。
- 唯一使用 `useShallow` 的地方是 `src/App.tsx:144-151`（`closingTabs`），注释解释了原因：tab 列表每次 resize 或另一个 tab 的命令状态变化都换标识。
- `src/App.tsx:126-129` 用返回 boolean 的派生选择器（`fileMode`），注释同样说明「不能订阅 tab 对象」。
- Workbench store 自带 localStorage 持久化（`VIEW_STORAGE_KEY` 等，键名集中在 `src/persistKeys.ts`），并有文档数上限 `MAX_DOCS = 8` / `HARD_MAX_DOCS = 16` / `MAX_DOC_CHARS = 8_000_000`。

### 1.4 虚拟化现状

**文件列表虚拟化：`src/components/VirtualFileRows.tsx`（147 行，自研，无第三方库）**

| 参数 | 值 | 位置 |
| --- | --- | --- |
| 启用阈值 | `VIRTUAL_THRESHOLD = 200` 行 | 第 10 行 |
| 过扫描 | `OVERSCAN = 6` 行 | 第 11 行 |

实现要点：

- `fileRowRange(count, top, height, pitch)` 是纯函数（第 14-21 行），可独立单测。
- 虚拟化时用**绝对定位**：容器 `height: entries.length * rowHeight`，每行 `top: index * rowHeight`。
- 滚动测量用 `ResizeObserver` + `MutationObserver` 同时观察 scroller **及其每一个子节点**（第 73-95 行）。原因写在注释里：Filer 在行容器上方渲染内联新建行、FtpPane 渲染错误/加载/空态，这些兄弟节点会移动行容器而不改变它的大小。
- 重新测量的依赖是 `[entries.length, rowHeight, resetKey]`（第 115-118 行），注释明确要求「父组件带着未变的输入重渲染（切 tab、传输 tick）不得强制同步 layout」。
- 拖拽捕获的行即使滚出视口也保持挂载（第 124-126 行）。
- 使用者：`FilerPanel`、`FtpPane`、`TransferCenter`、`ForwardCenter`。

**终端渲染：xterm 6.0.0 + WebGL**

- 控制器：`TerminalController`（`src/terminal.ts:47`）。
- GPU 渲染器：`src/terminalGpuRenderer.ts`，用 `@xterm/addon-webgl` 的 `WebglAddon`，带 context-loss 处理与 DOM 回退。
- **终端输出不经过 React store**：`src/App.tsx:298-300` 的注释说明每个会话的字节走 `connectSession` 的原始通道直入 controller（Rust 侧 `OutputPump`）。所以终端高频输出不会触发 React 重渲染。
- 隐藏面板用 `display: none` 而非 `visibility: hidden`（`src/styles/terminal.styles.css:87` 注释 + `scripts/check-hidden-render.mjs` 的门禁），这样 xterm 的渲染器会暂停。
- `TerminalController.setVisible` 控制 WebGL 渲染器的保留/释放：最近显示过的 tab 保留，其余放弃。

### 1.5 测试

**配置位置：`vitest.config.ts`（97 行，仓库根目录）**

两个 project 共用一个 runner：

| Project | 环境 | 匹配文件 | setup | 运行命令 |
| --- | --- | --- | --- | --- |
| `unit` | jsdom | `src/**/*.test.ts` + `scripts/**/*.test.mjs`，排除 `*.browser.test.ts` | `src/test/setup.ts` | `npm test` |
| `browser` | Playwright headless Chromium | `src/**/*.browser.test.ts` | **不加载** setup.ts | `npm run test:browser` |

配置里的关键细节：

- `maxWorkers: 2`、`maxConcurrency: 2`（Windows 预算）。
- 两个 project 都设 `css: { include: [/styles\.css/] }`，即 **测试里 CSS 是真实 CSS**，vitest 不会 stub 掉（包括 `?raw` 导入）。
- browser project 预声明 `optimizeDeps.include`（react、zustand、xterm 全家桶等），避免首次 import 触发依赖重新优化导致页面重载、React 实例混用。
- 平台常量 `__EDGETERM_MAC__` / `__EDGETERM_WINDOWS__` / `__EDGETERM_TEST_HOST__` 在 vitest.config.ts 里从 `process.platform` 重新声明（vite.config.ts 的 define 不继承到 vitest）。
- `PERF_BROWSER` 环境变量可切换系统浏览器通道（如 `msedge`）。

**测试文件数量：**

| 类型 | 数量 |
| --- | --- |
| `src/**/*.test.ts`（unit） | 96 |
| `src/**/*.browser.test.ts` | 12 |
| `scripts/**/*.test.mjs` | 3 |

**跑单个测试文件：**

```powershell
npm test -- src/fileSort.test.ts          # unit 项目，仓库 AGENTS.md 明确记载此用法
npm run test:browser -- src/xxx.browser.test.ts   # browser 项目
```

`npm test` 实际展开为 `vitest run --project unit`（见 `scripts/run-task.mjs:16`），所以 `--` 后的路径过滤器只作用于 unit 项目。

---

## 2. 性能基线

### 2.1 typecheck

```
命令：npm run typecheck
结果：通过（exit 0），无任何错误输出
环境：Node v24.19.0，jobs=2，CPUs=4，below-normal priority
```

基线是干净的：**当前 HEAD 无既有类型错误**。后续每一轮精修都应保持这个状态（工程规范 R8 要求每个提交自身通过 typecheck）。

### 2.2 渲染热点

已确认的 memo 边界（12 处）：

| 组件 | 位置 | memo 原因（源码注释） |
| --- | --- | --- |
| `StatusBar` | `StatusBar.tsx:141` | 唯一 prop 只在 workbench 接管主机采样时变，其他重渲染跳过整条状态栏 |
| `ResourceMonitorBar` | `ResourceMonitorBar.tsx:14` | 自带轮询，只订阅 `panelPreferencesRevision` |
| `ForwardCenter` | `ForwardCenter.tsx:28` | — |
| `TransferCenter` | **未 memo** | — |
| `SessionPane` | `TerminalPane.tsx:47` | 切 tab 或另一个 tab 的命令状态变化会改 tab 列表，每个 pane 都会重渲染 |
| `FilerPanel` | `FilerPanel.tsx:1127` | — |
| `FilerRow` / `FilerSize` / `FilerEntryIcon` / `FilerDate` | `filerPresentation.tsx:93,176,191,522` | 行级 memo |
| `FtpFileRow` | `ftpPresentation.tsx:285` | 行级 memo |
| `FileIcon` | `FileIcon.tsx:51` | — |
| `Sparkline` | `workbench/Sparkline.tsx:13` | 配合 `useMemo` 稳定的 series 数组标识 |

**高频更新路径（精修时最容易被破坏的地方）：**

1. **`TabStrip` 订阅整个 `s.tabs` 数组**（`TabStrip.tsx:156`）。tab 数组在每次终端 resize（`setSize`）和任何 tab 的命令状态变化（`markCommandStarted` / `markCommandCompleted`）时都会换标识。`SessionPane` 的 memo 正是为挡住这条路径而存在——**给 TabStrip 或 Workspace 加新订阅时要特别小心**。
2. **`Workspace.tsx` 订阅 6 个字段**（`Workspace.tsx:76-83`）：`layout`、`panes`、`tabs`、`activeId`、`activePaneId`、`dropTarget`。它是终端区域的直接父级。
3. **`ResourceMonitorBar` 自带轮询**：默认按 `settings.intervalSeconds` 调 `api.sampleResources`，每次采样 `setSample` + `setHistory`。它已 memo 且只订阅 revision，所以这条路径目前不外溢；但它的 `tab` prop 来自 `StatusBar` 的 `useActiveTab()`，而 `useActiveTab` 订阅的是 `s.tabs.find(...)` 的结果对象——**tab 对象每次 resize 都变**，所以 `StatusBar` 本身会在 resize 时重渲染（memo 挡不住 prop 变化）。
4. **`TransferCenter` 未 memo**，且同时订阅主 store 的 `panelPreferencesRevision` 和独立的 `useFileTransfers` store（`src/fileTransfers.ts`）。传输进行中它每秒多次重渲染。
5. **`MenuBar.tsx` 有约 35 个 store 选择器**（`MenuBar.tsx:298-338`），是选择器最密集的文件。
6. **`App.tsx` 有约 50 个 store 选择器**，是整个 React 树的重渲染源。所有对话框的条件挂载都在这里。

**终端输出不经过 React**（见 1.4），所以「终端刷屏导致界面卡」这类问题在本项目里不存在于 React 层；卡顿只可能来自 xterm 渲染器本身或 WebGL。

### 2.3 CSS 体积

`src/styles/` 11 个文件合计 **8,038 行 / 197,624 字节（约 193 KB）**。另有 `src/styles.css` 本身 12 行。

| 文件 | 行数 | 字节 | 占比 |
| --- | --- | --- | --- |
| `workbench.styles.css` | 1,962 | 37,645 | 24.4% |
| `dialogs.styles.css` | 1,338 | 30,390 | 19.1% |
| `filer.styles.css` | 824 | 31,387 | 15.9% |
| `ftp.styles.css` | 845 | 21,574 | 10.9% |
| `sender.styles.css` | 729 | 15,491 | 7.8% |
| `foundation.styles.css` | 474 | 15,466 | 7.8% |
| `shell.styles.css` | 567 | 13,830 | 7.0% |
| `tabs.styles.css` | 515 | 13,197 | 6.7% |
| `panels.styles.css` | 356 | 7,841 | 4.0% |
| `status.styles.css` | 234 | 6,407 | 3.2% |
| `terminal.styles.css` | 194 | 4,396 | 2.2% |
| **合计** | **8,038** | **197,624** | 100% |

注意：`filer.styles.css` 行数少于 `ftp.styles.css` 但字节更大（注释密度低、长选择器多）。**字节数比行数更能反映实际负载**。

`foundation.styles.css` 虽只占 7.8%，但它是 token 唯一定义处，改动影响面最大。

---

## 3. 可视化验证路径

### 3.1 环境就绪度（已实测）

```
命令：./dev.ps1 doctor
结果：通过。Node v24.19.0 / npm 11.17.0 / cargo 1.99.0 / rustc 1.99.0
      MSVC 14.44.35207 / Windows SDK 10.0.26100.0 / cmake / ninja / git 全部就位
      预算：4 逻辑 CPU（cpuMask 15）、cargoJobs=2、freeMemory 31.9 GiB
```

唯一噪音：`vswhere.exe` 不在 PATH 里打了一行警告，不影响结果（doctor 仍输出完整 JSON）。

**结论：本机可以跑起真实应用做视觉验证。**

### 3.2 路径 A：真实桌面应用（`npm run tauri:dev`）

```powershell
./dev.ps1 tauri:dev
```

可行性依据：

- 工具链完整（见 3.1）。
- `src-tauri/target/` 已有 **debug（2026-10-19）和 release（2026-10-20）构建产物**，增量编译，首次启动不会从零编译 Rust。
- Vite dev server 固定端口 1420（`vite.config.ts:33`，`strictPort: true`）。

**本轮未执行**（属于重活，且 Windows 规则要求一次只跑一个 managed task）。启动后会占用该任务槽，直到手动停止——后续实现轮次跑它之前要先确认没有其他 managed task 在跑。

限制：需要真实 SSH/FTP 服务器才能看到完整功能态；本地 ConPTY 会话（`kind: "local"`）不需要服务器，足够验证外壳、面板、对话框、Workbench 的视觉。

### 3.3 路径 B：浏览器 harness（无需真实服务器，推荐用于日常视觉验证）

`scripts/README.md` 记载了四类隔离 harness，都用 Playwright 驱动 headless 浏览器、mock Tauri IPC、加载**真实组件与真实 styles.css**：

| 脚本 | 覆盖范围 | 命令 |
| --- | --- | --- |
| `check-review-ui.mjs` | FtpPane + FilerPanel 双栏 + 真实 CSS；拖放、排序、传输调用 | `./dev.ps1 script scripts/check-review-ui.mjs` |
| `check-app-font-chain.mjs` | 构建**真实生产 bundle** 后驱动整个 App；断言 12/18px 字阶链、日期列裁切，并在 1100px/760px 存截图 | `PERF_BROWSER=msedge ./dev.ps1 script scripts/check-app-font-chain.mjs app-font-msedge-<date>` |
| `check-gutter-alignment.mjs` | 真实 SessionPane 的 hide→resize→show 链 + 真实 xterm 行矩形测量 | `./dev.ps1 script scripts/check-gutter-alignment.mjs gutter-check-chromium` |
| `check-file-performance.mjs` | 10,000 行列表首绘与 tab 切换的**性能门禁**（中位数 5 样本，超限 exit 1） | `./dev.ps1 script scripts/check-file-performance.mjs` |

另有 `npm run test:browser`（12 个 `*.browser.test.ts` 契约测试，真实布局测量/指针捕获/媒体查询）。

截图与结果落在 `artifacts/performance/` 和 `.tmp/records/implementation-03/`。

### 3.4 验证路径的具体缺口

| 缺口 | 说明 |
| --- | --- |
| **应用外壳无 harness** | `check-review-ui.mjs` 只挂 `FtpPane` + `FilerPanel`。MenuBar、TabStrip、会话树（SessionPanel）、面板停靠/拖拽（PanelDocks）都没有现成的浏览器 harness。 |
| **对话框无 harness** | 全部对话框（SessionDialog 及 15+ 个）只能靠路径 A 或新写 harness 验证。 |
| **Workbench 无 harness** | `check-app-font-chain.mjs` 驱动的是终端视图的 App，不覆盖 Workbench 视图。 |
| **终端真实渲染不覆盖** | 真实终端需要 PTY 会话 + xterm；`scripts/README.md` 明确说 tab 切换门禁「不覆盖终端 tab」。 |
| **WebView2 帧时间/GPU 成本不覆盖** | 需要 disposable CDP app instance（`check-native-terminal-tabs.mjs` 等），且要求便携版 release、无存档 profile。 |
| **浏览器 harness 需要 Edge/Chromium** | 默认 `msedge` 通道；干净机器要 `npx playwright install msedge`（或装 Edge）。本机 doctor 未验证此项，首次跑路径 B 前建议先确认。 |

**给后续实现者的建议**：日常精修用路径 B 的 `check-app-font-chain.mjs` 做回归（它构建真实 bundle 且会存截图，最适合看视觉变化），需要看完整外壳时用路径 A 的本地 ConPTY 会话。若要给外壳/对话框/Workbench 建立可复现的视觉验证，需要新写 harness——这是当前最大的工程缺口。

---

## 4. 实现注意事项（给后续实现者）

### 4.1 CSS / token 体系

1. **改 `src/styles.css` 的 `@import` 顺序会改变级联结果。** 新增样式文件必须按语义插到正确位置，不能直接追加到末尾。注释明确要求保持级联顺序。
2. **`foundation.styles.css` 是 token 唯一定义处，且被测试当纯文本读取。** `src/themes.test.ts` 用 `?raw` 导入它并断言：每个主题都有 palette 块、声明了正确的 `color-scheme`、`--bg-active` 对 `--bg-panel` 的对比度 ≥ 1.25:1。**重命名或删除任何 token 会直接打破这个测试。**
3. **四个主题必须同步修改**：`dark`（`:root` 默认）、`light`、`serialx-dark`、`serialx-light`。另外 `index.html:15` 的内联预绘脚本里也硬编码了这四个名字（`var themes = ["dark", "light", "serialx-dark", "serialx-light"]`），新增主题模式时三处都要改，且 `themes.test.ts` 会检查 index.html 是否列全。
4. **间距/圆角/高度 token 在 `foundation.styles.css:93-113`**（`--sp-2` 到 `--sp-16`、`--radius-xs` 到 `--radius-pill`、`--h-control-xs` 到 `--h-bar`）。注释明确说「高度绝不吸附到邻近档位——控件或行高改 1px，下面堆叠的一切都会移位」。改这些值会级联影响所有组件，属于高风险改动。
5. **字阶 `--fs-2xs` 到 `--fs-md` 声明在 `.app` 上而不是 `:root`**（`foundation.styles.css:366-376`）。原因是自定义属性在声明处解析：写在 `:root` 会冻结在 12px 默认值，无法跟随用户在显示设置里改的 `--panel-font-size`。**新增依赖面板字号的样式必须挂在 `.app` 的子树里。**
6. **`--row-h` 有两处定义**：`:root` 的 26px 是安全网，`.app` 的 `max(26px, calc(var(--panel-font-size) + 14px))` 是实际值。`VirtualFileRows` 的 `rowHeight` prop 必须与这个计算一致，否则行定位会错位。
7. **焦点环有一条全局规则**（`foundation.styles.css:405-418`）：`:where(button, a[href], [role=tab], [role=treeitem], [role=option], [role=menuitem], [role=menuitemradio], [role=separator], [tabindex]:not([tabindex="-1"])):focus-visible`。注释说明历史上大部分控件 Tab 到达时毫无反馈。**自己画环的组件（菜单行、tab）需要显式覆盖这条规则**，否则会出现双环。
8. **终端样式分两处**：`src/styles/terminal.styles.css`（搜索框、pane、拖放落点）和 `src/styles/ftp.styles.css:742`（覆盖 xterm 自带样式表的黑色背景）。改终端外观时两处都要看。
9. **CSS 总体积 193 KB，其中 workbench + dialogs + filer 占 59.4%。** 精修如果主要落在这三块，注意别让总量失控。

### 4.2 状态与订阅

10. **给组件加 `memo` 时先确认 props 的标识稳定性。** `StatusBar` 已经 memo 了，但它的 `tab` prop 来自 `useActiveTab()`，而 tab 对象每次 resize 都变——memo 在这里挡不住。这是现有代码里已经存在的外溢，不是新问题，但精修时不要误以为「加了 memo 就安全了」。
11. **`TabStrip` 订阅整个 `s.tabs` 数组**（`TabStrip.tsx:156`）。任何让 tab 数组更频繁换标识的改动都会直接打到标签栏。`SessionPane` 的 memo 是这条路径上唯一的屏障。
12. **`TransferCenter` 是状态栏里唯一未 memo 的子组件**，且同时订阅主 store 和 `useFileTransfers`。如果精修要动它，先补 memo 再改样式，否则传输中的高频重渲染会掩盖视觉问题。
13. **新增用户偏好必须注册到 `src/persistKeys.ts` 的 `PANEL_PREFERENCE_KEYS`**（或 store 自己的键）。文件头注释写明：未注册的偏好对「恢复默认设置」和数据导入/导出不可见。`persistKeys.ts` 必须保持无依赖（store 和面板都 import 它）。
14. **`panelPreferencesRevision` 是「面板偏好被外部改动」的广播令牌**。`ResourceMonitorBar`、`TransferCenter`、`FilerPanel`、`App.tsx` 都订阅它来重读 localStorage。新增需要跟随设置导入/重置的偏好，就 bump 这个 revision 并订阅它。

### 4.3 组件与图标

15. **图标必须复用 `src/components/icons.tsx` 的 Codicons 封装**（AGENTS.md 明确要求）。不要直接引 `@vscode/codicons` 或内联 SVG。
16. **所有用户可见文案走 `t()`**（`src/i18n.ts` + `src/useT.ts`）。新增 key 要同步加翻译；`themes.test.ts` 之外没有 i18n key 完整性测试，漏加只会在运行时暴露。
17. **`SessionDialog` 和 `FtpPane` 是 lazy 加载的**（`App.tsx:62`、`TerminalPane.tsx:26`）。改它们的 import 结构会影响首屏 bundle 体积。
18. **`VirtualFileRows` 的 `rowHeight` 必须与 CSS 的 `--row-h` 计算保持一致**（见第 6 条）。改行高时两端都要改。
19. **隐藏 pane 必须用 `display: none` 而非 `visibility: hidden`**（`terminal.styles.css:87` + `check-hidden-render.mjs` 门禁：旧实现 120/120 帧都在渲染，`display:none` 是 0 帧）。这是有回归测试守着的约定。

### 4.4 验证与提交

20. **Windows 上一次只能跑一个 managed task**（包括跨 worktree）。跑 `tauri:dev` 前必须确认没有其他 managed dev server / build / test 在跑；反之，启动 `tauri:dev` 会阻塞其他 managed task。
21. **不要用裸 `npx` / `cargo` 跑重活**，走 `./dev.ps1 <task>`。诊断脚本用 `./dev.ps1 script scripts/<name>.mjs`。
22. **`npm run typecheck` 是轻量命令，可以直接跑**（当前基线：通过，0 错误）。
23. **跑单个测试文件：`npm test -- src/xxx.test.ts`**；browser 契约：`npm run test:browser -- src/xxx.browser.test.ts`。
24. **提交规范（R8-R10）**：一个提交一个关注点；每个提交自身通过 typecheck；`perf:` 必须带 `Measured:` 或 `Unmeasured:`；`fix:` 必须带 `Tests:`；大提交要拆分或写 `Scope:`。PR 前跑 `npm run check:commits -- <base>..HEAD --typecheck`。
25. **性能声明要有测量**：`scripts/README.md` 里 `check-file-performance.mjs` 的门禁数字（首绘中位数 27.0 ms / 门禁 200 ms；tab 切换中位数 13.0 ms / 门禁 100 ms）是**单机数字**，改阈值或工作负载前要重新录制原始数据。

### 4.5 跨文件依赖提醒

26. **`src/persistKeys.ts` 被 store 和所有面板同时依赖**，且必须保持零依赖。往里加 import 会造成循环依赖风险。
27. **`src/storeTypes.ts` 是类型中枢**：`store.ts`、`storeLayout.ts`、`storePreferences.ts`、`storeProfileActions.ts`、`storePromptActions.ts`、`storeTabActions.ts`、`storePreferenceActions.ts` 全部 import 它。改 `AppStore` 接口要同步看这 7 个文件。
28. **`src/workbench/store.ts` 同时依赖主 store**（`import { useStore } from "../store"`，第 10 行）和自己的持久化键。两个 store 的边界在这里，改动时注意别让 workbench 反向依赖主 store 的 action。
29. **`foundation.styles.css` 同时被生产构建、`themes.test.ts`（`?raw`）、两个 vitest project（真实 CSS）和四个浏览器 harness 消费。** 它是全仓被读取次数最多的样式文件。

---

## 5. 一句话总结

CSS 走单入口 11 文件级联链、token 集中在 `foundation.styles.css` 且被测试守着；状态是两个独立 Zustand store，主流是细粒度单字段选择器、无整 store 订阅；文件列表有自研虚拟化（阈值 200 行），终端输出不经过 React；typecheck 基线干净（0 错误）；本机工具链完整、已有 Rust 构建产物，**可以跑 `./dev.ps1 tauri:dev` 做真实视觉验证**，日常回归推荐 `check-app-font-chain.mjs`（真实 bundle + 截图）；最大缺口是应用外壳、对话框、Workbench 三块没有现成浏览器 harness。
