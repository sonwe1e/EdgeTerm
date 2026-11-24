# 审计：终端渲染与状态（2026-11-24 第 156 轮）

只读审计，范围：terminal.ts、terminalLineGutter.ts、terminalCommands.ts、terminalHistoryCapture.ts、keyReference.ts、outputFlow.ts。4 条，**待修**。

| 编号 | 问题 | 位置 | 代价 |
| --- | --- | --- | --- |
| **TP1** | 每个输出换行都全量扫一遍注意标记表，滚回写满后错误/警告刷屏退化成 O(滚回长度)：标记表整缓冲保留，即使行号栏关闭、标签在后台也照扫 | terminalLineGutter.ts:293（dropLeadingLines 里的 for 循环），由 :112 每行触发 | 小（照同函数里已有的 LINE_TIME_SLACK 批量条件，攒够再剪；watchLines() 加 line >= firstLineNumber 过滤） |
| **TP2** | 开启「无缝冷历史」后，导出行超过 20000 行时每一行都重建整个最近文本集合（splice(0,1) 加全量 rebuild），刷屏时反而卡在导出循环 | terminalHistoryCapture.ts:173-176 | 小（改成超过 2 倍上限再一次性裁到上限，成本摊薄） |
| **TP3** | 程序上报 working 后直接退出、没有 idle/clear，标签会一直显示「命令运行中」，即使提示符已经回来；只有再提交一条命令才清除 | terminalCommands.ts:287 的早退守卫 vs :425-431 只对 agent 生效 | 中（把 :425 的分支推广到所有受理的 working 上报，光标行不是输入提示符时同样置位，让 detectReturnedPrompt 用既有 finishCommand 收尾） |
| **TP4** | 快捷键速查把「F10」列为打开菜单栏，但在终端里按 F10 会被 xterm 吃掉并送去转义序列，菜单不会打开 | keyReference.ts:70（keys 里含 F10）vs MenuBar.tsx:1058,1090 | 极小（从该条去掉 F10，只留 Alt；keys.menubar 文案不用改） |

## 审计确认「无缺陷」的部分

- 没有未批量的 xterm 写入路径：稳态写入都经过 outputFlow 的有序 ACK 窗口，每次 IPC 批一次。
- 正则查找不会卡死：在工作线程里跑，1500 ms 强杀并给出重试文案；纯文本查找会转义。
- 其它快捷键界面都渲染实时绑定，不会过时。

边界：读代码与注释里的历史实测（约 10k 行/秒）判断，未做本轮基准测量。

