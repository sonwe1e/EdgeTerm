import { afterEach, expect, it, vi } from "vitest";
import { auditLayout } from "./layout-audit.mjs";

let fixture;

afterEach(() => {
  fixture?.remove();
  vi.restoreAllMocks();
});

const measure = () =>
  auditLayout(
    { evaluate: async (fn, config) => fn(config) },
    {
      scene: "grid-contract",
      rowGroups: [
        {
          selector: ".monitor-tile",
          count: 4,
          fit: true,
          rowPitch: true,
          grid: { within: ".monitor-grid", rows: 2, columns: 2, gapVar: "--sp-8" },
        },
      ],
    },
  );

function grid({ height = 90.09, rowGap = 8, columnGap = 8, columns = 2 } = {}) {
  fixture = document.createElement("div");
  fixture.className = "monitor-grid";
  fixture.style.setProperty("--sp-8", "8px");
  const boxes = Array.from({ length: 4 }, (_, index) => ({
    x: 20 + (index % columns) * (240 + columnGap),
    y: 20 + Math.floor(index / columns) * (height + rowGap),
    width: 240,
    height,
  }));
  boxes.forEach((box) => {
    const tile = document.createElement("div");
    tile.className = "monitor-tile";
    vi.spyOn(tile, "getBoundingClientRect").mockImplementation(() => DOMRect.fromRect(box));
    for (const [name, value] of Object.entries({
      clientWidth: 238,
      scrollWidth: 238,
      clientHeight: Math.round(height - 2),
      scrollHeight: Math.round(height - 2),
    })) {
      Object.defineProperty(tile, name, { configurable: true, value });
    }
    fixture.append(tile);
  });
  document.body.append(fixture);
  return boxes;
}

it.each([90.09, 92.09])(
  "keeps a content-sized 2 by 2 grid valid at tile height %s",
  async (height) => {
    grid({ height });
    const result = await measure();
    expect(result.failures).toEqual([]);
    expect(result.assertions.find(({ id }) => id.endsWith(".grid.shape"))?.pass).toBe(true);
    expect(result.rows[0].expected).toBeCloseTo(height + 8, 2);
    expect(result.rows[0].grid.rowGaps).toEqual([8]);
    expect(result.rows[0].grid.columnGaps).toEqual([8, 8]);
  },
);

it.each([
  [{ rowGap: 12 }, ".grid.rowGap"],
  [{ columnGap: 12 }, ".grid.columnGap"],
  [{ columns: 1 }, ".grid.shape"],
])("rejects a grid that breaks its spacing or shape: %j", async (options, failure) => {
  grid(options);
  const result = await measure();
  expect(result.assertions.find(({ id }) => id.endsWith(failure))?.pass).toBe(false);
});

it("rejects unequal card heights rather than accepting any measured pitch", async () => {
  const boxes = grid();
  boxes[0].height -= 4;
  const result = await measure();
  expect(result.assertions.find(({ id }) => id.endsWith(".grid.equalHeight"))?.pass).toBe(false);
});

it("fails closed when the spacing token or the grid is missing", async () => {
  grid();
  fixture.style.removeProperty("--sp-8");
  const missingToken = await measure();
  expect(missingToken.assertions.find(({ id }) => id.endsWith(".grid.gapToken"))?.pass).toBe(false);
  fixture.remove();
  const missingGrid = await measure();
  expect(missingGrid.assertions.find(({ id }) => id.endsWith(".grid.present"))?.pass).toBe(false);
});

it("retains the existing content-fit gate alongside the new grid contract", async () => {
  grid();
  Object.defineProperty(fixture.firstElementChild, "scrollHeight", { value: 200 });
  const result = await measure();
  expect(result.assertions.find(({ id }) => id.endsWith(".fit"))?.pass).toBe(false);
});
