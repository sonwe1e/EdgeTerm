# 构建记录：1.7.8（第 208 轮，2026-11-25）

第 205 轮那版（`EA153752…`）之后修了一条拖了三轮的缺陷。**以本记录为准。**

| 项 | 值 |
| --- | --- |
| 提交 | `4004083`（`git status` 干净） |
| 版本 | 1.7.8（未升版） |
| 安装包 | `src-tauri/target/release/bundle/nsis/EdgeTerm_1.7.8_x64-setup.exe` |
| 大小 | 4,263,800 B（4.06 MiB） |
| SHA-256 | `2AE06F1DE0D316E2DB0D0363B7C34235D54319F69EB70DE4335D626EB951EC9B` |

## 构建前验证（同一提交）

- `npm run test:rust`：549 通过，32 ignored。
- `npm run verify`：`VERIFY_EXIT=0` —— 单测 224 文件／2002 用例，浏览器 75 文件／351 用例。
- `npm run check:commits -- 8539c0b..HEAD --typecheck`：1 commit，0 errors，0 warnings。
- `npm run tauri:build`：`BUILD_EXIT=0`。

## 与上一版（`EA153752…`）的差别

**「广播目标」浮层现在可以关闭了。**

它是一块最大 520×72vh 的固定面板，Escape 无反应、点别处也只让它继续浮在终端上方，**只有再按一次同一个按钮才能关掉**。它的三个同族浮层各自都用了 `usePopoverDismiss`，状态栏没有。

## 这条缺陷为什么拖了三轮

第 205、206 轮我改的是「焦点该在哪」，第 207 轮冻结并说「拿不到断言信息」。第 208 轮按自己写下的第一步做——把完整输出写进日志文件再读——**答案在第 17 行，而且根本不是断言：**

```
TypeError: Cannot read properties of undefined (reading 'includes')
```

是一条崩溃。那两条用例在浮层开着时抓了 DOM 引用，浮层按正确行为关掉后这些引用成了 detached 节点，`find(...)` 返回 undefined，再 `.includes` 就崩。**所以前三轮的方向全都错了**：问题不在焦点顺序，在用例把跨生命周期的 DOM 引用当成了活的。

而前两轮我一直在用 `Select-String -Pattern 'AssertionError|expected'` 过滤日志——失败根本不是断言，**过滤器把唯一有用的那行放过去了**。我以为「没有信息」，其实信息一直在，是我的过滤器问错了问题。

## 未验证的边界

- 只在 Windows x64 构建；未做安装／升级／卸载自动化。
- 待办 3 条：A3（发送面板手搓 `role="dialog"`，窗口快捷键穿透）、A4（停靠分隔条不报位置）、A5（两个 `aria-haspopup` 不报 `aria-expanded`）；另 W2 与「i18n 文案质量审计未完成」。
- 第 160–208 轮审计共 **80 条**，已修 **77 条**。

