# 审计：会话录制与回放（2026-11-24 第 160 轮）

只读审计，范围：录制勾选 → `open_session` → `Recorder::start` → `tab.info.recording` → 状态栏 REC → 失败事件 → 两语言文字。5 条，**全部交付**（第 162 轮）。

| 编号 | 问题 | 位置 | 代价 |
| --- | --- | --- | --- |
| ~~RC1~~ ✅ | 录制目录不可用会**直接导致连接失败**，而错误文案说的是地址／网络／凭据，真正的「无法创建录制目录」被折叠在「技术细节」里 | `recording.rs:85`、`sessions.rs:91-102`、`SessionDialog.tsx:1624`、`sessionValidation.ts:15` | 小（`connectionError` 区块在上方加一行显示当前录制目录，复用 `session.folder` 键） |
| ~~RC2~~ ✅ | 写盘失败后该会话**无法重新开始录制**（只有 `Recorder::start` 在连接路径里，没有 start/stop 命令），而提示不给下一步 | `en.ts:361`、`App.tsx:491,497` | 小（扩展 `status.recordingStopped` 文案点名「断开重连才能继续录制」） |
| ~~RC3~~ ✅ | 对话框承诺的文件名与后端实际写出的不一致：后端会清洗 `: / \ * ? " < > |` 并把名字截到 64 字符，前端却按原名加 `<date>_<time>.log` 展示——`db: prod` 这种名字在 NTFS 上根本不存在 | `SessionDialog.tsx:545` vs `recording.rs:214-266` | 小（前端照后端的 `file_stem` 规则生成示例） |
| ~~RC4~~ ✅ | 录制中途失败时，正持有焦点的 REC 芯片被移除，焦点掉到 document | `App.tsx:497`、`StatusBar.tsx:220` | 小（清空后按 `requestAnimationFrame` 把焦点交给 `[data-focus-region="status"]`，照 TransferCenter 的写法） |
| ~~RC5~~ ✅ | 回放说明让用户用 `cat`，而本发行版只有 Windows、默认 shell 是 cmd.exe，那里没有 `cat` | `en.ts:691`、`zhCN.ts:657` | 极小（文案改成占位符，Windows 传 `type`） |

## 审计确认「无缺陷」的部分

- **录制不会活过会话或标签**：SSH 与本地两端都在关闭时结束写入，`close_session` 先关输出通道，尾部由 `Writer::run` 写出。
- **没有「意外缺失的回放界面」**：应用本来就没有播放器，文档里写明了；本地 `.log` 可以用文件面板的大文本查看器打开。
- **REC 点击路径如实**：`revealLocalPath` 正确去掉文件名，失败会经状态栏报出。
- 两语言的录制相关键完整一致。

修复：RC1／RC3／RC5 = `784ad51`（连接失败时显示录制目录；`recordingName.ts` 按后端规则生成文件名；回放命令按平台传 `type`／`cat`）。RC4 = `272b283`（REC 芯片持有焦点时移除它，焦点交给状态栏区域）。RC2 = `a99b657`（停止录制的文案点名断开重连）。

用例：`src/recordingName.test.ts` 三条（把名字原样返回即全红）；RC1／RC2／RC4／RC5 **没有独立用例**。

边界：只读源码，未在真实磁盘写满或真实屏幕阅读器下复现。

