# 审计：端口转发（2026-11-24 第 160 轮）

只读审计，范围：port_forward.rs、commands/forwarding.rs、transport 的转发路径、ForwardCenter.tsx、remotePreview.ts、SessionDialog 与 SshConfigImportDialog 的转发区块、两语言文字。6 条，**全部交付**（第 161 轮）。

| 编号 | 问题 | 位置 | 代价 |
| --- | --- | --- | --- |
| ~~PF1~~ ✅ | Local／Remote 隧道只要**一个**客户端连不上，行内就变成红色错误文字，实时计数永久消失；状态仍是 listening，后来连上也清不掉，只有新建隧道才会重置 | port_forward.rs:437（另 434／443-445／525）vs ForwardCenter.tsx:471；SOCKS 路径已有正确写法 note_client_failure（:545） | 小（四处直接写 snapshot.error 改为走 note_client_failure） |
| ~~PF2~~ ✅ | 在「选择远端端口」里按「使用」会把整个表单重写：方向变回 Local、监听地址变回 127.0.0.1、监听端口变成 0——用户正在做的 Remote 隧道与手填的端口被丢弃，且没有任何提示 | ForwardCenter.tsx:389（setSpec({ ...defaults,）与 :396 | 小（只补 targetHost／targetPort 到现有 spec；dynamic 时不显示该按钮） |
| ~~PF3~~ ✅ | 会话断开带走的隧道显示为「Stopped」、没有原因，也不计入失败；与用户主动停止无法区分 | port_forward.rs:335（job.state(stopping, None)）与 :257、:423-425 | 小（在 control 分支里同样检查 transport.is_closed() 并写入 SSH connection closed） |
| ~~PF4~~ ✅ | 新建任何隧道都会**静默删除**失败隧道的行——而那正是移除确认里说的「唯一显示原因的地方」 | port_forward.rs:270（prune_finished）与 :280；文案 forward.removeFailedConfirm | 小（has_room 只统计未完成的，或保留 error 行） |
| ~~PF5~~ ✅ | 端口发现的提示写「需要 Linux」，但没说那是**服务器**；Windows-only 的应用里读起来像在要求本机 | en.ts:1369-1370／zhCN.ts:1316-1317 | 极小（点明是 SSH 服务器） |
| ~~PF6~~ ✅ | 隧道数上限的错误让用户「先删除已完成的隧道」，而代码刚刚已经删过了——它只会在 64 条**运行中**时触发 | port_forward.rs:250 与 :270-272 | 极小（改成「先停掉一条运行中的隧道（最多 64 条）」） |

## 审计确认「无缺陷」的部分

- Stop／移除的管线：stopping 行禁用、运行中拒绝移除、cleanup_pending_message 分方向。
- 端口发现对退出码、unsupported、超时的处理：ss 失败会报错，不会伪装成空结果。
- Remote 隧道的路由键与 GatewayPorts 说明（有一条 #[ignore] 的真实 OpenSSH 用例）。
- 登录时恢复配置文件转发会给出警告；remotePreview 只拆除自己启动的隧道。
- 没有发现「隧道活得比会话久」：两条 close_session 路径都会停掉它们。

修复：PF1／PF3／PF4／PF6 = `d5e7e3f`（客户端失败走 `note_client_failure`；控制分支在传输关闭时报「SSH connection closed」；完成的记录在有空间时保留、仅在记录满时清理；上限文案改成真实的出路）。PF2 = `c666ec8`（只替换目标主机与端口）。PF5 = `6c12982`（点明是 SSH 服务器）。

用例：`a_start_keeps_a_finished_row_while_there_is_room`（把 `has_room` 改回「每次先清理」即失败）与 `a_full_register_still_makes_room`；PF1 依赖既有的 `a_bad_socks_client_does_not_mark_the_tunnel`。PF2／PF3／PF5／PF6 **没有独立用例**。

边界：静态读代码，未在真实服务器上复现 PF1／PF3。

