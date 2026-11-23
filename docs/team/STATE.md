# 项目状态

## 本轮：让读屏软件也知道树自己的两个键（2026-11-24 第 113 轮）

- 起因：树的 ARIA 只声明了 `role="tree"` 与 `aria-activedescendant`；方向键、Home/End 属于该模式的约定，但 **F2（重命名）与空格（折叠）是本应用自己的**，此前没有任何地方向辅助技术声明它们。
- 交付：树容器加 `aria-keyshortcuts="F2 Space"`，筛选框加 `aria-keyshortcuts="/"`（`/` 聚焦筛选是本应用自己的键）。纯属性，无样式、无行为变化。
- 验证：`sessionTreeRename.browser.test.ts` **9/9**（新增 1 条：断言两个 `aria-keyshortcuts` 的值，并说明方向键不在此列因为属于树模式本身）。
- 自纠：第一次把注释写成 JSX 标签内的 `//` 行——`tsc` 与 Biome 都接受了，但这不是 JSX 的注释写法；改为标签上方的 `{/* … */}`，避免读者与其它工具困惑。
- 门（`npm run verify`）：`VERIFY_EXIT=0`；format:check ok 1.0s、typecheck ok 7.4s、lint ok 0.9s、test ok 125.5s（**212 文件／1918 用例**）、test:browser ok 192.8s（**72 文件／327 用例**）。


## 本轮：给七十轮日志加一张索引（2026-11-24 第 112 轮）

- 起因：`STATE.md`（70 轮）、`DECISIONS.md`（111 条）、`LEARNINGS.md`（325 条）都是按时间追加的线性日志；要找「某件事是哪一轮做的」只能从头翻。
- 交付：新建 `docs/team/INDEX.md`（**脚本从现有文件解析生成，未手工补写**）：① 第 41–111 轮的轮次一览（轮/日期/内容，取自 STATE 标题原文）；② 111 份说明文档的「文件 → 标题」表；③ 轮次 → 文档（只收标题里写明轮次的 105 份）。
- 顺带发现并写下的事实：`STATE.md` **从第 41 轮才有逐轮记录**，第 2–40 轮的说明文档仍在、状态日志里已无对应小节——那些轮次只有索引的第三张表能指路。这解释了为什么早期文档「找不到轮次」。
- 一次自纠：第一版把「文档写了轮次但 STATE 无对应条目」当成不一致，生成出 39 条「错位」；核对后确认是 STATE 被裁剪所致，改成上面这条事实陈述，没有把误判留进文档。
- 门（`npm run verify`）：`VERIFY_EXIT=0`；format:check ok 1.0s、typecheck ok 7.4s、lint ok 1.0s、test ok 126.2s（**212 文件／1918 用例**）、test:browser ok 191.9s（**72 文件／326 用例**）。纯文档改动，但按项目要求仍跑完整门。


## 本轮：会话筛选也能按分组找（2026-11-24 第 111 轮）

- 交付：`sessionFilter.ts` 新增 `groupPathMatches(path, needle)`——分组路径（从分区根到该组的名字）里任一名字命中即算匹配；面板的可见集合改为 `sessionMatchesFilter(p, needle) || inMatchingGroup(p)`。占位文字改为「按名称、主机、用户名或分组过滤」／“Filter by name, host, user or group”。
- 为什么现在做：第 107 轮刻意把「按组过滤」留作待判，理由是会分不清命中的是人还是分组；本轮判断为**可用性更重要**——人们常用分组名组织机器（prod、vault、lab），找组比找机器名更自然，且路径匹配只扩大结果、不改变行的呈现。
- 验证：`sessionFilter.test.ts` 7 条（其中分组 2 组：路径命中、空筛选与不命中）；`sessionTreeRename.browser.test.ts` **8/8**（新增：输入 `vault` 把位于该组的会话找回，输入不存在的组名则消失）。
- **负控制**：把面板改回只比名称/主机 → 新用例失败（`the group on the path brings the session back: expected false to be true`）；恢复后通过。
- 一次自纠：新用例的分组字面量漏了 `parentId`，`Required<SessionGroup>` 在 typecheck 里报错（第一次全量门因此 `typecheck FAILED (2)`）；补上后 TC=0。
- 门（第二次，最终）：`VERIFY_EXIT=0`；format:check ok 0.9s、typecheck ok 7.3s、lint ok 0.9s、test ok 125.5s（**212 文件／1918 用例**）、test:browser ok 192.1s（**72 文件／326 用例**）。


## 本轮：找到上轮那条浏览器用例失败的根因，并补上证据（2026-11-24 第 110 轮）

- 根因：App **挂载后会从后端加载 profiles**（夹具里 `list_profiles` 返回 `PROFILE`），所以在 `mount` 之前设置的 2222 端口被这次加载覆盖——搜索查的是旧数据。把设置挪到挂载并等待两帧之后，用例立刻通过。
- 定位手法：把断言写成哨兵（`expect(palette()?.textContent).toContain("SENTINEL-TEXT")`），失败消息直接给出渲染文本——先是 `No command matches "2222"`（确认没有匹配，而不是选择器错），改顺序后变成 `Saved sessions Connect to Build ser…`（确认已找到）。
- 交付：`commandPalette.browser.test.ts` 新增「按地址端口找到会话」（4/4），**上轮那句没有证据的话现在有证据了**。
- **负控制**：去掉 App 里 `address = target + ":" + port` 的拼接 → 该用例失败（`expected '' to contain 'Build server'`）；恢复后通过、typecheck EXIT=0。
- 门（`npm run verify`）：`VERIFY_EXIT=0`；format:check ok 0.9s、typecheck ok 7.3s、lint ok 0.9s、test ok 125.5s（**212 文件／1916 用例**）、test:browser ok 191.5s（**72 文件／325 用例**）。第 109 轮那句「浏览器层无证据」到此关掉。


## 本轮：命令面板的提示补上端口（2026-11-24 第 109 轮）

- 补齐上轮记下的不一致：App 里构造会话 hint 的那段解析只取 6 个字段，第 7 个（`port`）虽在 key 里却没用上，于是 Ctrl+P 不能按端口找会话，而树可以。现在 hint 为 `ssh · build@build.internal:2222 · Connect`。
- 验证：`commandPalette.test.ts` 31 条（新增 1 条：hint 里带 `:2222` 时，`2222` 与 `build.internal:2222` 都能命中该会话）。
- 门（`npm run verify`）：`VERIFY_EXIT=0`；format:check ok 1.0s、typecheck ok 7.3s、lint ok 0.9s、test ok 125.7s（**212 文件／1916 用例**）、test:browser ok 190.3s（**72 文件／324 用例**）。
- **未完成且如实记录**：曾在 `commandPalette.browser.test.ts` 写「真实 App 里按端口找到会话」的用例，三次失败——共同现象是查询 `2222` 后 `options()` 为**空**（标签断言收到空串）。同一文件的其余用例能正常取到选项，说明夹具本身可用，但本次没有定位到根因，**因此撤掉该用例而不是留着它跑红**。浏览器层的这句话目前无证据。


## 本轮：先确认命令面板找得到地址，再把这条能力钉住（2026-11-24 第 108 轮）

- 起因：上一轮把会话树的筛选扩到主机／用户／端口后，怀疑命令面板（Ctrl+P）同样只能按名称搜。**读代码后确认它已经能**：会话条目的 hint 带 `ssh · root@db.internal`，而 `commandScore` 对 hint 也算分（-120 的降权）。
- 交付：不新增实现，只加一条回归护栏——`commandPalette.test.ts` 新增「按 hint 里的地址找得到会话」（`db.internal` 与 `root@` 两种输入都命中 `session:profile-1`）。单文件 30 条通过。
- 记录：这条能力来自「hint 参与评分」这样一个不显眼的机制，一旦有人为了排序把它移出评分范围，搜索会**静默**失去按地址查找的能力——所以值得一条断言。
- 遗留不一致（记下未做）：面板的 hint 由 App 里一段 JSON key 元组解析（`id, name, kind, host, username, shell`），**端口不在其中**，所以面板还不能按端口找会话，而树已支持。是否扩展那段 key 留待下一轮判断。
- 门（`npm run verify`）：`VERIFY_EXIT=0`；format:check ok 0.9s、typecheck ok 7.4s、lint ok 0.9s、test ok 126.3s（**212 文件／1915 用例**）、test:browser ok 192.2s（**72 文件／324 用例**）。


## 本轮：会话筛选能按主机、用户、端口找（2026-11-24 第 107 轮）

- 缺陷（代码里确认）：`SessionPanel` 的筛选只比较 `p.name`——按主机 `10.0.0` 或用户名搜不到任何会话，而用户记得的通常是机器，不是保存时随手起的名字。
- 交付：纯函数 `sessionMatchesFilter(profile, needle)`（`src/sessionFilter.ts`）搜索名称、主机、用户名、`user@host`、端口、串口名；空筛选全通过。筛选框占位文字改为「按名称、主机或用户名过滤」（中英各一处）。
- 验证：`src/sessionFilter.test.ts` 5 条；`sessionTreeRename.browser.test.ts` **7/7**（新增 1 条：输入 `lab.inv` 把名称不含该串的会话找回来，输入匹配不到时它消失）。
- **负控制**：把面板改回只比 `name` → 新用例失败（`the host brings the session back: expected false to be true`）；恢复后通过、typecheck EXIT=0。
- 门（`npm run verify`）：`VERIFY_EXIT=0`；format:check ok 0.9s、typecheck ok 7.3s、lint ok 0.9s、test ok 125.6s（**212 文件／1914 用例**）、test:browser ok 192.5s（**72 文件／324 用例**）。


## 本轮：颜色字面量只许出现在 foundation 层（2026-11-24 第 106 轮）

- 背景：四套主题共用一套 token，约定新样式只写 `var(--...)`；此前没有任何门禁检查这条约定。实测结果：19 个组件样式表里**没有**颜色字面量，210 个全部在 `foundation.styles.css`（唯一命中注释里 `issue #108` 的 `#` 已剔除）。
- 交付：新增 `src/colourLiterals.test.ts` 2 条——① 除 foundation 外的样式表里不得出现 `#rgb(a)`／`#rrggbb(aa)`（先剥注释）；② foundation 自身必须仍有 100 个以上字面量，防止 glob 失效让门变成空转。用 `import.meta.glob("./styles/*.css", { query: "?raw", eager: true })`，新增样式表自动纳入。
- **负控制**：往 `ftp.styles.css` 追加 `.term-empty-x { color: #123456; }` → 失败（`expected [ './styles/ftp.styles.css: #123456' ] to deeply equal []`）；删除后恢复。
- 意义：这条约定从「文档里的规矩」变成「进门的断言」，与 styleCensus、shortcutCensus 同一族。
- 门（`npm run verify`）：`VERIFY_EXIT=0`；format:check ok 0.9s、typecheck ok 7.3s、lint ok 1.0s、test ok 125.2s（**211 文件／1909 用例**）、test:browser ok 191.2s（**72 文件／323 用例**）。


## 本轮：给快捷键表加一次普查（2026-11-24 第 105 轮）

