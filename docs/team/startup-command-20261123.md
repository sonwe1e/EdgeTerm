# 连接后自动执行的命令（2026-11-23 第 53 轮）

每天连同一台机器做的第一件事通常一样：`cd /srv/app && tmux attach`。SecureCRT、Xshell、WinSCP 都把这件事叫「登录脚本」。EdgeTerm 本轮补上。

## 一、行为

| 情况 | 结果 |
| --- | --- |
| 已保存的连接设了「连接后执行的命令」 | 连接成功后（shell 就绪约 0.4 秒）自动输入该命令并回车 |
| 连接期间读者已经输入过内容 | **先发读者的输入**，登录脚本不发（队列不插队） |
| 文件会话（FTP/SFTP） | 不执行——那里没有可输入的提示符 |
| 多行文本 | 只取第一行非空内容；对话框里写明「只支持一行」 |
| 清空字段 | 删除该连接的记录 |

## 二、为什么存在 localStorage 而不是 profile 文件

写进 profile 需要改 Rust 的模型与生成的绑定；存在应用设置里，**旧版本写的 profile 仍能被新版本读取**，新版本写的 profile 在旧版本里也不会出现未知字段。代价：换机器时这条设置不跟着走，文档里写明。

## 三、实现

| 位置 | 变化 |
| --- | --- |
| `startupCommands.ts` | 键 `edgeterm.startupCommands`、每连接一条、首行非空、上限 4000 字符与 200 条连接；畸形 JSON 一律丢弃 |
| `storeStartupActions.ts` | `startupCommands` + `setStartupCommand`（空值即删除，内容不变不写盘） |
| `actions.ts` | 连接成功后延迟 400 ms 发送；定时器复查标签仍在且已连接，关掉的标签不会收到迟到的命令 |
| `SessionDialog.tsx` | 「连接后执行的命令」字段（仅已保存的 ssh/local 连接），带提示 |

## 四、验证

| 用例 | 断言 |
| --- | --- |
| `startupCommands.test.ts`（5） | 取首行非空；畸形 JSON/数组/非字符串/空值全部丢弃；200 条上限；存取往返；store 设置与清空并写盘 |
| `startupCommand.browser.test.ts`（2） | SSH 连接成功后 `write_session` 收到 `cd /srv/app\\r`；SFTP 连接 900 ms 后**没有**任何启动命令写入 |

## 五、边界（写清楚）

- 固定向连接后 **400 ms** 发送，而不是等提示符出现：等待需要解析 shell 提示符，识别错了会永远不发；延迟是确定的、可解释的。
- 只支持一行：多行脚本应写进 `.bashrc` 或一个脚本文件里，那才是它们该在的地方。
- 字段只对已保存的连接显示：新连接还没有 id，记在临时 id 下的命令永远找不回来。
