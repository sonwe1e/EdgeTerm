# 放大窗格时缩放跟着会话走（2026-11-24 第 130 轮）

## 一、问题

`setActive` 与 `setActivePane` 只改 `activeId`／`activePaneId`，不动 `zoomedPaneId`。窗格放大时，若这时激活的是**另一个窗格**里的会话（Alt+N、命令面板调用、切换窗格），活动会话就指向一个 `display:none` 的窗格：画面不变，而随后的关闭会话、Sender 发送、文件面板跟随全都作用在看不见的会话上。

## 二、三个候选，两个被否

| 做法 | 结论 |
| --- | --- |
| 什么都不做（现状） | 否：请求落空，且活动会话跑到了看不见的地方 |
| 取消放大（照 `splitPane` 的先例） | 否：读者设的布局被丢掉，只为一个选择动作 |
| **把放大移到被请求的窗格** | 采用：读者看到自己要的会话，布局仍在 |

## 三、实现与验证

`storeTabActions.ts` 里加一个纯函数：

```ts
const movedZoom = (zoomed: string | null, paneId: string) =>
  zoomed === null || zoomed === paneId ? zoomed : paneId;
```

`setActive` 与 `setActivePane` 都带 `zoomedPaneId: movedZoom(...)`。

| 层次 | 证据 |
| --- | --- |
| 行为 | `zoomPane.browser.test.ts` 2/2；新用例断言活动窗格、放大窗格、屏幕上恰好一个窗格且内容是所请求的会话 |
| 负控制 | `movedZoom` 改回原样返回 → 用例失败 |
| 全量 | 212 文件／1918 用例；72 文件／334 用例 |


