# 死代码清理，以及把一个死掉的诊断工具变成门（2026-11-24 第 92 轮）

本轮按目标里的「代码质量评估」做一次有界扫描：列出 `src/` 里所有 `export`，数全仓库引用次数，只出现一次（即只有定义）的即为死导出。

## 一、扫描结果（6 个候选）

| 符号 | 处置 | 理由 |
| --- | --- | --- |
| `checkGeneratedContract`（bindings.contract.ts） | 保留 | 第 78 轮已判定：只编译的负控制，带 `@ts-expect-error` |
| `InstallReport`、`KeyCheck`（bindings.ts） | 保留 | 生成文件的类型，手改会被 `check:bindings` 打回 |
| `listPreviews`（previewClient.ts） | **删除** | 没有调用点；后端 `preview_list` 仍在，需要时再加回来 |
| `selectionDeleteSequence`（terminalSelectionEdit.ts） | **删除** | 只是 `selectionEdit` 的两行包装，调用方直接用后者 |
| `styleCensus`（uiAudit.ts） | **转为门**（见下） | 有诊断价值但没人调用 |

## 二、把 styleCensus 变成不变量

它是「实际绘制出来的字号／行高／圆角／文字色／背景色频次表」。此前没有任何调用者，等于一个没人拉响的警报器。现在由外壳视觉门（`src/test/uiAudit.browser.test.ts`，三种主题／视口各跑一遍）调用，并断言：

```
元素数 > 250            证明普查真的看到了外壳，而不是空文档
字号集合 == 10/11/12px  今天就是这三档；多一档立刻失败
行高 ≤ 4 档、圆角 ≤ 7 档、文字色 ≤ 8 档、背景色 ≤ 14 档
```

上限比实测多留一档（实测：圆角 6、文字色 6、背景色 10～11），这样**有意的**新增还做得到，而「这里顺手写个 13px／5px 圆角」的漂移会立刻失败。

## 三、验证

- `npm run test:browser -- src/test/uiAudit.browser.test.ts` → **5/5 通过**（三个主题／视口配置都跑过新断言）；
- typecheck EXIT=0；lint 0 error（2 条既有警告来自生成的 `src/bindings.ts`）；
- 全量见 STATE 本轮记录。

## 四、边界与风险

- 字号断言是**精确集合**，所以刻意新增一档字号需要同时改这条断言——这是有意的摩擦；
- 上限型断言（行高／圆角／颜色）不会因为删减而失败，只在增长时失败；
- 普查只看 DOM 里绘制出来的元素：终端画布、SVG 内的文字不计入。
