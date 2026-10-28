import type { Terminal } from "@xterm/xterm";
import { expect, it, vi } from "vitest";
import { paintVisibleDomRenderer } from "./terminalDomRenderer";

it("does not paint a partially updated synchronized-output frame", () => {
  const renderRows = vi.fn();
  const modes = { synchronizedOutput: true };
  const term = {
    rows: 1,
    cols: 1,
    buffer: { active: { viewportY: 0, getNullCell: () => ({}), getLine: () => undefined } },
    _core: {
      coreService: { decPrivateModes: modes },
      _renderService: {
        _renderer: {
          value: {
            renderRows,
            _widthCache: {
              _flat: new Float32Array(256),
              _holey: new Map(),
              _container: document.createElement("div"),
              _measureElements: Array.from({ length: 4 }, () => document.createElement("span")),
            },
          },
        },
      },
    },
  } as unknown as Terminal;

  paintVisibleDomRenderer(term);
  expect(renderRows).not.toHaveBeenCalled();
  modes.synchronizedOutput = false;
  paintVisibleDomRenderer(term);
  expect(renderRows).toHaveBeenCalledOnce();
});
