# 「/ 打开筛选」收敛成一个判断（2026-11-24 第 86 轮）

过去几轮把「列表里按 `/` 进入筛选」补到四处：文件面板、双栏每一侧、会话树、常用命令列表。同一段判断被抄了四遍：

```ts
if (event.key === "/" && !event.ctrlKey && !event.metaKey && !event.altKey) {
```

四处复制意味着：将来想加一个例外（例如 Vim 模式下 `/` 是搜索），要记住改四个地方——而第 81 轮就出现过「只改一处、别处忘掉」的同类风险。

## 一、交付

新增 `src/filterKey.ts`：

```ts
export function opensFilter(event: { key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean }): boolean
```

四处改为 `if (opensFilter(event)) { … }`，注释指向这个函数，由它一处说明为什么是 `/`、为什么不拦截带修饰键的组合。

## 二、验证

| 层次 | 证据 |
| --- | --- |
| 判断本身 | `src/filterKey.test.ts`（2 条）：空 `/` 为真；`Ctrl/⌘/Alt + /` 为假；其它键（`?`、`a`、`ArrowDown`、`Escape`）为假 |
| 四处接线 | 既有浏览器用例仍在守：`filerSelection`、`ftpKeyboard`（双栏两侧）、`sessionTreeRename`、`snippets` 各有一条「按 `/` 焦点进入筛选框」 |

## 三、边界

- 这次只搬位置，没有改变任何行为：四处仍然只在无修饰键时拦截 `/`；
- 修饰键组合照旧留给其它快捷键。
