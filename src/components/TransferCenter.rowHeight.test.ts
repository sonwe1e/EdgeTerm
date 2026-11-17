import { expect, it } from "vitest";

import transferStyles from "../styles/transfer.styles.css?raw";
import { FAILURE_ROW_HEIGHT, JOB_ROW_HEIGHT, RECOVERY_ROW_HEIGHT } from "./TransferCenter";

/**
 * The height of a virtualised row lives twice: the constant positions the rows,
 * and the row's own box is sized in CSS. Each place that happens carried a
 * "keep in step" comment and nothing checked it, so a row taller than the
 * constant would clip its content while a shorter one left a gap.
 */
function declaredHeight(className: string): number {
  const rule = transferStyles.match(new RegExp(`\\.${className}\\s*\\{([^}]*)\\}`));
  expect(rule, `the .${className} rule exists`).toBeTruthy();
  const height = rule![1].match(/height:\s*(\d+)px/);
  expect(height, `.${className} declares a pixel height`).toBeTruthy();
  return Number(height![1]);
}

it("sizes a transfer job row to the height the virtualiser positions it at", () => {
  expect(declaredHeight("transfer-job")).toBe(JOB_ROW_HEIGHT);
});

it("sizes a failure row to FAILURE_ROW_HEIGHT", () => {
  expect(declaredHeight("transfer-failure-row")).toBe(FAILURE_ROW_HEIGHT);
});

it("sizes a recovery row to RECOVERY_ROW_HEIGHT", () => {
  expect(declaredHeight("transfer-recovery-row")).toBe(RECOVERY_ROW_HEIGHT);
});
