# 把常用命令界面从 App 里搬出来（2026-11-23 第 48 轮）

第 42–47 轮给 App.tsx 添了三个状态（管理弹层开关、命名框、参数询问框）和一段约 40 行的界面，混在窗口外壳里。本轮做**结构收敛**：这些界面有了自己的家。

## 一、搬了什么

| 位置 | 内容 |
| --- | --- |
| 新文件 `components/useSnippetRunner.tsx` | 三个状态、`runSnippet`（无参数直发/有参数开框）、`saveLastCommandAsSnippet`（读跟踪器最后一命令）、以及三个对话框本身的渲染 |
| `App.tsx` | 只剩一行 `const snippetsUi = useSnippetRunner();`，菜单传 `snippetsUi.openSnippets`，面板动作复用 `snippetsUi.runSnippet` 与 `snippetsUi.saveLastCommandAsSnippet`，界面渲染 `{snippetsUi.surfaces}` |

## 二、为什么这样切

- 这个功能的三个界面互相依赖（命名框来自面板命令、询问框来自任何发送入口），把它们和逻辑放在一起，App 不必知道它们的存在。
- 以后要加「导入/导出」「发送到分组」，改动都落在这一处，不会再把 App 拖长。
- 搬动是**纯结构变化**：对外行为一字未改，证据是这一功能原有的 8 条浏览器用例和 13 条菜单用例全部通过。

## 三、规模变化（事实）

- `App.tsx`：1325 行（改动前约 1360 行）；
- 新 hook 文件约 95 行，其中 45 行是原先在 App 里的逻辑与界面。

## 四、验证

- `npm run typecheck`、`npm run lint` 在改动后立即通过（lint 仍只有生成绑定里 2 条既有警告）；
- 定向浏览器用例：`snippets.browser.test.ts` 8 条 + `contextMenu.browser.test.ts` 13 条 = 21 条通过；
- 全量（定稿树，均取退出码）：format:check EXIT=0（570 文件）、typecheck EXIT=0、lint（2 条既有警告）、单测 191 文件／1804 用例、浏览器契约 281 用例。

## 五、边界

- 只搬了常用命令的界面；App 里其他对话框（关于、字体、快捷键、SSH 配置导入等）仍在原处，它们没有同样的互相依赖，下一轮如再动，按同样的「功能自持界面」原则逐个处理。
