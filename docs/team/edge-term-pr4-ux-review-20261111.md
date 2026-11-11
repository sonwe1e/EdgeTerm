# EdgeTerm PR #4 后续：高频操作体验复核（2026-11-11）

## 范围和结论

- 原审查基线：PR #4，`627f9581a68c661356980ebbd9244dae5bbdef2c`。PR #4 已于 2026-11-10 合并关闭，不再修改其旧分支。
- 本轮交付基线：2026-11-11 的 `main`，`e4e6ef462a96bf203eb6d65a3fd1b3fb30a91271`；保留三个分离的修复/文档提交，创建新的 Draft PR 接受 CI 验证。
- 用户授权：独立体验官审查、实施高频操作与局部布局的小改动；重大取舍另行确认。
- 守门条件：先 Chromium 可操作体验，后 Windows Tauri/WebView2 真机验收；不得擅自合并或发布。
- 本轮定位两个有确定代码路径和失败回归的高频缺陷，做最小修复。**代码测试不能替代真实交互体验。**

## Team 独立观察与交叉验证

| 角色 | 独立检查场景 | 发现及本轮处置 |
| --- | --- | --- |
| 文件体验官 | Windows 文件拖入 Filer、失败后的恢复路径 | 失败进度条实际显示 Retry 却未绑定点击；已修复并补失败→成功 UI 回归 |
| 多会话体验官 | 3–4 SSH、Sender 手动群发与定时群发 | 手动 All 错误包含断线/连接中/出错会话；已统一 eligible 规则，并让两种 Sender 视图的数量准确 |
| 终端/TUI 体验官 | 查找、分屏、OpenCode/Pi、粘贴 | 查找层固定在整个工作区上沿、窄窗可能拥挤；真实渲染尚未复现，暂不动布局 |
| 视觉体验官 | 900px 三栏与典型高频按钮 | 终端剩余空间可能过窄；未取得可操作的 Chromium 截图，不据此做全局改版 |
| 交叉复核 | Filer Retry 与 Sender 代码 diff/test | Filer 从真实按钮走失败再成功；Sender eligibility 与定时发送一致；指出零目标文案误导并纳入小修 |

## 已实施的局部修复

1. `FilerPanel.tsx`：失败传输的 Retry 按钮使用已有 `retryTransfer`。新增回归从 Webview 拖放事件走到复制失败与按钮点击，核实仍写入原目标目录、完成状态出现、错误/Retry 消失、目录仍可刷新。
2. `useSenderSend.ts`、`SenderPanel.tsx`、`SenderQuickbar.tsx`：手动 All 只发送至 `connected` 且非文件会话；完整与紧凑两种显示使用同一 eligible 数量。Current 模式保持原行为。
3. 零 eligible 的 All 选择提供明确反馈，避免与“没有选择会话”混淆；不盲目禁用 Run，因为用户需要知道原因。

## 证据与限制

| 验证层 | 结果或状态 | 说明 |
| --- | --- | --- |
| 失败先行测试 | 通过红→绿 | Filer 旧按钮点击无二次复制；Sender 旧目标列表及计数与期望不符 |
| 前端单元及组件集成 | **1370 passed、7 skipped（133 files passed、2 skipped）** | 已在迁移后的 `main` 基线重新执行 `npm test`；jsdom、mock Tauri/SSH，不能证明真机拖放和传输 |
| TypeScript 与生产构建 | **通过** | 已在迁移后的 `main` 基线重新执行 `npm run typecheck`、`npm run build`；Vite 保留既有大 chunk 提示 |
| 格式与 lint | **通过；lint 有既有警告** | `npm run format:check` 检查 447 文件；`npm run lint` 对未改动生成文件 `src/bindings.ts` 报 2 条 `any` 警告，退出码 0 |
| 补丁空白检查 | **通过** | `git diff --check` |
| Chromium 可操作体验 | **阻塞，未通过/未失败产品** | 当前隔离执行环境无法启动系统 Chromium；浏览器自动化报 `socket() failed: Operation not permitted`，并非产品崩溃 |
| Windows Tauri/WebView2 原生 | **待执行** | 当前执行环境不是 Windows，缺真实 SSH 与资源管理器操作 |

本轮**未改** TUI gutter 宽度/行号渲染、工作台、断线重连、Filer 泛化的重试含义、Sender 当前会话语义或传输引擎。上述领域需在真实桌面测量后确定是否值得修改。

## 下一道门禁：Windows 真机操作卡

在 Windows 11 的正式 Tauri/WebView2 窗口中，以专用测试目录与无副作用命令验证：

1. **Filer Retry：** 从资源管理器拖文件到本地测试文件夹，让第一次复制可恢复地失败；修复权限后点击底部 Retry。文件应完整出现在原目录，错误消失，随后可刷新与再次复制。不得调整生产目录权限。
2. **Sender 目标：** 两个 connected SSH、一个 disconnected SSH、一个 SFTP，All 数量应为 2；对空闲 Shell 发送 `printf 'EDGE_TEST\n'`，只两台 connected SSH 各收到一次。收缩/展开 Sender 后计数一致；依次断线时数量 `2→1→0`，0 时无发送且提示原因。
3. **TUI 焦点：** 3–4 SSH 并行，OpenCode 与 Pi 窗口运行时测试标签/分屏切换、鼠标选区、中文 IME、Alt+click、滚动与后台日志。无误发送、焦点抢占或行号抖动。
4. **响应式与预览：** 在 900×560、1100×720、1440×900，Windows 缩放 100%/125%/150%，检查三栏终端空间、搜索框可达、菜单/弹窗不溢出；图片双击仍是只读、滚轮缩放/拖动/Esc 可用。

每项记录版本 SHA、WebView2 版本、窗口尺寸、结果、截图与复现步骤。未补齐 Chromium 实际操作和 Windows 原生证据之前，不宣称体验验收完成；新 PR 维持 Draft，不合并、不发布。
