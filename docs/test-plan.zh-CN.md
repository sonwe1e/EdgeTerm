# 测试与验收方案

配合[工程规范](engineering-standards.zh-CN.md)使用。每项结果填写基线/候选提交、日期、环境、命令、预期、实际和证据路径。测试状态只能是通过、失败、未运行；缺环境不能记作通过。

## 1. 基础检查

```powershell
npm ci
npm test
npm run build
cargo test --manifest-path src-tauri/Cargo.toml --lib
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
git diff --check
```

若 Rust 未在 PATH，使用已安装 cargo 的绝对路径。对格式/编译告警先与审查基线比较；记录继承的问题，不靠改动无关文件隐藏差异。构建通过不等于完成 Tauri 安装包或所有平台运行验证。

## SSH 工作流与传输扩展

普通检查包括 `src/fileTransfers.test.ts`、`src/transferSettings.test.ts`、`src/components/FileDiffDialog.test.ts`、`src/components/ForwardCenter.test.ts`、`src/components/ResourceMonitorBar.test.ts`、`src/components/SshReuseSetting.test.ts`、`src/terminalFlow.test.ts` 及 Rust 的 `file_transfer`、`file_diff`、`port_forward`、`resource_monitor`、`session::reuse` 模块。检查真实入口、取消后的旧响应、偏好导入/重置、字节和文本结果以及资源归属。

实际服务器测试位于 `file_transfer/real_tests.rs` 和各功能模块的 `real_*` 用例中，默认 ignored。它们仅供专用可清理服务使用：SSH 环境为 `EDGETERM_REAL_SSH_ADDR/USER/KEY/ROOT`，FTP 为 `EDGETERM_REAL_FTP_ADDR/USER/PASS/ROOT`。SSH ROOT 是测试服务器自己的目录，包含其 `sshd.log`，供实际认证次数核对；host key 使用每个测试自己的临时文件。FTP ROOT 必须在测试 jail 内。真实 GPU 用例需要 Linux 主机及 NVIDIA 查询能力。不要使用生产账号或目录；环境未配置、用例被过滤或 ignored 都不算通过。

```powershell
# 配置以上专用服务环境后运行，选择本轮真实功能用例。
cargo test --manifest-path src-tauri/Cargo.toml --lib real_ -- --ignored --nocapture --test-threads=1 --skip benchmark_real_server_folder_upload
```

上面的 skip 对应旧手动性能 benchmark；它需要单独的 `EDGETERM_BENCH_*` 源目录与远端目标配置，应单独运行并记录，不能混进验收后当作已有通过。

真实用例核对 SFTP/FTP 内容、冻结计划重建、源变化拒绝、恢复读回限速、两个运行任务与队列取消；diff 两侧只读内容；L/R TCP 双向传输、拒绝、owner停止、共享兄弟和真实断线后的监听释放；复用的认证次数、密钥在认证期间变化、失效重建；Linux/NVIDIA指标、首样未知、换传输重置、超时及输出上限后兄弟exec健康。Tauri `feature_ipc_tests` 使用 MockRuntime 分派实际生产命令到真实SSH引擎及隔离Store，验证参数/返回/取消/closed-owner边界；它不能替代桌面WebView端到端测试。

浏览器验收使用生产 React/CSS 和真实 xterm，但模拟 IPC 数据。应在实际状态栏容器检查新控件，覆盖应用最小宽度900px、长错误、弹层切换/Escape、明暗主题；大队列/恢复/失败文件及diff首尾可达、DOM有界；字节碎片保序与EOF尾批；隐藏/恢复的实际render帧。记录浏览器、源快照和工作负载，不把单次浏览器时延或合成多GPU当真实部署性能/多GPU硬件验证。

按R10在一次性worktree中破坏相关保护：限速扣费、journal归属、字节相等判断、认证身份、guest计数、迟到资源释放、owner停止、输出合批、隐藏采样、快照revision、转发入口owner、传输身份及虚拟化阈值。先运行同快照正常控制，再确认对应行为用例实际失败；编译失败不算检出。保留日志与源码哈希，清理worktree，禁止链接node_modules。

## 2. PR #91：排序、布局与设置

