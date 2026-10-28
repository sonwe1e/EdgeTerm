import type { Terminal } from "@xterm/xterm";

// xterm 6's DOM fallback measures one glyph at a time by mutating a span and
// reading offsetWidth. On a first show that forces layout for every distinct
// glyph. Batch those exact measurements for the visible cells before painting.
// If xterm's private cache changes, skip this optimization and let xterm work
// as usual. The existing cache still owns invalidation on font/size changes.
type WidthCache = {
  _flat: Float32Array;
  _holey: Map<string, number>;
  _container: HTMLElement;
  _measureElements: HTMLElement[];
};
type SelectionState = {
  start?: [number, number];
  end?: [number, number];
  columnSelectMode: boolean;
};
type DomRenderer = {
  _widthCache?: WidthCache;
  renderRows(start: number, end: number): void;
  handleSelectionChanged?(
    start: SelectionState["start"],
    end: SelectionState["end"],
    column: boolean,
  ): void;
};

const MAX_GLYPHS = 256;
const CACHE_UNSET = -9999;
const MEASURE_REPEATS = 32;

export function paintVisibleDomRenderer(term: Terminal) {
  const core = (
    term as unknown as {
      _core?: {
        coreService?: { decPrivateModes?: { synchronizedOutput?: boolean } };
        _renderService?: {
          _renderer?: { value?: DomRenderer };
          _selectionState?: SelectionState;
        };
      };
    }
  )._core;
  const service = core?._renderService;
  const renderer = service?._renderer?.value;
  const cache = renderer?._widthCache;
  const buffer = term.buffer?.active;
  if (
    !renderer ||
    typeof renderer.renderRows !== "function" ||
    !cache ||
    !(cache._flat instanceof Float32Array) ||
    !(cache._holey instanceof Map) ||
    !(cache._container instanceof HTMLElement) ||
    !Array.isArray(cache._measureElements) ||
    cache._measureElements.length !== 4 ||
    core?.coreService?.decPrivateModes?.synchronizedOutput ||
    !buffer ||
    term.rows < 1
  )
    return;

  const pending = new Map<string, { chars: string; variant: number; flat: number | null }>();
  const cell = buffer.getNullCell();
  for (let row = buffer.viewportY; row < buffer.viewportY + term.rows; row++) {
    const line = buffer.getLine(row);
    if (!line) break;
    for (let col = 0; col < term.cols && pending.size < MAX_GLYPHS; col++) {
      if (!line.getCell(col, cell) || cell.getWidth() === 0) continue;
      let chars = cell.getChars() || " ";
      if (chars === " " && (cell.isUnderline() || cell.isOverline())) chars = "\u00a0";
      const bold = !!cell.isBold();
      const italic = !!cell.isItalic();
      const variant = (bold ? 1 : 0) | (italic ? 2 : 0);
      const flat =
        !variant && chars.length === 1 && chars.charCodeAt(0) < cache._flat.length
          ? chars.charCodeAt(0)
          : null;
      const key = chars + (bold ? "B" : "") + (italic ? "I" : "");
      if (flat !== null ? cache._flat[flat] !== CACHE_UNSET : cache._holey.has(key)) continue;
      pending.set(key, { chars, variant, flat });
    }
    if (pending.size >= MAX_GLYPHS) break;
  }

  const spans: { key: string; element: HTMLElement; flat: number | null }[] = [];
  const fragment = document.createDocumentFragment();
  for (const [key, { chars, variant, flat }] of pending) {
    const template = cache._measureElements[variant];
    if (!(template instanceof HTMLElement)) return;
    const element = template.cloneNode(false) as HTMLElement;
    element.textContent = chars.repeat(MEASURE_REPEATS);
    fragment.appendChild(element);
    spans.push({ key, element, flat });
  }
  cache._container.appendChild(fragment);
  // All text is in the DOM before the first read, so the browser can satisfy
  // these measurements with one layout rather than one layout per glyph.
  try {
    for (const { key, element, flat } of spans) {
      const width = element.offsetWidth / MEASURE_REPEATS;
      if (width <= 0) continue;
      if (flat === null) cache._holey.set(key, width);
      else cache._flat[flat] = width;
    }
  } finally {
    for (const { element } of spans) element.remove();
  }
  // The fallback may have missed xterm's hidden resize paint. The host is
  // visible now, so paint its buffer even if IntersectionObserver is late.
  const selection = service?._selectionState;
  if (selection && typeof renderer.handleSelectionChanged === "function") {
    renderer.handleSelectionChanged(selection.start, selection.end, selection.columnSelectMode);
  } else {
    renderer.renderRows(0, term.rows - 1);
  }
}
