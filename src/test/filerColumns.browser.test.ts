import { describe, expect, it } from "vitest";

// Real Chromium, real stylesheet, real boxes: jsdom has no layout engine and
// cannot answer whether a column is a column. This is the contract behind the
// Filer's three-column grid — the caption row and every data row must place
// the same tracks at the same x, whether the listing is short enough to be
// laid out in flow or long enough to be virtualised (rows absolutely placed
// inside the row container).
//
// It deliberately repeats the widths the rows print: `1.2 MB` and `1023.9 KB`
// are not the same number of characters, and `14:32`, `yesterday`, `Oct 20`
// and `2023/12/31` are not either. Under the flex layout this replaced, each
// row took its own content width and every column wandered.
import "../styles.css";
import { formatBytes, formatDate } from "../components/panels/filerPresentation";

const ROW_HEIGHT = 26;
const day = 86_400;
const ago = (days: number) => Math.floor(Date.now() / 1000) - days * day;

const ENTRIES = [
  { name: "notes.txt", size: 812, modified: ago(0) },
  { name: "archive.tar.gz", size: 1023.9 * 1024, modified: ago(1) },
  { name: "screenshot.png", size: 12.4 * 1024 ** 2, modified: ago(40) },
  { name: "old-index.zip", size: 3 * 1024 ** 3, modified: ago(500) },
];

function rowsMarkup(virtual: boolean): string {
  return ENTRIES.map((entry, index) => {
    // The trailing span is the kind, said for screen readers alone: the icon
    // carries it by sight and nothing else does. It is absolutely placed, so
    // the grid gives it no track of its own.
    const cells = `<span class="filer-icon"></span>
        <span class="row-label">${entry.name}</span>
        <span class="filer-col-size row-meta">${formatBytes(entry.size)}</span>
        <span class="filer-col-date row-meta">${formatDate(entry.modified)}</span>
        <span class="sr-only">File</span>`;
    const row = `<div class="row filer-entry">${cells}</div>`;
    // The virtualiser wraps each row in an absolutely placed slot.
    return virtual
      ? `<div data-file-path="${entry.name}" style="position:absolute;top:${index * ROW_HEIGHT}px;width:100%;height:${ROW_HEIGHT}px">${row}</div>`
      : row;
  }).join("\n      ");
}

/** Mounts the panel's own markup at `width` and returns its live nodes. */
function mountFiler(width: number, virtual: boolean) {
  const app = document.createElement("div");
  app.className = "app";
  app.style.width = `${width}px`;
  // The virtualiser places its rows inside a positioned row container; that
  // container is what makes `width: 100%` on a slot mean "as wide as the
  // list", exactly as it does for a row laid out in flow.
  const container = virtual
    ? ` style="position:relative;height:${ENTRIES.length * ROW_HEIGHT}px;overflow-anchor:none"`
    : "";
  app.innerHTML = `<div class="panel filer-panel">
      <div class="filer-columns">
        <div class="filer-col-cell is-name"><button type="button" class="filer-col-name">Name</button></div>
        <div class="filer-col-cell is-size"><button type="button" class="filer-col-size">Size <span class="icon"></span></button></div>
        <div class="filer-col-cell is-date"><button type="button" class="filer-col-date">Modified <span class="icon"></span></button></div>
      </div>
      <div class="panel-body filer-list" role="listbox">
        <div class="virtual-file-rows"${container}>${rowsMarkup(virtual)}</div>
      </div>
    </div>`;
  document.body.append(app);
  return {
    app,
    caption: (column: string) => app.querySelector<HTMLElement>(`.filer-columns .${column}`)!,
    cell: (column: string) => [...app.querySelectorAll<HTMLElement>(`.filer-entry .${column}`)],
    labels: () => [...app.querySelectorAll<HTMLElement>(".filer-entry .row-label")],
    /** The inked box of a cell's text, which is what the eye compares. */
    ink: (element: HTMLElement) => {
      const range = document.createRange();
      range.selectNodeContents(element);
      return range.getBoundingClientRect();
    },
  };
}

