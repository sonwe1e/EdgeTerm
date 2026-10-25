# 代码风格与开发调试

代码排版由仓库内的工具配置决定。目标是让一个操作、一个分支和一组 UI 属性容易定位，
并让保存文件、命令行检查和 CI 使用一致的格式。

## 格式规则与范围

| 文件 | 约定 | 入口 |
| --- | --- | --- |
| TypeScript、TSX、JavaScript | 2 空格、双引号、分号、尾逗号；100 列参考宽度 | Biome |
| CSS | 2 空格，每条声明单独一行；保留选择器、声明和导入顺序 | Biome |
| 工具配置 JSON | 2 空格；结构与换行由格式化器决定 | Biome |
| Rust | 4 空格，沿用 rustfmt 默认规则 | Cargo fmt |
| PowerShell | 4 空格，保留现有脚本习惯 | 编辑器／人工整理 |
| Markdown | 保留表达段落与硬换行所需的空白 | 编辑器／人工整理 |

Biome 的范围是 `src/`、`scripts/` 中支持的源码、根目录 TS/MJS 配置，以及
`biome.json`、`package.json`、`tsconfig*.json` 和共享 VS Code JSON 设置。
`src/bindings.ts` 由 Tauri Specta 生成，排除自动格式化，仍参与原有类型与 lint 检查；
更新契约使用 `./dev.ps1 bindings`，核对使用 `./dev.ps1 check:bindings`。
锁文件、构建输出、临时目录和第三方资源不属于手工排版范围。

100 列是自动换行的参考值，字符串、URL 和无法安全拆开的表达式可能更长。
不要为凑宽度改写用户可见文本、协议内容、测试夹具或模板字符串。
格式化命令不执行 lint 修复或导入排序；CSS 的层叠顺序继续由源码控制。

## 日常命令

从仓库根目录顺序运行。Windows 使用以下受管入口，Node、Rust、MSVC 的选择与资源预算
见[构建环境](build-environment.zh-CN.md)。

```powershell
./dev.ps1 doctor

# 格式化整个受管前端／脚本范围，或仅格式化本次修改的文件。
./dev.ps1 format
./dev.ps1 format src/workbench/HostStrip.tsx

# 只检查，不写入。
./dev.ps1 format:check
./dev.ps1 lint
./dev.ps1 typecheck

# Rust 使用自己的格式化器。
./dev.ps1 cargo fmt --manifest-path src-tauri/Cargo.toml
./dev.ps1 cargo fmt --manifest-path src-tauri/Cargo.toml -- --check

# 按改动运行测试，必要时构建。
./dev.ps1 test src/fileSort.test.ts
./dev.ps1 build
git diff --check
```

Node/npm 已在 PATH 时，可用 `npm run format`、`npm run format:check`，单文件写作
`npm run format -- src/workbench/HostStrip.tsx`。这些命令走相同的受管入口。
CI 分别检查 Biome 格式与 Rust 格式。日常功能修改只格式化相关文件，便于评审。

## 编辑器

`.editorconfig` 定义 UTF-8、LF、末尾换行和各语言缩进。VS Code 的共享设置位于
`.vscode/settings.json`，推荐扩展位于 `.vscode/extensions.json`；安装推荐的 Biome
和 rust-analyzer 后，相关语言保存时按项目规则格式化。其他本地 VS Code 配置仍被忽略。
其他编辑器可启用 EditorConfig 并调用上述命令。

前端格式以 `biome.json` 为准，避免同时让多个格式化器接管同一种语言。
编辑器的构建、测试及完整 Cargo 检查也应使用受管命令；扩展自行启动的检查不会自动
获得项目任务的 CPU 预算。保存时格式化不是类型检查或行为测试。

## 阅读和调试入口

| 排查对象 | 推荐阅读顺序 |
| --- | --- |
| 应用与终端交互 | `src/App.tsx` → `src/components/` → `src/actions.ts`、`src/store*.ts` |
| 终端输入、输出和渲染 | `src/terminal.ts` → 对应 `src/terminal*.ts` → `src-tauri/src/session/` |
| IPC 请求与错误 | `src/api.ts`／`src/workbench/api.ts` → `src/bindings.ts`（只读）→ `src-tauri/src/commands/` |
| 文件传输 | `src/fileTransfers.ts` → `src/components/TransferCenter.tsx` → `src-tauri/src/file_transfer/` |
| 工作台与运行记录 | `src/workbench/Workbench.tsx` → `store.ts`、对应组件 → `src-tauri/src/workspace.rs`、`project.rs` |
| 样式与布局 | `src/styles.css` 的导入顺序 → `src/styles/` 中对应领域样式 |
| 错误日志 | `src/diagnostics.ts` → `src-tauri/src/diagnostics.rs`、`error.rs` |

前端布局与状态调试可运行 `./dev.ps1 dev`，在浏览器开发者工具的 Sources 中对源文件
设置断点；纯浏览器没有 Tauri 原生 IPC，需要隔离的测试夹具。
需要本地终端、真实文件或 SSH 等原生能力时运行 `./dev.ps1 tauri:dev`。
应用菜单提供“打开日志目录”和“导出诊断”；后端日志的 request id 可关联同一操作的阶段。
真实数据与连接测试的条件见[测试与验收方案](test-plan.zh-CN.md)。

先停止 dev 服务，再启动另一项受管检查。单元测试适合状态和纯逻辑，
`./dev.ps1 test:browser` 用于实际浏览器布局与交互；浏览器夹具不等于真实桌面／服务器验证。

## 保持可读性

- 按依赖方向阅读和组织：类型与常量、辅助函数、主组件或公开函数；保留有意义的领域分组。
- TypeScript 函数和变量沿用 camelCase，组件和类型用 PascalCase；Rust 沿用 snake_case。
- 一个语句单独一行；较长的事件处理器展开为块，便于在副作用前后设置断点。
- 注释说明约束、原因和失败边界，避免逐行重复代码；保留协议、清理和并发相关说明。
- JSX 的属性和子节点按格式化器换行；CSS 一条声明一行，关联规则保持相邻。
- 格式整理与逻辑重构分开评审；命名、模块拆分、状态流或错误处理的调整需要独立理由和验证。

提交与验收仍遵循[工程规范](engineering-standards.zh-CN.md)。
