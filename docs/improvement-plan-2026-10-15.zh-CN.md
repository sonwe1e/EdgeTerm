# 改造方案修订（2026-10-15）：九项审查结论与实施边界

本文是对 2026-10-15 收到的原始改造方案（#2–#10）的逐项修订。结论基于当日对本仓库
HEAD `91b962b1f9e9ee47f757a03425d3f20110df3331` 的源码核对与依赖注册表查询；文中标注
"外层基线" 的数字由外层监督方记录，本仓库内未复跑。规则遵循
[工程规范](engineering-standards.zh-CN.md)（R1–R10）：性能声明必须有同环境前后对照，
没有对照就写"收益待验证"；跨 IPC 的声明两侧都要有测试；一次提交只做一件事。

## 范围决定总表

| 项 | 决定 | 一句话理由 |
|---|---|---|
| #2 文件对比算法 | **本次实施** | 真实缺陷（64 行前瞻失步），可行为级回归 |
| #3 IPC 类型契约 | **部分实施**：file_diff 枚举化先行，绑定生成试点 | raw 字节路径（Request/Response、原始 Channel）是类型签名例外；普通命令与事件的生成覆盖以实际编译证据决定，不预先排除 |
| #4 ZMODEM/XMODEM 下沉 Rust | **暂缓**（非本次生产改动） | 互操作证据链未建立；现有实现已做内存分界 |
| #5 Biome 静态检查 | **本次实施**（有针对性规则集） | 零运行时成本；需同步修订 AGENTS.md 表述 |
| #6 React Compiler | **只做可比试验，不默认启用** | 缺少同环境前后对照；jsdom 测试不覆盖编译产物 |
| #7 fileIcons 加载 | **本次实施：URL 资源方案（以测量定案）** | 原方案两处关键断言（数 MB、"70%~85%"）经实测不成立；详见 #7 节测量与取舍 |
| #8 统一弹窗 `<dialog>` | **实施，补交互事实后分批** | 证据成立；WebKitGTK 支持与 StrictMode/::backdrop 细节必须先验证 |
| #9 浏览器契约测试 | **本次实施**（先钉 vitest 主版本决定） | @vitest/browser 5.x 与仓库 vitest 4.x 主版本不匹配，需前置决定 |
| #10 语义色兼容守卫 | **本次实施第一阶段**（位布局契约锁） | 第二阶段 Rust VT/单画布重写降为探索 spike，不设结果性承诺 |

依赖现状（本机 `cargo search` / `npm view`，2026-10-15）：

- `imara-diff` 0.2.0（原方案写 0.1，0.2 的 `compute`/`hunks` API 与 0.1 的 sink 式 API 不同）。
- `specta` / `tauri-specta` 2.0.0-rc.25（原方案钉 rc.22 / rc.21）。
- `@biomejs/biome` 2.5.15；`@vitest/browser`(-playwright) 5.0.4（仓库 vitest ^4.1.11）；
  `babel-plugin-react-compiler` 1.0.0（stable）；`zmodem.js` 0.1.10（2022-06 后无更新）；
  `material-icon-theme` 5.39.0。

外层基线（监督方记录，本回合未复跑）：typecheck/build 通过；前端 485/485；Rust 261 通过 /
23 ignored；`cargo fmt --check` 在基线即失败（原日志
`bench/edgeterm-glm53flash-flow181-20261015/product-before/rustfmt.log`），因此只对本次触及的
Rust 文件做格式核对，不做全仓重排；fileIcons chunk 基线 1,138,403 B / gzip 277,268 B
（同 product-before）。

---

## #2 文件对比：imara-diff 替换 64 行前瞻 —— 实施

**当前证据。** `src-tauri/src/file_diff.rs` 的 `compare_snapshots`（`for distance in 1..=64`）
只做单侧 skip：一侧插入或删除超过 64 行后，其余完全相同的行全部配成 `modified`。
`MAX_WORK`（1,000,000 次比较）耗尽后进入按位置配对，`alignment_simplified` 置真。

**修订后的设计（替代原方案的联合 token 设计）。**

1. 锚点只按**行文本**建立：`imara_diff::Algorithm::Histogram` 在全文件范围内对文本 token
   求 diff，得到 hunk 序列；hunk 之间的等值区间按位置逐行配对。