| 测试 | 步骤 | 通过标准 |
|---|---|---|
| 默认排序 | 清掉偏好，提供后端顺序 `file10,file2` | 未点击时顺序原样保留 |
| 显式排序 | 点击 Name 降序再升序，导出/导入或重挂载 | 显式自然升序为 `file2,file10`；不与默认状态混淆 |
| 多面板 | 同时挂载 Filer/FTP 本地/FTP 远端，点击共同列 | 另两个面板同步，箭头使用 Codicon |
| 恢复/导入 | 面板保持打开，修改偏好后 reset/import | UI 立即更新；新传输参数与显示一致 |
| 存储兼容 | 缺失、损坏 JSON、非法 key/direction、旧对象缺新字段 | 合法旧字段保留，其余按默认或忽略规则处理 |
| 布局 | 1280、800、799、700px；明暗主题；不同面板字号 | Name 左对齐，数值/日期右对齐；窄屏标题/行均隐藏 Modified |
| 虚拟化 | 10000 项滚到底，捕获行滚出视区，切换目录/排序 | 渲染量有界，最后一项可达，行距正确，释放捕获无丢失 |

自动化入口：`src/fileSort.test.ts`、`src/storeSettings.test.ts`、`src/fileTransfers.test.ts`、`src/components/VirtualFileRows.test.ts`、以下独立浏览器脚本。

```powershell
node scripts/check-review-ui.mjs
node scripts/check-file-performance.mjs
```

脚本使用 Playwright，可从本地安装或 `NODE_PATH` 提供；默认运行已安装的 Edge，可用 `PERF_BROWSER` 指定 Playwright channel。它们启动自己的 Vite/浏览器，不连接正在使用的 EdgeTerm。输出在 `artifacts/performance/`；需查看截图，不能只看退出码。

## 3. PR #92：拖拽

- 本地和远端分别测试同侧文件→目录、目录→目录、面板背景：零确认框、零 rename、零 transfer。
- 双向跨栏复制分别落在背景/目录行；同名文件弹 Replace，同名目录弹 Merge，不兼容类型拒绝。检查调用的实际目标路径。
- 长列表边缘停留：列表持续滚动、命中高亮随滚动变化；松手使用当前位置；Escape/pointercancel/隐藏/卸载后不再滚动或执行操作。
- 浏览器 mock IPC 只验前端动作。真实本地、OpenSSH SFTP（有/无 posix-rename 扩展）、至少一种 FTP 服务另测实际内容和冲突后原文件保留。提交录屏时注明服务实现/版本。

## 4. PR #93：resize

- 真实 xterm normal buffer 覆盖小缓冲、大缓冲和 200 行阈值；分别测试横向、纵向、对角线连续拖动。
- 小缓冲立即变化；大缓冲每次行变化立即通过 onResize，列只在停止后 100ms 应用最终宽度。
- 8/16/40/80ms 事件间隔、拖回原宽度、排队后隐藏、显示后立即 fit、dispose 后无回调。
- 单元用例只替换布局测量，保留 xterm resize 和回调。入口：`src/terminalResize.test.ts`。
- 真实桌面补测：WebGL/DOM × 1/8 个标签 × 3000/20000 行 × 底部/侧面 splitter。保留 Performance trace、长任务/帧间隔、隐藏标签 resize 次数；检查提示符在行缩小时不被延迟裁切。
- 未复现原始窗口卡死时，描述为“实现了 resize 策略并通过行为验证”，不能宣称原始卡死根因已修复。

## 5. 输出、二进制传输与重连

- 原始 IPC：全部 0–255 字节、Unicode 路径、非零 typed-array offset、跨 chunk 的多字节字符；X/ZMODEM 的真实协议收发与回到普通终端输出。
- ACK：重复、越界、乱序、失败重试、EOF、关闭和新连接 token；隐藏终端也要确认解析。界限是 IPC 未消费字节，不是整个进程 RSS。
- 慢消费者达到窗口后暂停读；关闭仍能退出；串口背压时控制命令仍可处理。无硬件流控的真实串口另测，不能凭内存预算承诺不丢设备数据。
- Enter 重连：只允许已结束且锁定的会话；普通输入/粘贴不发到断开的后端；host-key 对话框和连接过程不重复发起连接。
- 本机 PTY 检查可独立执行：

```powershell
cargo test --manifest-path src-tauri/Cargo.toml --lib native_pty_output_survives_a_stalled_consumer -- --ignored --nocapture
```

## 6. 后台文件任务与恢复

