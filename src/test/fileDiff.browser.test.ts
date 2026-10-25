import { createElement as h } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { browserAfterEach, mouse, mount, pagePoint, twoFrames } from "./browserHarness";
import { FileDiffDialog } from "../components/FileDiffDialog";
import type { FileComparison } from "../api";
import "../styles.css";

const api = vi.hoisted(() => ({ compareFiles: vi.fn(), cancelFileDiff: vi.fn() }));
vi.mock("../api", () => api);
vi.mock("../useT", async () => {
  const { translate } = await import("../i18n");
  return {
    useT: () => (key: import("../i18n").MessageKey, params?: Record<string, string | number>) =>
      translate("en", key, params),
  };
});

function comparison(count = 10_000): FileComparison {
  const metadata = {
    size: count * 40,
    kind: "text" as const,
    encoding: "UTF-8",
    bom: false,
    eol: "LF",
    finalNewline: true,
    lines: count,
    sha256: null,
    preview: "",
  };
  return {
    status: "different",
    bytesEqual: false,
    reason: null,
    alignmentSimplified: false,
    left: metadata,
    right: metadata,
    rows: Array.from({ length: count }, (_, index) => ({
      path: `${index + 1}:${index + 1}`,
      leftLine: index + 1,
      rightLine: index + 1,
      kind:
        index === 0
          ? "modified"
          : index === 5000
            ? "deleted"
            : index === count - 1
              ? "added"
              : "equal",
      left:
        index === count - 1
          ? null
          : index === 0
            ? "// 中文注释\t".repeat(50) + "LOCAL_END"
            : `line ${index + 1}`,
      right:
        index === 5000
          ? null
          : index === 0
            ? 'const remote = "' + "x".repeat(1500) + 'REMOTE_END";'
            : `line ${index + 1}`,
      leftEnding: "LF",
      rightEnding: "LF",
    })),
  };
}

beforeEach(() => {
  api.compareFiles.mockResolvedValue(comparison());
  api.cancelFileDiff.mockResolvedValue(undefined);
});
afterEach(async () => {
  await browserAfterEach();
  document.documentElement.removeAttribute("data-theme");
  document.documentElement.style.removeProperty("--terminal-font-family");
  vi.clearAllMocks();
});
async function open() {
  mount(
    h(FileDiffDialog, {
      sessionId: "fixture",
      local: "/local/source.ts",
      remote: "/remote/source.ts",
      active: true,
      onClose() {},
    }),
  );
  await expect.poll(() => document.querySelectorAll("[data-diff-row]").length).toBeGreaterThan(0);
  await twoFrames();
}
const scroller = () => document.querySelector<HTMLElement>(".file-diff-rows")!;
function visible(index: number) {
  const row = document.querySelector<HTMLElement>(`[data-diff-index="${index}"]`);
  if (!row) return false;
  const box = row.getBoundingClientRect();
  const viewport = scroller().getBoundingClientRect();
  return box.top < viewport.bottom && box.bottom > viewport.top;
}

for (const theme of ["dark", "light"])
  for (const width of [1280, 900, 799, 700]) {
    it(`wraps both columns without horizontal dragging at ${width}px in ${theme}`, async () => {
      await page.viewport(width, 900);
      document.documentElement.setAttribute("data-theme", theme);
      await open();
      expect(scroller().scrollWidth).toBeLessThanOrEqual(scroller().clientWidth + 1);
      const row = document.querySelector<HTMLElement>('[data-diff-row="1:1"]')!;
      expect(row.getBoundingClientRect().height).toBeGreaterThan(28);
      for (const code of row.querySelectorAll<HTMLElement>(".file-diff-code")) {
        expect(code.scrollWidth).toBeLessThanOrEqual(code.clientWidth + 1);
        expect(code.scrollHeight).toBeLessThanOrEqual(code.clientHeight + 1);
      }
      expect(row.textContent).toContain("LOCAL_END");
      expect(row.textContent).toContain("REMOTE_END");
      const second = document.querySelector<HTMLElement>('[data-diff-index="1"]')!;
      expect(
        Math.abs(second.getBoundingClientRect().top - row.getBoundingClientRect().bottom),
      ).toBeLessThan(1);
      if ((width === 900 && theme === "dark") || (width === 1280 && theme === "light")) {
        await page.screenshot({
          path: `../../artifacts/performance/file-diff/${theme}-${width}.png`,
        });
      }
    });
  }

