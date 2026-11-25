# 构建记录：1.7.8（第 213 轮，2026-11-25）

第 212 轮那版（`09FD30A7…`）之后接完了同一条缺陷的另一半。**以本记录为准。**

| 项 | 值 |
| --- | --- |
| 提交 | `0c8792d`（`git status` 干净） |
| 版本 | 1.7.8（未升版） |
| 安装包 | `src-tauri/target/release/bundle/nsis/EdgeTerm_1.7.8_x64-setup.exe` |
| 大小 | 4,261,792 B（4.06 MiB） |
| SHA-256 | `A5AA4C65C38F676FC4E810504CEFB9808557B32C1181A262143E44BED45B1BA0` |

## 构建前验证（同一提交）

- `npm run test:rust`：549 通过，32 ignored。
- `npm run verify`：`VERIFY_EXIT=0` —— 单测 224 文件／2003 用例，浏览器 75 文件／351 用例。
- `npm run check:commits -- e255f2d..HEAD --typecheck`：1 commit，0 errors，0 warnings。
- `npm run tauri:build`：`BUILD_EXIT=0`。

## 与上一版（`09FD30A7…`）的差别

**Tab 不再从发送面板的「查找已存命令」浮层漏出去。**

上一轮止住了窗口快捷键在它底下触发。剩下的是：它是个普通 div，浏览器不会替它把 Tab 关在里面，所以从最后一行 Tab 出去会落到背后的面板，而它不关。

本轮在已有的那个 `useEffect` 里加了 `containTab`，规则**照抄 `ModalDialog` 的那套**（没有显式选中时首尾两个停靠点互为边界，`offsetParent === null` 的隐藏节点不计入），并加上 `aria-modal="true"`。**没有改走 `ModalDialog`**——那样要重写定位、锚点和 `sender-more-menu` 的样式钩子，而 Tab 收容本身不依赖原生顶层。

**第 205 轮外壳无障碍审计的 5 条至此全部处理完毕。**

## 未验证的边界

- 只在 Windows x64 构建；未做安装／升级／卸载自动化。
- 这条修复**没有端到端用例**（Tab 收容靠的是真实焦点序列，jsdom 不产生）。
- 第 160–213 轮审计共 **80 条**，已修 **80 条**。剩下两项都不是本轮审计的发现：W2（监视标记跳转，夹具无法判别）与「i18n 文案质量审计未完成」。

