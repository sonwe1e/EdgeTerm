# 分支与历史维护记录

核对及本地整理日期：2026-10-23。整理基线为 `main / c0139231a97e0447f40ccfe1e2c36ef6e9841f8a`，线上 `origin/main` 为已发布 `v1.2.8 / e3e920a`。本记录是该时点的快照，不表示远端分支以后不会变化。

## 为什么主线会出现重复的开发记录

本分支从上游 `v1.0.0 / 3e6e357` 分出，随后有原始集成线、按功能重拆线和发布线。`af63eed1398122b25f267cf7f576bb4796350311` 把旧主线的 29 个提交合入发布线；其说明记录了保留历史的目的，`git diff af63eed^1 af63eed` 没有文件差异。

因此完整日志会同时出现原始提交与重拆后的提交。不能将相似标题当作功能被实现两次，也不应为减少日志长度再次重写已发布祖先。阅读发布主线可使用 `git log --first-parent --oneline main`；定位真实实现时仍需查看完整提交图和 diff。

另一个历史例外是 `bb80da1f1664a68898991eabfbf0214ebb3b517b`：保存当时已有的 1.2.6 工作区，共 59 个文件、6071 行增加和 2123 行删除，覆盖资源监控、传输、转发、文件面板、测试与协议实现清理。它已进入 1.2.8，保留原 SHA；快照本身不提供按功能独立回退的粒度。需要修复这些功能时新增窄范围提交，不从公开主线拆走它。

## 本地分支处理

归档操作前确认只有 `main` 被工作树检出。下表记录的是本地分支整理阶段：只调整本机分支引用，没有 reset/rebase main，没有移动标签，也没有修改远端引用。后续整理成果另行拆分为常规提交并快进推送 main；表中的 tip 和“未推送”状态仍指上述归档时点，不能当作推送后的实时状态。

| 原本地分支 | 当时 tip | 核对结果 | 本次处理 |
| --- | --- | --- | --- |
| `codex/edgeterm-reviewed-fixes` | `6994ccb297658dd287d026476fb40b6b1d1a4482` | 是 main 祖先；由 v1.2.1 标签保留 | 用 `git branch -d` 删除已合入的本地引用 |
| `feat/upstream-1.0.4-port` | `ffb1569279095dbd11f9e64a14d65c51014843f9` | 是 main 祖先；包含于 v1.2.8 | 同上 |
| `fix/ux-2026-10-20` | `7c653e58d5d04b05c23473223b5455ac6a2ec102` | 是 main 祖先；包含于 v1.2.8 | 同上 |
| `backup/pre-resplit-2026-10-14` | `7f670bd3d6d31033c7d68ffb9b912ec622d010c6` | main 不可达的拆分前快照 | 改名 `archive/2026-10-23/pre-resplit`，保留全部提交 |
| `codex/edgeterm-flow181-improvements` | `cec0f9e69501fdb408fce6d3ef109e5fccc8479c` | 19 个 main 不可达提交的 patch-id 均在 main 有等效项；原远端分支已不存在 | 改名 `archive/2026-10-23/flow181`，取消失效 tracking |
| `rewrite/by-feature` | `c588c73973191fed98f8573a046567b2a1b39a34` | 23 个 main 不可达提交中 21 个 patch-id 有等效项，2 个不能用单提交 patch-id 证明等效 | 改名 `archive/2026-10-23/by-feature`，取消旧 tracking；保留中间历史 |

