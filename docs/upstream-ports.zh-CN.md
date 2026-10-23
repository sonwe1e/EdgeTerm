# 上游移植记录

核对日期：2026-10-23。本分支共同祖先为上游 `v1.0.0`（`3e6e35738439a078de11abfd315c7160ca6b8ad4`）。本记录覆盖上游 `v1.0.0..v1.0.4` 的 14 个提交：10 个功能/修复提交与 4 个版本提交。上游 HEAD 核对为 `051f94e`，本地审查基线为 `c013923`，公开发行边界为本分支 `v1.2.8 / e3e920a`。

Git 祖先关系仍停留在 1.0.0；选择性移植不等于已 merge 上游 1.0.4。下表根据上游提交、本地 diff、现存代码和测试位置建立对应关系；“适配移植”不表示逐字 cherry-pick，也不代表逐项完成真实桌面/服务器验收。

## 功能与修复对应

| 上游提交 / 首次发布 | 本分支处理 | 对应提交与证据 |
| --- | --- | --- |
| [6fc2231](https://github.com/miskin-lee/EdgeTerm/commit/6fc2231) · 1.0.1 · 多选与整组传输 | 适配移植：接入已有统一传输队列 | `600a60c`；`src/fileBatch.test.ts`、`src/components/FtpPane.test.ts`、`src/paneDropWiring.test.ts`；浏览器用例 `src/test/ftpKeyboard.browser.test.ts` |
| [ec9faa7](https://github.com/miskin-lee/EdgeTerm/commit/ec9faa7) · 1.0.1 · 搜索选项与选区内搜索 | 适配移植：以本地 find 引擎替换 search addon，并修复全字匹配/正则边界 | `0aeb229`；`src/terminalFind.test.ts`、`src/terminalSearch.test.ts` |
| [126ae8c](https://github.com/miskin-lee/EdgeTerm/commit/126ae8c) · 1.0.1 · 波特率建议下拉 | 适配移植：使用应用内下拉控件 | `bc4f930`；`src/components/comboBox.test.ts` |
| [65ceb9c](https://github.com/miskin-lee/EdgeTerm/commit/65ceb9c) · 1.0.1 · 拥挤标签栏可读性与滚动 | 适配移植：本地采用逐标签步进按钮，保留自身布局 | `1f85d69`；`src/components/TabBar.tsx`。未在此索引中补造独立回归通过记录 |
| [a5bb692](https://github.com/miskin-lee/EdgeTerm/commit/a5bb692) · 1.0.2 · 断线 Enter 重连 | 已有对应能力，未重复搬运 | `e6df914` 实现，`f375549` 补实际 action 接线测试；`src/reconnect.test.ts`。不主张与上游全部实现细节等同 |
| [376df7d](https://github.com/miskin-lee/EdgeTerm/commit/376df7d) · 1.0.3 · Filer 大小列 | 已有对应能力，保留本地大小/日期列体系 | `3ed5b96` 引入列，`922b2ab` 改进列展示，`6633288` 加拖宽；`src/components/panels/FilerPanel.tsx`、`filerPresentation.tsx` |
| [92c87f6](https://github.com/miskin-lee/EdgeTerm/commit/92c87f6) · 1.0.3 · 输入名称跳转 | 适配移植：本地文件列表与双栏列表接入 | `62334d6`；`src/fileTypeSelect.test.ts` |
| [b731d45](https://github.com/miskin-lee/EdgeTerm/commit/b731d45) · 1.0.3 · Sender 标签颜色与右键选项 | 适配移植：八色标签及本地主题/导出数据 | `07f6026`；`src/senderColors.test.ts`、`src/themes.test.ts`、`src-tauri/src/tests.rs` |
| [866c3fb](https://github.com/miskin-lee/EdgeTerm/commit/866c3fb) · 1.0.4 · 移除状态栏 | 未移植，保留本分支现状 | 本分支状态栏仍承载传输、资源与转发入口，见 `src/components/StatusBar.tsx`。本次只记录差异，不改变产品布局 |
| [4ed8be2](https://github.com/miskin-lee/EdgeTerm/commit/4ed8be2) · 1.0.4 · Sender 续行与设备提示符 | 适配移植：保留原 shell 词汇并增加输入提示符判定 | `544572f`；`src/terminalPrompt.ts`、`src/terminalActivity.test.ts` |

公共文案为 `941178d`，移植后的 README 说明为 `0084461`，本分支版本提交为 `ffb1569`；最终公开的 1.2.8 标签落在后续测试脚本修正 `e3e920a`，不能把版本提交误当成发布的最终 SHA。

## 上游版本提交

| 上游版本 | 版本提交 | 处理 |
| --- | --- | --- |
| 1.0.1 | `7568e4e` | 仅作为来源范围，不覆盖本分支版本 |
| 1.0.2 | `28efdda` | 同上 |
| 1.0.3 | `ece336b` | 同上 |
| 1.0.4 | `051f94e` | 同上 |

本地存在上游标签不代表本仓库发行过这些包，也不代表它们是本分支自动更新通道。

## 验证证据与后续同步

[本分支 1.2.8 发布说明](https://github.com/sonwe1e/EdgeTerm/releases/tag/v1.2.8)记载了前端、浏览器、Rust 与移植提交检查结果，同时保留真实 WebView2 与真实 FTP/SFTP 批量传输尚待手动验证的边界。本次建立索引没有重新运行那套历史验收，表内测试路径是可核查入口，不是本次通过声明。

后续同步先更新上游参照，检查每个提交的语义和依赖，再选择直接移植、适配、已有能力或暂不采用。直接 cherry-pick 用 `-x` 保留来源；适配实现的提交 body 用 `Upstream: <仓库 URL / 完整 SHA>` 写明来源与差异，并同步此表。不要自动接收上游版本号、更新公钥、下载源或功能删除，也不要用空合并伪造“全部上游改动已接受”。
