# 长命令不能把菜单撑到窗外（2026-11-23 第 63 轮）

上一轮把最近命令放进了终端右键菜单，于是菜单里第一次可能出现**一整行命令**（示例命令 74 个字符）。子菜单此前只有 `max-width: calc(100vw - 12px)`：在 1112px 的测试视口里，一行 74 字符的命令把面板撑到 **488px**，再长就会顶到窗口边缘。

## 一、交付

| 位置 | 变化 |
| --- | --- |
| `panels.styles.css` `.context-submenu` | `box-sizing: border-box` + `max-width: min(440px, calc(100vw - 12px))`：与菜单栏面板同一个 440px 上限，且把内边距算在上限内 |
| `ContextMenu.tsx` | `MenuAction.title?`：标签被截断时，悬停给出完整文本 |
| `TerminalPane.tsx` | 「最近命令」与「发送已保存命令」的每一行都带上 `title` |

## 二、一个必须先测量的坑（我自己的第一版是错的）

第一版把上限写在 `shell.styles.css` 的 `.menu-submenu, .context-menu` 上，测试仍然失败。在测试里打印 `getComputedStyle(panel).maxWidth` 得到 **1088px**——不是 440px。原因：`panels.styles.css` 的 `.context-submenu { max-width: calc(100vw - 12px) }` 在文件顺序上更靠后，**覆盖**了我新加的规则。

教训：新增样式前先确认「谁最终生效」，而最省事的确认方式就是让测试把计算值打印出来——比读一遍全部样式表快。

## 三、验证

| 用例 | 断言 |
| --- | --- |
| `snippets.browser.test.ts`（17，新增 1） | 74 字符的命令进历史 → 右键 → 最近命令子菜单：面板宽度 < 448px、标签 `scrollWidth > clientWidth`（确实被截断而非换行）、行的 `title` 是完整命令 |

## 四、边界

- 上限只管宽度；高度另有 60vh 滚动上限（既有）。
- 只给命令类行加了 `title`：普通动作标签本来就不长，给每一行都加原生提示是噪音。
