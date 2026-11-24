# 构建记录：1.7.8（第 184 轮，2026-11-25）

第 183 轮那版（`BDFB1917…`）之后补了一条测试。**以本记录为准**。

| 项 | 值 |
| --- | --- |
| 提交 | `bfa1760`（`git status` 干净） |
| 版本 | 1.7.8（未升版） |
| 安装包 | `src-tauri/target/release/bundle/nsis/EdgeTerm_1.7.8_x64-setup.exe` |
| 大小 | 4,262,251 B（4.06 MiB） |
| SHA-256 | `0C315F269817CEF209CB5CD4525665FA38E72DB9263B4B2F47BE807BBB994301` |

## 构建前验证（同一提交）

- `npm run test:rust`：548 通过，32 ignored。
- `npm run verify`：`VERIFY_EXIT=0` —— 单测 223 文件／1997 用例，浏览器 74 文件／350 用例。
- `npm run check:commits -- af354fe..HEAD --typecheck`：1 commit，0 errors，0 warnings。
- `npm run tauri:build`：`BUILD_EXIT=0`。

## 与上一版（`BDFB1917…`）的差别

产品行为完全一致——本轮只补测试。差别是「清除单条中断记录后焦点留在中断列表里」这条现在有用例。

上一轮我把这条记为「`VirtualFileRows` 没渲染出来」。**那个诊断是错的**：该组件在 200 行阈值以下本来就把每一行都渲染出来，三条记录一直都在。真正坏掉的是我自己的选择器——我按一个该行并不带的 aria-label 找按钮。改成先按名字找行、再取它最后一个动作按钮就成了。

## 未验证的边界

- 只在 Windows x64 构建；未做安装／升级／卸载自动化。
- 仍无用例的 1 条：拖到盘符根（需要一份不同的列目录具）。
- 第 160–184 轮审计共 **61 条**已全部交付。

