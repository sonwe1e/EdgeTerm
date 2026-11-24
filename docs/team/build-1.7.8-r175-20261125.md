# 构建记录：1.7.8（第 175 轮，2026-11-25）

第 174 轮那版（`9CC7A413…`）之后落了串口/FTP 两条修复与两处用例债。**以本记录为准**。

| 项 | 值 |
| --- | --- |
| 提交 | `8d4bfac`（`git status` 干净） |
| 版本 | 1.7.8（未升版） |
| 安装包 | `src-tauri/target/release/bundle/nsis/EdgeTerm_1.7.8_x64-setup.exe` |
| 大小 | 4,260,902 B（4.06 MiB） |
| SHA-256 | `3BBDD882CA049AF8A0A2937B19E6B8C149C3B48E5E286AA7947341B9E9D39ADF` |

## 构建前验证（同一提交）

- `npm run test:rust`：547 通过，32 ignored。
- `npm run verify`：`VERIFY_EXIT=0` —— 单测 220 文件／1979 用例，浏览器 72 文件／342 用例。
- `npm run check:commits -- afa1616..HEAD --typecheck`：2 commits，0 errors，0 warnings。
- `npm run tauri:build`：`BUILD_EXIT=0`。

## 与上一版（`9CC7A413…`）的差别

- **FTP 下载按钮**：本地目录列不出来时不再可点（此前按下后没有任务、没有消息、没有转圈）。
- **串口字段**：配置写着 COM9 而本机没有该适配器时，下拉框不再空白——字段、副标题与连接实际使用的值一致。

## 未验证的边界

- 只在 Windows x64 构建；未做安装／升级／卸载自动化。
- 串口字段**没有用例**（对话框的串口区没有 jsdom 装置）；FTP 下载按钮的护栏有用例。
- 第 160–175 轮审计共 **32 条**已全部交付；其中仍有无用例的条目（拖拽预览、菜单勾选、冷历史查找失效等），逐条写在提交信息与各审计记录里。