- 背景：`shortcuts.ts` 里三张表（`SHORTCUT_COMMANDS`、`shortcutLabels`、`shortcutHints`）与两份平台默认值（`MAC_DEFAULTS`、`OTHER_DEFAULTS`）靠人工保持一致；`shortcuts.test.ts` 只测解析与匹配，不测「表与表之间是否对得上」。
- 交付：新增 `src/shortcutCensus.test.ts` 4 条——① 每个命令都有英文名与提示，且不是原始 key；② 命令不重复；③ 每个平台各自不会让两个命令抢同一个和弦（顺带断言和弦标签非空）；④ 两份平台表对同一命令是否有默认值保持一致。
- **负控制**：把 `other` 平台 `nextTab` 改成 `Ctrl+Shift+Tab` 与 `prevTab` 撞车 → 用例失败（`other: nextTab reuses Ctrl+Shift+Tab`）；恢复后 4/4 通过、typecheck EXIT=0。
- 意义：这是 D107「把死导出变成门」的延续——表结构的不变量从「靠自觉」变成「进门的断言」。
- 门（`npm run verify`）：`VERIFY_EXIT=0`；format:check ok 1.0s、typecheck ok 7.2s、lint ok 0.9s、test ok 124.8s（**210 文件／1907 用例**）、test:browser ok 191.2s（**72 文件／323 用例**）。


## 本轮：两处 type-ahead 合并到同一次搜索（2026-11-24 第 104 轮）

- 质量评估发现：文件列表的 `fileTypeSelect.typeToSelect` 与会话树的 `sessionTypeAhead` 各自实现了一遍「按前缀找下一行」——前者还多了 NFC 归一、输入法组合判断与重复字母轮转。
- 交付：`findByPrefix` 放宽为接受任何带 `name` 的行（`readonly Pick<FileEntry, "name">[]`），会话树的 `nextTypeAheadRow` 改为**委托**它，删掉自己那份搜索；树的缓冲区规则补上 `isComposing`（输入法组合期间的按键不再触发跳转）。
- 策略差异**保留**：文件列表允许空格续写（那里空格不承担动作），会话树排除空格（空格是折叠）。两个上层规则仍各自拥有自己的键位语义，只共用匹配核心。
- 验证：`sessionTypeAhead.test.ts` 9 条、`fileTypeSelect.test.ts` 与其它相关单测共 30 条通过；`sessionTreeRename.browser.test.ts` 6/6；typecheck EXIT=0。全量见下。


## 本轮：type-ahead 能改错字，也能被 Esc 取消（2026-11-24 第 103 轮）

- 交付：把「缓冲区怎么变」抽成纯函数 `nextTypeAheadBuffer(buffer, key, now)`——可打印字符续写（停顿 600ms 重开）、`Backspace` 缩短（空缓冲时不接管）、`Esc` **只在有搜索时**清空（否则仍可关菜单／退出筛选）、空格与带 Ctrl/⌘/Alt 的键一概不管。树的组件只剩派发，面板里的 600ms 常量下移到该模块。
- 验证：`src/sessionTypeAhead.test.ts` **9 条**（4 跳转 + 5 缓冲）；`sessionTreeRename.browser.test.ts` **6/6**。全量门最终 `VERIFY_EXIT=0`（单测 **209 文件／1903 用例**，浏览器 **72 文件／323 用例**）。
- **两次全量门失败与一条被撤掉的用例**：先写了「两键后 `Backspace` 回溯」的浏览器用例，单独跑绿、全量跑红两次（一次是两次 `keyboard` 调用之间夹 `twoFrames()` 超过 600ms 变成新搜索；改单次输入后又发现树里内置的 Local Shell 同样以 L 开头，期望本身不成立；换 Z 开头仍不稳定）。**结论：撤掉该用例**——`Backspace`／`Esc` 语义由 5 条单测覆盖，浏览器层只留单键跳转。
- 教训：一条不能在门里稳定通过的用例不该留在门里；两键路径的浏览器断言会把「600ms 产品语义」变成测试的时限依赖。


## 本轮：修掉上一轮 type-ahead 吞掉空格的问题（2026-11-24 第 102 轮）

- 缺陷：第 101 轮把「无修饰键的可打印字符」全部接管，但空格也是可打印字符——树里 `case " "` 的折叠/展开因此失效（分组与分区标题按空格不再响应）。
- 修复：type-ahead 条件加上 `event.key !== " "`（名字不会以空格开头），空格回到既有的折叠/展开分支。
- **负控制**：临时去掉该守卫后，新增用例立刻失败（`Space still collapses the heading: expected 'true' to be 'false'`），恢复后全绿——守卫确实在盯着这次回归。
- 验证：`sessionTreeRename.browser.test.ts` 6/6；typecheck EXIT=0。


## 本轮：会话树里的输入即跳转（type-ahead）（2026-11-24 第 101 轮）

- 交付：会话树有焦点时直接敲名字首字母，光标跳到下一个名字以所敲内容开头的会话；连续输入会**收窄同一次搜索**（600ms 内继续敲算同一次，停顿后重新开始）；搜索从当前行之后开始并环绕，所以重复按同一个字母会在同名首字母的会话间轮转。
- 实现：纯函数 `nextTypeAheadRow`（`src/sessionTypeAhead.ts`）＋ 树的 `onTreeKeyDown` 在方向键分支前接管**无修饰键的可打印字符**（因此不会触发页面滚动，也不会与快捷键表冲突；Alt/带修饰键的按键仍走既有路径）。
- 只匹配**会话行**，不匹配分区标题与组名——输入是找机器，不是找标题。
- 验证：`src/sessionTypeAhead.test.ts` 4 条（前缀匹配、大小写、环绕、空串与无匹配、重复字母前进）；`sessionTreeRename.browser.test.ts` 5/5（新增 1 条：焦点在分区标题时敲 `l`，`aria-activedescendant` 变成该会话行）。


## 本轮（第 100 轮）：关掉上轮记下的缺口——它不是缺陷

- 上一轮留了口子：「最小面板尺寸下空窗口的最近会话列表可能超出可视高度」。本轮先量：`.term-empty` 本身 `overflow: auto`，整个空状态是一个滚动容器。
- 新用例在 378×465 / 18px 实测尺寸下断言 `scrollHeight > clientHeight`，且把最近条目 `scrollIntoView` 后它在面板内可见（上下各留 1px／3px 余量）。**3/3 通过**：上一轮的点击超时是 Playwright 在自有滚动容器里的指针定位限制，不是被裁掉的界面，因此没有改样式。
- 补记 **D108**（空窗口复用既有 entry 结构；空状态整体滚动，不单独加样式）与 **D109**（文档里的「疑似缺口」先量再决定改不改；量出来是测试限制就写成测试限制）。
- 补第 87–100 轮小结（见 `round-100-milestone-20261124.md`）。
- 门（`npm run verify`）：`VERIFY_EXIT=0`；format:check ok 0.9s、typecheck ok 7.3s、lint ok 0.9s、test ok 123.8s（**208 文件／1894 用例**）、test:browser ok 191.2s（**72 文件／321 用例**）。


## 本轮：空窗口也是一个入口（2026-11-24 第 99 轮）

- 交付：关掉所有标签后，空窗口在能力入口下方列出**最多 3 个最近用过的已保存会话**（名字 + 「最近用过的会话」，无障碍名 `打开 <名字>`），点击即连接；复用既有 `.term-empty-entry` 结构，没有新增样式；无记录时不渲染。
- 测试暴露两件事：① 直接在页面根挂 `Workspace`（没有 `.app` 容器）时它没有高度，元素被排到视口外，点击超时；② 在最小面板尺寸（378×465、18px 字体）下列表比窗口高，按钮被裁一半——**点击**测不了。新增用例改用正常窗口尺寸＋`div.app` 容器；最小尺寸的排版仍由本文件既有用例覆盖。
- 遗留缺口（写进文档）：最小尺寸下最近会话列表可能超出可视高度；是否隐藏或内部滚动留待下一轮决定，没有顺手改样式。
- 验证：`workspaceEmpty.browser.test.ts` 2/2（新增 1 条）；`findBox`、`Workspace`、`WorkspaceTabFocus` 三个夹具传入新回调后全绿。
- 门（`npm run verify`）：`VERIFY_EXIT=0`；format:check ok 1.2s、typecheck ok 7.0s、lint ok 0.9s、test ok 126.6s（**208 文件／1894 用例**）、test:browser ok 190.1s（**72 文件／320 用例**）。

## 本轮：把「最近用过」标记的可见性钉住（2026-11-24 第 98 轮）

- 风险：第 97 轮的标记放在密集行里（颜色点 + 名字 + 标记 + 两个悬停按钮），名字很长且面板很窄时可能被压成 0 宽或被挤出；而外壳视觉门的夹具没有「最近用过」的会话，覆盖不到。
- 做法：新增一条浏览器用例——320px 宽、名字长到能占满整行、写入 `recentProfiles`，断言标记宽度 > 12px 且右边界不超出所在行。它的成立依赖 `.row-label` 的 `flex: 1` + `ellipsis`（名字先让位），规则被改时用例会立刻失败。
- 过程中的错误：第一次失败是 `ReferenceError: page is not defined`——这个夹具只导入了 `userEvent`，我加了 `page.viewport` 却没导入 `page`。失败的测试未必在说产品有问题。
- 验证：`sessionTreeRename.browser.test.ts` 4/4 通过。
- 门（`npm run verify`）：`VERIFY_EXIT=0`；format:check ok 0.9s、typecheck ok 7.2s、lint ok 0.9s、test ok 138.2s（**208 文件／1894 用例**）、test:browser ok 196.3s（**72 文件／319 用例**）。本轮机器负载偏高，单测与浏览器耗时比上轮多约 10s，与代码无关。

## 本轮：会话树里标出最近连过的会话（2026-11-24 第 97 轮）

- 交付：已保存会话的行在名字后显示 `Recent`／`最近`（悬停「你最近连接过这个会话」）；复用既有 `.row-meta` 槽位，**没有新增样式或颜色**，外壳普查不受影响；不动排序、分区与键盘模型。
- 两次被用例纠正：① 选择器按英文 title 匹配，而夹具 `beforeEach` 会把状态重置回存储里的语言（中文），标记在但查不到 → 改为按两种标签文本匹配；② 顺手写的 `.row-label` 断言取到的是分区标题，改为从标记向上找 `.row` 再断言含档案名。
- 验证：`sessionTreeRename.browser.test.ts` 3/3（新增 1 条）；上一轮的面板行断言仍通过。
- 门（`npm run verify`）：`VERIFY_EXIT=0`；format:check ok 0.9s、typecheck ok 7.1s、lint ok 0.9s、test ok 123.8s（**208 文件／1894 用例**）、test:browser ok 190.8s（**72 文件／318 用例**）。

## 本轮：命令面板标出最近连过的会话（2026-11-24 第 96 轮）

