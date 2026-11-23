# 文件面板：「在终端中打开」（2026-11-24 第 83 轮）

反方向早就有了：终端里按 Reveal（⌘J / 菜单「Terminal folder」）会把文件面板切到 shell 当前目录。反过来——**已经在文件面板里翻到了 `/var/www`，想在那个 shell 里 cd 过去**——只能自己抄路径。WinSCP、FileZilla 都有这一项。

## 一、交付

| 位置 | 变化 |
| --- | --- |
| 文件面板「…」视图菜单 | 新增「在终端中打开」（`filer.cdHere`），紧挨着它的反向动作「Terminal folder」 |
| 可用条件 | 仅当文件面板所属的会话**就是当前活跃的已连接 shell**（复用既有的 `canReveal` 条件）；不是同一个 shell 时禁用，避免把 `cd` 送进另一个窗口 |

## 二、引号：由路径决定，而不是由平台决定 |

新增 `src/filerShellPath.ts`：

```ts
export function cdCommand(path: string): string | null
```

| 路径形状 | 结果 | 理由 |
| --- | --- | --- |
| 以 `/` 开头 | `cd '/srv/app'`，名字里的 `'` 写成 `'\''` | SFTP 浏览的是远端 POSIX 路径，单引号结束字符串 |
| 其它（`C:\…`） | `cd 'C:\Users\me'`，名字里的 `'` 写成 `''` | 本地 shell 是 PowerShell，转义方式是双写 |
| 空白 | `null`（不发送任何东西） | 没有目录可切 |

平台判断放在路径上，是因为同一台 Windows 机器既会浏览本机路径，也会通过 SFTP 浏览远端 POSIX 路径——按平台判断会把远端路径当成本地。

## 三、验证

| 用例 | 断言 |
| --- | --- |
| `src/filerShellPath.test.ts`（3） | POSIX 普通/带空格/带单引号；Windows 普通/带单引号；空与空白返回 `null` |

菜单接线在第 84 轮补上了：新建 `src/test/filerOpenInTerminal.browser.test.ts`（2 条）——①文件面板的会话是活跃已连接本地 shell 时，菜单出现「Open in Terminal」，点击后 `api.writeSession` 收到 `("t1", "cd '/root'\r")`；②该会话不是活跃标签时，菜单项仍在但 `disabled`，且没有写入任何字节。

## 四、边界

- 只在同一个会话里生效：文件面板的会话不是活跃 shell 时该项禁用；
- 命令走既有的 `sendCommandText` 通道，成功不写状态栏；失败时状态栏说明「没有可切换目录的已连接终端：{path}」。