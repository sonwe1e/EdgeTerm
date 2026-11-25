# 构建记录：1.7.8（第 217 轮，2026-11-25）

第 216 轮那版（`34EE913C…`）之后换了审计方向：审**测试本身能不能抓住回归**。**以本记录为准。**

| 项 | 值 |
| --- | --- |
| 提交 | `21fb45d`（`git status` 干净） |
| 版本 | 1.7.8（未升版） |
| 安装包 | `src-tauri/target/release/bundle/nsis/EdgeTerm_1.7.8_x64-setup.exe` |
| 大小 | 4,263,779 B（4.06 MiB） |
| SHA-256 | `BFB82F35268C7B336F77A1B8D3995454CE94F032F5D90578A0EE61B25D05B231` |

## 构建前验证（同一提交）

- `npm run test:rust`：549 通过，32 ignored。
- `npm run verify`：`VERIFY_EXIT=0` —— 单测 224 文件／2003 用例，浏览器 75 文件／351 用例。
- `npm run check:commits -- 6ef9a4c..HEAD --typecheck`：1 commit，0 errors，0 warnings。
- `npm run tauri:build`：`BUILD_EXIT=0`。

## 与上一版（`34EE913C…`）的差别

**没有产品代码改动——这一版修的是测试。** 三条原本不可能失败的用例现在有判别力了：

1. `sameChord(mac, mac)` 拿和弦与自己比，对任何不抛异常的实现都为真，而测试名却宣称在交叉校验两张平台表。删掉该断言，把名字改成它真正证明的事。
2. `bounds exit-time directory capture…` **一条断言都没有**，只能靠挂起来失败。补上判别性断言。
3. 凭证状态那个间谍只检查 `console.error` 被调用过、不查内容，于是把 `console.error(error)` 换成 `console.error("failed")` 它照样绿——而那正是开发者唯一的诊断信息。

同类审计还确认了两件让人安心的事：**没有测试 mock 了正要验的东西**（52 个可疑文件 mock 的都是 IPC／原生边界），**全仓 0 个快照断言**，49 处 `toBeTruthy()` 都带失败消息且样式探针与导出常量双向比对。

## 未验证的边界

- 只在 Windows x64 构建；未做安装／升级／卸载自动化。
- 本轮改的是测试，**不改变任何产品行为**；安装包与上一版功能相同。
- 同一审计另有 3 条未修（都在审计备注里记了精确位置）：一条重复断言同一不变式、一条 ZMODEM 接收测试只有负向断言、一条「Rust 上限」只读 TS 常量。
- 第 160–217 轮审计共 **89 条**，已修 **86 条**。

