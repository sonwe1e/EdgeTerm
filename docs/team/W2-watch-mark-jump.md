# W2：监视标记跳转的坐标偏差（第 225 轮修好）

从第 179 轮挂到第 224 轮，第 194、196、197 轮三度尝试失败。第 225 轮修好。失败的原因从来不是「夹具不够大」，是我**没有先把三个坐标空间读清楚**。

## 三个坐标空间

| 表达式 | 空间 |
| --- | --- |
| `lineGutter.watchLines()` | **绝对行号**（`firstLineNumber + row`） |
 | `scrollToLine(absoluteLine)` 的参数 | **绝对行号**（内部做 `absoluteLine - firstLineNumber`） |
 | `buffer.baseY + buffer.cursorY` | **缓冲区相对行**（0 起） |

`jumpToLines` 把 `target`（来自 `watchLines()`，绝对）交给 `scrollToLine`（要绝对）——**对的**。但首次跳转的 `reference` 用 `buffer.baseY + buffer.cursorY`（缓冲区相对），比绝对坐标**小 `firstLineNumber`**。`commandJumpLine` 存的是 `target`（绝对），所以从第二次跳转起反而是对的——**只有第一次偏**。

## 为什么前三轮找不到判别性用例

我一直在找「`firstLineNumber` 大于 1」的场景，以为要填满并裁掉 10000 行滚动缓冲。**错了。** `firstLineNumber` 默认就是 1，偏差正好 1 行，而判别窗口正好是 1 行宽：

- 光标在缓冲区第 R 行，监视标记在缓冲区第 R-1 行（绝对行 R）。
- 错误：`reference = R`，问 `R < R`？否 → 继续往下找 → 找不到 → **返回 false，报「没有更早的标记」**。
- 正确：`reference = R+1`，问 `R < R+1`？是 → 跳过去。

**这就是可判别用例，而且不需要任何特殊夹具**——`"ERROR directly above\r\n"` 写完，光标恰好在标记的下一行。

第 196 轮我以为真正的原因是我断言了 `baseY + cursorY`（跳转从不移动它）。那句话本身没错，但我据此认为需要新夹具——**又一次「需要新装置」的判断被证明是错的**（本会话第五次）。

## 修法

```ts
const reference =
  this.commandJumpLine ??
  this.lineGutter.firstLineNumber + buffer.baseY + buffer.cursorY;
```

## 负对照

把 `reference` 改回 `this.commandJumpLine ?? buffer.baseY + buffer.cursorY`，新用例立刻红：

```
× steps back to a mark sitting directly above the cursor
AssertionError: the mark above the cursor: expected false to be true
```

其余 3 条仍绿——**红绿都只落在新用例上**。

### 负对照第一次是假的

第一次跑负对照时我用 `-replace` 配了一个含 `\n` 的模式，而文件是 `\r\n` 行尾，**替换静默失败**（PowerShell 的 `-replace` 不匹配就原样返回），测试当然全绿。我差点据此认为「这条改动没有测试保护」。第二次先打印 `PATTERN MATCHED`／`PATTERN NOT FOUND` 再跑，才发现第一次什么都没改。

**这是本会话第三次 `String.replace` 静默失败**（前两次弄坏过 `zmodem.test.ts` 与 `zmodemReceive.test.ts`）。教训同前：**先确认替换真的发生了，再相信测试结果**。

