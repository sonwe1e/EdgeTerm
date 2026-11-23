# 颜色字面量只许出现在 foundation 层（2026-11-24 第 106 轮）

四套主题共用一套 token：组件样式只写 `var(--...)`，`foundation.styles.css` 定义 token 并让每套主题覆盖。这条约定此前只写在文档里。

## 一、先量，再建门

扫描 19 个组件样式表：**0 个颜色字面量**；210 个全部在 `foundation.styles.css`。唯一一处疑似命中是注释里的 `upstream issue #108`，被注释剥离规则排除。也就是说约定目前是守住的——门的作用是防止它将来失守。

## 二、门本身

| 断言 | 作用 |
| --- | --- |
| 除 foundation 外的样式表不得出现 `#rgb` / `#rrggbb` / 带 alpha 的写法 | 新组件不再硬编码颜色，四套主题才不会分叉 |
| foundation 自身仍须有 100 个以上字面量 | 防止 glob 失效或路径改名后，门变成空转 |

用 `import.meta.glob("./styles/*.css", { query: "?raw", eager: true })` 收集文件，所以将来新增的样式表自动被覆盖，不需要维护清单。

## 三、负控制

往 `ftp.styles.css` 追加 `.term-empty-x { color: #123456; }`：

```
AssertionError: expected [ './styles/ftp.styles.css: #123456' ] to deeply equal []
Tests  1 failed | 1 passed (2)
```

删除后恢复。**门抓得住人为违规，才值得留下。**

## 四、验证

| 层次 | 证据 |
| --- | --- |
| 约定 | `src/colourLiterals.test.ts` 2/2 |
| 负控制 | 追加字面量 → 失败；删除 → 通过 |
| 全量 | 见 STATE 本轮记录 |

## 五、边界

门只管 **hex**：`rgb()`、`hsl()` 等写法不在规则内（当前样式表里没有）。如果将来有人用 `rgb(0 0 0 / 50%)` 绕开，这条门不会响——把边界写在这里，比假装覆盖了更有用。