- 问题：会话列表一长，每次都要按名字找；资料里没有「收藏」字段，让人手工维护一份收藏又是额外负担。
- 交付：新模块 `recentProfiles.ts`（上限 6、新在前、去重、键 `edgeterm.recentProfiles` 已注册进 `PANEL_PREFERENCE_KEYS`）；store 的 `recentProfiles` + `rememberRecentProfile(id)`；**连接成功**后记录 `profile.id`（没有 id 的临时目标不记，那是「最近连接过的目标」的职责）；命令面板的会话行在提示里追加「最近用过」；恢复默认清空、导入设置重读。
- 不做：不新增「收藏」字段；不重排会话树（会动键盘导航与大量既有用例）。
- 验证：`recentProfiles.test.ts` 4 条、`storeRecentProfiles.test.ts` 2 条、`commandPalette.test.ts` 新增 1 条（未连过无标记；标记是追加，地址与动作说明仍在）。
- 顺带记录：本轮量了一次浏览器契约的分文件耗时（按文件求和 166.3s；最慢 `dialogAudit` 27.3s / 8 例，`agents` 16.1s，`lineSpacing` 8.6s 单例）。这些是「每次挂载真实 App 并跑审计」的必然成本，未做改动，留给以后判断。
- 门（`npm run verify`）：`VERIFY_EXIT=0`；format:check ok 0.9s、typecheck ok 7.0s、lint ok 0.9s、test ok 123.7s（**208 文件／1894 用例**）、test:browser ok 188.9s（**72 文件／317 用例**）。

## 本轮：连接行说清楚它以谁登录（2026-11-24 第 95 轮）

- 问题：面板的「连接到 …」只列地址；当地址省略用户或端口时，读者看不出实际会用谁、哪个端口。
- 交付：提示行改由 App 用**与开会话同一段代码**（`quickConnectProfile(target, newSessionProfile())`）解析出的实际取值渲染：`SSH as {user}, port {port}`；「最近连接过」的行同时给出两段（来源 + 参数）。
- 一次被用例挡下的回退：第一版让记住的行也用同一个解析提示，于是丢掉「最近连接过」，浏览器用例的「从哪来的」断言立刻失败；两段信息各有用途，改为拼接保留。
- 验证：`commandPalette.browser.test.ts` 3/3（含新增断言：第一行含 `SSH as root, port 2222`）；typecheck EXIT=0。
- 门（`npm run verify`）：`VERIFY_EXIT=0`；format:check ok 0.9s、typecheck ok 7.1s、lint ok 0.9s、test ok 123.0s（**206 文件／1887 用例**）、test:browser ok 191.3s（**72 文件／317 用例**）。
- 另外补记 D103–D107（第 89–93 轮的取舍）到 `DECISIONS.md`。

## 本轮：记住的主机只有一处来源（2026-11-24 第 94 轮）

- 问题：第 91 轮把「最近连接过的目标」放在 App 的局部状态，第 93 轮的终端链接点击在 `actions.ts` 里拿不到它——于是从面板连的会记住，从链接点开的不记。
- 交付：列表移进 store（`AppStore.quickConnectRecents` + 动作 `rememberQuickTarget`），面板与链接**都调用它**；`App` 只读 store；「恢复默认设置」把内存列表一并清空，「导入设置」后从存储重新读取。
- 验证：新增 `src/storeQuickTargets.test.ts`（3 条：新在前并落盘、重复前移、上限与空标签）；`quickConnectRecents.test.ts` 5 条未改；`commandPalette.browser.test.ts` 3/3 通过。
- 门（`npm run verify`）：`VERIFY_EXIT=0`；format:check ok 0.9s、typecheck ok 7.1s、lint ok 0.9s、test ok 123.4s（**206 文件／1887 用例**）、test:browser ok 191.2s（**72 文件／317 用例**）。

## 本轮：终端里的 ssh:// 链接可以直接连（2026-11-24 第 93 轮）

- 交付：终端再挂一个 `WebLinksAddon`，`urlRegex` 只匹配 `ssh://…`；点击走第 89 轮解析器，直接开一个不保存的会话。插件自身用 `new URL` 过滤，不成立的地址不会被下划线。
- **一次真实缺陷**：正则第一版带 `g` 标志，插件 `computeLink` 做 `new RegExp(source, flags + "g")` → `gig` → 抛错，连带把同一终端上的**文件链接**也弄坏（既有 `terminalLinks.browser.test.ts` 立刻失败）。改为无 `g` 的 `/…/i`，并加守卫用例（`global === false`、`ignoreCase === true`）。
- 验证：`src/terminalSshLinks.test.ts` 4 条；`src/test/terminalLinks.browser.test.ts` 2/2 通过（既有文件链接未被破坏）。
- 浏览器契约三次运行记录：**第一次全量失败**（`SyntaxError: Invalid flags … 'gig'`）→ 修好后跑该文件通过 → **第二次全量通过**。
- 门（第二次全量 `npm run verify`）：`VERIFY_EXIT=0`；format:check ok 1.0s、typecheck ok 7.2s、lint ok 0.9s、test ok 121.7s（**205 文件／1884 用例**）、test:browser ok 188.9s（**72 文件／317 用例**）。

## 本轮：死代码清理，把 styleCensus 变成门（2026-11-24 第 92 轮）

- 扫描方式：列出 `src/` 所有 `export`，数全仓库引用，只出现一次（只有定义）的即死导出；共 6 个候选。
- 处置：`checkGeneratedContract` 保留（第 78 轮判定为只编译的负控制）、`bindings.ts` 的 `InstallReport`/`KeyCheck` 保留（生成文件）；**删除** `listPreviews`（无调用点）与 `selectionDeleteSequence`（只是 `selectionEdit` 的两行包装）；`styleCensus` **转为门**。
- `styleCensus` 由外壳视觉门（`src/test/uiAudit.browser.test.ts`，三主题／视口各跑一遍）调用并断言：元素数 > 250（证明普查看到了外壳）、字号集合恰为 10/11/12px、行高 ≤ 4 档、圆角 ≤ 7 档、文字色 ≤ 8 档、背景色 ≤ 14 档（实测圆角 6、文字色 6、背景色 10–11，各留一档余量）。
- 验证：`npm run test:browser -- src/test/uiAudit.browser.test.ts` 5/5 通过；typecheck EXIT=0；lint 0 error（2 条既有警告来自生成的 `src/bindings.ts`）。
- 门（`npm run verify`）：`VERIFY_EXIT=0`；format:check ok 0.9s、typecheck ok 7.0s、lint ok 0.9s、test ok 122.3s（**204 文件／1880 用例**）、test:browser ok 190.9s（**72 文件／317 用例**）。

## 本轮：最近连接过的机器（2026-11-24 第 91 轮）

- 背景：面板的目标框只帮第一次，同一台机器第二天还要重敲地址。
- 交付：从面板连上的目标记进本地偏好（键注册进 `PANEL_PREFERENCE_KEYS`，恢复默认会清、导出会带、导入会认），只记标签（如 `root@10.0.0.5:2222`），上限 4 条、重复前移；面板里作为普通命令参与**排序**，提示为「最近连接过」，回车即重连。
- 一次自我修正：第一版把它们插到列表最前面，用例立刻失败——空查询时列表按**分组顺序**重排，插入位置被覆盖。改为随排序走；测试用 `10.0.`（主机名不能以点结尾，故这一行只可能来自记忆）。
- 存储一律校验：非 JSON、非数组、含非字符串、重复项都丢弃；读失败只是没有最近记录，写失败只是丢失记忆。
- 验证：`src/quickConnectRecents.test.ts` 5 条；`commandPalette.browser.test.ts` 3 条（新增断言：连过之后输入 `10.0.` 出现该行且提示为「最近连接过」）。
- 门（`npm run verify`）：`VERIFY_EXIT=0`；format:check ok 0.9s、typecheck ok 7.3s、lint ok 0.9s、test ok 123.0s（**204 文件／1880 用例**）、test:browser ok 188.7s（**72 文件／317 用例**）。

## 本轮：连接目标接受 ssh:// 与方括号 IPv6（2026-11-24 第 90 轮）

- 背景：第 89 轮的目标框只认 host／user@host／host:port。从工单复制来的 `ssh://root@host:22`、不带端口的 `[::1]` 都落空；第一版的 IPv6 分支是个复合条件，读起来靠猜。
- 交付：`ssh://` 前缀（大小写无关）；方括号 IPv6 有端口/无端口都认；`::1`（无括号）与 `[::1]x` 明确拒绝——端口无法判定。地址拆解收进 `splitAddress`：方括号找右括号，其余按唯一冒号拆端口，出现多个冒号又没括号即写法错误。「算不算目标」的规则不变。
- 验证：`src/quickConnect.test.ts` 6 条（三种基本写法 + 方括号 IPv6；`ssh://` 含大小写；十二条拒绝清单；标签名与资料填充；未指定字段保留默认）。
- 门（`npm run verify`）：`VERIFY_EXIT=0`；format:check ok 0.9s、typecheck ok 7.2s、lint ok 0.9s、test ok 123.5s（**203 文件／1875 用例**）、test:browser ok 189.5s（**72 文件／317 用例**）。

## 本轮：命令行面板里直接连主机（2026-11-24 第 89 轮）

- 交付：命令行面板的搜索框兼作目标框——输入能被解析为目标时，**第一行**变成「连接到 …」，回车即开会话；不保存任何资料（`id` 留空的临时资料）。
- 支持的写法：`example.com`、`root@10.0.0.5`、`deploy@build-01.lab:2222`、`[::1]:2222`。
- 一次自我修正：第一版任何单词都能解析成主机，搜索 `zzzz` 时本该出现的「没有匹配」被「连接到 zzzz」顶掉（既有用例立刻失败）。规则改为目标必须**自己说出来**：有 `@`、有 `:`、主机名带点，或方括号地址。
- 验证：`src/quickConnect.test.ts` 5 条（四种写法、单词语句与非法端口被拒、标签名与资料填充、未指定字段保留默认）；`commandPalette.browser.test.ts` 3 条（新增 1：`display` 不出连接行，`root@10.0.0.5:2222` 第一行即连接行，回车后会话出现且 host/user/port 正确、面板关闭）。
- 门（`npm run verify`，第一次用它收尾）：`VERIFY_EXIT=0`；format:check ok 1.0s、typecheck ok 7.5s、lint ok 0.9s、test ok 124.6s（**203 文件／1874 用例**）、test:browser ok 191.4s（**72 文件／317 用例**）。

## 本轮：一条命令跑完整个验证门（2026-11-24 第 88 轮）

- 背景：每轮收尾要跑 `format:check`／`typecheck`／`lint`／`npm test`／`npm run test:browser` 五个门，此前靠我在 shell 里逐条串联；仓库里没有同样的入口给下一个人。
- 交付：`scripts/verify.mjs` + `npm run verify`——依次跑五个任务（每条仍经过托管运行器，遵守「同一时刻一个托管任务」），第一个失败即停但打印每条状态，结尾一张 `ok`/`FAILED (code)`/`skipped` 表并带耗时；可传参只跑子集。
- 实测（最终树，`VERIFY_EXIT=0`）：format:check ok 0.9s、typecheck ok 7.1s、lint ok 0.9s、test ok 124.0s、test:browser ok 190.3s，整门约 5 分 24 秒；单测 202 文件／1869 用例、浏览器契约 72 文件／316 用例。
- 门自身的测试：`scripts/verify.test.mjs`（默认任务顺序；表格对 ok/FAILED/skipped 的措辞与耗时）。
- 边界：不含 Rust 侧门（`test:rust`／`cargo fmt`／`check:clippy`），那些需要原生工具链；也不做增量判断——`ok` 的含义是「这次真的跑过」。

