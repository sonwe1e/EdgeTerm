import { createElement as h } from "react";
import { afterEach, expect, it } from "vitest";
import { browserAfterEach, mount, twoFrames } from "./browserHarness";
import { FilerColumnResizer } from "../components/panels/FilerColumnResizer";
import "../styles.css";

// The resizer reports the width of the cell it sits in, read from the laid-out
// box the moment the adjustment starts. jsdom reports every box as zero, so its
// test can only check the step arithmetic: a resizer that reported a constant
// instead of the column's real width would pass every test in the tree and
// resize the wrong column by the wrong amount on a real screen.
afterEach(async () => {
  await browserAfterEach();
});

function board(options: {
  onStart?: (width: number) => void;
  onResize: (startWidth: number, widenBy: number) => void;
}) {
  return h(
    "div",
    { style: { display: "flex" } },
    h(
      "div",
      {
        style: {
          position: "relative",
          width: "200px",
          height: "300px",
          // The real caption is a grid cell; the handle straddles its right
          // edge, so the cell's box is what the handle measures.
          display: "grid",
          gridTemplateColumns: "200px",
          border: "1px solid",
        },
      },
      h(FilerColumnResizer, { label: "Resize name column", ...options }),
    ),
  );
}

it("measures the cell it lives in and widens it from the keyboard", async () => {
  const started: number[] = [];
  const widths: { start: number; widenBy: number }[] = [];
  mount(
    board({
      onStart: (width) => started.push(width),
      onResize: (start, widenBy) => widths.push({ start, widenBy }),
    }),
  );
  await twoFrames();

  const handle = document.querySelector<HTMLElement>('[role="separator"]')!;
  expect(handle, "the handle is mounted").toBeTruthy();
  // The keydown goes straight to the handle: the measurement underneath is what
  // this test is about, and focus routing has its own jsdom coverage.
  handle.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
  await twoFrames();

  // The cell's border box: 200px of grid track plus its 1px borders. The value
  // has to come from the laid-out box, not from a constant.
  expect(started[0], "the resizer reports the cell as laid out").toBe(200);
  expect(widths[0], "one keypress reports the laid-out width").toEqual({ start: 200, widenBy: 8 });

  handle.dispatchEvent(
    new KeyboardEvent("keydown", { key: "ArrowLeft", shiftKey: true, bubbles: true }),
  );
  await twoFrames();
  expect(widths[1].widenBy, "shift is the coarse step, leftwards").toBe(-32);
});
