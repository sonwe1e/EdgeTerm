# 一条命令跑完整个验证门（2026-11-24 第 88 轮）

每轮收尾都要跑五个门：`format:check`、`typecheck`、`lint`、`npm test`、`npm run test:browser`。此前是我在 shell 里逐条串联，每条都要自己拼输出与退出码；读者（或下一个 agent）拿到仓库时没有同样的入口，只能从 `AGENTS.md` 里抄五条命令。

## 一、交付

新增 `scripts/verify.mjs` 与 `npm run verify`：

- 依次跑五个任务，**每条都经过既有的托管运行器**（`scripts/run-task.mjs`），因此仍然遵守「同一时刻只有一个托管任务」的预算；
- 第一个失败就停（后面的结果在已知失败后没有意义），但仍打印每条的状态；
- 结尾一张表，`ok` / `FAILED (退出码)` / `skipped`，带耗时；
- 可传参只跑一部分：`npm run verify typecheck lint`。

## 二、实测（本机，最终树）

```
format:check   ok 0.9s
typecheck      ok 7.1s
lint           ok 0.9s
test           ok 124.0s
test:browser   ok 190.3s
```

`VERIFY_EXIT=0`；同次运行里单测 202 文件／1869 用例、浏览器契约 72 文件／316 用例。整门约 **5 分 24 秒**，其中 97% 的时间在单测与浏览器契约上——这也说明「开发期只跑目标文件、收尾跑一次全量」的分工是对的。

## 三、验证这个门本身

`scripts/verify.test.mjs`（2 条）：①默认任务顺序与工程标准列出的顺序一致；②表格对 `ok`、`FAILED (code)`、`skipped` 三种状态的措辞与耗时格式正确——失败路径不靠人工观察。

## 四、边界

- 它不跑 Rust 侧（`test:rust`、`cargo fmt`、`check:clippy`）：那些需要原生工具链，属于打包前的门，不属于每次前端改动；
- 它不做任何缓存或增量判断：`ok` 的含义就是「这次真的跑过」。
