# 轮次与说明文档索引（第 41–111 轮）

`STATE.md`、`DECISIONS.md`、`LEARNINGS.md` 按时间追加，读起来是线性的；这个索引换方向：**按轮次**看每轮做了什么，**按文档**找专题说明。

## 怎么用

| 想查什么 | 去哪里 |
| --- | --- |
| 某一轮做了什么、对应哪份说明 | 第一、第三张表 |
| 为什么这样决定 | `DECISIONS.md`（D 编号） |
| 踩过什么坑 | `LEARNINGS.md`（编号） |
| 最近一次门禁结果 | `STATE.md` 最新一轮 |

## 一、轮次一览（74 轮，第 41–115 轮）

| 轮 | 日期 | 内容 |
| --- | --- | --- |
| 41 | 11-23 | 瞬态标记跟随会话状态 |
| 43 | 11-23 | 常用命令库 + 自动聚焦让位 |
| 44 | 11-23 | 常用命令进入命令面板 |
| 45 | 11-23 | 补上「保存上一条命令」的成功路径 |
| 46 | 11-23 | 常用命令的参数 |
| 47 | 11-23 | 常用命令的编辑与筛选 |
| 48 | 11-23 | 把常用命令界面从 App 搬出来 |
| 49 | 11-23 | 常用命令通过剪贴板搬家 |
| 50 | 11-23 | 留在 1.7 线 + 命令面板打开常用命令 |
| 51 | 11-23 | 标签指针约定 + 一次真实破坏与恢复 |
| 52 | 11-23 | 常用命令来到终端右键菜单 |
| 53 | 11-23 | 连接后自动执行的命令 |
| 54 | 11-23 | 命令偏好登记 + tabRename 偶发的真正原因 |
| 55 | 11-23 | 终端高亮补测试 + 整行分类抽出 |
| 56 | 11-23 | 新连接也能设「连接后执行的命令」 |
| 57 | 11-23 | 常用命令列表的键盘走查 |
| 58 | 11-23 | 右键菜单也能「把上一条命令存成常用命令」 |
| 59 | 11-23 | 第 59 轮「复制不覆盖源」的承诺其实不成立 |
| 59 | 11-23 | 常用命令可以复制一份再改 |
| 60 | 11-23 | 带参数的常用命令记住上次填的值 |
| 61 | 11-23 | 命令行面板列出最近用过的命令 |
| 62 | 11-23 | 终端右键菜单发送最近命令 |
| 63 | 11-23 | 长命令不能把菜单撑到窗外 |
| 65 | 11-23 | 终端右键菜单也能打开常用命令管理 |
| 66 | 11-23 | 空列表不是死胡同 + Esc 先退筛选 |
| 67 | 11-23 | 启动命令发不出去时，说一声 |
| 68 | 11-23 | 发送常用命令时说出「发给了几个终端」 |
| 69 | 11-23 | 常用命令有了自己的快捷键 |
| 70 | 11-23 | 文件面板能就地筛选 |
| 71 | 11-23 | 把第 71 轮留下的缺口补成证据 |
| 71 | 11-23 | 筛选属于它所在的文件夹；被筛掉的行不再保持选中 |
| 73 | 11-23 | 双栏文件浏览器也有筛选了 |
| 74 | 11-23 | F2 重命名当前项 |
| 75 | 11-23 | 常用命令列表也认 F2 |
| 76 | 11-23 | 改名时名字已经是选中的 |
| 77 | 11-23 | Esc 先从编辑里退一步 |
| 78 | 11-23 | 两个没人用的编辑器类型 +「/」聚焦筛选 |
| 79 | 11-23 | 关掉编辑器时释放它的记忆 |
| 80 | 11-24 | 预览记录跟着会话走 |
| 81 | 11-24 | 会话树也能用「/」筛，Esc 先清筛选 |
| 82 | 11-24 | 双栏筛选补上「/」键，并证明筛选属于一个目录 |
| 83 | 11-24 | 文件面板「在终端中打开」 |
| 84 | 11-24 | 补上「在终端中打开」的接线证据 |
| 85 | 11-24 | 那条重流程用例的超时预算 |
| 86 | 11-24 | 「/ 打开筛选」收敛成一个判断 |
| 87 | 11-24 | 一个站不住的改动前提 |
| 88 | 11-24 | 一条命令跑完整个验证门 |
| 89 | 11-24 | 命令行面板里直接连主机 |
| 90 | 11-24 | 连接目标接受 ssh:// 与方括号 IPv6 |
| 91 | 11-24 | 最近连接过的机器 |
| 92 | 11-24 | 死代码清理，把 styleCensus 变成门 |
| 93 | 11-24 | 终端里的 ssh:// 链接可以直接连 |
| 94 | 11-24 | 记住的主机只有一处来源 |
| 95 | 11-24 | 连接行说清楚它以谁登录 |
| 96 | 11-24 | 命令面板标出最近连过的会话 |
| 97 | 11-24 | 会话树里标出最近连过的会话 |
| 98 | 11-24 | 把「最近用过」标记的可见性钉住 |
| 99 | 11-24 | 空窗口也是一个入口 |
| 100 |  | 本轮（第 100 轮）：关掉上轮记下的缺口——它不是缺陷 |
| 101 | 11-24 | 会话树里的输入即跳转（type-ahead） |
| 102 | 11-24 | 修掉上一轮 type-ahead 吞掉空格的问题 |
| 103 | 11-24 | type-ahead 能改错字，也能被 Esc 取消 |
| 104 | 11-24 | 两处 type-ahead 合并到同一次搜索 |
| 105 | 11-24 | 给快捷键表加一次普查 |
| 106 | 11-24 | 颜色字面量只许出现在 foundation 层 |
| 107 | 11-24 | 会话筛选能按主机、用户、端口找 |
| 108 | 11-24 | 先确认命令面板找得到地址，再把这条能力钉住 |
| 109 | 11-24 | 命令面板的提示补上端口 |
| 110 | 11-24 | 找到上轮那条浏览器用例失败的根因，并补上证据 |
| 111 | 11-24 | 会话筛选也能按分组找 |
| 112 | 11-24 | 给七十轮日志加一张索引 |
| 113 | 11-24 | 让读屏软件也知道树自己的两个键 |
| 114 | 11-24 | 文件列表也声明自己的三个键 |
| 115 | 11-24 | 常用命令列表也声明自己的键 |

