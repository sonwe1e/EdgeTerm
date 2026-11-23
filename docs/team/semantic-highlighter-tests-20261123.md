# 给终端高亮补上测试，并把整行分类拆出来（2026-11-23 第 55 轮）

先量后改：统计 `src/` 下最大的、没有测试文件的逻辑模块。结果指向 `src/semanticColors.ts`——**754 行、零测试**，而它决定读者看到的每一行终端输出（提示符、错误、权限位、diff、链接、表格）。

## 一、补了什么测试（19 条）

| 组 | 断言 |
| --- | --- |
| 提示符词汇 | `user@host:~$`、`[deploy@web1 ~]$`、`(venv) deploy@web1:/app$`、cmd/PowerShell 三种、`❯`、`>>>`、`$`；`# a comment` 不是 root 提示符；`hello world` 不是提示符 |
| 提示符判定 | 只有提示符（含行尾空格）算提示符，提示符后跟命令不算 |
| 区间不变量 | 对 8 类真实输出：起点单调不减、终点大于起点、不越界、颜色是十六进制、条数不超过上限 |
| 语义 | 错误行的 red 区间与 error band；URL 下划线且 sky；`ls -l` 权限位逐位着色；新增/删除 diff 的 band；表格头 band；注释 gray |
| 主题 | 切换 light/dark 时调色板与 band 跟着换；serialX 主题下不变量仍成立 |
| 两条刻意的例外 | `- a list item` **不是**删除（YAML/Markdown 列表）；`--- a/f`、`+++ b/f` 是 slate 头且无 band |

## 二、顺带做的代码优化

`windtermLine` 里「整行类」的六个分支（diff/注释/段头/表头）抽成 `wholeLineStyle(text, unixPermissions, powershellMode)`，返回 `{color, band}` 或 null；调用方从 30 行分支变成 5 行。参数显式传两个已算好的首 token 判定，行为不变——**19 条测试是这次搬动的安全网**。

## 三、一个被测试挡下来的错误预期（我自己的）

我最初断言 `"- removed a line"` 应有删除 band，测试失败。读代码发现这是**刻意的**：一个短横加一个空格是 YAML/Markdown 列表项，若染成删除色，读者 `cat` 任何配置文件都会满屏警告。改成断言这条例外，并另用 `"-removed a line"`（无空格）验证删除 band。**测试写错时的正确反应是改测试去符合意图，而不是改产品去符合测试。**

## 四、边界

- 这些是纯函数单测（jsdom），不验证 xterm 里真实渲染的像素；渲染由浏览器契约另行覆盖；
- `serialxHighlight.ts` 已有测试，本轮不重复；
- 整行分类抽出的函数未导出：它只服务本文件，导出会变成不该有的公共 API。
