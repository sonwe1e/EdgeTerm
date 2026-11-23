# 关掉编辑器时释放它的记忆（2026-11-23 第 79 轮）

按用户要求做了一次系统性的代码质量扫描：写了一个只读脚本，取 `src` 下所有非测试文件的**导出符号**，统计每个名字在其它文件出现次数。269 个导出在自身文件之外没有引用；剔除生成文件 `bindings.ts` 与「只为测试而导出」之后，有 23 个连自身文件都不用。逐个核对后只有一个是真正的缺陷。

## 一、发现：`forgetEditorState` 写好了，却没人调用

`src/editor/editorState.ts` 里有一个注释写得很清楚、实现也齐全的函数：

```ts
/** Releases the remembered state for a document that is no longer open. */
export function forgetEditorState(docId: string): void { ... }
```

它同时做两件事：删掉缓存项，并把 id 记进 `suppressed`（供随后到来的 unmount 判断「这份状态不该回存」）。

**但全仓没有一处调用它。** 而文档 id 是每次打开新生成的（`crypto.randomUUID()`），也就是说：编辑器关闭后，它在 `savedEditors` 里的那份 CodeMirror 状态**再也不可能被命中**，只会一直占到 16 项上限、把别人挤出去。同时 `suppressed` 这条防线也从未启用。

## 二、修正

在 `src/fileEditor.ts` 的关闭路径（`closeCurrentEditor`，即确认放弃改动、清空状态之前）调用 `forgetEditorState(before.target.id)`。

## 三、验证

`src/fileEditor.test.ts` 新增一条：打开文件 → 记下 `target.id` → `closeFileEditor()` 返回 true → 断言 `forgetEditorState` 被调用且参数就是那个 id（用模块级 `vi.mock` 包住真实实现）。`fileEditor.test.ts` + `data/codemirror.test.ts` 共 24 条通过，typecheck EXIT=0。

## 四、其余扫描结果的处置（如实记录）

| 符号 | 判定 |
| --- | --- |
| `checkGeneratedContract`（bindings.contract.ts） | **保留**：注释写明是「只编译的负控制」，`@ts-expect-error` 在 typecheck 时才起作用 |
| `forgetSessionPreviews`、`listPreviews`（预览） | **暂留**：前者缺少明确的会话关闭调用点（记录下来，下一轮或后续处理），后者是 Rust `preview_list` 的镜像 |
| `selectionDeleteSequence`、`styleCensus`（纯函数） | 暂留：本轮时间预算用于上面那条真实缺陷；标记为待清 |

结论：机械删除「零引用」不是质量工作——269 个候选里只有 1 个是真的行为缺陷，其余多是测试入口、生成文件或为未来保留的镜像。