2. 换行符差异沿用现有 `row`/`same` 契约判定：等值区间内文本相同、ending 不同（CRLF/LF/CR/none）
   的行对输出 `modified`，文本与 ending 都相同的输出 `equal`。这样整文件 EOL 转换同时又有插入时，
   文本锚点不丢，插入行仍被识别为 `added`，被转换的原有行成对配为 `modified`。
   原方案把 `(text, ending)` 联合做 token，会让 EOL 转换消灭全部公共 token、
   锚点整体失效——已废弃该设计。
3. hunk 内部：hunk 已由文本锚点界定两端，内部按位置**线性**配对为 `modified`
   （保留现有内容修改的双栏呈现），多余的左行输出 `deleted`、右行输出 `added`。
   不做 hunk 内的无界文本搜配——全异大块会引入二次复杂度风险，且非单调配对无法保证
   两侧行号单调。不变量（以测试固定）：两侧的每一原始行在输出中恰好出现一次、
   两侧行号各自单调、内容修改仍成对呈现为 `modified`。
4. 既有前置契约全部保留：4 MiB / 50,000 行 / 16 KiB 每行、BOM 与 UTF-16/GBK 解码、
   二进制控制字符检测、只读（读前后 stat 复核）、12 秒外层超时、`Control::check()`
   取消检查、`Comparison`/`DiffRow` JSON 形状不变，前端零改动。
5. **取消边界（明确表述）**：取消检查保留在入口与每一行输出处；imara 的 `compute`
   在 `spawn_blocking` 内运行，`compare` 的 12 秒外层超时**只约束等待与响应**，
   不会终止已在运行的 compute，也不限定其 CPU 耗时；算法返回后才到达下一个取消点。
   compute 的工作量由输入上界（50,000 行/侧）界定，其实际耗时以提交内的大输入用例
   实测记录（机器时间，不是算法上界），不声称"算法内部立即取消"，
   也不声称"所有 50,000 行输入都在数毫秒内"——该断言无测量依据。
6. **`alignment_simplified` 语义（重定义并写入代码注释）**：它表达的退化是
   "行配对退化为按位置对齐，而非锚定对齐"。旧实现中该退化由 1M 比较预算触发；
   新实现总是先计算整文件锚定对齐，等值区间按锚点配对、hunk 内部在锚点界定下
   按位置配对，不存在"整体失去锚点"的退化，因此该字段在本实现中恒为 `false`。
   字段与前端提示（`diff.alignmentNote`）保留以维持序列化契约，提示随之不再出现。

**验收。**

- 旧实现失败证明已由外层监督方独立完成（非编译失败）：在 91b962b 的旧源码上加入六个
  wire JSON 行为测试，`cargo test --lib flow181_` 实际 2 通过 4 失败——失败项为
  100 行插入、100 行删除、5→100 不等长替换后的锚点保留、整文件 CRLF→LF 叠加 3 行插入；
  两个通过的正常控制为"内容替换保持 modified"与"双侧投影无丢失/重复/乱序"。
  日志：`bench/edgeterm-glm53flash-flow181-20261015/product-before/independent-diff-old.log`。
  六项测试原样采纳进产品测试（保留 flow181_ 命名与独立来源），候选实现上全部复验通过。
- 本地补充用例：重复行与空行锚定、混合 EOL 与末行无换行的 kind 级断言、
  取消入口边界、2 万行级 smoke（确定性断言 equal/added 计数并打印本机耗时，不作上界）。
- 既有契约测试全绿：EOL/BOM/编码/二进制/上限/取消/序列化
  （`exact_bytes_and_line_edits_include_line_endings_and_bom` 等）。
- 投影不变量在多个输入上验证：每侧原始行恰好出现一次、行号单调、内容修改仍 `modified`。
- 提交说明按 R9：`fix:` 带 `Tests:`（引用上述旧实现失败证据）；不出现未测量的耗时/倍率。

## #3 IPC 类型契约 —— 部分实施

**当前证据。** `src/types.ts`、`src/api.ts` 与 Rust 侧模型平行维护，已有真实漂移：
后端 `SessionProfile.backspace: Option<String>`，前端却是 `"delete" | "controlH"` 联合类型；
`file_diff.rs` 的 `Metadata.kind` / `Comparison.status` / `DiffRow.kind` 为 `&'static str`。

