# 审计：代码质量——死代码、重复、无回报的复杂度（2026-11-25 第 219 轮）

前四轮审的是行为、无障碍、文案、测试。这一轮审**代码本身**。方法：跑 `npm run typecheck` 作为编译器权威（exit 0），对全部 544 个 src 文件（251 个非测试、293 个测试；11,476 个函数、6,316 个参数、3,260 个 if、28 个 switch）建导出/导入图并做 AST 分析，每个候选都手工读过才上报。

## 6 条发现

| 编号 | 问题 | 状态 |
| --- | --- | --- |
 | C1 | 拖拽手柄的整套生命周期在 `Splitter` 与 `FilerColumnResizer` 之间**整体重复**（约 80 行，连两行注释都一字不差）——这是 UI 里最微妙的正确性面：先退役再释放 capture 的次序、window 回退与 lostpointercapture 的竞态、释放时冲刷vs中断时取消、卸载清理 | **未修**（需提取共享助手） |
 | C2 | 「最近使用」的 localStorage 层被写了三遍（`recentProfiles`、`quickConnectRecents`、`commandPalette`），`safeStorage` 逐字节相同，加载循环与封顶写入也相同——连三个测试文件都在重测同一套规则 | **未修** |
 | C3 | `endpoint` 与 `forwardRoute` 被逐字复制进三个对话框（IPv6 加括号规则、「动态转发不写目标」规则各存三份） | **未修** |
 | C4 | `SessionDialog` 的 save 与 connect 重复同一段 11 行校验前奏（连三行注释都一样）——两个必须就「校验什么、焦点落哪」达成一致的入口是两份拷贝 | **未修** |
 | C5 | 1,339 个非测试导出里有 **112 个没有任何导入方**，其中 43 个是值不是类型；`export let paneCounter` 还暴露了无人消费的可变模块状态 | **未修**（删 export 关键字，机械但churn 大） |
 | C6 | 小死单元与别名：`endingLabel` 全仓只出现一次（连内部调用都没有）、`downloadClashes` 是 `namesTaken` 的纯别名、`errorMessage` 是 `errorText` 的纯别名、`newestAbsLine` 算了却没人用 | **已修**（前三项） |

## 明确查过没有问题的三类（AST 验证，非推测）

- **「参数收了不读」——没有。** 6,316 个参数，0 个从未被引用。这覆盖了 `tsc` 的 `noUnusedParameters` 看不到的情况（被用参数前面的参数、解构参数）。
- **「不可达分支」——没有。** 六项 AST 检查全零：return/throw/break/continue 之后的语句、两个分支都终止后还有语句、switch 重名 case、if/else-if 条件文本相同、同一块里 `if (C) { ...return }` 之后又出现 C、字面量 `if (true)`/`if (false)`。
- **「注释与所附着代码矛盾」——没有。** 提取并读了全部 135 条断言用法的前导注释（含 "no longer"、"unused"、"dead"、"never called"、"only used"、"deprecated"、"legacy"），逐条对照代码，无一矛盾。

审计者还主动排除了两个误报：`checkGeneratedContract`（文档记载的有意编译期负对照，带 `@ts-expect-error`）与生成物 `bindings.ts` 里的重复。

## 本轮只修了 C6 的前三项

删 `endingLabel`（无调用者）、删 `downloadClashes` 与 `errorMessage`（纯别名，调用点改指 `namesTaken`／`errorText`），并删掉那条**断言两个别名相等**的测试——它在任一被删后都会继续通过，保护不了任何东西。

C1–C5 都是真正的重构，每一处都贴近行为，本轮预算下不做。精确位置都记在上面。

### 本轮自伤五次，全是同一类

1. 删 `endingLabel` 只删了签名，**函数体成了孤儿**，`tsc` 报 `TS1128`。
2. 删 `downloadClashes` 后忘了 `useFilerDownloads.test.ts` 里还有 6 处调用，且 `namesTaken` 没导入。
3. `errorText` 我以为在 `terminalTransfer` 里定义，其实它只是从 `./errorInfo` 导入再转发——所以正确做法是让调用方直接 import `errorInfo`。
4. `terminalClipboard.ts` 在 `src/components/` 下，我把路径写成 `../errorInfo`，应为 `./errorInfo`。
5. `format:check` 又失败一次——**我只格式化了手动改的几个文件，漏了两个**。这是本会话第三次同一个错误（第 215、216 轮各一次）。

**五次都是「凭印象下手，没有先读当前状态」。**第 3、4 条尤其是：我据审计描述假设了模块结构，而没有打开文件确认。修法最后一次做对了：`git status` 列出所有改动文件，逐个喂给 formatter。

## 第 220 轮：C3 修好了（纯移动，无行为变化）

新建 `src/forwardRoute.ts`，把 `endpoint` 与 `forwardRoute` 搬进去，三个对话框改为导入。删除的是三份逐字拷贝——**连两条文档注释都一字不差**。

两处收尾：`SessionDialog` 与 `SshConfigImportDialog` 其实只用 `forwardRoute`，我却按审计描述导入了两个名字，`tsc` 报两条 `TS6133` 后收窄。**这是本轮唯一一次自伤，且是编译器一秒纠正。**格式化这次做对了：用 `git status` 列出全部改动文件逐个喂给 formatter，没有再犯前三轮那个错。

`ForwardCenter` 只导 `endpoint`（它那里没有 `forwardRoute` 的用例）。

## 第 221 轮：C4 修好了

`save` 与 `connect` 重复同一段 11 行校验前奏——**连三行注释都一字不差**。提成一个局部 `prepare(): candidate | null`（重置错误、归一化、校验、聚焦、置错误），两个入口各自第一行调用它。

为什么这条值得修：这两个入口**必须**就「什么算有效」和「无效时焦点落哪」达成一致，而它们是两份拷贝——给一边加规则、忘了另一边，就是 Save 与 Connect 之间一次无声的行为分裂。用户点了保存能过、点连接被拒，且没有任何提示解释为什么。

本轮零自伤：一次读全两处、一次改完、typecheck 直接过。这是连续三轮里第一次没靠编译器纠正我。

## 第 222 轮：C2 修好了

新建 `src/recentIds.ts`，导出 `loadIds(key, limit, storage)`／`pushId(ids, id, limit)`／`saveIds(ids, key, limit, storage)` 与共用的 `StorageLike`／`safeStorage`。三个模块各自只留自己的键与上限。

三个签名从 `storage: StorageLike | null = safeStorage()` 改成 `storage: StorageLike | null = null`，内部传 `storage ?? undefined` 让共享助手自己取默认值——这样三个模块仍然可以像以前一样被注入假存储，**三套既有测试一条没改就全绿**。

本轮零自伤：先读全三处、再建模块、再逐个重写，typecheck 一次过。这是连续两轮零自伤（上一轮 C4 也是）。
