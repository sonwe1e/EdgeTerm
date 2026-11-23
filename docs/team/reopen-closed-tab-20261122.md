# 重开已关闭的标签（2026-11-22 第 17 轮）

按错一次关闭，会话就没了——这是 SSH 客户端最常见的手滑损失。本轮补上安全网：

- 关闭的会话被记住（按最近排序、上限 10 条、仅运行时）；
- Ctrl+Shift+T（Mac ⇧⌘T，浏览器惯例）重开最近关闭的一个；
- Session 菜单与命令面板同名可用（和弦出现在菜单里）；
- 没有可重开的会话时，状态栏说明一句，而不是静默无反应。

## 一、为什么是新会话而不是复活

旧标签的控制器已退役、连接已关闭；重开时沿用旧 id 会撞上 isConnectionClosing 的记账，也会让迟到的握手把已关闭的标签重新点亮。所以重开总是：同一个 profile，新的会话 id，新的连接。

## 二、实现

| 位置 | 作用 |
| --- | --- |
| storeTabActions | closedTabs 栈 + pushClosedTab（新近在后、上限 10）+ takeClosedTab（取走最近一条） |
| closeTab | 关闭成功后把 {info, profile} 入栈（批量的 Close Others 也逐条入栈） |
| actions.reopenClosedTab | 取栈顶、无则写状态、有则 openSession(profile) |
| shortcuts | 新命令 reopenTab，Ctrl+Shift+T / ⇧⌘T；面板与对话框由表生成 |
| MenuBar | Session 菜单的重新打开已关闭的标签，带和弦 |

## 三、验证

| 用例 | 断言 |
| --- | --- |
| 单测 closedTabs.test.ts | 最近的最后入栈；超过 10 条时丢掉最旧的一条 |
| 浏览器 reopenTab.browser.test.ts | 走真实的 closeTab 路径 → 栈里出现 db → 按 Ctrl+Shift+T → 新标签出现、同 profile、新 id、open_session 收到 p-db；再按一次 → 状态栏说明没有可重开的会话，且不产生幽灵标签 |

全量：前端单测 176 文件／1727 用例、浏览器契约 52 文件／249 用例、typecheck、format:check（530 文件）、lint（仅生成绑定 2 条既有警告）、生产构建全部通过。

## 四、边界

- 栈不持久化：重启后不会自动连回旧会话（那会是一次没人要求的连接）。
- 文件会话（SFTP/FTP）也入栈，重开即新的文件会话。
- 批量关闭不合并成一条记录：每个关闭的标签各占一条。