patch-id 对应只证明补丁等效，不能证明每个中间提交可构建或真实环境行为一致。重拆线的 `ca310db`、`5a09ad8` 属于未单独匹配项；[现有工程标准 R8](engineering-standards.zh-CN.md#r8提交范围与拆分)已记录过跨提交删除/恢复 importer 导致中间类型检查失败的问题，不将其重新引入主线。

进一步核对树对象：`5a09ad8` 与主线 `0e660e4` 的 tree 均为 `8f76e81c666ecaebbea245cb184aa4cbd0baeb15`；归档 tip `c588c73` 与主线 `c2f6d51` 的 tree 均为 `12dcc8ce119d1798f0a919f405b80688811b2049`。这证明对应终点的受版本控制文件完全一致，旧重拆线没有需要整条再次合并的终点差异；归档仍保留其不同的中间历史。

归档分支属于本机引用，尚未上传，其他克隆不会自动拥有它们。恢复已删本地引用可运行 `git branch <原名> <表中完整 SHA>`；归档分支可以用 `git branch -m <归档名> <原名>` 改回。不要在归档分支继续开发或将其整条合入 main。

## 远端分支分类（本次保留）

| origin 分支 | 核对 tip | 分类及后续用途 |
| --- | --- | --- |
| `main` | `e3e920a` | 正式发布主线，本地在其后已有 3 个未推送提交 |
| `codex/edgeterm-reviewed-fixes` | `6994ccb` | 已结束的发布准备线；v1.2.1 和 main 已保留内容。本次不删除远端引用 |
| `rewrite/by-feature` | `f73bad9` | 旧重拆线，落后于本机归档 tip 12 个提交；不是当前开发基线 |
| `gpui-rewrite` | `c48a98d` | GPUI 前端实验，保留，不纳入正式发行完成声明 |
| `spike/p2p-term` | `9236632` | P2P 终端实验，保留，不纳入正式发行完成声明 |

本机为浅克隆，共同基线可确认，但更早的完整祖先链可能被截断。实验分支的整条 `main..branch` 数量不能直接当作新增功能数。将来清理远端前需重新核对远端 tip、开放 PR/使用方和必要归档，不直接照此快照删除。

## 2026-11-16 分支清理（1.7.6）

上游同步移植分支 `codex/upstream-ports-20261116` 以快进方式合入 main（`d280b92..9cd62e1`），随后建立版本提交 `c86b9c9`（annotated 标签 `v1.7.6`）并推送。核对祖先关系与 `git cherry main <branch>` 的补丁等价性后清理：

| 原 origin 分支 | 核对 tip | 处置 |
| --- | --- | --- |
| `codex/edgeterm-reviewed-fixes` | `6994ccb` | 已合入 main（2.1 之前的 v1.2.1 内容在主线），删除远端引用 |
| `codex/edgeterm-terminal-stability-20261111` | `d139f0b` | 已合入 main（PR #6 的合并提交 `d280b92`），删除远端引用 |
| `codex/edgeterm-ux-20261111` | `51bec5e` | 0 个独有补丁，删除 |
| `feat/edgeterm-1.8-filer-bounded-20261109` | `627f958` | 0 个独有补丁，删除 |
| `fix/a2-off-settings-ux-20261108` | `4957615` | 0 个独有补丁，删除 |
| `fix/agent-gutter-stability` | `976d315` | 0 个独有补丁，删除 |
| `fix/cold-history-agent-stability-20261108` | `c136a84` | 9 个独有补丁，归档为 `archive/2026-11-16/cold-history-agent-stability` 后删除 |
| `gpui-rewrite` | `c48a98d` | 154 个独有补丁，归档为 `archive/2026-11-16/gpui-rewrite` 后删除 |
| `rewrite/by-feature` | `f73bad9` | 2 个独有补丁，归档为 `archive/2026-11-16/rewrite-by-feature` 后删除 |
| `spike/p2p-term` | `9236632` | 125 个独有补丁，归档为 `archive/2026-11-16/spike-p2p-term` 后删除 |

`codex/edgeterm-terminal-stability-20261111` 在清理后的 `git fetch --prune` 中才被发现：本地远端跟踪引用此前缺失，初版快照因此漏记。该 tip 是 main 的祖先，已一并删除。本地 `codex/release-1.3.0`、`codex/release-1.5.0`（均已合入 main）与合入后的 `codex/upstream-ports-20261116` 一并删除；`archive/2026-10-23/*` 本地归档保留。四个 `archive/2026-11-16/*` 引用已推送到 `origin`，因此远端仍可取回这些历史 tip；它们不是开发基线，不要在其上继续开发或整条合入 main。本页上一节"远端分支分类（本次保留）"是 2026-10-23 的历史快照，不代表清理后的远端状态。2026-11-27 补记：这四个远端引用现已不在 `origin`，本机归档也已删除，见下一节。

恢复已删原分支：`git branch <原名> <表中 tip>`，需要远端同名分支时再 `git push origin <branch>`。

## 2026-11-27 核对与清理（1.8.1）

核对基线为 `main / c813abe`（已发布 1.8.1）；当日 `git ls-remote --heads origin` 只返回 `main`。本轮只调整本机引用并更新记录，没有改写主线、移动标签或改动应用代码。

### PR 与远端分支

本仓库 36 个 PR 均已关闭：35 个合并，#2 是未合并的草稿。#1、#3–#6 的分支处置见上一节；其余 30 个（#7–#36）于 2026-11-22 12:36–19:59（北京时间）合并，远端 head 分支此后已删除。#19 以 #15 的分支为 base、#21 以 #20 的分支为 base，先进入该分支，再随它合入 main。30 个 head 提交都是 main 的祖先；下表的 head 提交取自 GitHub 的 PR 记录。

| PR | head 分支 | head 提交 | 说明 |
| --- | --- | --- | --- |
| #7 | `codex/edgeterm-sender-repeat-20261120` | `3c26d56` |  |
| #8 | `codex/edgeterm-filer-epoch-20261120` | `aa36037` |  |
| #9 | `codex/edgeterm-viewport-fit-20261120` | `b394a8c` |  |
| #10 | `codex/edgeterm-filer-create-navigation-20261120` | `f18f10b` |  |
| #11 | `codex/edgeterm-pristine-editor-save-20261120` | `4a1515a` |  |
| #12 | `fix/log-viewer-follow-match` | `176a62f` |  |
| #13 | `fix/ftp-delete-feedback` | `d1fbb7b` |  |
| #14 | `fix/find-late-controller` | `ad1370c` |  |
| #15 | `fix/ftp-restore-navigation` | `47b9105` | #19 的 base |
| #16 | `fix/reserve-focus-region-f6` | `883e6ea` |  |
| #17 | `fix/tab-strip-roving-focus` | `db83218` |  |
| #18 | `fix/reverse-focus-cycle-entry` | `9442f44` |  |
| #19 | `fix/ftp-transfer-refresh-navigation` | `f5a985b` | 堆叠于 #15 |
| #20 | `fix/ftp-local-parent-navigation` | `00b3121` | #21 的 base |
| #21 | `fix/ftp-child-drop-preflight` | `4922550` | 堆叠于 #20 |
| #22 | `fix/ftp-transfer-attempt-ownership` | `b4ace37` |  |
| #23 | `fix/sender-preserve-draft-ending` | `608a302` |  |
| #24 | `fix/terminal-selection-delete` | `8906afc` |  |
| #25 | `fix/ftp-operation-feedback` | `5ede4cd` |  |
| #26 | `fix/ftp-restore-side` | `6912869` |  |
| #27 | `fix/ftp-refresh-wait` | `4cef459` |  |
| #28 | `fix/filer-create-feedback` | `83d0a3e` |  |
| #29 | `fix/search-pending-query` | `7ae805f` |  |
| #30 | `fix/tab-focus-intent` | `a7f287e` |  |
| #31 | `fix/shortcut-reserved-owner` | `3a41158` |  |
| #32 | `feat/git-workspace` | `92120d7` |  |
| #33 | `fix/plan-window-assertion` | `93375d3` |  |
| #34 | `fix/filer-rename-feedback` | `8e420bd` |  |
| #35 | `fix/search-pending-direction` | `c858b4c` |  |
| #36 | `fix/git-workspace-ux` | `765bcf7` |  |

恢复已删 head 分支：`git branch <分支名> <head 提交>`。GitHub 也保留每个 PR 的 `refs/pull/<编号>/head`，可 `git fetch origin pull/<编号>/head` 取回。

GitHub 事件流中可见 2026-11-22 对其中 18 个 head 分支的删除记录（`fix/ftp-child-drop-preflight`、`fix/ftp-delete-feedback` 各两条），其余 12 个未见记录；事件流不完整，远端现状以 `git ls-remote` 为准。

上一节记为已推送到 `origin` 的四个 `archive/2026-11-16/*` 远端引用现已不在远端：事件流可见 `cold-history-agent-stability`、`gpui-rewrite`、`rewrite-by-feature` 于 2026-11-24 20:53（北京时间）被删除；`spike-p2p-term` 未见删除记录，但同样不在远端。

### 本地归档分支

七个本机归档分支逐条核对后，都没有 main 之外需要保留的内容，本轮删除本机引用。删除前把它们相对 `origin/main`、`upstream/main` 的独有对象打成 bundle：`.tmp/records/archive-branches-20261127/edgeTerm-archive-20261127.bundle`，8920323 字节，SHA-256 `0cf282ed2fcb0540a2d8e65213a852b4897eab5b43b6624150309832e5f80f7d`，依赖 main 上的四个基线提交（`033c6dfe`、`3e6e3573`、`392718ed`、`492680bf`）；同目录的 `refs-before-delete.txt` 记有删除前的七个引用。bundle 是本机文件，不是远端备份；`.tmp/` 被忽略，清理该目录前需另行保存。

| 归档分支 | 删除前 tip | 核对结果 |
| --- | --- | --- |
| `archive/2026-10-23/flow181` | `cec0f9e6` | 19 个提交的 patch-id 均在 main 有等效项；tip 文件树与 main `bf5f6d8` 相同 |
| `archive/2026-10-23/by-feature` | `c588c739` | tip 文件树与 main `c2f6d51` 相同，不同的只有中间历史 |
| `archive/2026-10-23/pre-resplit` | `7f670bd3` | 快照内容经重拆进入 main；按行比对，未在当前 main 找到的只有一个旧 agent 计划文件（31 行）和分布在 13 个文件里的 23 行零散改动 |
| `archive/2026-11-16/rewrite-by-feature` | `f73bad9e` | 是 `archive/2026-10-23/by-feature` 的祖先；tip 文件树与 main `5f1d540` 相同 |
| `archive/2026-11-16/cold-history-agent-stability` | `c136a842` | PR #2 的 head，9 个提交可由 `refs/pull/2/head` 取回；`git merge-tree` 对当前 main 有 9 个文件冲突，冷历史的后续修复已在 main 另行提交 |
| `archive/2026-11-16/gpui-rewrite` | `c48a98d0` | 上游 `gpui-rewrite` 仍在，tip 相同 |
| `archive/2026-11-16/spike-p2p-term` | `9236632c` | 上游 `spike/p2p-term` 仍在，tip 相同 |

删除后曾从 bundle 把七个分支取回临时命名空间，tip 与删除前逐一相同，随后删除临时引用。恢复命令：`git fetch .tmp/records/archive-branches-20261127/edgeTerm-archive-20261127.bundle '+refs/heads/archive/*:refs/heads/archive/*'`。本页 2026-10-23 一节里用 `git branch -m` 改回归档名的做法自此不再适用。

### 其他核对

- 标签：本分支 21 个自有标签中，`v1.6.2` 仍只在本地（见发布索引的 1.6.2 构建记录），其余 20 个与远端一致；本地独有的另有 `v1.0.1`–`v1.0.8` 上游标签。
- 上游：`upstream/main` 为 `0015880`（1.0.8），落后的 26 个提交处置均已记入[上游移植记录](upstream-ports.zh-CN.md)，没有新增。
- 本机残留：2026-11-16 的 stash（`codex/upstream-ports-20261116` 上的上游复核草稿，内容已被主线定稿取代）导出为 `.tmp/stash-20261116-upstream-review.patch` 后丢弃；8 个 `refs/codex/turn-diffs/checkpoints/*`（指向 tree 对象）已删除，清单在 `.tmp/codex-checkpoint-refs-20261127.txt`。

## 后续规则

2026-10-26 发布补记：从当时主线 `8c663d0` 建立 `codex/release-1.3.0` 准备版本；6 个未推送提交逐个通过类型及提交规范检查后，`main` 从远端 `66297b8` 快进推送到 `dd012ba965c857c0a1dc2bcb25584887640f4c22`。1.3.0 的源码标签固定在该版本提交，后续发布索引通过新的文档提交补充，不移动标签或替换已公开附件。没有改写公开主线、修改旧发布或清理上表中的归档及实验分支。此补记不将 2026-10-23 的远端分支快照改写成实时清单。

1. 保留已公开提交、标签和发布包。只在未发布且不被其他工作依赖的分支上整理提交；旧历史的错误用新增说明或修复提交纠正。
2. 从当前 main 创建 `codex/<topic>` 短期工作分支。一项行为连同必要测试与说明形成可独立检查的提交；合入前执行 R8–R10。避免把多个无关工作区改动封成一个正式“baseline”提交。
3. 已合入分支确认祖先关系、工作树占用及独有内容后清理引用；有价值但未合入的历史先归档并写明 tip。分支改名不等于完成了功能迁移。
4. 给上游贡献时，从所需上游基线单独整理改动和依赖，不携带本分支完整发布历史；直接移植或适配都记录来源，见[上游移植记录](upstream-ports.zh-CN.md)。
5. 正式版本、附件和发布说明按[发布索引](releases.zh-CN.md)维护；上游下载与文档保留明确标识，当前发行入口指向本仓库。
