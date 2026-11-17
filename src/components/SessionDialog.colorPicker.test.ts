import { expect, it } from "vitest";

import dialogStyles from "../styles/dialogs.styles.css?raw";
import { COLOR_PICKER_COLUMNS } from "./SessionDialog";

/**
 * The colour picker's arrow-key navigation steps by `COLOR_PICKER_COLUMNS` while
 * the visible grid gets its width from the stylesheet. A comment asked whoever
 * changed one to change the other; nothing checked it, and a mismatch makes the
 * down arrow land two swatches away from the one underneath.
 */
it("lays the colour picker out in the columns its arrow keys step by", () => {
  const rule = dialogStyles.match(/\.session-color-picker\s*\{([^}]*)\}/);
  expect(rule, "the .session-color-picker rule exists").toBeTruthy();

  const columns = rule![1].match(/grid-template-columns:\s*repeat\(\s*(\d+)\s*,/);
  expect(columns, "the rule declares a repeated column count").toBeTruthy();

  expect(Number(columns![1])).toBe(COLOR_PICKER_COLUMNS);
});
