# 审计：命令面板与 SSH 连接（2026-11-24 第 156 轮）

只读审计，范围：commandPalette.ts、components/CommandPalette.tsx、paletteHistory.ts、session/ssh/*.rs、errorInfo.ts。4 条全部本轮交付。

| 编号 | 问题 | 交付 |
| --- | --- | --- |
| **PA1** | 需要人回答的登录（一次性验证码、推送确认、账号密码）被 30 秒握手窗口杀掉：认证跑在 handshake 的 tokio::time::timeout 里，auth.rs 里 180 秒的 ANSWER_TIMEOUT 永远轮不到；失败文案还归咎服务器，用户随后输入的验证码被静默丢弃 | 30 秒窗口只套拨号与密钥交换：connect_hop 内部对直接拨号和跳板通道分别设 timeout，认证交给 ANSWER_TIMEOUT；handshake 不再包超时 |
| **PA2** | 面板里输入裸主机名会给出「连接到 example.com」，回车却只得到内部错误「session is missing a username」——快速连接的 profile 从不带账号 | 空用户名回落到本机账号（OpenSSH 的读法），新增 credentials::local_account() 供三处共用（凭据密钥、config 解析、连接） |
| **PA3** | 中文界面里用「语言」「恢复默认」「导出」搜不到设置面板——设置行只有英文关键词，空结果还回一句不相干的 user@host 提示 | 设置行增加 localized 关键词，取 menu.language／menu.restoreDefaultSettings／menu.exportData／menu.importData 的本地化文案；新增用例（中文三个词都要找到该行），负控制即失败 |
| **PA4** | 快速连接成功过的目标，再次键入时列表里出现两个同 id 的行：React key 冲突、aria-activedescendant 重复，打开时没有任何行显示为选中 | 新增纯函数 withoutTypedTarget，键入行已覆盖的记住目标不再重复列出；单元用例覆盖（去掉过滤即失败），浏览器用例钉住「一行」与「选中态」 |

## 审计确认「无缺陷」的部分

- 主机密钥对话框可关闭（dismissable={!busy}、Cancel、Esc）。
- keepalive 已配置：interval 15 秒、max 3，静默对端在窗口内判死（有专门用例）。
- 超时文案点名了原因；SFTP 拨号共用同一个上限。

边界：读代码判断，未在真实 MFA 服务器上复现 PA1。