## 二、说明文档（115 份）

| 文档 | 标题 |
| --- | --- |
| [aria-key-hints-20261124.md](./aria-key-hints-20261124.md) | 让读屏软件也知道树自己的两个键（2026-11-24 第 113 轮） |
| [aria-key-hints-filer-20261124.md](./aria-key-hints-filer-20261124.md) | 文件列表也声明自己的三个键（2026-11-24 第 114 轮） |
| [aria-key-hints-snippets-20261124.md](./aria-key-hints-snippets-20261124.md) | 常用命令列表也声明自己的键（2026-11-24 第 115 轮） |
| [autofocus-respects-deliberate-focus-20261123.md](./autofocus-respects-deliberate-focus-20261123.md) | 自动聚焦不再抢走「你刚放好的焦点」（2026-11-23 第 43 轮） |
| [broadcast-targets-20261122.md](./broadcast-targets-20261122.md) | 广播目标选择（2026-11-22 第 13 轮） |
| [build-1.7.8-20261123.md](./build-1.7.8-20261123.md) | 1.7.8 安装包构建记录（2026-11-23） |
| [colour-literals-20261124.md](./colour-literals-20261124.md) | 颜色字面量只许出现在 foundation 层（2026-11-24 第 106 轮） |
| [command-exit-status-20261122.md](./command-exit-status-20261122.md) | 命令退出状态（2026-11-22 第 27 轮） |
| [command-navigation-20261122.md](./command-navigation-20261122.md) | 命令导航（2026-11-22 第 8 轮） |
| [command-palette-20261122.md](./command-palette-20261122.md) | 命令面板（2026-11-22 第 2 轮） |
| [copy-command-chords-20261122.md](./copy-command-chords-20261122.md) | 复制命令的快捷键（2026-11-22 第 14 轮） |
| [copy-command-output-20261122.md](./copy-command-output-20261122.md) | 复制上一条命令 / 它的输出（2026-11-22 第 7 轮） |
| [dead-editor-types-and-slash-filter-20261123.md](./dead-editor-types-and-slash-filter-20261123.md) | 删掉两个没人用的编辑器类型；「/」也能聚焦筛选（2026-11-23 第 78 轮） |
| [dead-exports-and-style-scale-20261124.md](./dead-exports-and-style-scale-20261124.md) | 死代码清理，以及把一个死掉的诊断工具变成门（2026-11-24 第 92 轮） |
| [dialog-audit-20261122.md](./dialog-audit-20261122.md) | 对话框审计（2026-11-22 第 5 轮） |
| [edge-term-1.7.2-stable-acceptance.md](./edge-term-1.7.2-stable-acceptance.md) | EdgeTerm 1.7.2 稳定体验验收卡（A2 保持关闭） |
| [edge-term-1.8-filer-acceptance.md](./edge-term-1.8-filer-acceptance.md) | EdgeTerm 1.8 — Filer 预览与 SFTP 基准验收卡 |
| [edge-term-1.8-full-audit.md](./edge-term-1.8-full-audit.md) | EdgeTerm 1.8.0：全盘筛查与修复记录 |
| [edge-term-pr4-ux-review-20261111.md](./edge-term-pr4-ux-review-20261111.md) | EdgeTerm PR #4 后续：高频操作体验复核（2026-11-11） |
| [editor-state-release-20261123.md](./editor-state-release-20261123.md) | 关掉编辑器时释放它的记忆（2026-11-23 第 79 轮） |
| [editor-surface-20261122.md](./editor-surface-20261122.md) | 内置编辑器表面（2026-11-22 第 16 轮） |
| [empty-window-recents-20261124.md](./empty-window-recents-20261124.md) | 空窗口也是一个入口：列出最近用过的会话（2026-11-24 第 99 轮） |
| [failed-command-jump-20261122.md](./failed-command-jump-20261122.md) | 跳到失败命令（2026-11-22 第 29 轮） |
| [failed-command-marks-20261122.md](./failed-command-marks-20261122.md) | 失败命令在侧栏留痕（2026-11-22 第 28 轮） |
| [file-list-coherence-20261122.md](./file-list-coherence-20261122.md) | 文件列表的一致性（2026-11-22 第 11 轮） |
| [filer-cd-here-20261124.md](./filer-cd-here-20261124.md) | 文件面板：「在终端中打开」（2026-11-24 第 83 轮） |
| [filer-filter-20261123.md](./filer-filter-20261123.md) | 文件面板能就地筛选（2026-11-23 第 70 轮） |
| [filer-filter-scope-20261123.md](./filer-filter-scope-20261123.md) | 筛选属于它所在的文件夹；被筛掉的行不再保持选中（2026-11-23 第 71 轮） |
| [focus-ring-contrast-20261122.md](./focus-ring-contrast-20261122.md) | 焦点环对比度（2026-11-22 第 6 轮） |
| [font-size-chords-20261122.md](./font-size-chords-20261122.md) | 终端字号快捷键（2026-11-22 第 21 轮） |
| [ftp-filter-scope-and-key-20261124.md](./ftp-filter-scope-and-key-20261124.md) | 双栏筛选：补上「/」键，并证明筛选属于一个目录（2026-11-24 第 82 轮） |
| [ftp-pane-filter-20261123.md](./ftp-pane-filter-20261123.md) | 双栏文件浏览器也有筛选了（2026-11-23 第 73 轮） |
| [group-broadcast-20261123.md](./group-broadcast-20261123.md) | 按组选择性广播（2026-11-23 第 33 轮） |
| [gutter-command-marks-20261122.md](./gutter-command-marks-20261122.md) | 行号栏的命令标记（2026-11-22 第 9 轮） |
| [heavy-test-budget-20261124.md](./heavy-test-budget-20261124.md) | 那条重流程用例的超时预算（2026-11-24 第 85 轮） |
| [jump-consistency-20261123.md](./jump-consistency-20261123.md) | 缓冲区走查的统一实现与菜单路径的缺陷修复（2026-11-23 第 37 轮） |
| [jump-to-latest-20261122.md](./jump-to-latest-20261122.md) | 跳到最新输出（2026-11-22 第 24 轮） |
| [key-hints-policy-20261124.md](./key-hints-policy-20261124.md) | 自定义键的可发现性：规则与清单（2026-11-24 第 116 轮） |
| [keyboard-focus-sweep-20261122.md](./keyboard-focus-sweep-20261122.md) | 键盘焦点扫查（2026-11-22 第 3 轮） |
| [line-spacing-20261122.md](./line-spacing-20261122.md) | 终端行间距（2026-11-22 第 10 轮） |
| [locale-truncation-incident-20261123.md](./locale-truncation-incident-20261123.md) | 一次真实的破坏与恢复：语言包被截断（2026-11-23 第 51 轮） |
| [manage-snippets-from-terminal-20261123.md](./manage-snippets-from-terminal-20261123.md) | 终端右键菜单也能打开常用命令管理（2026-11-23 第 65 轮） |
| [menu-width-cap-20261123.md](./menu-width-cap-20261123.md) | 长命令不能把菜单撑到窗外（2026-11-23 第 63 轮） |
| [motion-tokens-20261122.md](./motion-tokens-20261122.md) | 状态动效收敛到两个时长（2026-11-22 第 15 轮） |
| [one-filter-key-20261124.md](./one-filter-key-20261124.md) | 「/ 打开筛选」收敛成一个判断（2026-11-24 第 86 轮） |
| [own-shell-premise-20261124.md](./own-shell-premise-20261124.md) | 一个站不住的改动前提：文件面板就是当前标签（2026-11-24 第 87 轮） |
| [palette-address-search-20261124.md](./palette-address-search-20261124.md) | 先确认命令面板找得到地址，再把这条能力钉住（2026-11-24 第 108 轮） |
| [palette-history-20261123.md](./palette-history-20261123.md) | 命令行面板列出最近用过的命令（2026-11-23 第 61 轮） |
| [palette-port-evidence-20261124.md](./palette-port-evidence-20261124.md) | 找到上轮那条浏览器用例失败的根因（2026-11-24 第 110 轮） |
| [palette-port-hint-20261124.md](./palette-port-hint-20261124.md) | 命令面板的提示补上端口（2026-11-24 第 109 轮） |
| [palette-quick-connect-20261124.md](./palette-quick-connect-20261124.md) | 命令行面板里直接连主机（2026-11-24 第 89 轮） |
| [palette-snippets-20261123.md](./palette-snippets-20261123.md) | 常用命令进入命令面板（2026-11-23 第 44 轮） |
| [pane-zoom-20261122.md](./pane-zoom-20261122.md) | 面板放大（2026-11-22 第 18 轮） |
| [pinned-drag-invariant-20261122.md](./pinned-drag-invariant-20261122.md) | 固定标签的拖拽边界（2026-11-22 第 25 轮） |
| [pinned-tabs-20261122.md](./pinned-tabs-20261122.md) | 固定标签页（2026-11-22 第 23 轮） |
| [preference-registration-20261123.md](./preference-registration-20261123.md) | 让读者写下的命令跟着设置一起走（2026-11-23 第 54 轮） |
| [preview-follows-session-20261124.md](./preview-follows-session-20261124.md) | 预览记录跟着会话走（2026-11-24 第 80 轮） |
| [quick-connect-hint-20261124.md](./quick-connect-hint-20261124.md) | 连接行说清楚它以谁登录（2026-11-24 第 95 轮） |
| [quick-connect-recents-20261124.md](./quick-connect-recents-20261124.md) | 最近连接过的机器（2026-11-24 第 91 轮） |
| [quick-connect-shapes-20261124.md](./quick-connect-shapes-20261124.md) | 连接目标：接受 ssh:// 前缀，并把地址拆解写清楚（2026-11-24 第 90 轮） |
| [recent-commands-menu-20261123.md](./recent-commands-menu-20261123.md) | 终端右键菜单：发送最近用过的命令（2026-11-23 第 62 轮） |
| [recent-mark-narrow-20261124.md](./recent-mark-narrow-20261124.md) | 上一轮的标记，在窄面板和长名字下还看得见吗（2026-11-24 第 98 轮） |
| [recent-sessions-mark-20261124.md](./recent-sessions-mark-20261124.md) | 命令面板标出最近连过的会话（2026-11-24 第 96 轮） |
| [recents-one-writer-20261124.md](./recents-one-writer-20261124.md) | 记住的主机现在只有一处来源（2026-11-24 第 94 轮） |
| [remote-title-20261123.md](./remote-title-20261123.md) | 程序自报的窗口标题（2026-11-23 第 39 轮） |
| [reopen-closed-tab-20261122.md](./reopen-closed-tab-20261122.md) | 重开已关闭的标签（2026-11-22 第 17 轮） |
| [resources-sender-20261122.md](./resources-sender-20261122.md) | 资源弹层与发送面板（2026-11-22 第 19 轮） |
| [round-100-milestone-20261124.md](./round-100-milestone-20261124.md) | 第 100 轮：把上轮记下的缺口关掉（2026-11-24） |
| [save-last-command-menu-20261123.md](./save-last-command-menu-20261123.md) | 右键菜单也能「把上一条命令存成常用命令」（2026-11-23 第 58 轮） |
| [semantic-highlighter-tests-20261123.md](./semantic-highlighter-tests-20261123.md) | 给终端高亮补上测试，并把整行分类拆出来（2026-11-23 第 55 轮） |
| [session-filter-20261124.md](./session-filter-20261124.md) | 会话筛选能按主机、用户、端口找（2026-11-24 第 107 轮） |
| [session-filter-keys-20261124.md](./session-filter-keys-20261124.md) | 会话树也能用「/」筛，Esc 先清筛选（2026-11-24 第 81 轮） |
| [session-group-filter-20261124.md](./session-group-filter-20261124.md) | 会话筛选也能按分组找（2026-11-24 第 111 轮） |
| [session-state-gating-20261123.md](./session-state-gating-20261123.md) | 瞬态标记跟随会话状态（2026-11-23 第 41 轮） |
| [session-tree-f2-20261123.md](./session-tree-f2-20261123.md) | F2 重命名当前项（2026-11-23 第 74 轮） |
| [session-tree-recent-mark-20261124.md](./session-tree-recent-mark-20261124.md) | 会话树里标出最近连过的会话（2026-11-24 第 97 轮） |
| [session-type-ahead-20261124.md](./session-type-ahead-20261124.md) | 会话树里的输入即跳转（2026-11-24 第 101 轮） |
| [settings-dialog-audit-20261123.md](./settings-dialog-audit-20261123.md) | 设置与快捷键对话框：笔记本尺寸下的焦点与可读性（2026-11-23 第 31 轮） |
| [shortcut-census-20261124.md](./shortcut-census-20261124.md) | 给快捷键表加一次普查（2026-11-24 第 105 轮） |
| [snippet-args-memory-20261123.md](./snippet-args-memory-20261123.md) | 带参数的常用命令，记得上次填的值（2026-11-23 第 60 轮） |
| [snippet-clipboard-20261123.md](./snippet-clipboard-20261123.md) | 常用命令通过剪贴板搬家（2026-11-23 第 49 轮） |
| [snippet-duplicate-20261123.md](./snippet-duplicate-20261123.md) | 常用命令可以复制一份再改（2026-11-23 第 59 轮） |
| [snippet-editing-20261123.md](./snippet-editing-20261123.md) | 常用命令的编辑与筛选（2026-11-23 第 47 轮） |
| [snippet-parameters-20261123.md](./snippet-parameters-20261123.md) | 常用命令的参数（2026-11-23 第 46 轮） |
| [snippet-rename-selection-20261123.md](./snippet-rename-selection-20261123.md) | 改名时名字已经是选中的（2026-11-23 第 76 轮） |
| [snippet-send-count-20261123.md](./snippet-send-count-20261123.md) | 发送常用命令时说出「发给了几个终端」（2026-11-23 第 68 轮） |
| [snippet-surfaces-extraction-20261123.md](./snippet-surfaces-extraction-20261123.md) | 把常用命令界面从 App 里搬出来（2026-11-23 第 48 轮） |
| [snippets-20261123.md](./snippets-20261123.md) | 常用命令库（2026-11-23 第 42–43 轮） |
| [snippets-empty-and-escape-20261123.md](./snippets-empty-and-escape-20261123.md) | 空列表不是死胡同：说明两条更快的保存路径；Esc 先退筛选（2026-11-23 第 66 轮） |
| [snippets-escape-edit-20261123.md](./snippets-escape-edit-20261123.md) | Esc 先从编辑里退一步（2026-11-23 第 77 轮） |
| [snippets-f2-20261123.md](./snippets-f2-20261123.md) | 常用命令列表也认 F2（2026-11-23 第 75 轮） |
| [snippets-keyboard-list-20261123.md](./snippets-keyboard-list-20261123.md) | 常用命令列表的键盘走查（2026-11-23 第 57 轮） |
| [snippets-shortcut-20261123.md](./snippets-shortcut-20261123.md) | 常用命令有了自己的快捷键（2026-11-23 第 69 轮） |
| [splitter-reset-20261122.md](./splitter-reset-20261122.md) | 拖动条双击还原（2026-11-22 第 20 轮） |
| [stale-remote-title-20261123.md](./stale-remote-title-20261123.md) | 陈旧标题的清理，以及一次未复现的失败排查（2026-11-23 第 40 轮） |
| [startup-command-20261123.md](./startup-command-20261123.md) | 连接后自动执行的命令（2026-11-23 第 53 轮） |
| [startup-command-failure-20261123.md](./startup-command-failure-20261123.md) | 启动命令发不出去时，说一声（2026-11-23 第 67 轮） |
| [startup-field-new-session-20261123.md](./startup-field-new-session-20261123.md) | 新连接也能设「连接后执行的命令」（2026-11-23 第 56 轮） |
| [status-popovers-20261122.md](./status-popovers-20261122.md) | 状态栏弹层（2026-11-22 第 12 轮） |
| [synchronized-input-20261122.md](./synchronized-input-20261122.md) | 同步输入（广播）（2026-11-22 第 4 轮） |
| [tab-bell-20261123.md](./tab-bell-20261123.md) | 后台标签的响铃提醒（2026-11-23 第 38 轮） |
| [tab-rename-20261122.md](./tab-rename-20261122.md) | 标签页重命名（2026-11-22 第 26 轮） |
| [tab-title-persistence-20261122.md](./tab-title-persistence-20261122.md) | 标签名的持久化（2026-11-22 第 26 轮收尾） |
| [terminal-snippet-menu-20261123.md](./terminal-snippet-menu-20261123.md) | 常用命令来到终端右键菜单（2026-11-23 第 52 轮） |
| [terminal-ssh-links-20261124.md](./terminal-ssh-links-20261124.md) | 终端里的 ssh:// 链接可以直接连（2026-11-24 第 93 轮） |
| [transfer-forward-audit-20261123.md](./transfer-forward-audit-20261123.md) | 传输中心与隧道中心的可读性审计（2026-11-23 第 32 轮） |
| [type-ahead-buffer-20261124.md](./type-ahead-buffer-20261124.md) | type-ahead 能改错字，也能被 Esc 取消（2026-11-24 第 103 轮） |
| [type-ahead-space-regression-20261124.md](./type-ahead-space-regression-20261124.md) | 上一轮的 type-ahead 吞掉了空格（2026-11-24 第 102 轮） |
| [type-ahead-unification-20261124.md](./type-ahead-unification-20261124.md) | 两处 type-ahead 合并到同一次搜索（2026-11-24 第 104 轮） |
| [typing-latency-20261123.md](./typing-latency-20261123.md) | 输入延迟：状态栏的「按键到回显」读数（2026-11-23 第 36 轮） |
| [ui-quality-gate-20261122.md](./ui-quality-gate-20261122.md) | 界面质量门禁与第一批可视化修复（2026-11-22） |
| [verify-command-20261124.md](./verify-command-20261124.md) | 一条命令跑完整个验证门（2026-11-24 第 88 轮） |
| [watch-jump-20261123.md](./watch-jump-20261123.md) | 观察标记的跳转（2026-11-23 第 35 轮） |
| [watch-marks-20261123.md](./watch-marks-20261123.md) | 关键字的高亮与命中索引：现状核对 + 观察字的行标记（2026-11-23 第 34 轮） |
| [wheel-zoom-20261122.md](./wheel-zoom-20261122.md) | Ctrl+滚轮缩放与字号助手（2026-11-22 第 22 轮） |

