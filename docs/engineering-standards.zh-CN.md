# 工程规范：上游评审后的开发与验收规则

适用范围：所有新修改，以及已有 agent 生成代码的复核。来源是上游 PR [#91](https://github.com/miskin-lee/EdgeTerm/pull/91)、[#92](https://github.com/miskin-lee/EdgeTerm/pull/92)、[#93](https://github.com/miskin-lee/EdgeTerm/pull/93) 的 Changes Requested，和 2026-10-14 对 PR #91 之后提交的逐个复审（那份笔记没有入库；其中的结论只有被当前代码或测试复核过才能引用）。历史评审、历史提交说明和本文件都不能替代当前代码的验证。

## R1：先证明问题，再声明修复

- 记录触发步骤、预期/实际行为、基线与候选提交。性能问题另记操作系统、构建模式、渲染器、缓冲行数、标签数量、操作方向和测量工具。
- 因果解释必须能在调用链、版本固定的依赖源码、协议或 profile 中对应起来。不能从“拖动卡顿”直接推断“所有 resize 都会重排全部历史”。xterm 6.0.0 在列数不变时跳过 reflow，但这不等于整个应用的竖向拖动没有开销。
- 每个优化都要有同环境、同工作负载、同语义的前后对照。明确预热、次数、构建模式，保留原始结果；降低持久性保障、提高并发数必须单列，不能把它们全部归为算法收益。
- 分开写“代码机制成立”“夹具测试通过”“真实部署验证通过”。模拟 20 ms RTT 和 jsdom/无渲染测量不能证明真实服务器吞吐、WebView2 GPU 卡顿或所有平台均已修复。
- 缺少测量时写“收益待验证”；不得写“已解决卡死”“全部优化有效”。不要引用无法定位原始数据的历史倍率。

## R2：UI 承诺必须能由实际后端兑现

- 当前双栏拖拽只允许跨面板复制。任何同侧 drop 都返回 null；不得用“增加一次确认”替代作者要求的“删除同侧 move”。工具栏的显式重命名是另一条操作路径。
- Replace、Merge、Resume、Cancel、Durable 等承诺必须贯穿 UI → IPC → 后端 → 协议实现核验。测试必须检查目标文件内容和失败后状态，不能只检查某个函数被调用。
- 不把 `rename` 一概称为覆盖或原子提交。以下是当前传输引擎的能力边界：

| 路径 | 替换方式 | 能承诺的范围 |
|---|---|---|
| 本地下载 | 同目录临时文件 → 目标替换 | 不先删除旧目标；按本地文件系统的替换语义执行 |
| 支持 `posix-rename@openssh.com` 的 SFTP | 扩展 rename | 单次服务器端替换；不能推导为掉电后目录项必定持久 |
| 无该扩展的 SFTP | 旧目标 → backup，partial → 目标 | 可恢复的两步提交；有目标路径短暂不存在的窗口，不是原子覆盖 |
| FTP | RNFR/RNTO，采用 backup + partial 两步流程 | 同样有可见性窗口；服务器语义/断线恢复需单独测试 |
| Durable 上传 | SFTP `fsync@openssh.com` | 要求服务器支持且返回成功；缺扩展或 FTP 上传必须明确失败，不能悄悄降级 |

- 暂停/重试/丢应答后，依据已确认检查点恢复。复用旧 partial 即使 offset 为 0，也必须清理未确认尾部。只有本次排他新建且仍持有句柄的空文件可跳过截断。
- drain 并发请求时必须保留每个失败；目录重试保持父先子后。一次假失败不等于覆盖了多个依赖目录同时失败。
- 所有权不明的 partial/backup 不得认领或清理；错误消息要说明哪些文件保留、何时可重试。

## R3：保持默认行为，区分默认与用户选择

- 未点击排序的列表保持后端原顺序。不要因为新功能存在就无条件引入 numeric/locale 排序。
- “默认名称升序”和“用户明确选择名称升序”是不同状态。当前 `FileSort.explicit` 保存这种区别；旧存储中没有标记的名称升序保持原语义。用户选择后的升/降序必须用同一套比较规则。
- 目录始终排在文件前；缺失时间的顺序、同值稳定性、中文/大小写/标点/数字文件名都要有明确契约。
- 设置变更、排序、目录切换和虚拟列表滚动重置要一致；使用 `path` 作为记录身份，不用可变行号。

## R4：持久化必须完整且即时生效

- store 已有偏好由 store 的读写、导入/导出、恢复默认路径管理；外部面板偏好集中登记在 `persistKeys.ts`。该文件不是所有历史 localStorage key 的总表。
- 新共享偏好优先放入 store。Filer 和双栏必须订阅同一个排序值；测试应实际挂载多个面板验证同步，不能以“用了 zustand”代替测试。
- reset/import 后，已挂载组件必须刷新。旧面板的编辑草稿通过 `panelPreferencesRevision` 重读并校验；不能要求用户关闭面板或重启才生效。正在运行的传输/发送任务保留启动时的参数，新任务使用新偏好。
- 校验损坏值、缺失字段、未知字段和旧版配置。增加一个字段不能使其他合法旧配置全部失效。
- localStorage 不可用时遵循已有容错约定；导入外部偏好只能写入登记的 key。

## R5：复用既有 UI，验证真实布局与交互

- 复用 `icons.tsx` 的 Codicon；调整元素类型后搜索全部相关选择器，包括媒体查询、hover/focus 和全局 reset。
- Name 左对齐；数值/时间列保持原对齐。800px 断点两侧都检查，不能仅用静态 CSS 搜索代替浏览器布局验证。
- 虚拟列表的父容器负责滚动，行距与 CSS 一致。覆盖顶部/底部、字号变化、目录/排序重置，以及被指针捕获的行滚出可见区仍能释放。
- 自动滚动必须更新命中目标；释放、Escape、pointercancel、隐藏和卸载都停止后续工作。隐藏标签保留挂载时，卸载清理不够。
- 浏览器测试记录工具边界：合成文件和 mock IPC 可以证明前端交互，不证明真实上传/下载内容正确。

## R6：终端 resize 的可观察契约

- 隐藏终端不执行布局 fit，并取消待执行的列调整；显示时立即重新测量。此处采用“显示时 fit”，与 VS Code 的隐藏时 idle 策略并不完全相同。
- normal buffer 少于 200 行，立即调整两维；大缓冲时行变化始终立即应用，包括宽高同时变化。只有列变化等待最后一次事件后的 100 ms。
- dispose、窗口尺寸回退、显隐切换和多个 fit 入口都不得留下过期任务。字体/初次显示的显式立即 fit 不受拖拽防抖延迟。
- 测试使用真实 xterm 的尺寸和 onResize（PTY 同步边界），只 mock jsdom 不具备的布局测量。禁止把 `applyFit` 整个 mock 掉后，仅靠调用次数声称行为正确。

## R7：测试与提交说明必须可审计

- 采用 [测试与验收方案](test-plan.zh-CN.md)。针对确认缺陷先证明新用例在旧实现上失败，再记录修复后的结果。
- 每个评审意见映射到实现、测试和结果。后续“修复评审”的提交也必须重新审查，不能按标题判断完成。
- 不把历史诊断脚本的退出码当作自动验收。脚本必须等待异步结果、失败时非零退出、明确选定测试目标，并清理自身创建的会话/限速/监听。
- 独立 PR 从目标基线构建；确需堆叠则明示依赖，不能把被打回的改动夹带到另一 PR。
- 提交/PR 描述写最终行为和验证边界。无法运行的测试注明缺什么条件；不要用更多 mock 来掩盖真实环境缺口。

## R8：提交范围与拆分

- 一个提交只做一件事。标题之外的改动（偏好开关、迁移、无关处理器）单独提交；body 里写“Also carries …”说明它应该被拆出去，而不是被披露就算合规。例：bd1c4e2 的 resize/输出额度里夹带了 WebGL 渲染器开关和 Enter 重连处理；e15dab9 的双栏浏览器里夹带了 Sender 偏好重读和 persistKeys 迁移。
- 每个提交单独成立：自身就能通过 `npm run typecheck` 和它触及区域的测试（前端改动跑相关 `*.test.ts`，后端改动跑 `cargo test --lib` 中对应模块）。bisect 和 cherry-pick 依赖这一点。
- 删除或移动文件时，所有 importer 在同一提交内修改。例：ca310db 删除了 `src/terminalTransfer.ts`，`terminal.ts`/`xmodem.ts`/`zmodem.ts` 仍在导入，直到 5a09ad8 才加回；中间三个提交各有 4 个 TS 错误（3×TS2307 + 1 个连带的 TS7006）。用 `npm run check:commits -- <base>..HEAD --typecheck` 逐个提交验证。
- 不夹带顺手功能。审查中发现的新问题另起提交，并在 PR 描述中列出。
- 大提交（默认：除锁文件外 >1500 行改动或 >40 个文件，或同时改 `src/`、`src-tauri/` 和文档）要么拆分，要么在 body 写 `Scope: <为何不能拆>`，例如生成代码、单一协议的原子替换。ca310db（约 5000 增 / 1300 删）应按“后端引擎 / IPC / UI / 测试夹具”拆分。
- 依赖顺序：被依赖的提交在前，并且自身可编译。堆叠的工作在 PR 描述里写明基线和依赖链；重排或拆分后，对整个范围重跑 `--typecheck`。

## R9：提交说明必须能由 diff 证明

- 标题描述这个提交的 diff 实际做了什么，不描述整个功能链。若关键逻辑已在之前的提交里，标题写本提交补的那一环。例：1085a2e 标题为 “reconnect a dead session with Enter”，但按键处理已在 bd1c4e2，本提交只是接上回调，应写 “feat: wire Enter-reconnect callback into session actions”。
- 措辞对应 R1 的证据级别：
  - 只有代码机制：用动作动词（add、wire、remove、replace），不写结果。
  - 夹具/jsdom 测试通过：可写行为，body 注明 `Tests:` 和环境边界。
  - 真实环境测量：才可写 faster、fixes hang、no longer re-renders 等结果性措辞。
- `perf:` 必须带 `Measured: baseline <sha/数值> / candidate <sha/数值> / env <OS、构建模式、渲染器、负载>`；没有测量就写 `Unmeasured: <原因>`，标题不得出现数值或倍率。例：f8a7318 “stop tab churn from re-rendering the whole app” 无测量，且 App 仍订阅 `activeId` 和当前标签对象，切换标签仍会重渲染；应写 Unmeasured 并把标题收窄到实际减少的订阅。
- `fix:` 必须带 `Tests: <回归用例，已在旧实现上失败>`，或 `Tests: none — <原因>`。若没有复现旧缺陷，不用 `fix:`。例：5a09ad8 “keep XMODEM and ZMODEM payloads binary” 没有旧实现损坏数据的证据，实质是去掉一次 base64 往返，更适合 `perf:`/`chore:` 加 Unmeasured。
- 标题中的绝对化词语视为待证：全部、所有、彻底、完全、已解决、根治、all、every、whole、fully、completely、always、never、reliable、guarantee。没有对应证据就删掉。`check:commits` 会对这些词给出 WARN。
- “address review”/“修复评审”类提交按 R7 逐条重新审查，PR 描述列出每条评审项对应的提交和测试。
- 必填行格式固定为 `Key: value`，放在 body 中独立一行：`Measured:`、`Unmeasured:`、`Tests:`、`Scope:`。

## R10：测试必须能失败

- 行为声明需要在真实调用点有测试，而不只是纯函数。例：`paneDrop.test.ts` 只测了 `source.side !== target.side` 这一个比较，FtpPane 里同侧 drop 的接线被改掉也不会失败；隐藏面板仍 fit 没有组件级测试。
- 预期值不能从被测的生产常量推导。例：`output.rs` 的测试用 `SESSION_WINDOW` 计算预期，改常量预期同步变化，等于没测。写字面值，或单独断言常量本身。
- 不 mock 正在被证明的东西。例：`apiBinary.test.ts` mock 了 `invoke`，只能证明前端发出的形状，不能证明 Rust 端能解码；跨边界的声明需要另一侧的测试（Rust 单元测试解同一份字节）。`reconnect.test.ts` 直接调用私有 `handleData` 并传入 mock 回调，证明不了 `actions.ts` 的接线。
- 变异抽查：对每条行为声明，写出“改哪一行生产代码，哪个测试必须失败”。上次抽查 15 个有效变异中 4 个存活：`actions.ts` 的 Enter 重连接线、host-key 守卫、FtpPane 同侧 drop 接线、隐藏面板 fit。存活的变异要么补测试，要么在 PR 中写明未覆盖。
- 变异要在一次性 worktree 中做，不改主工作区：
  1. `git worktree add --detach .tmp/mutate/<name> HEAD`（`.tmp/` 已被忽略，位于仓库内，Node 和 TypeScript 会向上找到主仓库的 `node_modules`）。
  2. 在 worktree 中改一行，从 worktree 目录运行 `node ../../../node_modules/vitest/vitest.mjs run <测试文件>`；Rust 用 `cargo test --manifest-path .tmp/mutate/<name>/src-tauri/Cargo.toml --lib <过滤>`。
  3. 记录结果后 `git worktree remove --force .tmp/mutate/<name>` 再 `git worktree prune`，确认 `git worktree list` 只剩主工作区。
  - 禁止对 `node_modules` 做 symlink/junction 或复制到 worktree。曾有一次 junction 后删除 worktree，把主仓库的 `node_modules` 一并清空。删除前若看到 worktree 里有 `node_modules` 链接，先单独移除链接本身。
  - 不在主工作区用 `git stash`/手改再还原的方式做变异，避免把变异留在提交里。

## PR 自查清单

- [ ] `npm run check:commits -- <base>..HEAD --typecheck` 无 ERROR；每条 WARN 已处理或在 PR 中说明。
- [ ] 每个提交只有一个关注点；移动/删除文件与 importer 在同一提交。
- [ ] 每个标题都能由该提交的 diff 证明；无未证明的绝对化词语。
- [ ] `perf:` 有 `Measured:` 或 `Unmeasured:`；`fix:` 有 `Tests:`，且回归用例在旧实现上失败过。
- [ ] 每条行为声明列出了变异抽查结果（见测试方案“提交与拆分验收”）；存活的变异已写明。
- [ ] 测试预期不依赖被测常量；没有 mock 被证明的对象；跨 IPC 的声明两侧都有测试。
- [ ] `git worktree list` 只有主工作区；`.tmp/` 无残留；`git status` 只有预期改动。

## 固定参照

- [xterm 6.0.0 Buffer.ts](https://github.com/xtermjs/xterm.js/blob/6.0.0/src/common/buffer/Buffer.ts)：reflow 的列数判断。
- [VS Code TerminalResizeDebouncer，5177e1b](https://github.com/microsoft/vscode/blob/5177e1b4e4da8b371e9482b1c0b9024a10c488ed/src/vs/workbench/contrib/terminal/browser/terminalResizeDebouncer.ts)：200 行阈值、行/列拆分、100 ms 列防抖。
- [OpenSSH 协议说明，8ec21f6](https://github.com/openssh/openssh-portable/blob/8ec21f6274108e93601173ec4e6f7528b90b0003/PROTOCOL)：posix-rename 与 fsync 是不同扩展。
- [RFC 959](https://www.rfc-editor.org/rfc/rfc959.html)：RNFR/RNTO 本身不提供本项目两步提交的原子性保证。
