# 切目录后筛选清空：问题在夹具（2026-11-24 第 124 轮）

第 72 轮把「切目录后筛选清空」记为缺口；第 123 轮写用例时它**真的没清空**，于是留下两种假设。这一轮把它查清了。

## 一、根因：夹具没 stub 后端调用

`goUp()` 的实现是 `await api.localParent(path)`——父路径只有后端知道（Windows 盘符根、挂载点）。而 `filerSelection.browser.test.ts` 的 `vi.mock("../api")` 只为 `localHome`／`localList` 等给了桩，**`localParent` 落到真实实现**，浏览器夹具里没有 Tauri，它 reject，面板 `setError`，**导航根本没发生**。

所以不是产品缺陷，是夹具缺一个桩。补上之后用例立刻通过。

## 二、交付

| 项 | 内容 |
| --- | --- |
| 夹具 | 增加 `localParent: vi.fn(async (path) => path.replace(/\/[^/]+$/, "") \|\| "/")`，并注释说明「不 stub 时按钮看起来什么都不做」 |
| 用例 | 打开面板 → 筛选框输入 `file1` → 点「Parent folder」→ 轮询断言筛选变空 |

## 三、验证

| 层次 | 证据 |
| --- | --- |
| 文件 | `filerSelection.browser.test.ts` 7/7 |
| 全量 | 单测 212 文件／1918 用例；浏览器 72 文件／331 用例 |
| 负控制 | 去掉 `useEffect` 的清空行 → 用例失败；恢复 → 通过 |

## 四、教训

**「按钮没反应」的候选缺陷，先看它调用的后端函数有没有被 stub。** 夹具里 mock 了一部分 api，漏掉的那个会让动作在 `catch` 里静默失败——表现为产品行为缺失。


