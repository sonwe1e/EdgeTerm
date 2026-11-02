import { describe, expect, it } from "vitest";

// Real Chromium, real stylesheet, real boxes: jsdom has no layout engine, so
// only a browser can answer whether the list gives its name the room the
// metadata does not need. This is the contract behind the docked Filer's one
// row shape: a 16px type icon, the name as the flexible middle, and one quiet
// metadata cluster pinned to the row's right edge. There are no column
// captions and no column resizers — the table with those is the dual-pane
// view, and this list is the navigator beside the terminal.
import "../styles.css";
import { formatBytes, formatDate } from "../components/panels/filerPresentation";

const PITCH = 26;

const day = 86_400;
const ago = (days: number) => Math.floor(Date.now() / 1000) - days * day;

const ENTRIES = [
  { name: "notes.txt", size: 812, modified: ago(0), isDir: false },
  { name: "EdgeTerm_1.6.1_x64-setup.exe", size: 4_184_827, modified: ago(0), isDir: false },
  { name: "screenshot-of-the-editor.png", size: 12.4 * 1024 ** 2, modified: ago(40), isDir: false },
  { name: "archive.tar.gz", size: 1023.9 * 1024, modified: ago(1), isDir: false },
  { name: "a-folder-with-a-long-name", size: 0, modified: ago(500), isDir: true },
];

function rowMarkup(entry: (typeof ENTRIES)[number]): string {
  const meta = entry.isDir ? "" : `<span class="filer-meta-size">${formatBytes(entry.size)}</span>`;
  return `<div class="row filer-entry">
      <span class="filer-icon"></span>
      <span class="row-label">${entry.name}</span>
      <span class="filer-row-meta row-meta">${meta}<span class="filer-meta-date">${formatDate(entry.modified)}</span></span>
    </div>`;
}

interface Options {
  width?: number;
  font?: number;
  hidden?: boolean;
  virtual?: boolean;
}

/** Mounts the panel's own markup at a width and returns its live nodes. */
function mountFiler(options: Options = {}) {
  const { width = 300, font = 12, hidden = false, virtual = false } = options;
  const app = document.createElement("div");
  app.className = "app";
  app.style.width = `${width}px`;
  app.style.setProperty("--panel-font-size", `${font}px`);
  const rows = ENTRIES.map((entry, index) =>
    virtual
      ? `<div data-file-path="${entry.name}" style="position:absolute;top:${index * PITCH}px;left:0;right:0;height:${PITCH}px">${rowMarkup(entry)}</div>`
      : rowMarkup(entry),
  ).join("");
  app.innerHTML = `<div class="panel filer-panel" style="width:100%;height:600px"${hidden ? ' data-size-hidden=""' : ""}>
      <div class="panel-body filer-list" role="listbox">
        <div class="virtual-file-rows"${virtual ? ` style="position:relative;height:${ENTRIES.length * PITCH}px"` : ""}>${rows}</div>
      </div>
    </div>`;
  document.body.append(app);
  const list = app.querySelector<HTMLElement>(".filer-list")!;
  const entries = [...app.querySelectorAll<HTMLElement>(".filer-entry")];
  const box = (element: HTMLElement) => element.getBoundingClientRect();
  return {
    app,
    list,
    entries,
    label: (index: number) => entries[index].querySelector<HTMLElement>(".row-label")!,
    cluster: (index: number) => entries[index].querySelector<HTMLElement>(".filer-row-meta")!,
    date: (index: number) => entries[index].querySelector<HTMLElement>(".filer-meta-date")!,
    size: (index: number) => entries[index].querySelector<HTMLElement>(".filer-meta-size"),
    box,
    /** The inked box of a text element, which is what the eye compares. */
    ink: (element: HTMLElement) => {
      const range = document.createRange();
      range.selectNodeContents(element);
      return range.getBoundingClientRect();
    },
  };
}

