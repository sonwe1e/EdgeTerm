# 构建记录：1.7.8（第 219 轮，2026-11-25）

第 218 轮那版（`87DC9DFD…`）之后开了第四个审计面：**代码本身的质量**。**以本记录为准。**

| 项 | 值 |
| --- | --- |
| 提交 | `be5edcc`（`git status` 干净） |
| 版本 | 1.7.8（未升版） |
| 安装包 | `src-tauri/target/release/bundle/nsis/EdgeTerm_1.7.8_x64-setup.exe` |
| 大小 | 4,265,881 B（4.06 MiB） |
| SHA-256 | `537D4FB60F05C2ADBCC456C9E94F0390673E1F4CD472CEFA90A05A285E975B86` |

## 构建前验证（同一提交）

- `npm run test:rust`：549 通过，32 ignored。
- `npm run verify`：`VERIFY_EXIT=0` —— 单测 **224 文件／2001 用例**（比上一版少 1，删的是别名测试），浏览器 75 文件／351 用例。
- `npm run check:commits -- e1355f3..HEAD --typecheck`：1 commit，0 errors，0 warnings。
- `npm run tauri:build`：`BUILD_EXIT=0`。

## 与上一版（`87DC9DFD…`）的差别

**没有产品行为改动——删掉三个死名字和别名。**

- `endingLabel`：全仓只出现一次，连内部调用都没有。
- `downloadClashes`：`namesTaken` 的纯别名。它唯一的测试断言两者相等——**在任一被删后都会继续通过**，保护不了任何东西。
- `errorMessage`：`errorText` 的纯别名。三个调用点改为直接从 `errorInfo` 导入，不再经过一层转发。

同一个审计还确认了三件让人安心的事（AST 验证，非推测）：**6,316 个参数里 0 个从未被读**（覆盖 `noUnusedParameters` 看不见的情况）；**不可达分支六项检查全零**；**135 条断言用法的前导注释无一与代码矛盾**。

## 未验证的边界

- 只在 Windows x64 构建；未做安装／升级／卸载自动化。
- 本轮改的是死代码与别名，**不改变任何产品行为**。
- 同一审计另有 5 条未修，都是真正的重构：C1 拖拽生命周期整体重复（约 80 行，连注释都一字不差）、C2 最近使用存储层写三遍、C3 `endpoint`/`forwardRoute` 复制进三个对话框、C4 save/connect 重复同一段校验前奏、C5 112 个导出没有导入方。精确位置都在 [审计备注](docs/team/audit-code-quality-20261125.md) 里。
- 第 160–219 轮审计共 **95 条**，已修 **89 条**。

