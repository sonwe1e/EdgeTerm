# 审计：诊断导出与更新流（2026-11-25 第 186 轮）

只读审计。2 条，**修 1 条，另 1 条待办**。

| 编号 | 问题 | 位置 | 状态 |
| --- | --- | --- |
| ~~D2~~ | 「启动时不联系签名更新服务」那条测试**早已不加载它要守的模块**，断言因此空转——若日后重新引入 `check()`，应用会在启动时去问 feed（正是发布政策禁止的那件事），而这条测试仍然报绿 | `updater.test.ts:14-15` 的 `vi.mock` 指向代码不再导入的模块 | 已修，**且第一次修法是错的**（见下） |
| D1 | 诊断导出在目录或分段读不了时，会列出日志文件又宣称 `complete` 的尾部里没有它；目录打不开时甚至说 `log files: none` + `(complete)`，读者据此判定「这个构建什么都没记」并关掉工单 | `diagnostics.rs:144/171/174` 把错误塌缩成空 `Vec`，喂给 `:133` 的 `(None, false) => "complete"` | **未修**：需要让 `log_files` 把 `read_dir` 的错误经既有的 `unavailable: Option<&str>` 参数 surfaced 出来，并扩展现有测试 `the_report_says_when_logging_is_disabled`。属 Rust 侧改动，单独立项 |

## D2：一次被负控制抓回来的修法

审计给的最小改动是「删掉那两个失效的 `vi.mock`，让真的 `@tauri-apps/plugin-updater` 被导入」。我照着做了，测试全绿——**然后跑了负控制：在 `updater.ts` 里重新 `import { check }`，测试依然全绿。**

原因：`check` 被导入但没被调用，而断言写的是 `expect(mocks.check).not.toHaveBeenCalled()`，`mocks.check` 现在只是个没人碰的 `vi.fn()`。删掉 mock 只是把「空转」从一种形式换成另一种。

真正有判别力的做法是**断言源码本身**：`import updaterSource from "./updater.ts?raw"` 然后 `expect(updaterSource).not.toContain("plugin-updater")`。负控制已验证：重新加上 import 立刻红。运行时 spy 证明不了这件事——模块根本没人导入时，什么 mock 都不会被加载。

## 确认无缺陷

- **版本号一致**：package.json、Cargo.toml、Cargo.lock、package-lock.json、tauri.conf.json 的 `"../package.json"` 全部解析为 1.7.8；报告的 `env!("CARGO_PKG_VERSION")` 与前端 `getVersion()` 读同一个数，`scripts/check-version.mjs` 守着这四处。
- **日志目录打不开**：`create_dir_all` 先于 `open_path` 执行；`opener:default` 同时放行 `https://*`（「打开本 fork 的 Releases」按钮真能到 `RELEASES_URL`）与路径打开。
- **导出失败有出路**：错误落到持久的状态栏字符串，菜单项可重试；更新对话框的错误态同时给关闭与重试。
- **尾部算式**：256 KiB 预算、最旧优先、部分行截断与 `truncated` 标志在单文件、多文件、刚好等于预算三种情况下都正确。
- **更新流从不声称检查过**：`useUpdater` 只设 `phase: "manual"`，没有「已是最新」的断言，不调 feed；`diagnostics.*`/`update.*`/`about.*` 两语言各 1531 键完全对等。