describe("the Filer's three columns", () => {
  for (const virtual of [false, true]) {
    it(`${virtual ? "virtualised" : "in flow"}, the captions sit over their own column`, () => {
      const filer = mountFiler(420, virtual);
      for (const column of ["filer-col-name", "filer-col-size", "filer-col-date"]) {
        const caption = filer.caption(column).getBoundingClientRect();
        for (const cell of filer.cell(column)) {
          const box = cell.getBoundingClientRect();
          expect(box.left).toBeCloseTo(caption.left, 1);
          expect(box.right).toBeCloseTo(caption.right, 1);
        }
      }
      filer.app.remove();
    });

    it(`${virtual ? "virtualised" : "in flow"}, the text aligns even though every row differs`, () => {
      const filer = mountFiler(420, virtual);
      for (const column of ["filer-col-size", "filer-col-date"]) {
        const caption = filer.ink(filer.caption(column));
        const inks = filer.cell(column).map((cell) => filer.ink(cell));
        expect(inks.length).toBe(ENTRIES.length);
        for (const box of inks) {
          expect(box.right).toBeCloseTo(caption.right, 1);
        }
      }
      // The caption starts with the names, not with the icon beside them.
      const name = filer.ink(filer.caption("filer-col-name"));
      for (const label of filer.labels()) {
        expect(filer.ink(label).left).toBeCloseTo(name.left, 1);
      }
      filer.app.remove();
    });

    it(`${virtual ? "virtualised" : "in flow"}, the columns stay clear of each other`, () => {
      const filer = mountFiler(240, virtual);
      const caption = (column: string) => filer.caption(column).getBoundingClientRect();
      expect(caption("filer-col-size").left - caption("filer-col-name").right).toBeGreaterThan(5);
      expect(caption("filer-col-date").left - caption("filer-col-size").right).toBeGreaterThan(5);
      // Nothing runs past the panel: the caption and all four rows end inside.
      const panel = filer.app.querySelector<HTMLElement>(".filer-panel")!.getBoundingClientRect();
      for (const element of [filer.caption("filer-col-date"), ...filer.cell("filer-col-date")]) {
        expect(element.getBoundingClientRect().right).toBeLessThanOrEqual(panel.right);
      }
      filer.app.remove();
    });
  }

  // The pitch the virtualiser walks is the row's own height plus 2px, and
  // FilerPanel derives it from the same panel font this sheet does, so any
  // drift between the two shows up once a listing is long enough to be
  // windowed. The flow list matches it because `.filer-entry + .filer-entry`
  // puts back the pixel that two adjoining 1px margins would otherwise collapse
  // away — one density whichever path a listing takes.
  for (const font of [12, 20]) {
    it(`stacks rows one pitch apart at a ${font}px panel font`, () => {
      const filer = mountFiler(420, false);
      filer.app.style.setProperty("--panel-font-size", `${font}px`);
      const drawn = filer.cell("filer-col-size").map((cell) => {
        const row = cell.closest<HTMLElement>(".filer-entry")!;
        return row.getBoundingClientRect();
      });
      expect(drawn.length).toBe(ENTRIES.length);
      const expected = Math.max(24, font + 10);
      for (const box of drawn) expect(box.height).toBeCloseTo(expected, 1);
      for (let index = 1; index < drawn.length; index++) {
        expect(drawn[index].top - drawn[index - 1].top).toBeCloseTo(expected + 2, 1);
      }
      filer.app.remove();
    });
  }

  // The caption has to fit the track it names, arrow and all — otherwise it is
  // the one thing in the row that is clipped while the dates below it are not.
  // (`MODIFIED` plus a 16px arrow is wider than any date this column prints.)
  for (const font of [12, 20]) {
    it(`fits its captions inside their own tracks at a ${font}px panel font`, () => {
      const filer = mountFiler(420, false);
      filer.app.style.setProperty("--panel-font-size", `${font}px`);
      for (const column of ["filer-col-size", "filer-col-date"]) {
        const caption = filer.caption(column);
        expect(filer.ink(caption).width).toBeLessThanOrEqual(
          caption.getBoundingClientRect().width,
        );
      }
      filer.app.remove();
    });
  }

  // The list scrolls and the caption row above it does not, so a classic
  // scrollbar takes its width out of the rows and not out of the captions —
  // which is how every right-hand column came to sit a scrollbar left of its
  // own heading. The panel measures the gutter at run time and the caption row
  // spends it on its right padding.
  // Spent on the caption row's right padding only: the rows keep their own
  // width, so a caption that moves 10px left lands on column that lost 10px to
  // a scrollbar. (Whether a scrollbar takes space at all is the platform's
  // choice; where it takes none the measured value is 0 and nothing moves.)
  it("follows the list's scrollbar with the caption row", () => {
    const filer = mountFiler(420, false);
    const columns = filer.app.querySelector<HTMLElement>(".filer-columns")!;
    const caption = () => filer.caption("filer-col-date").getBoundingClientRect();
    const row = () => filer.cell("filer-col-date")[0].getBoundingClientRect();
    const before = { caption: caption().right, row: row().right };
    columns.style.setProperty("--filer-sb-w", "10px");
    expect(caption().right).toBeCloseTo(before.caption - 10, 1);
    expect(row().right).toBeCloseTo(before.row, 1);
    filer.app.remove();
  });

  it("keeps the grid together when the panel font grows", () => {
    const filer = mountFiler(420, false);
    filer.app.style.setProperty("--panel-font-size", "20px");
    const size = filer.caption("filer-col-size").getBoundingClientRect();
    for (const cell of filer.cell("filer-col-size")) {
      const box = cell.getBoundingClientRect();
      expect(box.width).toBeCloseTo(size.width, 1);
      // The widest formatted size still fits the track it was given.
      const text = filer.ink(cell);
      expect(text.width).toBeLessThanOrEqual(box.width);
    }
    filer.app.remove();
  });
});