**边界修正（原方案未覆盖）。** 96 个 `#[tauri::command]` 中约 65 个含特殊签名，其中真正的
**类型签名例外**是 raw 字节路径：`tauri::ipc::Request`/`Response` 原始字节体 +
`x-edgeterm-metadata` 自定义头（`zmodem_write_bytes`/`zmodem_read_bytes`）与
`Channel<ArrayBuffer>` 原始输出流——serde 值签名不描述字节体，这些保留手写契约 +
双侧测试（现有 `apiBinary.test.ts` 与 Rust `binary_transfer_tests` 模式）。
其余不预先排除：tauri-specta 本身支持事件（`Event` derive + `collect_events`），
本仓库只是尚未接入，是否接入以迁移成本与漂移证据决定；`State`/`AppHandle` 等
Rust 侧注入参数由宏跳过，不妨碍其余参数生成。普通命令与事件的生成覆盖范围
以 spike 的实际编译结果决定。`types.ts` 含非 DTO 内容（主题、调色板、helper），
只能按 DTO 子集重导出。"CI 中报错"无落点：仓库仅有 release 流水线，验收落在
`cargo test` + `npm run typecheck` 与 `check:commits`。

**分步**：① file_diff 三组枚举改 `#[derive(Serialize)]` enum + serde 命名与现 JSON 逐字一致
（以序列化契约测试证明）；② model/commands 标注 `specta::Type`/`#[specta::specta]` 试点，
先以 spike 记录 96 个命令中哪些签名不可标注及原因；③ 绑定生成测试 + DTO 子集重导出。
release 体积影响实测后再写结论，不预设"零损耗"。

## #4 ZMODEM/XMODEM 下沉 —— 暂缓（非本次生产改动）

现状已部分解决原方案声称的问题：IPC 分块为应用级 1 MiB，下载流式落盘，
上传读取按 1 MiB，写路径走原始二进制 IPC。剩余真实开销是每字节仍跨 IPC 两次与
CRC/组包占用 JS 主线程——收益存在但未测量。

**未来进入条件（全部满足才立项）：**

1. 测量证据：同机同负载（真实串口/回环会话）下现有实现的耗时与内存剖面，
   指认 JS 侧成本占比；`perf:` 提交带 `Measured:`。
2. 互操作证据：Rust↔Rust 内存对拍（映射现有测试的逐个场景，不得虚构
   "U-Boot 3 CAN/lrzsz 8 CAN 已有覆盖"）之外，必须包含真实 lrzsz（或其记录字节流）
   作为对端的一致性向量；可选真机 sz/rz 过 PTY 的 ignored 测试沿用
   `EDGETERM_REAL_*` fixture 惯例。
3. 集成设计：Rust 输出泵等价实现"已显示字节回放"与首帧 `**` 抑制且不延迟普通输出；
   GBK 会话"先哨兵后解码"的顺序约束写进设计；删除依赖的提交同步更新
   `scripts/check-file-performance.mjs`（它直接 import zmodem.js 与 zmodemInput.ts）。

## #5 Biome —— 实施（有针对性）

全仓无 lint 配置。`@biomejs/biome` 2.5.15，devDependencies、单二进制。规则集对齐现有风格
（2 空格、双引号、分号），启用 `useExhaustiveDependencies`（react 域）、
`noUnusedVariables`、`noUnusedImports`、`noExplicitAny`(warn)。只 lint 不整仓格式化，
避免污染 blame。存量告警修复独立提交；无存量 hook 缺陷就如实写"无"，不编造收益。
同一提交更新 AGENTS.md 的 "No ESLint or Prettier configuration is present" 表述，
并把 `--lint` 纳入 `check:commits` 的可选项。

## #6 React Compiler —— 只做可比试验

非测试源码 `useMemo`/`useCallback` 共 44 处、13 个文件，原方案"大量手写"言过其实。
`babel-plugin-react-compiler` 已 1.0.0 stable；仓库钉 `@vitejs/plugin-react` ^4.6.0，
`babel.plugins` 挂载方式对 4.x 有效。**关键边界**：vitest 以 esbuild 转换源码，
不经过该 Babel 插件，jsdom 测试不覆盖编译产物语义。
试验流程：同一基线提交上，用 `scripts/check-file-performance.mjs` 同机同负载跑
首绘/切换对照（记录样本与中位数），组件级测试在编译开关两种状态下各跑一遍；
无对照数据不启用，启用提交按 R9 带 `Measured:`，否则标题只写 "enable" 并带 `Unmeasured:`。

## #7 fileIcons 加载 —— 已实施为 URL 资源方案（以测量定案）

