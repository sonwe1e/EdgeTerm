# 构建记录：1.7.8（第 185 轮，2026-11-25）

第 184 轮那版（`0C315F26…`）之后补了最后一条测试。**以本记录为准**。

| 项 | 值 |
| --- | --- |
| 提交 | `b27f739`（`git status` 干净） |
| 版本 | 1.7.8（未升版） |
| 安装包 | `src-tauri/target/release/bundle/nsis/EdgeTerm_1.7.8_x64-setup.exe` |
| 大小 | 4,262,980 B（4.06 MiB） |
| SHA-256 | `E84029502314A04A277888CEC77F4125E1E33C74CAEA832DFC6ADF05CB63E7BE` |

## 构建前验证（同一提交）

- `npm run test:rust`：548 通过，32 ignored。
- `npm run verify`：`VERIFY_EXIT=0` —— 单测 223 文件／1997 用例，浏览器 75 文件／351 用例。
- `npm run check:commits -- 912a806..HEAD --typecheck`：1 commit，0 errors，0 warnings。
- `npm run tauri:build`：`BUILD_EXIT=0`。

## 与上一版（`0C315F26…`）的差别

产品行为完全一致——本轮只补测试，而且是**最后一条**。

补的过程中修正了我自己当时的一个说法：我先断言「目标行会亮起成为放置目标」，依据是「盘符根在上游就拒绝了整个手势」——**不成立**。`useFilerDrag` 拒绝的是把盘**拖出**盘符根，`moveEntries` 拒绝的是把一个盘**拖到另一个盘上**，这是两条不同的路径，只有后者此前缺失。所以用例只钉结果，负控制证明它判别：去掉 `moveEntries` 的守卫，`localRename` 就带着一个整卷路径发出去了。

## 未验证的边界

- 只在 Windows x64 构建；未做安装／升级／卸载自动化。
- **第 160–185 轮审计共 61 条已全部交付，且无用例项为 0。**