## 三、轮次 → 说明文档（标题里写明轮次的 109 份）

| 轮 | 文档 |
| --- | --- |
| 2 | [command-palette-20261122.md](./command-palette-20261122.md) |
| 3 | [keyboard-focus-sweep-20261122.md](./keyboard-focus-sweep-20261122.md) |
| 4 | [synchronized-input-20261122.md](./synchronized-input-20261122.md) |
| 5 | [dialog-audit-20261122.md](./dialog-audit-20261122.md) |
| 6 | [focus-ring-contrast-20261122.md](./focus-ring-contrast-20261122.md) |
| 7 | [copy-command-output-20261122.md](./copy-command-output-20261122.md) |
| 8 | [command-navigation-20261122.md](./command-navigation-20261122.md) |
| 9 | [gutter-command-marks-20261122.md](./gutter-command-marks-20261122.md) |
| 10 | [line-spacing-20261122.md](./line-spacing-20261122.md) |
| 11 | [file-list-coherence-20261122.md](./file-list-coherence-20261122.md) |
| 12 | [status-popovers-20261122.md](./status-popovers-20261122.md) |
| 13 | [broadcast-targets-20261122.md](./broadcast-targets-20261122.md) |
| 14 | [copy-command-chords-20261122.md](./copy-command-chords-20261122.md) |
| 15 | [motion-tokens-20261122.md](./motion-tokens-20261122.md) |
| 16 | [editor-surface-20261122.md](./editor-surface-20261122.md) |
| 17 | [reopen-closed-tab-20261122.md](./reopen-closed-tab-20261122.md) |
| 18 | [pane-zoom-20261122.md](./pane-zoom-20261122.md) |
| 19 | [resources-sender-20261122.md](./resources-sender-20261122.md) |
| 20 | [splitter-reset-20261122.md](./splitter-reset-20261122.md) |
| 21 | [font-size-chords-20261122.md](./font-size-chords-20261122.md) |
| 22 | [wheel-zoom-20261122.md](./wheel-zoom-20261122.md) |
| 23 | [pinned-tabs-20261122.md](./pinned-tabs-20261122.md) |
| 24 | [jump-to-latest-20261122.md](./jump-to-latest-20261122.md) |
| 25 | [pinned-drag-invariant-20261122.md](./pinned-drag-invariant-20261122.md) |
| 26 | [tab-rename-20261122.md](./tab-rename-20261122.md) |
| 26 | [tab-title-persistence-20261122.md](./tab-title-persistence-20261122.md) |
| 27 | [command-exit-status-20261122.md](./command-exit-status-20261122.md) |
| 28 | [failed-command-marks-20261122.md](./failed-command-marks-20261122.md) |
| 29 | [failed-command-jump-20261122.md](./failed-command-jump-20261122.md) |
| 31 | [settings-dialog-audit-20261123.md](./settings-dialog-audit-20261123.md) |
| 32 | [transfer-forward-audit-20261123.md](./transfer-forward-audit-20261123.md) |
| 33 | [group-broadcast-20261123.md](./group-broadcast-20261123.md) |
| 34 | [watch-marks-20261123.md](./watch-marks-20261123.md) |
| 35 | [watch-jump-20261123.md](./watch-jump-20261123.md) |
| 36 | [typing-latency-20261123.md](./typing-latency-20261123.md) |
| 37 | [jump-consistency-20261123.md](./jump-consistency-20261123.md) |
| 38 | [tab-bell-20261123.md](./tab-bell-20261123.md) |
| 39 | [remote-title-20261123.md](./remote-title-20261123.md) |
| 40 | [stale-remote-title-20261123.md](./stale-remote-title-20261123.md) |
| 41 | [session-state-gating-20261123.md](./session-state-gating-20261123.md) |
| 43 | [autofocus-respects-deliberate-focus-20261123.md](./autofocus-respects-deliberate-focus-20261123.md) |
| 43 | [snippets-20261123.md](./snippets-20261123.md) |
| 44 | [palette-snippets-20261123.md](./palette-snippets-20261123.md) |
| 46 | [snippet-parameters-20261123.md](./snippet-parameters-20261123.md) |
| 47 | [snippet-editing-20261123.md](./snippet-editing-20261123.md) |
| 48 | [snippet-surfaces-extraction-20261123.md](./snippet-surfaces-extraction-20261123.md) |
| 49 | [snippet-clipboard-20261123.md](./snippet-clipboard-20261123.md) |
| 51 | [locale-truncation-incident-20261123.md](./locale-truncation-incident-20261123.md) |
| 52 | [terminal-snippet-menu-20261123.md](./terminal-snippet-menu-20261123.md) |
| 53 | [startup-command-20261123.md](./startup-command-20261123.md) |
| 54 | [preference-registration-20261123.md](./preference-registration-20261123.md) |
| 55 | [semantic-highlighter-tests-20261123.md](./semantic-highlighter-tests-20261123.md) |
| 56 | [startup-field-new-session-20261123.md](./startup-field-new-session-20261123.md) |
| 57 | [snippets-keyboard-list-20261123.md](./snippets-keyboard-list-20261123.md) |
| 58 | [save-last-command-menu-20261123.md](./save-last-command-menu-20261123.md) |
| 59 | [snippet-duplicate-20261123.md](./snippet-duplicate-20261123.md) |
| 60 | [snippet-args-memory-20261123.md](./snippet-args-memory-20261123.md) |
| 61 | [palette-history-20261123.md](./palette-history-20261123.md) |
| 62 | [recent-commands-menu-20261123.md](./recent-commands-menu-20261123.md) |
| 63 | [menu-width-cap-20261123.md](./menu-width-cap-20261123.md) |
| 65 | [manage-snippets-from-terminal-20261123.md](./manage-snippets-from-terminal-20261123.md) |
| 66 | [snippets-empty-and-escape-20261123.md](./snippets-empty-and-escape-20261123.md) |
| 67 | [startup-command-failure-20261123.md](./startup-command-failure-20261123.md) |
| 68 | [snippet-send-count-20261123.md](./snippet-send-count-20261123.md) |
| 69 | [snippets-shortcut-20261123.md](./snippets-shortcut-20261123.md) |
| 70 | [filer-filter-20261123.md](./filer-filter-20261123.md) |
| 71 | [filer-filter-scope-20261123.md](./filer-filter-scope-20261123.md) |
| 73 | [ftp-pane-filter-20261123.md](./ftp-pane-filter-20261123.md) |
| 74 | [session-tree-f2-20261123.md](./session-tree-f2-20261123.md) |
| 75 | [snippets-f2-20261123.md](./snippets-f2-20261123.md) |
| 76 | [snippet-rename-selection-20261123.md](./snippet-rename-selection-20261123.md) |
| 77 | [snippets-escape-edit-20261123.md](./snippets-escape-edit-20261123.md) |
| 78 | [dead-editor-types-and-slash-filter-20261123.md](./dead-editor-types-and-slash-filter-20261123.md) |
| 79 | [editor-state-release-20261123.md](./editor-state-release-20261123.md) |
| 80 | [preview-follows-session-20261124.md](./preview-follows-session-20261124.md) |
| 81 | [session-filter-keys-20261124.md](./session-filter-keys-20261124.md) |
| 82 | [ftp-filter-scope-and-key-20261124.md](./ftp-filter-scope-and-key-20261124.md) |
| 83 | [filer-cd-here-20261124.md](./filer-cd-here-20261124.md) |
| 85 | [heavy-test-budget-20261124.md](./heavy-test-budget-20261124.md) |
| 86 | [one-filter-key-20261124.md](./one-filter-key-20261124.md) |
| 87 | [own-shell-premise-20261124.md](./own-shell-premise-20261124.md) |
| 88 | [verify-command-20261124.md](./verify-command-20261124.md) |
| 89 | [palette-quick-connect-20261124.md](./palette-quick-connect-20261124.md) |
| 90 | [quick-connect-shapes-20261124.md](./quick-connect-shapes-20261124.md) |
| 91 | [quick-connect-recents-20261124.md](./quick-connect-recents-20261124.md) |
| 92 | [dead-exports-and-style-scale-20261124.md](./dead-exports-and-style-scale-20261124.md) |
| 93 | [terminal-ssh-links-20261124.md](./terminal-ssh-links-20261124.md) |
| 94 | [recents-one-writer-20261124.md](./recents-one-writer-20261124.md) |
| 95 | [quick-connect-hint-20261124.md](./quick-connect-hint-20261124.md) |
| 96 | [recent-sessions-mark-20261124.md](./recent-sessions-mark-20261124.md) |
| 97 | [session-tree-recent-mark-20261124.md](./session-tree-recent-mark-20261124.md) |
| 98 | [recent-mark-narrow-20261124.md](./recent-mark-narrow-20261124.md) |
| 99 | [empty-window-recents-20261124.md](./empty-window-recents-20261124.md) |
| 100 | [round-100-milestone-20261124.md](./round-100-milestone-20261124.md) |
| 101 | [session-type-ahead-20261124.md](./session-type-ahead-20261124.md) |
| 102 | [type-ahead-space-regression-20261124.md](./type-ahead-space-regression-20261124.md) |
| 103 | [type-ahead-buffer-20261124.md](./type-ahead-buffer-20261124.md) |
| 104 | [type-ahead-unification-20261124.md](./type-ahead-unification-20261124.md) |
| 105 | [shortcut-census-20261124.md](./shortcut-census-20261124.md) |
| 106 | [colour-literals-20261124.md](./colour-literals-20261124.md) |
| 107 | [session-filter-20261124.md](./session-filter-20261124.md) |
| 108 | [palette-address-search-20261124.md](./palette-address-search-20261124.md) |
| 109 | [palette-port-hint-20261124.md](./palette-port-hint-20261124.md) |
| 110 | [palette-port-evidence-20261124.md](./palette-port-evidence-20261124.md) |
| 111 | [session-group-filter-20261124.md](./session-group-filter-20261124.md) |
| 113 | [aria-key-hints-20261124.md](./aria-key-hints-20261124.md) |
| 114 | [aria-key-hints-filer-20261124.md](./aria-key-hints-filer-20261124.md) |
| 115 | [aria-key-hints-snippets-20261124.md](./aria-key-hints-snippets-20261124.md) |
| 116 | [key-hints-policy-20261124.md](./key-hints-policy-20261124.md) |

## 四、边界

- `STATE.md` 从第 41 轮开始逐轮记录；第 2–40 轮的说明文档仍在，但状态日志里已没有对应小节——那些轮次只有第三张表能指路。
- 第三张表的轮次取自文档标题原文；标题没写轮次的文档不猜，只在第二张表里列出。
- 全部内容由脚本从现有文件解析生成，未手工补写事实。

