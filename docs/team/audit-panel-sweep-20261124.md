# 三份只读审计（第 129 轮）

用户允许自由分派子代理，于是并行开三个**只读**审查（命令面板／文件面板／标签与编辑器）。它们被明确要求：不改文件、不跑构建或测试、每条发现必须给出文件与行号、允许「没发现问题」。本轮合入文件面板中的两条，其余按价值排队。

## 一、本轮已处理

| # | 问题 | 处理 |
| --- | --- | --- |
| F1 | 上传分裂按钮的菜单被第二次点击关掉后，uploadMenuWasOpen 没有复位；此后按 Enter／Space 只会提前返回，菜单再也打不开（同文件的「更多操作」菜单本来会复位） | 在提前返回分支里复位，与兄弟菜单一致 |
| F3 | 拖放被拒时提示「请等待当前**传输**完成」，但 busy 也来自列目录、删除、重命名，读者被指向一个并不存在的传输 | 英文改为 wait for the current task to finish，中文改为「请等待当前操作完成」 |

## 二、待处理队列（按价值排序）

| # | 面板 | 问题 | 最小改法 |
| --- | --- | --- | --- |
| P1 | 命令面板 | 只输入主机名（如 example.com）时，快速连接行显示「SSH as , port 22」——账号为空，建出来的会话也没有用户名 | App.tsx 里 username 为空时改显示既有 palette.quickConnectHint |
| F2 | 文件面板 | 切到已断开的 SSH 标签时，若当时正在列目录，底部会永久停在「Working…」，busy 也一直挡住按键 | useFilerDirectory.ts 的离线重置分支补 setBusy(false) |
| P4 | 会话对话框 | 连接中按标题栏 × 会关掉表单（底部取消是禁用的、Esc 也被忽略），但连接仍在继续，标签随后才出现 | 把 ModalDialog 的 if (!busy) 守卫用到 × 上，或让取消按钮不再禁用 |
| P6 | 会话对话框 | (S)FTP 端口超范围时提示出现，但焦点无法移到端口框、也不标 aria-invalid——只有 SSH/Telnet 的端口框注册了 fieldRefs | 给 (S)FTP 端口框补 data-field 与 ref，照抄 SSH/Telnet 那段 |
| P2 | 命令面板 | 不认识的输入只有「没有匹配的命令」，user@host:port 这种可用形状从未说出 | 加 palette.noMatchHint，与 snippets.noMatchesHint 同样做法 |
| P3 | 命令面板 | Tab 会关闭整个面板，但页脚只写「Esc 关闭」，Home/End 也没列出 | 改既有 palette.footer 一处文案 |
| P5 | 命令面板 | 快速连接行与「最近连接」都归在「已保存的会话」标题下，而它们的承诺恰恰是「不保存」 | commandPalette.ts 里该行 group 改为 actions |
| F4 | 文件面板 | 中文界面在盘符根处，路径栏与列表无障碍名显示英文哨兵值 This PC | 渲染时用 atDrivesRoot 分支加新键 filer.drivesRoot；发给 IPC 的哨兵值不变 |
| F5 | 文件面板 | 空文件夹是唯一没有动作、也不会被朗读的空状态 | 复用 panel-empty-action 加「新建文件」，role 去掉条件 |
| F6 | 文件面板 | 同一个「名字已存在」有三种引号写法，英文里还出现中文直角引号 | 统一成弯引号 |

## 三、口径

子代理的结论是**线索，不是证据**：本轮两条都自己读代码复核过才动手。它们被禁止写文件、跑构建与测试，所以没有制造任何绿灯。

## 四、第三份审计（标签、窗格、编辑器）

| # | 问题 | 最小改法 |
| --- | --- | --- |
| T1 | **窗格放大时**，用 Alt+N、命令面板或切换窗格去激活另一窗格里的会话，活动会话会指向看不见的那个标签，而画面不变——随后的关闭会话、Sender 发送、文件面板跟随都作用在看不见的会话上 | storeTabActions.ts 的 setActive／setActivePane 照 splitPane 已有的做法：目标窗格不是放大窗格时清掉 zoomedPaneId |
| T2 | 关掉最后一个会话后焦点掉到 body，空状态的主按钮出现了却没有焦点 | Workspace.tsx 给空状态主按钮加 ref，并在 activeElement 为 body 时聚焦，抄 TerminalPane.tsx 的守卫写法 |
| T3 | 关掉终端标签后，同窗格里露出的 FTP/SFTP 标签没有焦点（FtpPane 没有 focused 参数） | 传 focused，并在 activeElement 为 body 时聚焦文件列表（role=listbox 已存在） |
| T4 | 标签栏滚动按钮在键盘焦点落在其上时消失或被禁用，焦点掉到 body | 溢出恢复后把焦点交给标签栏容器（已有 tabIndex=-1 与 F2 处理） |
| T5 | 「所有会话」按钮与它的「N 个会话需要注意」只覆盖当前窗格 | 改既有 tab.allSessions 文案，点明范围（如「此窗格的标签页」） |

编辑器面未发现问题：Ctrl+S 提示真实存在且有浏览器用例；Esc 能关是因为只传了 dismissable={false}；关窗焦点归还由 ModalDialog 负责；未保存关闭有确认。


