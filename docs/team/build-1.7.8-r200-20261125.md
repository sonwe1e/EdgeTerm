# 构建记录：1.7.8（第 200 轮，2026-11-25）

第 195 轮那版（`39B4951D…`）之后只改了测试代码。**以本记录为准。**

| 项 | 值 |
| --- | --- |
| 提交 | `852cf57`（`git status` 干净） |
| 版本 | 1.7.8（未升版） |
| 安装包 | `src-tauri/target/release/bundle/nsis/EdgeTerm_1.7.8_x64-setup.exe` |
| 大小 | 4,262,142 B（4.06 MiB） |
| SHA-256 | `3E1B1A4A55B9F7D934D2EA1158D6C86D76191E1D6A1182B4A676BFEC91646787` |

## 构建前验证（同一提交）

- `npm run test:rust`：549 通过，32 ignored。
- `npm run verify`：`VERIFY_EXIT=0` —— 单测 224 文件／2001 用例，浏览器 75 文件／351 用例。
- `npm run check:commits -- 75ff99a..HEAD --typecheck`：1 commit，0 errors，0 warnings。
- `npm run tauri:build`：`BUILD_EXIT=0`。

## 与上一版（`39B4951D…`）的差别

**产品行为完全一致**——本轮只修测试代码。

`ResourceMonitorBar.test.ts` 里的 `styled()` 助手是从一个正则构建的，而那个正则的转义早已损坏（一个字符串转义把 `const vitals = ...` 吞成了替换文本的一部分），结果是**它对一切选择器都返回 false**，包括样式表里明确定义的类。任何建立在它上面的断言都不可能失败，所以这个文件里有几条检查**从写下起就是空转的**。

改成不含任何转义字符的写法：在样式表里找到该选择器，要求其后第一个非空白字符是 `{` 或 `,`。已对真实文件验证——`.metric-warn`、`.metric-crit`、`.vital` 为 true，`.no-such-class` 为 false。

## 未验证的边界

- 只在 Windows x64 构建；未做安装／升级／卸载自动化。
- 那几条断言现在**方向正确了**，但它们断言的具体内容（哪些类必须有规则）本轮没有逐条核对，只验证了助手本身能判别。
- W2（监视标记跳转坐标）仍未修：已定位到坐标关系，但现有规模的夹具无法让修复显出红绿差异。

