import { expect, it } from "vitest";

import transferStyles from "../styles/transfer.styles.css?raw";
import { JOB_ROW_HEIGHT } from "./TransferCenter";

// The row's height lives twice: the virtualiser positions rows with the
// constant, and the row's own box is sized in CSS. A comment asked whoever
// changed one to change the other; nothing checked that they did.
it("sizes a transfer job row to the height the virtualiser positions it at", () => {
  const rule = transferStyles.match(/\.transfer-job\s*\{([^}]*)\}/);
  expect(rule, "the .transfer-job rule exists").toBeTruthy();
  const height = rule![1].match(/height:\s*(\d+)px/);
  expect(height, ".transfer-job declares a pixel height").toBeTruthy();

  expect(Number(height![1])).toBe(JOB_ROW_HEIGHT);
});
