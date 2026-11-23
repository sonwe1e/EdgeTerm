# 预览记录跟着会话走（2026-11-24 第 80 轮）

上一轮记录的缺口：`forgetSessionPreviews` 没有调用点。这一轮把它想清楚了——**不是补一个调用，而是把「记录」改成「跟着会话存在」。**

## 一、问题

`src/previewActions.ts` 在窗口侧记着「本窗口开过哪些报告预览」（`running`）。会话关闭时，Rust 侧会释放这些预览，但窗口侧这张表没人清理。后果不是内存泄漏那么无害：文件面板的右键菜单据此决定显示「Stop preview」还是「Preview report」——一条死记录会让菜单继续提供「Stop preview」，点下去只能得到一句错误。

原计划在会话关闭处调用 `forgetSessionPreviews`，但关闭动作在 store 里，而 `previewActions` 已经 import 了 store——再反向依赖就是环。

## 二、做法

改为**按会话是否仍在来判断**：

```ts
const sessionAlive = (sessionId: string): boolean =>
  useStore.getState().tabs.some((tab) => tab.info.id === sessionId);
```

| 位置 | 变化 |
| --- | --- |
| `isPreviewRunning` | 记录存在**且**会话仍在才算在跑：死记录不再让菜单提供「Stop preview」 |
| `stopReportPreview` | 会话已不在时丢掉记录并返回，不再对着已释放的预览报错 |
| `forgetSessionPreviews` | 删除（它的职责由上面两条取代，且本来无人调用） |

这样不需要在任何关闭路径上安排调用——不存在「忘记调用」的可能。

## 三、验证

新增 `src/previewActions.test.ts`（2 条）：

1. 打开预览前为 false；打开后为 true；把会话从 store 里去掉后变回 false，且 `stopReportPreview` **不会**调用 `previewClient.stopPreview`（会话已带走它）；
2. 会话仍在时，`stopReportPreview` 调用 `stopPreview("pv1")` 并把记录清掉。

## 四、边界

- 「会话仍在但预览已被 Rust 侧关掉」仍按原设计：停止时如实报错，而不是假装成功；
- 记录仍只增于本窗口真正打开过的预览，不猜测外部状态。

## 五、定稿证据与一次未复现的失败

| 检查 | 结果 |
| --- | --- |
| format:check | EXIT=0（586 文件） |
| typecheck | EXIT=0 |
| lint | EXIT=0（2 条既有警告） |
| 单测 | UNIT_EXIT=0，199 文件 / 1862 用例 |
| 浏览器契约（第一次全量） | **EXIT=1**：`watchWords.browser.test.ts` 3 条失败 |
| 同一文件单独跑 | EXIT=0，3/3 通过 |
| 浏览器契约（重跑全量） | EXIT=0，71 文件 / 311 用例 |

那 3 条失败（watch 标记）与本轮改动的预览记录无关，单独跑与重跑全量都没有复现。按既有约定（D76）记录为「**一次未复现**」，不声称已消除；下一轮若再见，再按顺序依赖问题调查。