**最终实现（已落地）**：`src/fileIcons.ts` 改为 `import.meta.glob(..., { query: "?no-inline" })`
的每图标一个 SVG 资产：解析契约不变（大小写不敏感、exact 文件名优先于扩展名、
最长后缀优先、`.clone` 变体剥离、`light.*` 覆盖、文件/目录默认回退），渲染仍是
懒加载模块 + `<img src=URL>`。`npm run check:icons` 在构建后校验：chunk 内 982 个
映射键与包内非 -open SVG 一一对应、chunk 提到的每个 /assets/*.svg 在 dist 真实存在、
theme JSON（含 light.file/folder 默认）引用的 906 个图标全部可解析；负对照
（删除真实资产、篡改 chunk 键）均使门禁以非零退出失败。

**测量（全部为局部测量，非整体应用提速结论）**：

- 体积：fileIcons chunk 1,138,403 B / gzip 277,268 B → 318.64 KB / gzip 53.42 KB
  （raw -72%，gzip -81%）。**dist 总量上升**：9 文件 2,443,749 B（gzip 660,069）→
  988 文件 2,472,038 B（gzip 873,355），raw +1.2%、gzip +32%——逐文件压缩失去了
  单 chunk 的跨文件字典收益，这是本方案用首开换来的代价，如实记录。
- 首开（外层独立 A/B，`independent-icons-second/results.json`：真实
  FileBrowser/FileIcon + 生产 CSS、10k 条目、图标模块不预载、冷 context 每臂 6 次
  交替、计到已渲染窗口行（含 overscan）图标全部 naturalWidth>0 再过 2 帧）：
  baseline 68.20 ms / candidate 52.55 ms（-23%）；pageerror 与资产 404 为 0，
  像素一致。这是该夹具单批六次的中位数，不是普遍速度保证。
- 堆（`independent-icon-heap.json`：冻结两臂生产 fixture、每臂 4 个 fresh
  context 交替、显式 GC 后 V8 usedSize、首挂载增量中位数）：
  baseline 2,597,928 B / candidate 1,777,202 B，保留堆 -820,726 B。
  仅 V8 保留堆，不是总进程/GPU/image backing/WebView2。
- 本仓库内可复用驱动 `scripts/measure-file-icons.mjs`：显式 `resolveId` 绑定
  变体并从构建产物核验（svg 资产数/createObjectURL 存在性），杜绝变体误绑；
  其 21 行小夹具首轮曾因 alias 未拦截相对 specifier 测成 A/A（原始失败记录保留
  于 `.tmp/records/implementation-02/`），该批数据已作废，未用于任何结论。
- 截图：`scripts/icon-screenshots.mjs` 产出的暗/亮两幅（各 21 行真实组件）位于
  `.tmp/records/implementation-02/icons/{dark,light}.png`。

**范围与边界**：以上都是合成生产组件夹具——不证明真实 Filer 全链路、SFTP 列表
或 WebView2/GPU 行为；"首开"不包含应用入口与 IPC。记录中曾出现的
`Runtime.compileScript` 计时路线（对 ESM 按 classic 编译报语法错）已被
`compile-probe-negative-control.json` 证伪并废弃；21 行 probe 的首轮 A/A 数据
同样仅作废案存档。

## #8 统一弹窗 —— 实施，补齐交互事实后分批

证据成立：15 个弹窗组件重复 backdrop + capture 键盘监听；无 portal；
层叠靠硬编码 z-index（`.dialog-backdrop` 200、`.context-menu` 150、三个 popover 1000，
popover 已实际压在弹窗之上）；SessionDialog 与 HostKeyDialog 可同时挂载，两者的
window capture 监听都会收到 Escape，一次 Esc 双关（同一 target 上 `stopPropagation`
不拦截同元素其他监听器）。多数弹窗关闭不恢复焦点；FileDiffDialog 已有完整
trap+恢复，作迁移范本。

实施前必须落地的四类事实：

1. 平台支持：WebView2/WKWebView 现代版支持 `<dialog>`+top layer；Tauri Linux 的
   WebKitGTK 行为须本机实测，不达标则保留旧实现或能力检测回退（回退策略先进方案）。
2. `::backdrop` 不接收事件：点外部关闭与 attention 抖动改为坐标判定，
   dialogAttention 测试同步。
3. StrictMode 已启用：showModal/close 幂等（open 守卫、仅本人打开者关闭），
   组件测试含 StrictMode 双挂载用例。
4. 焦点恢复：`dialog.close()` 原生恢复与手工恢复的差异逐弹窗核对；
   弹窗打开时其下 context menu 因 inert 不可达写入预期并测试。

验收：Tab 不出顶层弹窗；双弹窗下 Esc 仅关顶层（先在旧实现复现双关并失败）；
800px 断点两侧浏览器验证；每批迁移一个提交。

## #9 浏览器契约测试 —— 实施（先钉版本决定）

`@vitest/browser` 5.0.4 与仓库 vitest ^4.1.11 主版本不匹配：要么用 4.x 配套，
要么把"升级 vitest 5"列为前置独立提交。Playwright 需变成显式 devDependency 并写明
浏览器获取方式；仓库无常规测试 CI，执行门禁落在本机命令与 `check:commits`。
browser 项目只补 jsdom 无法证明的断言（真实布局、指针捕获、隐藏渲染暂停），
不重复已有逻辑断言；每个 browser 测试注明证明边界（沿用 scripts/README 措辞风格）。

### 实施状态（2026-10-15，本轮完成）

已按 4.x 配套落地（`@vitest/browser(-playwright) 4.1.11` + `playwright 1.64.1`，
与仓库 vitest 同版本）。三类生产契约各成 `*.browser.test.ts`（browser 项目，
不继承 jsdom setup）：

- **VirtualFileRows**：真实滚动容器的顶/底/中覆盖与 runaway 滚动钳制、
  rowHeight 重测、resetKey 复位、真实 CDP 指针捕获的 keep-alive（滚出窗口保留、
  释放回收、捕获中 pointermove 投递）与合成事件负对照、≤200 非虚拟路径。
- **TerminalController fit**：字体就绪后真实像素填充、199/200 行阈值精确边界
  （小缓冲双轴立即；大缓冲行即列缓、斜向行先列后、最后一次宽度事件获胜且无迟到）、
  隐藏取消挂起任务且不再 fit、显示立即重测、真实 SessionPane 隐藏/显示链、
  dispose 无迟到 resize。
- **ResponsiveLayout**（FtpPane + ResourceMonitorBar）：800px 断点两侧列可见性与
  表头/行真实对齐、1100px 宽窄 rail 几何、真实 CDP 指针跨面板 drag 上传/下载参数、
  同侧 drop 无动作、Escape/隐藏中止拖拽。

发现并修复两处真实缺陷（独立 fix 提交，均有旧源失败证据）：

1. `fix: re-measure the terminal cell at the resize boundary`（54cadf8）——
   gutter 行距在 onResize 同步读取旧 screen 高 ÷ 新 rows（15.34px vs 21px），
   隐藏首挂载后 fit 返回 null。修复：resize 完成边界的单次重测 + 空提案的
   一帧重试。
2. `fix: re-fit the terminal when its host geometry lands and stage hidden
   font changes`（43dd85c）——WebKit 首显 607px screen > 476px host（gutter
   宽度后置，pane 级观察器看不到内部收缩）与隐藏字体改动不落地。修复：
   fit 父级（.term-host）ResizeObserver + 隐藏字体暂存至显示边界落地
   （最后请求优先，14→26→14 渲染级证明）。

新增两个生产构建门禁（dev 模式 Vitest 无法复现生产时序/完整 App 链）：

- `scripts/check-gutter-alignment.mjs`：gutter 对齐经组件 hide/resize/show 与
  隐藏字体链，Edge 与 `PERF_ENGINE=webkit`；`fix` 提交前后分别为 3 行为 fail /
  5 全 pass（edge+webkit），两正常控制恒过。
- `scripts/check-app-font-chain.mjs`：真实 App → store → FilerPanel → 行距链，
  12/18px × 1100/760 审计字面矩阵、10k 窗口化、unexpected-IPC 门禁；
  两个 worktree 变异（App CSS 硬编码 12px、FilerPanel rowHeight 硬编码 26）
  均使门禁以非零退出。

行为变异（一次性 worktree，已全部清理）：VirtualFileRows keep-alive 删除、
paneDrop 同侧放行、FIT_BUFFER_THRESHOLD 201、staged-font 早退复原——
各自对应套件以非零退出。

边界（R1/R5）：以上全部是真实 Chromium/Edge（及 Playwright WebKit）里的
组件 + 合成数据 + 受控 IPC 契约；不证明 WebView2 打包、GPU 渲染器、真实
PTY/服务器吞吐或其他平台引擎。

## #10 终端仿真 —— 第一阶段实施；第二阶段降为探索 spike

第一阶段：`semanticPaint.ts` 直接读写 xterm 6 私有 `_line._data`（3 word/格、
PAINTED=bit32）。现有 terminalSemanticPaint.test.ts 覆盖很厚，布局变更时测试会失败，
但报错是"颜色没画上"而非"布局契约变了"；补显式位布局契约锁（CELL/FG/BG/PAINTED
位不被 xterm 自身写入），失败信息直达契约层。`@xterm/xterm` 已精确钉 6.0.0。
"输出流 SGR 织入"替代路线标记为高险：词法规则作用于前端解码后的文本
（GBK 在哨兵之后解码），Rust 侧织色要么复制规则要么先解码，破坏现有顺序约束，
只做设计笔记不实施。

第二阶段（Rust VT 内核 + 视口快照 + 单画布）**不列入本次生产改动**。原方案两处断言更正：
`WEBGL_MAX_TERMINALS = 6` 的动因是隐藏标签用不上快速渲染器、每个 context 钉一块
窗口级 GPU 表面（把 GPU 内存控制在几百 MB）并与 WebKit 的 16 个 live context 上限
保持余量（[terminal.ts:78-89](src/terminal.ts#L78-L89) 注释）；LRU 让最久未显示的
放弃渲染器、显示时再取回。context **丢失**另有有界恢复：2 秒后重建、60 秒窗口内至多
3 次（`WEBGL_RECOVERY_DELAY_MS`/`WEBGL_RECOVERY_LIMIT`，terminal.ts 的
`handleWebglLoss`/`scheduleWebglRecovery`），窗口之外的丢失是新预算；只有持续掉
context 的 GPU 才留在 DOM 渲染器——不存在"上下文丢失必然永久滞留 DOM"。
"百万行零内存膨胀"是假承诺——
Rust 环形缓冲仍是内存，只是搬出 WebView 堆并降低每行成本，表述改为
"有界、可配置的更低每行内存"。未来进入条件：先做 2–3 天 spike（Rust VTE 解析
吞吐/内存基准 + 快照通道 PoC）产出数据，VT 奇偶性、IME、选择、搜索、unicode11、
OSC52、语义色的重证明计划成立后另行立项；未立项前不写任何"极速/瞬时/彻底"承诺。

---

## 原方案绝对保证更正对照

| 原方案断言 | 更正 |
|---|---|
| imara-diff "0.1"、`diff(algorithm, input, sink)` API | 现行 0.2.0，`compute(Algorithm, &InternedInput)` + `hunks()` |
| "Histogram 在 50,000 行下最坏数毫秒" | 无测量依据；以输入上界 + 12s 超时表述，机时不写成算法上界 |
| specta rc.22 / tauri-specta rc.21 | 现行 rc.25；与 tauri 2.12 兼容性以 spike 实测 |
| "零体积膨胀/运行时零损耗" | 改为 release 体积实测后写结论 |
| 命令名 `write_temp_chunk/read_file_chunk` | 实际为 `zmodem_create_file/read_bytes/write_bytes/finish_file` 等，分块已 1 MiB |
| "zmodem.test.ts/xmodem.test.ts 已覆盖 U-Boot 3 CAN、lrzsz 8 CAN、非 UTF-8" | 现有测试无这些场景；移植清单以现有用例逐条映射 |
| 图标 "1000+ 个 SVG 数 MB" "缩减 70%~85%" | 982 个/约 850 KB/chunk 1.14 MB；引用闭包过滤仅省约 8%，比例待实测 |
| "fileIcons 首屏同步加载" | 模块已懒加载，chunk 不在首屏包 |
| "焦点锁完全缺失" | FileDiffDialog 已有 trap+恢复；其余弹窗确实缺失 |
| "百万行历史零内存膨胀" | 删除该承诺；改为有界、更低的每行内存 |
| "前端零改动兼容"（#2） | 成立（JSON 形状不变），但 `alignmentSimplified` 恒 false 的语义变化需记录 |

## 实施顺序（修订）

1. 本回合：#2 diff 改造（独立提交，附旧实现失败证据）+ 本文档。
2. 后续：#10 第一阶段契约锁；#5 Biome；#3 枚举化；#7 构建期精简；#9 版本决定后落双环境；
   #8 分批迁移；#6 对照试验报告。
3. 暂缓：#4 全量迁移、#10 第二阶段——按上文进入条件另行立项。
