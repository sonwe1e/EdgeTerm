# 终端里的 ssh:// 链接可以直接连（2026-11-24 第 93 轮）

脚本、工单、文档里经常打印 `ssh://root@host:22`。此前终端里它是纯文本：浏览器插件 `WebLinksAddon` 只认 `http(s)/ftp` 之类，而且本机也没有为 `ssh://` 注册的处理器。

## 一、交付

- 终端再挂一个 `WebLinksAddon`，`urlRegex` 只匹配 `ssh://…`（大小写无关）；
- 点击时 `preventDefault` 并走第 89 轮的解析器：`ssh://user@host:port` 直接开会话，不保存资料；
- 不合法的文本不会被下划线——插件本身会用 `new URL` 过滤掉不成立的地址。

## 二、一次真实缺陷：`gig`

第一版把正则写成 `/ssh:\/\/[^\s"<>]+/gi`，全量浏览器契约立刻失败：

```
SyntaxError: Invalid flags supplied to RegExp constructor 'gig'
FAIL terminalLinks.browser.test.ts > opens a path printed by a command …
```

插件的 `computeLink` 会做 `new RegExp(source, flags + "g")`。**正则自己带 `g`，拼出来就是 `gig`，构造直接抛错**——而它抛在链接提供者里，连带把同一终端上的**文件链接**也弄坏了（既有用例正是这样发现的）。改为不带 `g` 的 `/…/i`，并加一条守卫用例：`SSH_URI_REGEX.global === false`、`ignoreCase === true`。

## 三、验证

| 层次 | 证据 |
| --- | --- |
| 正则 | `src/terminalSshLinks.test.ts` 4 条：三种写法、引号与查询串的边界、其他协议与裸词不匹配、**不带 g 标志** |
| 真实终端 | `src/test/terminalLinks.browser.test.ts` 2/2 通过（文件链接的 Ctrl+点击没有被新挂件破坏） |
| 全量 | 见 STATE 本轮记录（第一次全量失败，修好后重跑） |

## 四、边界

- 只认 `ssh://` 前缀；纯文本 `user@host` 不下划线（与搜索框的取舍一致，避免误连）；
- 点击后走的是「不保存」的临时资料，与会话列表无关；
- 终端画布里的下划线由插件绘制，无法用 DOM 断言，因此本轮以「不破坏既有链接」和正则单测作为证据边界。
