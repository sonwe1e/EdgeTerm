# React Compiler 对照（2026-10-16）

默认关闭。精确锁定 babel-plugin-react-compiler 1.0.0；仅显式设置
EDGETERM_REACT_COMPILER=1 才对应用构建启用。`npm run experiment:compiler -- <唯一名称>`
会单独 production build 同源夹具两臂，保留未经排序的全部样本和实际 CompileSuccess 事件。
不会覆盖默认 dist，不依赖 jsdom 源码测试。两臂均验证真实 FileBrowser 的选择、排序后的
滚动复位、虚拟行数、有指针捕获的释放以及 ModalDialog 的输入/Tab/Esc；禁用选择状态
更新的负对照能被观察到。该对照不覆盖完整双栏传输、真实服务器或桌面 WebView。

本机 Windows / Edge 155.0.4283.45，16 个新 context、交替顺序，每臂 8 次。
fixture SHA256 为 97ff0848f27ac53b205a459433487e0ea9212841cfc4939d64d94a52d523f94c。
实际生产组件获得 14 条 CompileSuccess（同一文件中多个函数分别记录）。

| 指标中位数 | 关闭 | 开启 |
|---|---:|---:|
| 首次挂载至双 RAF | 29.3 ms | 30.5 ms |
| 8 次滚动 RAF 交互 | 138.8 ms | 140.4 ms |

原始样本在 `.tmp/compiler-takeover-final/results.json`，另存本次任务证据目录。
这些含显示刷新等待的本机夹具数据未显示有价值的收益，不能推导编译器普遍更慢。
未宣称全应用性能改善，不删除现有 useMemo/useCallback。若未来考虑默认启用，需先补
完整应用、实际桌面渲染器及受影响异步业务路径的语义与性能证据。
