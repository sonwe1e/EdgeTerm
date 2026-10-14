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

以上是模拟延迟基准，报告 build profile、RTT、文件数/大小、并发和 durable。不能把默认关闭 fsync 前后的时间差标成纯性能提升。真实跳板机用例需要配置 `EDGETERM_TEST_JUMP` 等测试凭据，只使用专用测试环境；不将其加入无条件本地命令。

## 7. 提交验收记录

每个提交或修复记录：`问题/评审项 → 当前行为 → 回归用例 → 旧实现失败 → 新实现结果 → 未验证范围`。任何未修复的已知缺陷明确标注；保留原始测试失败原因，不在总结中用“全部通过”抹掉缺配置、历史格式检查失败或平台缺口。

历史 `scripts/cdp-*.cjs` 和 Win32 `.ps1` 是人工诊断工具，见 [脚本说明](../scripts/README.md)，不可代替上述回归矩阵。

## 8. 提交与拆分验收

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
