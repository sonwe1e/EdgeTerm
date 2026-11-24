# 多跳 ProxyJump：为什么不能靠「把共用跳板连成链」实现（2026-11-24 第 140 轮）

上游 PR #2 的核心价值是多跳 `ProxyJump a,b`。开始实现前，先把现有结构查清，结论改变了做法。

## 一、现状（已核实）

| 层 | 事实 |
| --- | --- |
| 传输 | `connect_handle(profile, jumps: &[SessionProfile], …)` **本来就接受任意长度的跳板链**，逐跳 `direct-tcpip`，每跳独立校验主机密钥 |
| 解析 | `Store::jump_chain` 从 `jump_profile_id` 向外走、末尾反转，得到「第一跳在前」的链，并检查循环、`MAX_JUMP_HOPS`、跳板必须是 SSH 传输 |
| 数据 | `SessionProfile.jump_profile_id: Option<String>`——**每个会话只能指名一个跳板**；多跳靠跳板自身也有跳板来表达 |
| 导入 | `ProxyJump a,b` **明确不导入**：`jumps_ignored += 1`，并给出文案「multi-hop jumps are not imported」 |

## 二、把「共用跳板连成链」为什么不成立

测试里的场景正好是反例：

```
Host bastion   HostName 10.0.0.1        # 直连
Host web       ProxyJump bastion        # web → bastion
Host db        ProxyJump entry.example.com,bastion   # db → entry → bastion
```

若为了让 `db` 变成两跳，而去给 **`bastion` 这个已存在的 profile** 设 `jump_profile_id = entry.example.com`，那么 **`web` 的路径也被改了**（web → bastion → entry），而 `web` 的配置里只写了 `ProxyJump bastion`。**共享 profile 的链是全局副作用**，不能这么实现。

另一条退路是为链上每一跳建**专用副本**。这样路径是对的，但会话面板会凭空多出「bastion 的副本」，读者无法分辨哪个是真会话；多导入几次还会累积。

## 三、由此确定的正确做法

把链放进**会话自身**的数据里，即模型从 `jump_profile_id: Option<String>` 改为持有**有序的跳板 id 列表**：

1. 模型与迁移：新增 `jump_profile_ids`，读取旧数据时把单个 id 包成单元素列表；`jump_profile_id` 保留为只读兼容字段或彻底迁移（需连同 `bindings.ts`、快照白名单一起改）。
2. `Store`：校验改成逐项检查（存在、是 SSH 传输、无重复、总长 ≤ `MAX_JUMP_HOPS`），`jump_chain` 直接按列表取，不再向外遍历。
3. 导入：按 `ProxyJump a,b` 顺序把链写进该会话，**不再修改任何其他 profile**，`jumps_ignored` 与两条文案随之删除。
4. 对话框：跳板字段从单个下拉改为链式列表（增删、顺序即路径顺序），`SessionDialog` 的循环校验改用列表。
5. `actions.ts` 的重连等价判断、`workspaceSnapshot.ts` 的白名单、`journal.rs` 的记录同步。

这五处必须**同一次落地**：只改后端而对话框仍写单值，会在保存时把链截断成一条——静默的数据丢失。

## 四、本轮结论

本轮只做了上面这轮调查，**没有改任何代码**：先动模型再发现别名副作用，代价远大于先花一轮把设计定死。下一轮按第三节的五步一次做完（含 Rust 与前端用例），不再拆开提交。

