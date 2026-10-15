# 本次改造的体验与验收（2026-10-16）

本次按质量优先完成修订方案。源码在分支 codex/edgeterm-flow181-improvements。
未推送、发布、安装或启动用户应用；初始五份用户文件保留原始字节和未提交状态。
GLM / Flow Next 1.8.1 执行前半程，用户要求后由 Codex 接手收尾；不是无监督模型对照。

## 建议优先体验

1. **文件对比**：连接自己的 SFTP/FTP 会话，在双栏中各选一个本地/远程文件，再点中间的
   Compare。试一侧增加/删除超过 64 行、整文件 CRLF/LF 转换同时插入几行、重试与取消。
   相同尾部应重新对齐，换行差异仍显示为修改。仍是只读比较，超时不承诺立即终止 CPU 计算。
2. **终端显隐与字号**：在有较多输出的终端切换/隐藏标签，调整窗口后回来；打开 View →
   Display Settings，调整缓冲区字号，再恢复，检查行号与文本是否保持对齐。GPU 和普通
   renderer 都值得在自己的设备试。已有浏览器证据不替代实际 WebView2/GPU 验收。
3. **大目录和图标**：打开大目录、滚动到底部、切换标签和亮暗主题，确认图标正常、行未跳位。
   图标 JS 首开负担明显下降，但资源文件数量增加；未承诺整个应用的统一加速倍数。
4. **弹窗**：在新建会话、显示设置、快捷键、文件对比和确认框中试 Tab/Shift+Tab、Esc、
   点击外部及拖动标题。草稿表单外点击只提示；关闭后应恢复焦点。快捷键录制阶段 Esc 先退出
   录制。主机密钥变更必须明确点击接受，默认 Cancel；忙碌期间的关闭守卫保持。
5. **字体联动**：显示设置中面板字号 12→18，检查文件列表、日期文字、虚拟行间距同步变化。
   原生窗口最小宽度是 900；可在 900–1100 范围体验窄布局。760px 是浏览器压力夹具。

开发侧新增 `npm run lint`、`npm run check:bindings`，能发现未使用变量/导入、遗漏依赖和
Rust/TS 字段漂移。Compiler 对照没有显示有价值的收益，默认关闭；实验入口和原始样本见
[Compiler 对照](compiler-experiment.zh-CN.md)，覆盖/例外见 [IPC 契约](ipc-contracts.zh-CN.md)。

## 自动验证结果

- 前端单元：496/496；真实 Chromium：32/32；真实 Edge 155：32/32。
- Rust：273 通过、23 ignored（需外部设备/服务器的既有夹具，未冒充通过）。
- IPC：92/97 注册命令、5 类结构事件生成；新鲜度正常；在一次性 worktree 中仅改 Rust
  serde 字段名，导出成功但新鲜度明确失败，随后清理 worktree。
- 真实 xterm 6 解析器检查 RGB、Unicode/宽字符、扩展样式、BG 标志与 resize；未知 stride
  反例在旧实现失败，候选通过。没有移植 VT 内核。
- 真实生产构建 App → store → 字体 CSS → Filer 行距门禁：4/4，未知 IPC、页面错误、
  控制台错误、坏资源均为 0。图标门禁：982 映射、906 引用，URL 资源全部存在。
- 暗/亮 Session 与 Display Settings 四张截图已检查；独立 Edge 弹窗边界 8 项通过。
- 逐提交 typecheck/lint 与提交说明检查、仅本次触及 Rust 的格式检查均执行；全仓 Rust
  格式基线原本失败，没有做无关的全仓重排。生成器自带两处 any lint 警告保留。

## 产物

构建命令：`npm run tauri -- build --no-bundle`。最终日志：`.tmp/final-delivery-tauri.log`。
可运行 exe：`G:\Workspaces\TestStudio\EdgeTerm\src-tauri\target\release\edgeterm.exe`。
构建结果和 SHA256 在本次任务最终交付记录中核对。

## 主动暂缓和未验证

- 主动暂缓 #4 ZMODEM/XMODEM 下沉 Rust、#10 的 Rust VT/单画布重写。需要真实负载成本、
  互操作和平台收益证据后再立项；原方案的高收益断言不足以支持本次大规模替换。
- Compiler 默认开启未做：本次组件夹具无收益，不作全应用加速承诺。
- 真实 SSH/SFTP/FTP、串口、lrzsz 对端、更新下载/安装、原生拖出到系统、实际 GPU 驱动，
  以及 macOS WKWebView/Linux WebKitGTK 的人工验收未做。Playwright WebKit 是辅助引擎证据。
- 未制作安装包、签名、发布或推送。Flow 的后续机制修复与产品分开记录；机制测试不能
  证明模型解题能力、跨任务收益或费用降低。

完成本次产品与已确定的 Flow 修复后停止，不自动扩展下一轮架构任务。