## 本轮：一个站不住的改动前提（2026-11-24 第 87 轮）

- 想法：第 83 轮的「在终端中打开」只在当前标签是已连接 shell 时可用。试着改成「发给面板自己的会话」，让 A 标签的面板能直接 cd A 的 shell。
- 结果：**前提不成立**。既有夹具立刻失败——`FilerPanel` 用 `useActiveTab()`，**文件面板就是绑定在活跃标签上的单例**，「面板会话 ≠ 活跃标签」在本面板里不存在。
- 处置：撤回改动（动作仍发往当前活跃 shell）；保留拆出的 `sendCommandToSession(id, command)`，由 `sendCommandText` 调用，按 id 发送只有一份实现，供将来的标签级面板复用；用例恢复为「不是当前 shell 时禁用且不写入」。
- 结论：要支持「在 A 标签的面板里 cd A 的 shell」，先要有标签级文件面板，而不是给单例面板加参数。
- 全量（定稿树，均取退出码）：format:check EXIT=0（591 文件）、typecheck EXIT=0、lint 0 error（2 条既有警告）、单测 **UNIT_EXIT=0 / 201 文件 / 1867 用例**、浏览器契约 **BROWSER_EXIT=0 / 72 文件 / 316 用例**。

## 本轮：「/ 打开筛选」收敛成一个判断（2026-11-24 第 86 轮）

- 问题：四处列表（文件面板、双栏两侧、会话树、常用命令列表）各自抄了一遍 `event.key === "/" && !ctrl && !meta && !alt`。将来加例外要改四处，第 81 轮就出现过「改一处忘别处」的同类风险。
- 交付：新增 `src/filterKey.ts` 的 `opensFilter(event)`，四处改为调用它；行为一处未变。
- 验证：`src/filterKey.test.ts`（2 条：空 `/` 为真，`Ctrl/⌘/Alt + /` 与其它键为假）；四处接线仍由既有浏览器用例守着（`filerSelection`、`ftpKeyboard`、`sessionTreeRename`、`snippets` 各一条「按 / 焦点进入筛选框」）。
- 全量（定稿树，均取退出码）：format:check EXIT=0（591 文件）、typecheck EXIT=0、lint 0 error（2 条既有警告）、单测 **UNIT_EXIT=0 / 201 文件 / 1867 用例**、浏览器契约 **BROWSER_EXIT=0 / 72 文件 / 316 用例**。
## 本轮：那条重流程用例的超时预算（2026-11-24 第 85 轮）

- 第 84 轮全量浏览器失败的**真实原因**是 `Error: Test timed out in 15000ms`（不是断言不成立）：`lineSpacing.browser.test.ts` 这条要走三次对话框往返（键盘开命令面板→输入→回车→等对话框），中间还夹终端重排的行数测量。
- 修正：给这一条 `it(..., 30000)` 并写明原因；断言一条没动（行数变多/变少、记忆、gutter 行高照旧）。
- 判断依据：同一文件单独跑 8.7 秒通过；本轮全量 72 文件/316 用例通过；失败信息是超时。
- **没有做的事**：没有给所有浏览器用例统一放宽超时（会连「真的很慢」一起藏起来）；没有改 `until()` 轮询上限；第 80 轮 `watchWords` 的失败是断言（`expected undefined to be true`），与超时不同源，仍未复现，保持原记录。
- 全量（定稿树，均取退出码）：format:check EXIT=0（589 文件）、typecheck EXIT=0、lint 0 error（2 条既有警告）、单测 **UNIT_EXIT=0 / 200 文件 / 1865 用例**、浏览器契约 **BROWSER_EXIT=0 / 72 文件 / 316 用例**。
## 本轮：补上「在终端中打开」的接线证据（2026-11-24 第 84 轮）

- 补第 83 轮缺口：新增 `src/test/filerOpenInTerminal.browser.test.ts`（2 条）——①文件面板的会话是活跃已连接本地 shell 时，菜单出现「Open in Terminal」，点击后 `api.writeSession` 收到 `("t1", "cd '/root'\r")`；②该会话不是活跃标签时，菜单项仍在但 `disabled`，且没有写入任何字节。
- 夹具两次自我修正：①语言包在 `useStore.setState({...initialState})` 里被重置回中文，`aria-label` 查不到——改为在 setState 之后显式 `setLanguage("en")`；②禁用态是 `<button disabled>`，不是 `aria-disabled`，改断言元素自身的 `disabled`。
- **第二次未复现的全量失败**：本轮全量浏览器 EXIT=1（`lineSpacing.browser.test.ts` 1 条），该文件单独跑 1/1 通过、重跑全量 72 文件/316 用例通过。上一轮是 `watchWords` 3 条，同样未复现。两轮合计：全量浏览器偶发**布局/终端拟合类**用例失败，单跑与重跑均通过；按 D76 只记为未复现，下一轮若继续出现，再查顺序依赖或 worker 共享状态。
- 全量（定稿树，均取退出码）：format:check EXIT=0（589 文件）、typecheck EXIT=0、lint 0 error（2 条既有警告）、单测 **UNIT_EXIT=0 / 200 文件 / 1865 用例**、浏览器契约 **BROWSER_EXIT=0（重跑）/ 72 文件 / 316 用例**。
## 本轮：文件面板「在终端中打开」（2026-11-24 第 83 轮）

- 背景：反方向早有（终端 Reveal → 文件面板跟随），反过来「翻到某目录，在那个 shell 里 cd 过去」只能手抄路径。
- 交付：文件面板「…」菜单新增 `filer.cdHere`，紧挨反向动作「Terminal folder」；仅当文件面板所属会话就是当前活跃的已连接 shell 时可用（复用 `canReveal`），避免把 `cd` 送进另一个窗口。
- 新增 `src/filerShellPath.ts` 的 `cdCommand(path)`：按**路径形状**决定引号——以 `/` 开头按 POSIX（名字里的 `'` 写成 `'\''`），否则按 PowerShell（`''` 双写）；空白返回 `null`。理由：同一台 Windows 机器既浏览本机路径也浏览远端 POSIX 路径，按平台判断会错。
- 验证：`src/filerShellPath.test.ts` 3 条（POSIX 普通/空格/单引号；Windows 普通/单引号；空与空白）。
- **缺口（如实记录）**：菜单项接线（启用条件、点击后写入 shell）本轮没有自动化用例——需要在夹具里构造「已连接的本地 shell 且为活跃标签」，超出本轮预算，下一轮补。
- 全量（定稿树，均取退出码）：format:check EXIT=0（588 文件）、typecheck EXIT=0、lint 0 error（2 条既有警告）、语言包各 1479 键（一致）、单测 **UNIT_EXIT=0 / 200 文件 / 1865 用例**、浏览器契约 **BROWSER_EXIT=0 / 71 文件 / 314 用例**。
## 本轮：双栏筛选补上「/」键，并证明筛选属于一个目录（2026-11-24 第 82 轮）

- 背景：第 73 轮给双栏加筛选时只测了「输入筛选、Esc 恢复」，有两条行为没有证据：换目录后筛选是否清掉、键盘能不能进筛选框。
- 交付：双栏列表聚焦时 `/` 聚焦本侧筛选框（组合键不拦截，其余按键仍交给列表的键盘模型）。至此四处列表（文件面板、双栏两侧、会话树、常用命令列表）的 `/` 行为一致。
- 验证（两条都是补证据）：`ftpKeyboard.browser.test.ts` 6 条（新增 2）——①夹具里 `path` 由状态驱动，筛成只剩 `file-b.txt` 后切到 `/next` → 筛选框为空、列表回到三条；②列表聚焦按 `/` → 焦点在 `.filer-filter`。
- 全量（定稿树，均取退出码）：format:check EXIT=0（586 文件）、typecheck EXIT=0、lint 0 error（2 条既有警告）、单测 **UNIT_EXIT=0 / 199 文件 / 1862 用例**、浏览器契约 **BROWSER_EXIT=0 / 71 文件 / 314 用例**。
## 本轮：会话树也能用「/」筛，Esc 先清筛选（2026-11-24 第 81 轮）

- 背景：文件面板与常用命令列表都支持「列表里按 / 进入筛选」；会话树有同样的筛选框，却只能点进去。
- 交付：树聚焦时 `/` 聚焦筛选框（Ctrl/⌘/Alt 组合键不拦截）；筛选框里 `Esc` 先清空筛选（与另两处一致）。
- 验证：`sessionTreeRename.browser.test.ts` 2 条（新增 1：树聚焦 → `/` → 焦点在 `.panel-filter input`；输入 `zzz` → 会话行消失；`Esc` → 筛选清空、会话行回来）。
- 全量（定稿树，均取退出码）：format:check EXIT=0（586 文件）、typecheck EXIT=0、lint 0 error（2 条既有警告）、单测 **UNIT_EXIT=0 / 199 文件 / 1862 用例**、浏览器契约 **BROWSER_EXIT=0 / 71 文件 / 312 用例**。
## 本轮：预览记录跟着会话走（2026-11-24 第 80 轮）

- 补第 79 轮记下的缺口：`forgetSessionPreviews` 无调用点。没有补调用，而是改判断——`isPreviewRunning` 要求「记录存在**且**会话仍在」，`stopReportPreview` 对已关闭会话丢弃记录并返回（不再对已释放的预览报错）；`forgetSessionPreviews` 删除。
- 理由：关闭动作在 store 里，`previewActions` 已 import store，反向依赖会成环；按状态判断就不存在「忘记调用」。
- 验证：新增 `src/previewActions.test.ts`（2 条：会话关闭后不再显示在跑、且停止时不调用 `stopPreview`；会话仍在时正常停止并清记录）。
- **一次未复现的失败**：首次全量浏览器 EXIT=1（`watchWords.browser.test.ts` 3 条），该文件单独跑 3/3 通过、重跑全量 311/311 通过；与本轮改动无关，按 D76 记为未复现。
- 全量（定稿树，均取退出码）：format:check EXIT=0（586 文件）、typecheck EXIT=0、lint 0 error（2 条既有警告）、单测 **UNIT_EXIT=0 / 199 文件 / 1862 用例**、浏览器契约 **BROWSER_EXIT=0 / 71 文件 / 311 用例**。
## 本轮：关掉编辑器时释放它的记忆（2026-11-23 第 79 轮）

- 做法：写只读脚本统计 `src` 全部导出符号在其它文件的出现次数（269 个零外部引用；剔除生成文件与测试入口后 23 个连自身文件都不用）。
- **发现一个真缺陷**：`src/editor/editorState.ts` 的 `forgetEditorState` 实现齐全（删缓存 + 记 `suppressed` 供随后 unmount 判断），但**全仓无人调用**。文档 id 每次打开都是新的 `crypto.randomUUID()`，所以关闭后那份 CodeMirror 状态永远不可能再命中，只会占满 16 项上限；`suppressed` 这条防线也从未启用。
- 修正：`src/fileEditor.ts` 的 `closeCurrentEditor` 在清空状态前调用 `forgetEditorState(before.target.id)`。
- 验证：`src/fileEditor.test.ts` 新增 1 条（打开 → 记 id → 关闭 → 断言被调用且参数为该 id）；`fileEditor.test.ts`+`codemirror.test.ts` 24 条通过。
- 其余扫描结果：`checkGeneratedContract` 保留（只编译的负控制）；`forgetSessionPreviews`/`listPreviews`/`selectionDeleteSequence`/`styleCensus` 暂留并记录原因。
- **数字更正**：本轮 `npm test` 实际为 **198 文件／1860 用例**（退出码 0）。此前多轮 STATE 里写的「199 文件」是转抄时的偏差，用例数（1859→1860，正好是本轮新增 1 条）与日志一致；今后总量一律从日志行抄录。
- 全量（定稿树，均取退出码）：format:check EXIT=0（585 文件）、typecheck EXIT=0、lint 0 error（2 条既有警告）、单测 **UNIT_EXIT=0 198 文件／1860 用例**、浏览器契约 EXIT=0 311 用例。
## 本轮：两个没人用的编辑器类型 +「/」聚焦筛选（2026-11-23 第 78 轮）