| 故障/边界 | 必须验证 |
|---|---|
| 乱序写应答/短 DATA | 仅推进连续确认前缀；文件最终逐字节一致 |
| 零/非零检查点的旧 partial | 截断未确认尾部；已确认前缀被改则拒绝 |
| 一个 mkdir 与多个子目录同时失败 | drain 保留全部失败，父先子后重试；跨满 8 项窗口与末批都覆盖 |
| 写超时/暂停/取消/断线 | 不提前替换原文件；可恢复状态与清理结果一致 |
| rename 成功但应答丢失 | 重试核对结果，不再次破坏原文件；backup 只按所有权清理 |
| 原目标/源/partial 改变、目录或 symlink 冲突 | 明确失败，不把长度相等当作完整内容相等 |
| fsync 支持/不支持/拒绝 | 开关影响真实扩展请求；不支持的上传拒绝，下载不受影响 |
| FTP REST/APPE 拒绝 | 安全重传，读回校验恢复前缀，最终内容与大小匹配 |
| 多任务 | 同目标互斥、取消等待锁、切换/关闭标签、退避重试、手动 Retry、清理后 Dismiss |

入口：`src-tauri/src/file_transfer/*_tests.rs` 及模块内测试。真实服务器补测还应包括权限保留、低句柄限制、认证/MFA/跳板、离线清理和远程编辑保存。夹具对协议处理和文件系统持久性的简化必须写明。

```powershell
cargo test --manifest-path src-tauri/Cargo.toml --lib benchmark_ -- --ignored --nocapture
```

以上是模拟延迟基准，报告 build profile、RTT、文件数/大小、并发和 durable。不能把默认关闭 fsync 前后的时间差标成纯性能提升。真实跳板机用例需要配置 `EDGETERM_TEST_JUMP` 等测试凭据，只使用专用测试环境；跳板 fixture 应通过 `PermitOpen` 允许实际 SSH 目标并拒绝目标端口 1，负例须在 5 秒内收到真实拒绝，超时算失败。用例为每次握手显式注入临时 known_hosts，不依赖 Windows 上无效的 HOME 环境覆盖；不将其加入无条件本地命令。

## 7. 实验工作台

自动化入口：`src/workbench/model.test.ts`、`drafts.test.ts`、`fileTree.test.ts`、`session.test.ts`、`store.test.ts`、`workbench.browser.test.ts`、`editor.browser.test.ts`；Rust 的 `workspace::`、`project::` 与 `feature_ipc_tests::workspace_records_cross_ipc_and_keep_projects_isolated`。

| 测试 | 步骤 | 通过标准 |
|---|---|---|
| 三项目隔离 | 两台登录、同登录两个目录；分别打开同名文件并保存 | 文档 id、绝对路径、会话和服务器标签互不串用 |
| 实验归属 | 变体引用项目内基线；尝试引用其他项目的基线 | 后者被拒绝；删除基线后变体解除引用 |
| 运行归属 | 用项目 B 的实验为项目 A 记录运行；正常启动 | 前者被拒绝；运行记录保存服务器、实验、根目录和代码标识 |
| 草稿持久化 | 连续保存两份各 80 万字符的未保存内容；令写入失败；令删除失败 | 两份都保留，不因数量/字符预算淘汰；失败返回 `ok:false` 且旧草稿不变；删除失败时草稿仍可见 |
| 草稿恢复 | 基线哈希匹配 / 不匹配 / 来自其他服务器 | 分别恢复为未保存、冲突、不自动套用；草稿不被静默删除 |
| 关闭保护 | 磁盘写入失败时关闭有未保存内容的标签 | 关闭被拒绝，标签保留并显示“未写入本地”；只有显式“丢弃并关闭”才丢失内容 |
| 草稿迁移 | localStorage 中存在旧版草稿 | 首次启动迁入磁盘；全部成功才删除旧键，失败时旧键保留 |
| 保存冲突 | 服务器副本变化后保存 | 返回 `conflict`，保留草稿，显示重载/覆盖/继续编辑 |
| 保存并发 | 同一登录的两个会话对同一文件并发保存；不同端口/路径拼写 | 同一文件同键串行、第二次返回冲突；不同目标互不影响；`//`、`./`、`..` 归一后同键 |
| 写入不确定 | rename 失败或大小校验失败（真实服务器用例） | 返回 `uncertain`，临时/备份文件路径随错误返回，编辑器不标记为已保存 |
| 断线保存 | 关闭 SSH 会话后保存 | 不自动重连，文档保持未保存并报错 |
| 未同步启动 | 有未保存文档时启动运行；再勾选“仍然启动” | 默认拒绝并列出文件；确认后记录 `binding.unsynced` |
| 执行内容 | 留档模式与隔离模式各启动一次 | 记录 `executedFrom`、`isolated`、`snapshotVerified`；快照不完整时隔离启动被拒绝；链接失败时拒绝启动 |
| 环境失败 | 让 `conda activate` 指向不存在的环境 | 训练命令不执行，退出码无 `env_ok`，状态说明是环境失败 |
| 启动不确定 | 中断启动命令的返回（真实服务器用例） | 运行记录已存在且为 `unknown`；重试被拒绝；刷新后可确认 |
| 运行状态 | `sbatch` 0 退出、普通进程 0 退出、无退出码失联、用户停止 | 分别为已提交、完成、失联、停止；不自动启动 |
| 服务器漂移 | 修改 profile 的 host/port/user 后连接项目 | 拒绝连接并提示刷新项目身份 |
| 编辑器切换 | 编辑 A → 打开 B 并编辑 → 返回 A；检查撤销/重做、选区、滚动、焦点 | 历史、选区与阅读位置恢复；B 的编辑不出现在 A；返回后 Ctrl+Z 作用于 A |
| 同路径不同项目 | 两个项目打开同一相对路径，各自编辑后切换 | 两份文档历史、选区互不串用 |
| 重载后撤销 | 服务器内容替换当前文档后撤销 | 撤销不恢复替换前的文本（历史已重建） |
| 关闭后重开 | 关闭有编辑的标签再打开同一路径 | 不恢复已关闭文档的撤销历史 |
| 视图切换 | 编辑后切到终端视图再回工作台 | 文档历史仍在，不因整棵树卸载而丢失 |
| 布局 | 1440×900 明色主题、三项目、打开文件、运行中 | 项目/服务器身份、草稿入口、编辑器、文件树、执行内容、运行日志可见；无横向溢出；截图存 `artifacts/` |

