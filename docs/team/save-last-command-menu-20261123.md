# 右键菜单也能「把上一条命令存成常用命令」（2026-11-23 第 58 轮）

命令行面板早有「Save Last Command as a Snippet」，但读者在同一处右键时看不到它——终端右键菜单只有「发送已保存命令」的子菜单。读者记住一条命令后最自然的动作是在终端里右键，而不是先想起一个快捷键。

## 一、交付

| 位置 | 变化 |
| --- | --- |
| 终端右键菜单 | 新增「Save Last Command as a Snippet」：有已保存命令时紧跟其子菜单，没有时位于分隔线之后；未连接时禁用 |
| `snippetActions.ts` | 新增保存回调注册（`registerSnippetSaver` / `requestSnippetSave`），与既有的「运行」注册同形：没有注册者时请求是安全的空操作 |
| `useSnippetRunner.tsx` | 在同一个 effect 里注册运行与保存两个入口，对话框仍由这个特性自己拥有 |

## 二、一个类型教训

把注册 effect 放在 `saveLastCommandAsSnippet` 定义之前，`TS2448` 直接报「使用在声明之前」。`useCallback` 的值不是提升的：effect 必须排在它引用的回调之后。

## 三、验证

| 用例 | 断言 |
| --- | --- |
| `snippetRunner.test.ts`（4，新增 2） | 已注册的保存者被调用一次；未注册时请求不抛错 |
| `snippets.browser.test.ts`（13，新增 1） | 提交过 `kubectl get pods` 后右键终端：菜单里有这一项；点击后出现命名对话框且提示含该命令；命名 `Pods` 提交后 store 里存的是这条命令 |

## 四、边界

- 菜单项在未连接时禁用——没有控制器就没有「上一条命令」，保存一个空命令没有意义；
- 一条命令都没有提交过时点击它，会走与面板相同的提示（`snippets.noCommandToSave`），不会弹出空命名框。