- **代码质量**：`src/editor/editorTypes.ts` 的 `DocSync`、`DraftState` 全仓各只有声明处一处引用（`src` 下 `.ts`/`.tsx` 0 命中），是一代编辑器实现留下的残骸；更糟的是 `DraftState` 的注释描述了一套**并不存在**的「本地草稿落盘」机制（真实保护是 `fileEditor.ts` 的 `hasUnsavedFile()` + 关闭时询问）。已删除，typecheck EXIT=0、lint 仍 2 条既有警告。
- **交互**：常用命令管理器行上按 `/` 聚焦筛选框（与文件面板一致；`Ctrl/⌘/Alt` 组合不拦截）。
- 验证：`snippets.browser.test.ts` 25 条（新增 1：行聚焦按 `/` → 焦点在 `.snippets-filter`）。
- 全量（定稿树，均取退出码）：format:check EXIT=0（585 文件）、typecheck EXIT=0、lint 0 error（2 条既有警告）、单测 199 文件／1859 用例、浏览器契约 EXIT=0 311 用例。
## 本轮：Esc 先从编辑里退一步（2026-11-23 第 77 轮）

- 问题：在常用命令管理器里改写一条命令时，按 Esc 会把整个管理器关掉，改到一半的内容无声消失。管理器本来就是「Esc 先清筛选、再关窗」的两级结构（第 11 轮），编辑是同一类「读者正身处其中」的地方。
- 交付：有编辑在进行时，Esc 与「Close」按钮先退出编辑（丢弃表单内容、回到空表单），再按一次才关窗。只对**已存在**的条目生效：写全新命令时 Esc 仍直接关窗，对话框不困住读者。
- 验证：`snippets.browser.test.ts` 24 条（新增 1：点「Edit Deploy」→ Esc → 管理器仍在、表单清空、列表条目未改动；再 Esc → 关闭）。
- 边界：三级 Esc——筛选 → 编辑 → 关窗，每一级只退一步。
- 全量（定稿树，均取退出码）：format:check EXIT=0（585 文件）、typecheck EXIT=0、lint 0 error（2 条既有警告）、单测 199 文件／1859 用例、浏览器契约 EXIT=0 310 用例。
## 本轮：改名时名字已经是选中的（2026-11-23 第 76 轮）

- 问题：上一轮让常用命令列表认 F2，但按下之后焦点仍在行上，读者要再点一次输入框、再全选一次才能输入新名字。
- 交付：进入编辑（F2 / 铅笔按钮）后，名字输入框获得焦点且**全文选中**：直接打字就替换，Enter 保存。
- 关键实现：动作放在 `useEffect(editingId)` 而不是 `edit()` 里——`edit()` 只写状态，随后的渲染把值写进输入框，而**赋值会把光标移到末尾**；渲染之后再选中才是读者看到的那一屏。
- 用例加强：`snippets.browser.test.ts` 断言 F2 后 ①表单名字正确 ②焦点在输入框 ③选择区间覆盖整个名字 `[0, 6]` ④没有发送、列表仍是两条。
- 一次自我修正：第一版把 `focus()/select()` 写在 `edit()` 里，同步成功但被随后的渲染清掉；移到 effect 后通过。
- 另一处清理：给这个 effect 加的 `biome-ignore` 是多余的（依赖已完整），lint 因此从 2 条警告变成 3 条；删除后回到 2 条。
- 全量（定稿树，均取退出码）：format:check EXIT=0（585 文件）、typecheck EXIT=0、lint 0 error（2 条既有警告）、单测 199 文件／1859 用例、浏览器契约 EXIT=0 309 用例。
## 本轮：常用命令列表也认 F2（2026-11-23 第 75 轮）

- 背景：上一轮给会话树加了 F2；常用命令列表能用方向键走动，却唯独改名要拿鼠标点铅笔按钮。
- 交付：命令行的 `F2` 把光标所在行载入表单，走的就是铅笔按钮那条路径（`edit(snippet)`）。没有另做就地改名：一行有两块内容，改名与改命令本就共用一张表单。
- 验证：`snippets.browser.test.ts` 23 条（新增 1：焦点放到第二行按 `F2` → 表单名字是 `Deploy`，且 `WRITES` 仍为空、列表仍是两条）。
- 边界：`F2` 只填表不保存，读者仍要按「Save Changes」；行上 Delete / Backspace / 方向键行为不变。
- 全量（定稿树，均取退出码）：format:check EXIT=0（585 文件）、typecheck EXIT=0、lint 0 error（2 条既有警告）、单测 199 文件／1859 用例、浏览器契约 EXIT=0 309 用例。
## 本轮：F2 重命名当前项（2026-11-23 第 74 轮）

- 背景：文件面板早有 F2；会话树没有，读者必须放下键盘去右键菜单找「Edit…」。
- 交付：会话树里 `F2` 作用于光标所在行——会话 → 打开会话编辑器；分组 → 打开分组重命名框；类型分区标题不做任何事。放在树的按键处理器而不是行按钮上（行按钮自己吞按键，而方向键走动时光标可能在任意行）。
- 一次自我修正：首次没先走动光标——焦点进入树时激活的是第一行（类型分区标题），F2 对分区不做事，断言 0 次调用；改为「先走到会话行再按 F2」，并用 `toContain("Lab box")` 让失败时直接报出光标停在哪一行。
- 验证：新文件 `sessionTreeRename.browser.test.ts`（单会话夹具挂载会话树，`aria-activedescendant` 走到 `Lab box` 后按 F2 → `onEditProfile` 调用一次且参数正确）。
- 全量（定稿树，均取退出码）：format:check EXIT=0（585 文件）、typecheck EXIT=0、lint 0 error（2 条既有警告）、单测 199 文件／1859 用例、浏览器契约 EXIT=0 308 用例。
## 本轮：双栏文件浏览器也有筛选了（2026-11-23 第 73 轮）

- 背景：上一轮只给 Filer 面板加了筛选；FTP/SFTP 双栏走的是另一个组件（`FileBrowser`），那里一直没有筛选。
- 交付：双栏每侧在路径栏下方新增筛选栏（与 Filer 同一套样式与计数文案）；筛选进入排序 memo；`path` 变化清空；筛选变化清空本侧选择；`aria-label` 带面板标题，两栏同名也能区分。
- 两次自我修正：①`onSelectionChange(new Set())` 类型不对——这个组件的选择模型是 `{ paths, anchor }`，不是 `Set`，typecheck 抓到；②断言 `1 of 3` 实际是 `1 / 3`——夹具默认中文，在该用例开头设 `setLanguage("en")`。
- 验证：`ftpKeyboard.browser.test.ts` 4 条（新增 1：三条目夹具输入 `file-b` → 只剩一条、计数 `1 of 3`、Esc 恢复三条）。
- 全量（定稿树，均取退出码）：format:check EXIT=0（584 文件）、typecheck EXIT=0、lint 0 error（2 条既有警告）、单测 199 文件／1859 用例、浏览器契约 EXIT=0 307 用例。
## 本轮：把第 71 轮留下的缺口补成证据（2026-11-23 第 72 轮）

- 目标：第 71 轮「切目录后筛选清空」只有实现、没有测试，当时写进已有夹具文件的用例会让邻居用例在 `open()` 阶段超时。
- 做法：新建**只有一条用例、自有 mock** 的 `filerFilterNavigation.browser.test.ts`（`/root` 含目录 `sub` 与文件 `a.txt`，`/root/sub` 含 `b.txt`）：筛成 `1 of 2` 后双击进入 `sub` → 列出 `b.txt` 且筛选值为空。
- 证据：该文件 1/1 通过；全量浏览器 306 项通过（较上轮 +1）。
- 结论：第 71 轮的超时不是产品行为，而是**用例放进共享夹具后的相互影响**；同一条行为在独立夹具里一次通过。第 71 轮文档已把「未覆盖」改为已覆盖并说明原因。
- 过程中两次自我修正：①先断言 `0 of 2` 却得到 `0 / 2`——夹具语言不是 en，补 `setLanguage("en")`；②先用 `filter.blur()` 再按 Esc 清空，但 Esc 清空处理器挂在输入框上，失焦后不会触发——改为「先筛出目录名（`su`），再双击进入」，这更接近读者真实路径。
- 全量（定稿树，均取退出码）：format:check EXIT=0（584 文件）、typecheck EXIT=0、lint 0 error（2 条既有警告）、单测 199 文件／1859 用例、浏览器契约 EXIT=0 306 用例。
## 本轮：筛选属于它所在的文件夹；被筛掉的行不再保持选中（2026-11-23 第 71 轮）

- 补齐上一轮留下两个语义问题：切换目录后筛选仍然生效（读者看到被旧关键词过滤的目录）；被筛掉的行仍留在选中集（一次删除会作用在看不见的文件上）。
- 交付：`path` 变化时清空筛选；筛选值改变时清空选择。
- 证据：`filerSelection.browser.test.ts` 覆盖「选中 file1 → 输入 file999 → 选中集为空」（并入筛选用例，6/6 通过）。
- **未覆盖的缺口（如实记录）**：「切目录后筛选清空」没有测试。写过一个用路径编辑框导航到 `/elsewhere` 的用例，它让该文件后续 6 条用例在 `open()` 阶段超时；移除后恢复。根因未确认（疑似共享 mock 与二次挂载的交互），本轮不把这条行为算作已验证。
- 全量（定稿树，均取退出码）：format:check EXIT=0（583 文件）、typecheck EXIT=0、lint 0 error（2 条既有警告）、单测 199 文件／1859 用例、浏览器契约 EXIT=0 305 用例。
## 本轮：文件面板能就地筛选（2026-11-23 第 70 轮）