it("navigates sparse changes and the last row with bounded DOM, including wrap toggles", async () => {
  await page.viewport(1280, 900);
  await open();
  expect(document.querySelectorAll("[data-diff-row]").length).toBeLessThan(100);
  await userEvent.click(page.getByRole("button", { name: "Next difference", exact: true }));
  await expect.poll(() => visible(5000)).toBe(true);
  expect(document.querySelectorAll("[data-diff-row]").length).toBeLessThan(100);
  expect(document.querySelector(".file-diff-count")!.textContent).toBe("Difference 2 / 3");
  await userEvent.click(page.getByRole("button", { name: "Next difference", exact: true }));
  await expect.poll(() => visible(9999)).toBe(true);
  expect(document.querySelector(".file-diff-count")!.textContent).toBe("Difference 3 / 3");
  expect(
    page.getByRole("button", { name: "Next difference", exact: true }).element(),
  ).toBeDisabled();
  expect(document.querySelectorAll("[data-diff-row]").length).toBeLessThan(100);
  await userEvent.click(page.getByRole("button", { name: "Previous difference", exact: true }));
  await expect.poll(() => visible(5000)).toBe(true);
  const overview = document.querySelector<HTMLElement>(".file-diff-overview")!;
  expect(overview).not.toBeNull();
  expect(overview.querySelector(".is-deleted")).not.toBeNull();
  expect(overview.querySelector(".is-added")).not.toBeNull();
  const marker = pagePoint(overview, 0.5, 0.997);
  await mouse.press(marker.x, marker.y);
  await mouse.release(marker.x, marker.y);
  await expect.poll(() => visible(9999)).toBe(true);
  await userEvent.keyboard("{Home}");
  await expect.poll(() => visible(0)).toBe(true);
  await userEvent.keyboard("{ArrowDown}");
  await expect.poll(() => visible(5000)).toBe(true);
  await page.viewport(900, 900);
  await twoFrames();
  expect(visible(5000)).toBe(true);
  await userEvent.click(page.getByRole("button", { name: "Wrap long lines", exact: true }));
  await twoFrames();
  expect(visible(5000)).toBe(true);
  await userEvent.click(page.getByRole("button", { name: "Wrap long lines", exact: true }));
  await twoFrames();
  expect(visible(5000)).toBe(true);
  await userEvent.click(page.getByRole("button", { name: "First line", exact: true }));
  await userEvent.click(page.getByRole("button", { name: "Wrap long lines", exact: true }));
  expect(scroller().scrollWidth).toBeGreaterThan(scroller().clientWidth);
  await userEvent.click(page.getByRole("button", { name: "Wrap long lines", exact: true }));
  await twoFrames();
  expect(scroller().scrollLeft).toBe(0);
  expect(scroller().scrollWidth).toBeLessThanOrEqual(scroller().clientWidth + 1);
  await userEvent.click(page.getByRole("button", { name: "Last line", exact: true }));
  await expect.poll(() => visible(9999)).toBe(true);
  await userEvent.click(page.getByRole("button", { name: "Compare again", exact: true }));
  await expect.poll(() => visible(0)).toBe(true);
  expect(scroller().scrollTop).toBe(0);
});

it("disables change navigation for equal lines, including metadata-only differences", async () => {
  const value = comparison(10);
  value.rows = value.rows.map((row) => ({ ...row, kind: "equal" }));
  api.compareFiles.mockResolvedValue(value);
  await open();
  expect(
    page.getByRole("button", { name: "Previous difference", exact: true }).element(),
  ).toBeDisabled();
  expect(
    page.getByRole("button", { name: "Next difference", exact: true }).element(),
  ).toBeDisabled();
  expect(document.querySelector(".file-diff-count")!.textContent).toBe("No line differences");
  expect(document.querySelectorAll(".file-diff-marker")).toHaveLength(0);
});

it("groups adjacent changed rows and bounds the overview with alternating changes", async () => {
  const value = comparison();
  value.rows = value.rows.map((row, index) => ({
    ...row,
    kind: index % 2 === 0 ? "modified" : "equal",
    left: "a",
    right: index % 2 === 0 ? "b" : "a",
  }));
  // The first three changed rows form a single stop, including mixed kinds.
  value.rows[1].kind = "deleted";
  value.rows[3].kind = "added";
  api.compareFiles.mockResolvedValue(value);
  await open();
  expect(document.querySelector(".file-diff-count")!.textContent).toBe("Difference 1 / 4998");
  await userEvent.click(page.getByRole("button", { name: "Next difference", exact: true }));
  await expect.poll(() => visible(6)).toBe(true);
  expect(document.querySelector(".file-diff-count")!.textContent).toBe("Difference 2 / 4998");
  expect(document.querySelectorAll(".file-diff-marker").length).toBeLessThanOrEqual(1200);
  expect(document.querySelectorAll("[data-diff-row]").length).toBeLessThan(100);
});

it("remeasures wrapped rows after font changes and keeps viewport rows covered", async () => {
  await page.viewport(900, 900);
  const value = comparison(300);
  value.rows = value.rows.map((row, index) => ({
    ...row,
    left: "Wide 中文\t".repeat((index % 5) * 20 + 1),
    right: "unbroken".repeat((index % 7) * 15 + 1),
  }));
  api.compareFiles.mockResolvedValue(value);
  await open();
  document.documentElement.style.setProperty("--terminal-font-family", "serif");
  await twoFrames();
  const at = pagePoint(scroller(), 0.75, 0.5);
  await mouse.wheel(at.x, at.y, 1200);
  await twoFrames();
  const viewport = scroller().getBoundingClientRect();
  const boxes = [...document.querySelectorAll<HTMLElement>("[data-diff-row]")].map((row) =>
    row.getBoundingClientRect(),
  );
  for (let y = viewport.top + 1; y < viewport.bottom - 1; y += 9) {
    expect(
      boxes.some((box) => box.top <= y && box.bottom >= y),
      `uncovered viewport point ${y}`,
    ).toBe(true);
  }
  await userEvent.click(page.getByRole("button", { name: "Last line", exact: true }));
  await expect.poll(() => visible(299)).toBe(true);
  expect(document.querySelectorAll("[data-diff-row]").length).toBeLessThan(100);
});