describe("the docked Filer's list rows", () => {
  it("stacks rows one pitch apart in the flow layout", () => {
    const filer = mountFiler();
    const tops = filer.entries.map((entry) => filer.box(entry).top);
    for (let index = 1; index < tops.length; index += 1) {
      expect(tops[index] - tops[index - 1]).toBeCloseTo(PITCH, 1);
    }
  });

  it("gives the name the room the metadata does not need", () => {
    const narrow = mountFiler({ width: 300 });
    const wide = mountFiler({ width: 420 });
    const narrowName = narrow.box(narrow.label(0)).width;
    const wideName = wide.box(wide.label(0)).width;
    // The extra 120px of dock goes to the name, not to the metadata.
    expect(wideName - narrowName).toBeGreaterThan(100);
    // The cluster's right edge is the row's own edge in both widths.
    for (const filer of [narrow, wide]) {
      const row = filer.box(filer.entries[0]);
      const cluster = filer.box(filer.cluster(0));
      expect(Math.abs(cluster.right - (row.right - 6))).toBeLessThanOrEqual(1.5);
    }
  });

  it("hands the size's room back to the name when the size is hidden", () => {
    const shown = mountFiler({ width: 300 });
    const hidden = mountFiler({ width: 300, hidden: true });
    expect(hidden.box(hidden.label(0)).width).toBeGreaterThan(shown.box(shown.label(0)).width + 24);
    // The date keeps the row's right edge; hiding a neighbour never moves it.
    expect(
      Math.abs(hidden.box(hidden.date(0)).right - shown.box(shown.date(0)).right),
    ).toBeLessThan(1.5);
    // The slot stays in the markup and leaves the layout: that is what hands
    // its room to the name, and what the row's flex measures.
    expect(getComputedStyle(hidden.size(0)!).display).toBe("none");
    expect(getComputedStyle(shown.size(0)!).display).not.toBe("none");
  });

  it("keeps every row's moment on the same right edge", () => {
    const filer = mountFiler({ width: 300 });
    const rights = ENTRIES.map((entry, index) =>
      entry.isDir ? filer.box(filer.cluster(index)).right : filer.box(filer.date(index)).right,
    );
    for (const right of rights) expect(Math.abs(right - rights[0])).toBeLessThan(1.5);
  });

  it("truncates a long name instead of pushing the metadata out of the row", () => {
    const filer = mountFiler({ width: 300 });
    const long = filer.label(1);
    // Ellipsis is layout: the text box is narrower than the text itself.
    expect(long.scrollWidth).toBeGreaterThan(long.clientWidth);
    expect(filer.list.scrollWidth).toBeLessThanOrEqual(filer.list.clientWidth + 1);
    expect(filer.box(filer.cluster(1)).right).toBeLessThanOrEqual(
      filer.box(filer.entries[1]).right - 5,
    );
  });

  it("survives the panel's largest font without spilling sideways", () => {
    const filer = mountFiler({ width: 300, font: 18 });
    expect(filer.list.scrollWidth).toBeLessThanOrEqual(filer.list.clientWidth + 1);
    // The metadata grows with the panel font; it is still printed at full size.
    const meta = getComputedStyle(filer.cluster(0));
    expect(meta.fontSize).toBe("16px");
    expect(filer.box(filer.label(0)).width).toBeGreaterThan(60);
    expect(filer.box(filer.cluster(0)).right).toBeLessThanOrEqual(
      filer.box(filer.entries[0]).right - 5,
    );
  });

  it("keeps the row inside the dock at its minimum width", () => {
    const filer = mountFiler({ width: 150, hidden: true });
    expect(filer.list.scrollWidth).toBeLessThanOrEqual(filer.list.clientWidth + 1);
    const name = filer.label(1);
    expect(name.scrollWidth).toBeGreaterThan(name.clientWidth);
    expect(filer.box(filer.cluster(1)).right).toBeLessThanOrEqual(
      filer.box(filer.entries[1]).right - 5,
    );
  });

  it("keeps the virtualised rows inside their 26px slots", () => {
    const filer = mountFiler({ virtual: true });
    for (const entry of filer.entries) {
      expect(filer.box(entry).height).toBeLessThanOrEqual(PITCH);
    }
    expect(filer.box(filer.entries[1]).top - filer.box(filer.entries[0]).top).toBeCloseTo(PITCH, 1);
  });
});
