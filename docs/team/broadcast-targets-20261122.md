# 广播目标选择（2026-11-22 第 13 轮）

同步输入此前只能"发给所有已连接 shell"。多面板场景里，读者常常只想同步其中两三台。本轮加上目标选择：

- 状态栏广播指示旁新增一个 **caret**（仅在广播开启时出现），打开"广播目标"弹层；
- 弹层列出所有**其它已连接 shell**（名称 + 地址），逐个勾选；
- 指示本身的语义不变：**点一下仍然是关闭**（D20 的安全约定保留）；
- 取消勾选最后一台 → 模式自动关闭、弹层随之关闭、状态栏说明"Broadcast input off"。

## 一、实现

- [broadcast.ts](../../src/broadcast.ts)：`broadcastTargets(tabs, sourceId, excluded)` 增加排除项；`canBroadcast` 同步。
- store：`broadcastExcluded: string[]` + `setBroadcastPeer(id, included)`；排除项**按运行期保留**（关掉再开不会把上次排除的机器又拉回来）。取消最后一台时直接关模式并写状态。
- [sessionInput.ts](../../src/sessionInput.ts)：写入路径使用同一排除列表。
- [BroadcastTargets.tsx](../../src/components/BroadcastTargets.tsx)：复用 `StatusPopover` 外壳；勾选框行高 ≥24px，名称省略号 + 地址弱化。
- 状态栏与 App 的计数、自动关闭判断都改成**同一个带排除项的函数**。

## 二、验证时发现的缺陷

初版只把排除项接进了写入路径与弹层，**状态栏计数与 App 的自动关闭判断仍在用"全部会话"**：取消勾选后弹层显示 1 台，指示却仍写"Broadcast to 2"。浏览器契约第一条断言就抓到了。修复后两处计数与写入路径共用同一函数。

## 三、验证

`src/test/broadcast.browser.test.ts` 4/4，本轮新增：

| 断言 | 说明 |
| --- | --- |
| 弹层列出每个已连接 peer，行数正确 | 两个 peer（db、edge） |
| 取消勾选 db 后计数变 1 | 指示文本与 store 同步 |
| 键入只到达 build 与 edge，不到 db | edge 是**后台标签**（无挂载终端），仍按会话收到字节 |
| 取消勾选 edge 后模式关闭、弹层关闭、状态说明 | 不会留下"看起来在广播但没人收"的状态 |

单元侧新增 `broadcastTargets` 排除项用例。全量：前端单测 175 文件／1725 用例、浏览器契约 49 文件／241 用例、typecheck、format:check（526 文件）、lint（仅生成绑定 2 条既有警告）、生产构建全部通过。

## 四、边界

- 排除项不持久化（与模式本身一致），重启后回到"全部会话"。
- 后台标签（未显示的会话）仍是合法目标：广播写的是会话，不是终端视图。
- 断线的 peer 自然不在列表里；重新连接后按默认（包含）处理，除非再次取消。