真实服务器验证需要提供可清理的专用 SSH 环境以及插帧项目路径/命令；在拿到之前，上述结果只算前端与 IPC 夹具验证。浏览器测试使用模拟 IPC 和真实 CodeMirror/CSS，不证明 WebView2 行为。不得把本节的通过写成真实训练、GPU 或断线恢复已验证。

## 8. 提交验收记录

每个提交或修复记录：`问题/评审项 → 当前行为 → 回归用例 → 旧实现失败 → 新实现结果 → 未验证范围`。任何未修复的已知缺陷明确标注；保留原始测试失败原因，不在总结中用“全部通过”抹掉缺配置、历史格式检查失败或平台缺口。

历史 `scripts/cdp-*.cjs` 和 Win32 `.ps1` 是人工诊断工具，见 [脚本说明](../scripts/README.md)，不可代替上述回归矩阵。

## 9. 提交与拆分验收

对应工程规范 R8–R10。提 PR 前按顺序执行，`<base>` 为目标分支的合并基线（默认 `git merge-base main HEAD`）：

```powershell
git worktree list                                   # 只有主工作区
npm run check:commits -- <base>..HEAD --typecheck   # 逐提交 lint + tsc，无 ERROR
npm test
npm run build
cargo test --manifest-path src-tauri/Cargo.toml --lib
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
git diff --check
git worktree list                                   # 再次确认无残留；.tmp/ 为空或不存在
```

- `check:commits` 的 ERROR：前缀、标题长度、`perf:` 缺 `Measured:`/`Unmeasured:`、`fix:` 缺 `Tests:`、某提交单独 typecheck 失败。WARN：绝对化词语、规模超限、前端/后端/文档同时修改、body 中的 “Also …”、docs 提交改代码、评审跟进提交。WARN 不阻断，但要在 PR 中逐条处理或说明。
- `--typecheck` 只在 `.tmp/commit-check/<short-sha>` 下建临时 worktree，使用主仓库的 `node_modules/typescript`，结束（含失败）后移除并 prune。上次异常中断留下目录时脚本拒绝运行；确认无用后加 `--clean-stale`，它只删除登记过的 worktree。
- typecheck 只覆盖前端 `tsconfig.json`；后端提交的逐个 `cargo test` 目前需手工执行。
- 重排、拆分、squash 后对整个范围重跑。

变异抽查记录模板（每条行为声明一行；在 `.tmp/mutate/<name>` 一次性 worktree 中做，见 R10）：

| 行为声明 | 变异（一行生产代码改动） | 应失败的测试 | 结果（失败=通过/存活/未运行） | 备注 |
|---|---|---|---|---|
| 例：断开会话按 Enter 重连 | `actions.ts` 中不传入重连回调 | `src/reconnect.test.ts` | 存活 | 测试直接调用私有 `handleData` |
| 例：同侧 drop 不执行操作 | FtpPane 中移除同侧判断 | `src/paneDrop.test.ts` | 存活 | 只测了比较函数 |
| | | | | |

存活或未运行的变异必须写进 PR 描述的未验证范围。
