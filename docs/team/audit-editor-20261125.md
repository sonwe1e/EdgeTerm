# 审计：内置编辑器（2026-11-25 第 176 轮）

只读审计，范围：src/editor/*、src-tauri/src/project.rs、src-tauri/src/local_text.rs 及其调用方与两语言 fileEditor.*/editor.* 键。5 条，**本轮已修 5 条**。

| 编号 | 问题 | 位置 | 状态 |
| --- | --- | --- | --- |
| ~~ED1~~ | 「覆盖此文件」对**本地文件永远不可能成功**，草稿无路可走 | `local_text.rs:167` 的哈希校验不读 `TextWrite.force` | 已修：`force` 时短路该校验（远端一向如此）；`an_explicit_overwrite_writes_over_a_changed_local_file` 同时断言「带 force 落盘」与「不带 force 仍返回 Conflict」 |
| ~~ED2~~ | 焦点一离开编辑器正文，Ctrl+S 就**静默失效**，而对话框自己的提示写着「Ctrl+S 保存」 | `codemirror.ts:312` 的绑定没有 scope | 已修：加上与 Mod-f 相同的 `editor search-panel` scope；对话框再兜住页脚控件（Reload 等）——CodeMirror 的 keydown 只挂在正文上 |
| ~~ED3~~ | 覆盖提示承诺「被替换的版本会另存为 .bak」，本地从不建、远端核验成功即删 | `en.ts:725`、`zhCN.ts:688` | 已修：改成「只有保存无法核验时才会留下备份副本」，与 `fileEditor.backupKept` 的既有措辞一致 |
| ~~ED4~~ | 覆盖成功后按钮消失，焦点掉到 `<body>`，紧接着的输入全部丢失 | `FileEditorDialog.tsx:78-87` | 已修：冲突由真转假时把焦点还给编辑器正文（`CodeEditor` 的 `refocus`） |
| ~~ED5~~ | 「跳转到行」面板从未翻译，中文界面里出现英文标签与按钮 | `CodeEditor.tsx:58-74` 的 phrases 缺两个键 | 已修：补 `editor.goToLine`／`editor.go`（两语言），并传给 CodeMirror |

## 确认无缺陷

- SFTP 替换梯级与恢复说明：每条拒绝路径都说清服务器上实际有什么。
- 哈希 CAS：替换前重读，两个 EdgeTerm 保存之间的竞态已闭合。
- 每文件锁：键为用户@主机:端口 + 规范路径，同一主机的两个会话串行。
- `uncertain` 的前端处理：保留草稿并点名备份位置。
- 未保存提示：关闭、重载、另开文件、退出都走 `closeCurrentEditor`。
- 4 MiB 限制：`fileEditor.textOnly` 与 `TEXT_LIMIT`、本地 `LIMIT` 一致。
- 未实现「打开文档的实时监视」：哈希 CAS 在保存时给通知，看设计是有意为之。

边界：静态读源码，未在真实文件被外部改写的场景下点检 ED1/ED4。