- 问题：文件面板只有 type-to-select，没有筛选；1000 个文件的目录里找 `file999.txt` 只能翻或跳。FileZilla、WinSCP、资源管理器都有筛选框。
- 交付：路径栏下方新增筛选栏（按名称、不区分大小写），非空时右侧显示「{shown} / {total}」；列表里按 `/` 聚焦筛选框；筛选框里 `Esc` 先清空筛选。
- 关键实现：筛选放进 `sortedEntries` 这一个 memo，选择、type-to-select、方向键、虚拟滚动自动作用于筛选后的列表——否则读者会遇到「选中了看不见的文件」。
- 验证：`filerSelection.browser.test.ts` 6 条（新增 2：1000 文件夹具中输入 `file999` → 只剩一个、计数 `1 of 1000`、Esc 恢复；列表聚焦按 `/` → 焦点进入筛选框）。
- 一次测试修正：先给行按钮 `.focus()` 不成立（行不在 Tab 顺序），keydown 没经过列表处理器；改为聚焦列表容器。
- 格式化门一次为 1（新 CSS 行），`biome format --write` 后 0；两语言包各 1477 条键（一致）。
- 全量（定稿树，均取退出码）：format:check EXIT=0（583 文件）、typecheck EXIT=0、lint 0 error（2 条既有警告）、单测 199 文件／1859 用例、浏览器契约 EXIT=0 305 用例。
## 本轮：常用命令有了自己的快捷键（2026-11-23 第 69 轮）

- 交付：新增 `snippets` 快捷键命令——Windows/Linux 为 **Ctrl+Shift+S**，macOS 为 **⌘⇧S**，可在键盘快捷键里改绑；分发到 `requestSnippetsOpen()`，与菜单打开同一个弹层。
- 为什么是 Ctrl+Shift+S：终端里 Shift 不参与控制字节，`Ctrl+Shift+字母` 不损失任何按键（VS Code/WindTerm/MobaXterm 同一家族）；S 与「保存」语义一致，且与已占用的 P/B/O/L/W/T/Z/F/G/J/C/V/A 都不冲突。
- 面板不重复列出该命令（面板里已有「Saved Commands」动作行），避免同一动作两行。
- 验证：`shortcuts.test.ts` + `commandPalette.test.ts` 50 条通过（默认表含新命令、无冲突、标签/提示齐全）；`snippets.browser.test.ts` 22 条（新增 1：真实页面按 Ctrl+Shift+S 打开弹层）。
- 全量（定稿树，均取退出码）：format:check EXIT=0（583 文件）、typecheck EXIT=0、lint 0 error（2 条既有警告）、单测 199 文件／1859 用例、浏览器契约 EXIT=0 303 用例。
## 本轮：发送常用命令时说出「发给了几个终端」（2026-11-23 第 68 轮）

- 问题：同步输入打开时，一条常用命令写到每个勾选的终端，状态栏却只说「Sent: Logs」——没说是只发了这一个还是发到了五台机器。
- 交付：同步输入打开且有其它目标时，状态栏变成 `Sent: {name} — to {count} shells`（含来源终端）；其它情况保持原文案。
- 关键点：目标数来自 `broadcastTargets`——与真正写入用的是**同一个纯函数**，不另写筛选，「说发的」和「实际发的」不可能分叉。
- 验证：新增 `snippetSend.test.ts` 4 条（单目标／同步开启计数并写到 b／b 被排除后回到单目标文案／活动标签是 SFTP 时拒绝并给出原因）。
- 一次类型返工：测试夹具手写 Tab 对象漏了 6 个字段、`pendingSessionInfo` 又要求完整 SessionInfo；最后改用真实的 `pendingSessionInfo` 构造，typecheck 才过。**夹具也别手搓大对象。**
- 全量（定稿树，均取退出码）：format:check EXIT=0（583 文件）、typecheck EXIT=0、lint 0 error（2 条既有警告）、单测 199 文件／1859 用例、浏览器契约 EXIT=0 302 用例。
## 本轮：启动命令发不出去时，说一声（2026-11-23 第 67 轮）

- 缺陷：启动命令的 `writeSession` 失败此前是 `catch(() => undefined)`——静默失败。读者专门设了这一行，就是为了让会话落在正确目录。
- 交付：失败改为在状态栏报「Startup command could not be sent: {error}」（中英文各一条）。
- 原则延续：第 62 轮是「结果已在屏幕上就不出声」，这一轮是它的另一面——**应当出现的结果没出现，必须说**。
- 验证：`startupCommand.browser.test.ts` 3 条（新增 1：让 `write_session` 抛错 → 状态栏出现该消息并含原因）。
- 边界：只覆盖写入失败；标签在 400ms 内被关闭仍静默（读者自己关的）。
- 全量（定稿树，均取退出码）：format:check EXIT=0（582 文件）、typecheck EXIT=0、lint 0 error（2 条既有警告）、单测 198 文件／1855 用例、浏览器契约 EXIT=0 302 用例。
## 本轮：空列表不是死胡同 + Esc 先退筛选（2026-11-23 第 66 轮）

- 问题：常用命令弹层第一次打开只写「在下面添加一条」；读者刚跑完的命令在屏幕上，而保存它的两条更快路径（终端右键、命令行面板）没人告诉他。
- 交付：空列表第二行（更暗更小）点明两个入口；筛选框里 `Esc` 先清空筛选，**再按一次**才关闭弹层。
- 判断：指导只出现在空列表（有了条目就撤掉，避免永久占据版面）；`Esc` 是一步退——筛选是读者走进去的一层。
- 验证：`snippets.browser.test.ts` 21 条（新增 2：空列表含两条指引、保存一条后消失；筛选无匹配时 Esc 清空且弹层仍在，再按关闭）。
- 全量（定稿树，均取退出码）：format:check EXIT=0（582 文件）、typecheck EXIT=0、lint 0 error（2 条既有警告）、单测 198 文件／1855 用例、浏览器契约 EXIT=0 301 用例。
## 本轮：终端右键菜单也能打开常用命令管理（2026-11-23 第 65 轮）

- 问题：右键菜单能发送、能保存、能重跑最近命令，但想**改一条或删一条**还得先想起命令行面板。
- 交付：`snippetActions` 增加打开管理器的注册（与运行/保存同形，未注册为空操作）；hook 在同一个 effect 注册三个入口；终端菜单新增「Saved Commands」。
- 判断：管理**不依赖连接**——它只是编辑动作；断线时读者更需要整理命令库，而不是被告知先连上。发送与保存仍然要求已连接。
- 验证：`snippetRunner.test.ts` 6 条（新增 2：打开者被调用／未注册不抛错）；`snippets.browser.test.ts` 19 条（新增 1：右键 → 「Saved Commands」→ 管理器打开）。
- 全量（定稿树，均取退出码）：format:check EXIT=0（582 文件）、typecheck EXIT=0、lint 0 error（2 条既有警告）、单测 198 文件／1855 用例、浏览器契约 EXIT=0 299 用例。
## 本轮：第 59 轮「复制不覆盖源」的承诺其实不成立（2026-11-23 第 64 轮）

- 缺陷：`copyName` 先前是「先拼后缀、再裁到上限」。名字已用满 60 字符时，`X copy` 裁回 60 位正好等于原名；`saveSnippet` 按名覆盖，于是复制把**源条目改成了副本**。
- 为什么当时没发现：单测只断言长度 ≤ 上限，没断言结果与既有名字不同；浏览器用例用的名字很短。
- 负向对照（独立脚本复现旧算法）：`old: 60 个 x → overwrites source: true`；`new: "…x copy" → distinct: true`。
- 修法：按后缀长度**先缩短词干**再拼后缀，后缀永不被裁掉；计数用尽后继续计数而不是交回已占用名字。
- 验证：`snippets.test.ts` 14 条（新增 2：60 字符名、连续 4 个副本）；`snippets.browser.test.ts` 18 条（新增 1：界面点复制后是**两条**条目，源命令不变）。
- 全量（定稿树，均取退出码）：format:check EXIT=0（582 文件）、typecheck EXIT=0、lint 0 error（2 条既有警告）、单测 198 文件／1853 用例、浏览器契约 EXIT=0 298 用例。
## 本轮：长命令不能把菜单撑到窗外（2026-11-23 第 63 轮）

- 背景：上一轮把最近命令放进右键菜单，菜单里第一次可能出现一整行命令（示例 74 字符）。实测子菜单被撑到 **488px**（原先只有 `max-width: calc(100vw - 12px)`）。
- 交付：`.context-submenu` 改为 `box-sizing: border-box` + `max-width: min(440px, calc(100vw - 12px))`（与菜单栏面板同一个 440px 上限，且把内边距算进上限）；`MenuAction` 新增 `title`，最近命令与已保存命令的每一行都带完整文本。
- 第一版写错：把上限写在 `shell.styles.css` 的 `.menu-submenu` 上，被后加载的 `panels.styles.css` `.context-submenu` 覆盖。是在测试里打印 `getComputedStyle(panel).maxWidth`（得到 1088px）才定位的。
- 验证：`snippets.browser.test.ts` 17 条（新增 1：74 字符命令 → 子菜单宽度 < 448px、标签 `scrollWidth > clientWidth`、`title` 是完整命令）。
- 全量（定稿树，均取退出码）：format:check EXIT=0（582 文件）、typecheck EXIT=0、lint 0 error（2 条既有警告）、单测 198 文件／1851 用例、浏览器契约 EXIT=0 297 用例。
## 本轮：终端右键菜单发送最近命令（2026-11-23 第 62 轮）

- 目标：读者想重跑刚用过的一条命令时，手就在终端里；右键比先想起快捷键更快。
- 交付：终端右键菜单新增「最近命令」子菜单（最多 10 条，最近在前，未连接禁用）；抽出 `sendCommandText` 与发送已保存命令共用同一条通道与同一句拒绝理由，`sendSnippet` 改为调用它后再报「已发送」。
- 两个判断：历史行成功时**不出声**（命令已经在屏幕上，状态提示只是噪音）；菜单在绘制时读历史（每次打开都重建，无需订阅）。
- 验证：`snippets.browser.test.ts` 16 条（新增 1：记一条历史 → 右键 → 子菜单 → 点击 → `git status\r`，状态栏没有「Sent:」）。
- 一次真实失败：测试最初用 `noteCommandSent` 期望顺带写入历史，实际没有；改为 `commandHistory.record`。这说明历史只在真实提交路径写入，模拟「上一条命令」不等于「已记录」。
- 一次自查抓到的回归：把 `setPaletteOpen(true)` 换成 `openPalette()` 后忘了补依赖，typecheck 不报、lint 的 `useExhaustiveDependencies` 报 error；补进依赖后 lint 回到 0 error。
- 全量（定稿树，均取退出码）：format:check EXIT=0（582 文件）、typecheck EXIT=0、lint 2 条既有警告、单测 198 文件／1851 用例、浏览器契约 EXIT=0 296 用例。
## 本轮：命令行面板列出最近用过的命令（2026-11-23 第 61 轮）

- 问题：历史此前只做行内补全与清空；重跑几天前的长命令只能靠记忆打出足够长的前缀。
- 交付：`history.recent(limit)`（按最近使用排序、同文本一行）；面板新增 `history` 数据源（id `history:<n>`，标签是命令本身，提示行是主机）与 `sendHistory` 动作，走与打字相同的发送通道；面板打开时装入最近 40 条。
- 三个判断：历史行放在目录**最后**（不把 40 行压在其他命令之上，搜索仍能找到）；目录在**打开面板时**重建（不是每次记录都重建，否则每按一次 Enter 就重渲染整个窗口）；非 shell 会话由同一条拒绝路径说明原因。
- 验证：`history.test.ts` 新增 1（三条记录含重复文本 → 去重且按最近排序）；`paletteHistory.test.ts` 新增 2（标签/提示/关键字/run 调用；无历史时没有 `history:` 行）。
- 全量（定稿树，均取退出码）：format:check EXIT=0（582 文件）、typecheck EXIT=0、lint 2 条既有警告、单测 198 文件／1851 用例、浏览器契约 EXIT=0 295 用例。
## 本轮：带参数的常用命令记住上次填的值（2026-11-23 第 60 轮）

