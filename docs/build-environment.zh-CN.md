# 构建环境与资源预算

日常构建、测试和诊断统一经过项目入口，避免每个工具按整机 CPU 数自行扩张，
也避免从 IDE／agent 临时注入的 PATH 中碰运气选择编译工具。

```powershell
./dev.ps1 doctor
./dev.ps1 typecheck
./dev.ps1 test
./dev.ps1 build
./dev.ps1 test:rust
./dev.ps1 tauri:dev
./dev.ps1 tauri:build
```

已有 `npm test`、`npm run build`、`npm run tauri:dev` 等命令也经过相同入口。
`dev.ps1` 直接读取持久化的用户／系统 PATH，因此刚安装工具、旧终端尚未刷新
环境，或者当前终端没有 Node/npm 时，也可以启动。PowerShell 执行策略阻止
脚本时可使用 `powershell -NoProfile -ExecutionPolicy Bypass -File .\dev.ps1 doctor`；
该选项只作用于此进程。

## 资源如何受控

- Windows：整棵子进程树继承同一 CPU affinity，最多使用 4 个逻辑处理器，
  小机器最多取逻辑处理器的一半（至少 1 个），使用 BelowNormal 优先级。
  这也覆盖单个 rustc、链接器和 esbuild 内部的线程，而不仅是 Cargo 进程数。
  单逻辑处理器机器只能降低优先级，无法额外预留一个处理器。
- Cargo 同时编译 2 个任务，Rust 测试线程 2，CMake/Go/Rayon/libuv 并行预算 2。
- 每个 Node 子进程的 V8 old-space 堆预算为 3072 MiB，保留其他 NODE_OPTIONS。
  这约束 JS 堆，避免测试 worker 各自按整机内存扩张；不等于进程总内存上限。
- Vitest 默认最多 2 个 worker，显式 concurrent 测试并发 2；浏览器测试文件串行运行。
  配置本身也保护直接运行的 Vitest。根目录 `.cargo/config.toml` 对从仓库内
  直接运行的 Cargo 提供 jobs=2 的后备默认。
- Windows 登录会话内只允许一个独立的受管任务；另一任务立即报错，不排队堆积。
  锁覆盖不同 checkout/worktree，并由操作系统在退出／崩溃后释放。
  Tauri 的 `beforeDevCommand` / `beforeBuildCommand` 继承父任务，允许嵌套执行。
  长期运行的 dev 服务也占用预算；运行其他检查前先 Ctrl+C 停止服务。
- Vite 不监听 `.tmp/`、`artifacts/` 和 Rust 目录，避免构建产物、诊断输出和
  临时 worktree 导致无关文件监听负担。
- Biome 强制跳过 `.tmp/`、`artifacts/` 和 Rust target，不发现这些目录内的
  嵌套配置，避免临时 worktree／中断测试留下的配置扩大扫描范围。

这些数值是优先保证桌面可用性的保守默认，代价是冷构建和全量测试会更慢。
没有修改 release 的 LTO／优化级别，也没有通过清理 target 强迫重编译。
首次切换到明确指定的 MSVC linker 时，Cargo 可能重建依赖；后续统一使用此入口
复用同一套编译参数和 target 缓存，不需要为排查 PATH 反复清理构建目录。
CPU affinity 不是固定的整机占用百分比承诺；逻辑处理器的性能、系统负载各不相同。
并发限制可降低同时驻留的任务数量，但不是内存或磁盘 I/O 的硬配额。

## 工具从哪里来

1. Windows Node 从持久化的机器 PATH、用户 PATH 按顺序选择，不优先使用
   agent 注入的运行时。特殊安装可显式指定绝对路径：
   `$env:EDGETERM_NODE = 'D:\Tools\nodejs\node.exe'`。
   该目录必须同时带有 npm。入口和所有本地 JS CLI 使用同一个 Node；支持
   Node 20.19+、22.12+ 或 24+（与当前 Vite/Vitest 要求一致），推荐安装完整的 Node LTS。
   CI 的 npm 入口保留 CI 已配置的 Node（例如 setup-node 提供的版本），无需修改
   runner 注册表；显式 `EDGETERM_NODE` 仍优先。
2. Rust 使用 `CARGO_HOME`（未设置时为 `%USERPROFILE%\.cargo`）内的 rustup，
   遵从项目 rustup override／toolchain 选择，解析 Cargo 和 rustc 的实际绝对路径。
   Windows 当前入口支持 x64 MSVC 工具链；GNU 或其他目标会明确报错。
   冲突的 `RUSTC` 会报错，而不会悄悄混用另一套编译器。
3. 使用 VS Installer 的 `vswhere` 找到最新的、含 C++ x64 工具的安装，通过
   官方 `VsDevCmd.bat` 加载 PATH、INCLUDE、LIB 等完整环境。检查 `cl`、`link`
   来自选定 MSVC，`rc`、`mt` 来自 Windows SDK，并为 Cargo 指定实际 MSVC linker。
4. 优先放入已安装的机器／用户 PATH，再加入原进程 PATH 作为后备；MSVC 和
   选定 Node/Rust 的目录放在最前面。所有修正仅作用于任务进程及其子进程，
   不修改全局 PATH，不把某个版本的 MSVC 目录永久写进系统设置。

缺失 Rust 时安装 rustup；缺失 MSVC/SDK 时安装 Visual Studio Build Tools 的
“使用 C++ 的桌面开发”和 Windows SDK。缺失 Node 时安装 Node LTS。
`doctor` 会显示精确路径、版本、CPU mask 和可用内存；失败信息指向缺失组件。
入口没有安装／更新工具链的步骤，也不会隐式执行 npm install。

## 常用扩展命令

```powershell
./dev.ps1 test src/fileSort.test.ts
./dev.ps1 test:browser
./dev.ps1 cargo check --locked --manifest-path src-tauri/Cargo.toml
./dev.ps1 cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
./dev.ps1 script scripts/check-review-ui.mjs
```

命令参数通过参数数组传递，不拼成 shell 命令；带空格的参数按 PowerShell 的
普通引号规则传入。`npm run cargo -- ...` 是相同的 Cargo 入口。

边界：直接运行 `cargo`、`npx`、VS Code 自己的任务或应用内任意项目命令，不会
进入 Windows 资源隔离和工具解析流程；应改用以上入口。已经启动的进程不会被
追溯修改。Linux/macOS 使用同一 Node 入口和并行预算，但不具备这里的 Windows
affinity、互斥锁或 MSVC 初始化；其工具链沿用当前环境。没有对无关程序限速或终止。
手动传入 Cargo `-j`、Vitest `--maxWorkers` 等参数可覆盖工具默认并发，日常检查
不要提高这些参数。性能对照必须让基线和候选使用相同预算，并记录预算；受限的
dev 应用和诊断脚本不能直接与过去不受限的测试成绩比较。

依据：[Cargo jobs 默认和配置](https://doc.rust-lang.org/stable/cargo/reference/config.html)、
[Windows 子进程继承 CPU affinity](https://learn.microsoft.com/en-us/windows/win32/procthread/inheritance)。
