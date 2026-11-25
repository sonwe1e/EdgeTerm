# 构建记录：1.7.8（第 218 轮，2026-11-25）

第 217 轮那版（`BFB82F35…`）之后修完测试质量审计的最后三条。**以本记录为准。**

| 项 | 值 |
| --- | --- |
| 提交 | `d865e4b`（`git status` 干净） |
| 版本 | 1.7.8（未升版） |
| 安装包 | `src-tauri/target/release/bundle/nsis/EdgeTerm_1.7.8_x64-setup.exe` |
| 大小 | 4,265,107 B（4.06 MiB） |
| SHA-256 | `87DC9DFD5CBEB58664FA0BC69382DE66B4FC0633CE0C733DC160466D3C9381CE` |

## 构建前验证（同一提交）

- `npm run test:rust`：549 通过，32 ignored。
- `npm run verify`：`VERIFY_EXIT=0` —— 单测 **224 文件／2002 用例**（比上一版少 1，删的是冗余用例），浏览器 75 文件／351 用例。
- `npm run check:commits -- 6bfcc61..HEAD --typecheck`：1 commit，0 errors，0 warnings。
- `npm run tauri:build`：`BUILD_EXIT=0`。

## 与上一版（`BFB82F35…`）的差别

**没有产品代码改动——连续两版修的都是测试。**

1. **「没有两个命令共用默认和弦」这条不变式被断言了两遍。** census 那份比的是 `chordLabel` 字符串，而它按运行时平台分支——在 Windows 构建上会用 Windows 风格修饰符去标 mac 表。字段级的 owner 是 `shortcuts.test.ts`，保留它，删掉 census 那份记账。
2. **短文件 ZMODEM 那条唯一断言是负向的。** 接收链路整个不交付时 `notices` 一直是空的，断言平凡通过。现在负向断言前有一条正向锚点。
3. **「1 MiB 是 Rust 传输上限」只读 TS 常量。** 注释宣称在钉 `binary_transfer.rs` 的上限，但 Rust 侧改动它看不见；下面那条行为测试把同一个切分硬编码在对真实 `zmodemWriteBytes` 调用的断言里，用同样的数据失败、信号更诚实。删掉字面量那条，并把注释改写成「这个契约**没有**被自动验证」。

## 未验证的边界

- 只在 Windows x64 构建；未做安装／升级／卸载自动化。
- 本轮改的是测试，**不改变任何产品行为**。
- 第 160–218 轮审计共 **89 条，已修 89 条**——三个审计面（外壳无障碍 5、i18n 文案 6、测试质量 6）加上此前各轮，队列全空。
- 唯一剩下的 W2（监视标记跳转坐标）已完整定位，但现有夹具的 `firstLineNumber` 恒为 1，判别不出 1 行偏差；造判别性夹具要填满并裁掉 10000 行滚动缓冲，成本超过该缺陷本身的表现。