- 问题：`ssh {{host}}`、`deploy {{env}}` 每跑一次都要重填参数。
- 交付：同一应用会话内，按命令 id 记住上次填的值；再次运行时预填、立即可以发送。只记在内存里——参数常是环境名/主机名/一次性代号，写进设置会让「保存的命令」带上读者没打算保存的上下文，也让导出/恢复带上它们。
- 验证：`snippets.browser.test.ts` 15 条（新增 1：首次填 `prod` 发送 → 再次打开已预填、发送可用 → 第二次 `write_session` 收到 `deploy prod\r`）。
- 全量（定稿树，均取退出码）：format:check EXIT=0（581 文件）、typecheck EXIT=0、lint 2 条既有警告、单测 197 文件／1848 用例、浏览器契约 EXIT=0 295 用例。
## 本轮：常用命令可以复制一份再改（2026-11-23 第 59 轮）

- 目标：读者想要的常是「照这条改一条」，此前只能新建再手动重打命令。
- 交付：行内新增「复制」按钮；`copyName` 依次试 `X copy`、`X copy 2`…，大小写不敏感，结果裁到名字上限；复制绝不覆盖源（名字是查找与「再保存即替换」的键）。
- 验证：`snippets.test.ts` 12 条（新增 4：空位／被占计数／大小写／上限）；`snippets.browser.test.ts` 14 条（新增 1：点复制后 `Logs` 与 `Logs copy` 并存且命令相同）。
- 过程中一次真实失误：第一次追加上单测时用正则找 import 行，格式化后的多行 import 让匹配为 null，追加失败；改用 edit 精确插入后 12 条通过。这说明「追加到文件」的脚本要按当前格式定位，不能假设单行。
- 格式门：本轮首次 format:check 为 1（新增 locale 行未按 Biome 排版），`biome format --write` 后 0；随后核对两语言包各 1469 条键（一致），未发生截断。
- 全量（定稿树，均取退出码）：format:check EXIT=0（581 文件）、typecheck EXIT=0、lint 2 条既有警告、单测 197 文件／1848 用例、浏览器契约 EXIT=0 294 用例。
## 本轮：右键菜单也能「把上一条命令存成常用命令」（2026-11-23 第 58 轮）

- 问题：命令行面板有「Save Last Command as a Snippet」，终端右键菜单却只有「发送已保存命令」。读者记住一条命令后的自然动作是右键，而不是先想起一个快捷键。
- 交付：终端右键菜单新增该项（有已保存命令时紧跟在子菜单后，否则在分隔线后；未连接禁用）；`snippetActions` 增加保存回调注册，与运行注册同形，没有注册者时是安全空操作；hook 在同一个 effect 里注册运行与保存。
- 类型教训：注册 effect 写在 `saveLastCommandAsSnippet` 之前 → `TS2448`。`useCallback` 不提升，effect 必须排在它引用的回调之后。
- 验证：`snippetRunner.test.ts` 4 条（新增 2：已注册被调用一次／未注册不抛错）；`snippets.browser.test.ts` 13 条（新增 1：提交 `kubectl get pods` → 右键 → 菜单项 → 命名 `Pods` → store 里存的是这条命令）。
- 全量（定稿树，均取退出码）：format:check EXIT=0（581 文件）、typecheck EXIT=0、lint 2 条既有警告、单测 197 文件／1844 用例、浏览器契约 EXIT=0 293 用例。
## 本轮：常用命令列表的键盘走查（2026-11-23 第 57 轮）

- 问题：每行三个按钮全在 Tab 顺序里，两条命令就要按 6 次 Tab 才能在它们之间挪动。
- 交付：行上 `↑`/`↓` 在相邻行之间移动焦点（筛选后的可见列表内，边界不动）；`Delete`/`Backspace` 删除该行并在正在编辑它时退出编辑；`Tab` 顺序保持不变。
- 判断依据：行内按钮不接收文本，Backspace 在这里本来无意义，因此借来当删除不与打字冲突；删除不确认，与既有删除按钮一致。
- 验证：`snippets.browser.test.ts` 新增 1 条——聚焦第一行、↓ 到第二行、↑ 回第一行、Delete 后只剩 Deploy，且**没有任何写入**（删除不是发送）。
- 全量（定稿树，均取退出码）：format:check EXIT=0（581 文件）、typecheck EXIT=0、lint 2 条既有警告、单测 197 文件／1842 用例、浏览器契约 EXIT=0 292 用例。
## 本轮：新连接也能设「连接后执行的命令」（2026-11-23 第 56 轮）

- 修上一轮留下的洞：字段原本只在已保存连接上出现，读者必须先保存再打开一次。现在新建 ssh/local 也能填写，Save / Save & connect 用返回的 id 归属，随后连接时自动发送。
- 顺带改进：字段改为本地草稿，保存时一次写入——此前每敲一个字就写一次 localStorage，取消还会留下半条命令。
- 验证：`startupField.browser.test.ts` 1 条端到端——新连接可见字段、输入后未保存不落盘、点主按钮后命令存到 `p-new`、随后 `write_session` 收到 `cd /srv/app\r`。这条同时补上了第 53 轮只在直接 openSession 路径验证过的自动发送。
- 一次类型教训：`SessionDialog` 的 `initial` 类型是 `SessionProfile | null`，不是 `undefined`；浏览器测试能跑，typecheck 抓到。
- 全量（定稿树，均取退出码）：format:check EXIT=0（581 文件）、typecheck EXIT=0、lint 2 条既有警告、单测 197 文件／1842 用例、浏览器契约 291 用例。
## 本轮：终端高亮补测试 + 整行分类抽出（2026-11-23 第 55 轮）

- 先量后改：最大的、无测试的逻辑模块是 `semanticColors.ts`（754 行、0 测试），而它决定每一行终端输出的样子。
- 测试：19 条——提示符词汇（user@host、方括号、venv 前缀、cmd/PowerShell、❯/>>>/$、`# comment` 不算 root）、只有提示符才算提示符、8 类真实输出的区间不变量（单调、界内、十六进制、条数上限）、错误/链接/权限位/diff/表头/注释的语义、light/dark 与 serialX 主题切换。
- 代码优化：`windtermLine` 的六个整行分支抽成 `wholeLineStyle(text, unixPermissions, powershellMode)`，调用方 30 行→5 行，行为不变（19 条为安全网）。
- 被测试挡下的错误预期：`"- removed"`（短横+空格）本就**不是**删除——YAML/Markdown 列表项；改测试断言这条例外，另用无空格的 `"-removed"` 验证 band。
- 全量（定稿树，均取退出码）：format:check EXIT=0（580 文件）、typecheck EXIT=0、lint 2 条既有警告、单测 196 文件／1842 用例（+19）、浏览器契约 EXIT=0 290 用例。
## 本轮：命令偏好登记 + tabRename 偶发的真正原因（2026-11-23 第 54 轮）

- 质量项一（规则违反）：第 46、53 轮加的两个偏好键没有登记进 `persistKeys.ts`，于是「恢复默认设置」不清、设置导出不带、导入不生效。已登记，键常量改为引用登记表；导入后立刻重读进 store，恢复默认时同时清空 store（只删键会留下界面上的幽灵命令）。test: settingsCommands 3 条覆盖导出/导入/恢复。
- 质量项二（偶发失败定位）：tabRename 全量失败再次出现。先测量（单文件 8 次全绿 → 只在负载下出现），再试守卫（全量两次绿，但单测 5 条红 → 证明守卫破坏了「点标签进 shell」，回退）。真正原因：**用例跳过了「标签栏拥有键盘」这个前置状态**，直接 focus 标签，于是应用按设计把焦点交给 shell。用例先 `setActive("a","strip")`、断言焦点在标签上，再按 F2。
- 证据：WorkspaceTabFocus 12/12、tabRename 连跑 3 次全绿、全量浏览器连续 2 次全绿（290），最终树再次确认见下。
## 本轮：连接后自动执行的命令（2026-11-23 第 53 轮）

- 交付：已保存的 ssh/local 连接可设「连接后执行的命令」，连接成功后自动输入并回车；连接期间读者已输入内容时先发读者的输入、登录脚本让位；文件会话不执行；只取首行；清空即删除。
- 存储取舍：放应用设置（`edgeterm.startupCommands`）而不是 profile 文件——不改 Rust 模型与绑定，旧 profile 仍可读；代价是换机器不跟着走，文档写明。
- 时序：连接成功后固定延迟 400 ms 再发；定时器复查标签仍在且已连接，关掉的标签收不到迟到的命令。没有等提示符，因为识别错会永远不发。
- 验证：startupCommands 单测 5 条（首行、畸形输入、200 上限、往返、store 写盘与清空）+ 浏览器 2 条（SSH 后 `write_session` 收到 `cd /srv/app\r`；SFTP 900 ms 后无写入）。
- 全量（定稿树，均取退出码）：format:check EXIT=0（578 文件）、typecheck EXIT=0、lint 2 条既有警告、单测 194 文件／1820 用例、浏览器契约 290 用例。
## 本轮：常用命令来到终端右键菜单（2026-11-23 第 52 轮）

- 交付：终端右键菜单新增「发送常用命令 ▸」（最多 15 条），点击走与弹层、命令面板相同的入口（含参数询问）；未连接时禁用；没有保存命令时不显示。
- 结构：终端面板不拥有对话框，于是加一层极小登记（registerSnippetRunner / requestSnippetRun，未登记时退回直接发送），三条入口不会走出两种行为。
- 验证：snippetRunner 单测 2 条（登记后收到同一片段；未登记退回直接发送并给出原因）+ 浏览器 1 条（右键 → 子菜单 → 点 Logs → IPC 收到 `tail -f app.log\r`）。
- 测试层教训：右键模式由组件渲染时读取，夹具必须先设模式、等一帧再派发；否则处理器闭包仍是旧模式。另：`RightClickAction` 的字面量是 `menu`，不是 `contextMenu`（typecheck 抓到，浏览器测试不会）。
- 全量（定稿树，均取退出码）：format:check EXIT=0（574 文件）、typecheck EXIT=0、lint 2 条既有警告、单测 193 文件／1815 用例、浏览器契约 288 用例。
## 本轮：标签指针约定 + 一次真实破坏与恢复（2026-11-23 第 51 轮）

- 交付一（用户可见）：中键点击标签页关闭它（活动标签与关闭按钮同一路径：**运行中的会话先询问**，已结束的直接关闭；**固定标签不受中键影响**，连询问都不弹）；标签栏空白处右键新增「重新打开已关闭的标签页」，栈空时禁用。
- 交付二（事故处理，必须记录）：我把 `src/locales/en.ts` 与 `zhCN.ts` 用「读取→改→整体写回」截短了约 570 条。`read` 对约 80 KB 的文件只返回了前一部分行，我没有核对行数就整体覆盖。
- 恢复：第 50 轮被取消的 1.8.0 构建留下了 `dist/`（18:41，早于损坏），语言包被编进 bundle。从中提取 2956 个键值对、按语言归类、与残存文件合并，两包各恢复 **1463** 条；另修正 5 条误判（英文值含双引号，在 bundle 里是单引号字面量）。
- 恢复证据：typecheck 通过（`MessageKey` 由英文包键集定义，任何缺失键都会编译失败）；单测 192 文件／1813 用例、浏览器契约 287 用例（含大量精确文案断言）全部通过。
- 全量（定稿树，均取退出码）：format:check EXIT=0（573 文件）、typecheck EXIT=0、lint 2 条既有警告、单测 192 文件／1813 用例、浏览器契约 287 用例。

