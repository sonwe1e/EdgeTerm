# EdgeTerm 文档索引

本目录同时存放**现行规范**和**按日期的历史记录**。两者维护方式不同：

- **现行规范**随代码一起维护，行为改变时必须同步更新，并出现在本索引的「现行规范」表里。
- **带日期的记录**是当时基线上的快照（审计、评审、方案、诊断），保留原始结论与失败证据，不随代码回改；发现它们与现状不符时，写新的记录并在本索引标注「历史」。
- 主题相同的新文档继续用旧记录时，以最新日期的那份为准，并在这里注明取代关系。

## 命名与归档约定

| 类型 | 位置与命名 | 例子 |
| --- | --- | --- |
| 现行规范 | `docs/<主题>.zh-CN.md` | `engineering-standards.zh-CN.md` |
| 带日期的记录 | `docs/<主题>-YYYY-MM-DD.zh-CN.md` | `audit-2026-10-14.zh-CN.md` |
| 发布说明 | `docs/release-<版本>.zh-CN.md` | `release-1.5.1.zh-CN.md` |
| 团队记录 | `docs/team/` | `team/STATE.md` |
| 专题设计 | `docs/ui-refinement/` 等子目录 | `ui-refinement/visual-spec.md` |
| 站点资源 | `docs/*.html`、`docs/*.css`、`docs/*.png`、`docs/*.webp` | `index.html` |

新增文档后在本索引登记。新文档的链接使用**相对本文件的路径**。带日期的旧记录里有用仓库根目录书写的路径（如 `src/terminal.ts`）和当时行号锚点，按历史原样保留：阅读时把它们当作“相对仓库根目录的路径”即可，行号以当前代码为准。

## 现行规范

| 文档 | 用途 |
| --- | --- |
| [engineering-standards.zh-CN.md](engineering-standards.zh-CN.md) | 开发与验收规则（提交拆分、每提交类型检查、`fix:`/`perf:` 的必填证据） |
| [test-plan.zh-CN.md](test-plan.zh-CN.md) | 测试与验收方案：状态只能是通过/失败/未运行，缺环境不算通过 |
| [code-style.zh-CN.md](code-style.zh-CN.md) | 代码风格、编辑器与调试约定 |
| [build-environment.zh-CN.md](build-environment.zh-CN.md) | 构建入口、资源预算、受限主机上的降级行为、工具来源 |
| [ipc-contracts.zh-CN.md](ipc-contracts.zh-CN.md) | specta/tauri-specta 生成的 IPC 契约与手写绑定的边界 |
| [history-and-branches.zh-CN.md](history-and-branches.zh-CN.md) | 分支与已发布历史的维护规则和归档做法 |
| [releases.zh-CN.md](releases.zh-CN.md) | 历史发布索引与各版本构建、校验记录 |
| [upstream-ports.zh-CN.md](upstream-ports.zh-CN.md) | 上游提交的处置记录（直接移植/改造/已有能力/不采纳） |

## 团队记录

| 文档 | 用途 |
| --- | --- |
| [team/STATE.md](team/STATE.md) | 当前阶段完成项、验证结果、未验证边界与下一步 |
| [team/DECISIONS.md](team/DECISIONS.md) | 关键决策、替代方案与重新评估条件 |
| [team/LEARNINGS.md](team/LEARNINGS.md) | 已复现的缺陷经验、方法边界、不算缺陷的疑点 |

## 发布说明

| 文档 | 版本 |
| --- | --- |
| [release-1.3.0.zh-CN.md](release-1.3.0.zh-CN.md) | 1.3.0 |
| [release-1.4.0.zh-CN.md](release-1.4.0.zh-CN.md) | 1.4.0 |
| [release-1.5.0.zh-CN.md](release-1.5.0.zh-CN.md) | 1.5.0 |
| [release-1.5.1.zh-CN.md](release-1.5.1.zh-CN.md) | 1.5.1（现行最新） |

## 专题与历史记录

| 文档 | 内容 | 状态 |
| --- | --- | --- |
| [audit-2026-10-14.zh-CN.md](audit-2026-10-14.zh-CN.md) | PR #91 起的逐提交复审 | 历史 |
| [improvement-plan-2026-10-15.zh-CN.md](improvement-plan-2026-10-15.zh-CN.md) | 九项审查结论的改造方案修订 | 历史 |
| [experience-guide-2026-10-16.zh-CN.md](experience-guide-2026-10-16.zh-CN.md) | 改造后的体验与验收记录 | 历史 |
| [maintainability-and-file-diff-2026-10-16.zh-CN.md](maintainability-and-file-diff-2026-10-16.zh-CN.md) | 长代码维护性检查与文件比较改进 | 历史 |
| [passwordless-ssh-plan-2026-10-16.zh-CN.md](passwordless-ssh-plan-2026-10-16.zh-CN.md) | 免密登录专项的阶段记录 | 历史 |
| [defect-fixes-2026-10-17.zh-CN.md](defect-fixes-2026-10-17.zh-CN.md) | 三项成熟度缺陷修复与复验 | 历史 |
| [ui-interaction-review-2026-10-19.zh-CN.md](ui-interaction-review-2026-10-19.zh-CN.md) | 界面、字体与菜单交互评审 | 历史 |
| [ui-ux-audit-2026-10-19.zh-CN.md](ui-ux-audit-2026-10-19.zh-CN.md) | 界面、交互与默认值审计（含「仍未修复」清单） | 历史 |
| [compiler-experiment.zh-CN.md](compiler-experiment.zh-CN.md) | React Compiler 对照实验（默认关闭） | 现行开关说明 |
| [terminal-performance.zh-CN.md](terminal-performance.zh-CN.md) | OpenCode 多标签性能测试记录 | 记录 |
| [sidebar-freeze-diagnostics.zh-CN.md](sidebar-freeze-diagnostics.zh-CN.md) | 侧栏拖拽卡死的诊断与修复边界 | 记录 |
| [terminal-input-fixes.zh-CN.md](terminal-input-fixes.zh-CN.md) | 终端输入修复：Pi 滚动、标签切换、Alt 菜单 | 记录 |
| [filer-ui-audit.zh-CN.md](filer-ui-audit.zh-CN.md) | Filer 面板 UI 审查（第一轮） | 历史 |
| [filer-ui-audit-round2.zh-CN.md](filer-ui-audit-round2.zh-CN.md) | Filer UI 审查第二轮汇总 | 历史 |
| [roadmap-scrollback-and-bulk-transfer.zh-CN.md](roadmap-scrollback-and-bulk-transfer.zh-CN.md) | 长历史与批量小文件传输的路线图 | 规划稿 |

## 站点资源

`index.html`、`tutorial.html`、`feature-audit.zh-CN.html`、`style.css`、`lang.js`、`logo*.png`、`icon.png`、`screenshot-*.png/.webp` 是网站与 README 用的页面和图片；`ui-refinement/` 存放界面重构的视觉规范、交互规范、工程说明与计划。改网站时同时检查 README 里的图片引用。