### 流程反思（本轮）

- 事故的根因不是工具，是我没有**核对** `lines.length` 与 `totalLines` 就整体覆盖。已写进规则：大文件不读-改-写。
- 长构建的产物救回了源码内容：取消构建前先想清楚它是不是唯一副本。
## 本轮：留在 1.7 线 + 命令面板打开常用命令（2026-11-23 第 50 轮）

- 用户指示：**先别 1.8，继续在 1.7 版本完善**。已把版本从 1.8.0 改回 1.7.8（package.json、Cargo.toml；tauri.conf 用 `../package.json`），并取消正在运行的 1.8.0 构建任务；bundle 目录里没有 1.8.0 产物。
- 本轮交付：命令面板新增「常用命令」条目 → 打开管理弹层（键盘读者不必经过菜单）。
- 验证：paletteSnippets 单测 4 条（新条目存在、标签、运行回调、未提供时不出现）+ 片段浏览器用例 10 条（新增：面板输入 Saved Commands → 弹层标题出现）。
- 全量（定稿树，均取退出码）：format:check EXIT=0（572 文件）、typecheck EXIT=0、lint 2 条既有警告、单测 192 文件／1813 用例、浏览器契约 283 用例。

### 发布边界（事实）

- 已发布的 1.7.8 安装包早于第 41–50 轮的改动；当前工作树是 1.7.8 之上的开发状态，未生成新安装包。
- 需要新安装包时，按 1.7 线补一个补丁号（例如 1.7.9）再构建；未经用户确认不升到 1.8。
## 本轮：常用命令通过剪贴板搬家（2026-11-23 第 49 轮）

- 目标：保存的命令只活在这台机器上，换机、给同事、批量整理都没有出口。
- 交付：`snippetTransfer.ts`（导出/导入的纯函数：格式与版本、无 id、三种拒绝原因、按名去重末条胜出、条数与长度上限、名称清洗）；store 的 `importSnippets` 一次合并一次持久化；弹层底部「复制全部 / 从剪贴板导入」与提示、错误文本。
- 取舍：走剪贴板而不是文件——不需要原生保存/打开对话框，也不在磁盘上留下需要读者自己管理的文件；要落盘时把剪贴板内容粘进任意编辑器即可。
- 半途发现：本轮原本打算做「会话日志到文件」，先查了一遍后端，发现**录制已存在**（`session::recording`、profile 的 recording 字段、失败事件与对话框勾选）。没有重复实现，改做真正缺的搬运能力。
- 验证：单测 6 条（导出无 id/往返/三种拒绝/跳过计数与重名/上限/清洗）+ store 2 条（合并持久化、上限返回 0）+ 浏览器 1 条（复制→剪贴板包 JSON 与提示；导入→多一条；`not json`→错误且列表不变）。
- 全量（定稿树，均取退出码）：format:check EXIT=0（572 文件）、typecheck EXIT=0、lint 2 条既有警告、单测 192 文件／1812 用例、浏览器契约 282 用例。
## 本轮：把常用命令界面从 App 搬出来（2026-11-23 第 48 轮）

- 目标：结构收敛。App.tsx 里混着常用命令的三个状态与约 40 行界面。
- 交付：新 `components/useSnippetRunner.tsx` 自持三个状态、runSnippet、saveLastCommandAsSnippet 与三个对话框；App 只留一行调用、两个入口与 `{snippetsUi.surfaces}`。
- 规模：App.tsx 1325 行（改动前约 1360），新 hook 约 95 行，其中 45 行来自 App。
- 性质：纯结构变化，对外行为不变；证据是既有 8 条片段浏览器用例与 13 条菜单用例全部通过，另有全量。
- 全量（定稿树，均取退出码）：format:check EXIT=0（570 文件）、typecheck EXIT=0、lint 2 条既有警告、单测 191 文件／1804 用例、浏览器契约 281 用例。
## 本轮：常用命令的编辑与筛选（2026-11-23 第 47 轮）

- 目标：改一条保存过的命令只能删掉重加；列表长了只能滚动。
- 交付：store 新增 replaceSnippet（原地改名称与命令、拒绝重名、持久化）；弹层表单兼编辑器（铅笔载入、保存修改/取消、重名错误）；筛选框按名称与命令收窄，无匹配有专门提示。
- 验证：单测 8 条（原地更新并持久化、重名拒绝且原条目不变、空值/未知 id 拒绝）+ 浏览器 8 条（编辑成功后 store 更新、重名出现错误文本、筛选收窄/无匹配/清空恢复）。
- 一处测试教训：编辑与删除按钮共用 `.snippets-delete` 类，旧用例因此点到了编辑按钮；改为按 aria-label 前缀定位。
- 验证事故（如实记录）：首次全量时 format:check 实际失败，而我的输出只截了末尾两行、看到空行没看到结论；确认退出码后重跑并修正了一个文件的格式。教训写入 LEARNINGS：**结论看退出码，不看截断的尾部**。
- 全量（定稿树）：单测 191 文件／1804 用例、浏览器契约 281 用例、typecheck、format:check（569 文件，EXIT=0）、lint（仅生成绑定 2 条既有警告）通过。
## 本轮：常用命令的参数（2026-11-23 第 46 轮）

- 目标：同一行命令里通常只有一两个词会变（`deploy {{env}} --tag {{tag}}`），保存下来即一条可复用的模板。
- 交付：snippets.ts 新增 templateNames / expandTemplate（去重、按出现顺序、名称去空白、空值保留占位符）；SnippetArgsDialog（预览 + 每参数一字段 + 填全才可发送）；App 用唯一入口 runSnippet 统一弹层与命令面板两条路径。
- 分隔符取舍：用 `{{name}}`，因为 `${VAR}` 属于 shell、`{}` 出现在 awk/find/sed 里；靠语法猜哪些花括号是我们的会改坏命令。未闭合的 `{{` 原样保留。
- 验证：单测 5 条（去重顺序、替换、缺值保留、awk 花括号不动、未闭合原样、名称去空白）+ 浏览器 1 条（缺值时 Send 禁用；填全后 IPC 收到 `deploy prod --tag v9\r`，询问框关闭）。
- 全量：单测 191 文件／1801 用例、浏览器契约 69 文件／279 用例（带日志）、typecheck、format:check（569 文件）、lint（仅生成绑定 2 条既有警告）通过。
## 本轮：补上「保存上一条命令」的成功路径（2026-11-23 第 45 轮）

- 背景：第 44 轮把该路径记为已知缺口，理由是「夹具无法稳定驱动命令跟踪器」。
- 定位方式：写一个断言式探针（把期望值故意写成哨兵字符串，从失败差异里读出真实值），三种驱动方式一次跑出结果——`noteCommandSent` 先于 OSC 133 C 时得到 `echo hi`，其余两种得到空字符串。
- 根因：**调用顺序**。`noteCommandSent` 开始一次命令；之后 shell 的 `OSC 133 C` 在已运行状态下被忽略。第 44 轮写的是 C → note → D，于是命令以空文本开跑。
- 交付：浏览器用例改为覆盖完整链路——面板 → 命名框（提示带命令原文）→ 提交 → 存储出现 `{name: "Greeting", command: "echo hi"}`；保留「没有可保存命令」的拒绝路径。片段浏览器用例 5/5。
- 全量：单测 190 文件／1796 用例、浏览器契约 68 文件／278 用例（带日志）、typecheck、format:check（567 文件）、lint（仅生成绑定 2 条既有警告）通过。

### 流程反思（本轮）

- **哨兵断言比 console.log 好用**：本项目 Vitest 会吞掉测试里的 console 输出，把期望值写成不可能命中的字符串，失败差异就是答案。
- 「夹具驱动不了」不是放弃的理由：写探针的成本约 2 分钟，本轮一次就拿到三种顺序的真实行为。
## 本轮：常用命令进入命令面板（2026-11-23 第 44 轮）

- 交付：命令面板新增两类条目——「发送 <名称>」（每个片段一条，按片段名/命令文本/snippet 可搜）与「把上一条命令存为常用命令」（无已完成命令时状态栏说明、不弹空框）；命名框复用 GroupNameDialog。
- 验证：paletteSnippets 单测 3 条（条目、关键词、回调、调用方不提供时不出现）+ 片段浏览器用例 4 条（新增：面板发送后 IPC 收到 `tail -f app.log\r`；无命令时拒绝且不弹框）。
- 未覆盖并记录：保存成功路径没有端到端用例（夹具无法稳定把跟踪器驱动到「已完成命令」，两种写法都得到空命令文本）；改用例覆盖拒绝路径，成功路径记为已知缺口，不制造绿灯。
- 全量：单测 190 文件／1796 用例、浏览器契约 67 文件／277 用例（带日志）、typecheck、format:check（567 文件）、lint（仅生成绑定 2 条既有警告）通过。
## 本轮：常用命令库 + 自动聚焦让位（2026-11-23 第 42–43 轮）

- 交付一（第 42 轮主体）：常用命令库——snippets.ts（校验/持久化/发送字节）、storeSnippetActions（按名称 upsert、删除、每次持久化）、snippetActions（走输入漏斗，文件/未连接会话拒绝并说明）、SnippetsDialog（列表、Add、删除、Close/Esc）、View 菜单入口。
- 交付二（第 43 轮）：自动聚焦让位——调度时记下焦点，帧里若焦点已被读者移走则放弃；这修掉的是真实缺陷：迟到的 rAF 会把焦点从标签/菜单抢到终端，F2 等「元素自己的键」随之静默失效，也是前几轮几次未复现浏览器失败的同一机制。
- 验证：单测 189 文件／1793 用例（片段模型 9 条、存储 5 条）；浏览器契约 66 文件／275 用例（片段端到端 2 条：保存→点击发送→IPC 收到 `tail -f app.log\r`→删除；无会话时拒绝且零写入）；改名用例连跑 3 次全绿。
- 全量（定稿树）：typecheck、format:check（566 文件）、lint（仅生成绑定 2 条既有警告）、单测与浏览器契约全部通过。

### 流程反思（本轮）

- 这次失败**有日志**才查出根因：`.tmp/browser-run-43.log` 里带行号的断言与截图路径直接指向 F2/焦点。第 40 轮起固定落盘日志的做法第一次真正兑现。
- 教训：一次「未复现」的失败，如果不能定位，就把它当作仍然存在的问题；本轮它第二次出现时给出了完整现场。
## 本轮：瞬态标记跟随会话状态（2026-11-23 第 41 轮）

- 缺陷：第 38/39 轮加的两个瞬态指示都不看会话状态——关闭的会话仍显示最后的程序标题，已关闭的标签仍挂铃铛徽标。
