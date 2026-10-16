import { act, createElement as h } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./platform", () => ({
  IS_MAC: false,
  IS_WINDOWS: true,
}));

import { SearchOverlay } from "./components/SearchOverlay";
import { useStore, type Tab } from "./store";
import { TerminalController } from "./terminal";
import { disposeController, setController } from "./terminalRegistry";

const SESSION_ID = "search-session";

function createTestTab(id = SESSION_ID): Tab {
  return {
    info: {
      id,
      profileId: "p1",
      name: "Search Test",
      color: null,
      protocol: "SSH",
      address: "127.0.0.1:22",
      kind: "ssh",
      supportsRemoteFiles: true,
      recording: null,
      sharedConnection: false,
      legacyAlgorithms: [],
    },
    profile: {
      id: "p1",
      name: "Search Test",
      kind: "ssh",
      host: "127.0.0.1",
      port: 22,
      username: "user",
      auth: "password",
    },
    number: 1,
    ordinal: 0,
    state: "connected",
    commandActivity: "idle",
    activityKind: "command",
    cols: 80,
    rows: 24,
    paneId: "main",
  };
}

function createRegisteredController(id = SESSION_ID) {
  const controller = new TerminalController(
    id,
    {
      onData() {},
      onResize() {},
      onStatus() {},
      onCommand() {},
      onCommandState() {},
      suggest: () => [],
      forgetSuggestion() {},
    },
    13,
    100,
  );
  // xterm's SelectionService is only instantiated by term.open() in a real
  // browser; stand in for the selection state so SearchAddon can select
  // matches in jsdom while running its real SearchEngine and result tracker.
  let selection: { col: number; row: number; length: number } | null = null;
  vi.spyOn(controller.term, "select").mockImplementation((col, row, length) => {
    selection = { col, row, length };
  });
  vi.spyOn(controller.term, "clearSelection").mockImplementation(() => {
    selection = null;
  });
  vi.spyOn(controller.term, "getSelectionPosition").mockImplementation(() =>
    selection
      ? {
          start: { x: selection.col, y: selection.row },
          end: { x: selection.col + selection.length, y: selection.row },
        }
      : undefined,
  );
  setController(id, controller);
  return controller;
}

function write(controller: TerminalController, text: string): Promise<void> {
  return new Promise((resolve) => controller.term.write(text, resolve));
}

function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;
  useStore.setState({
    tabs: [createTestTab()],
    activeId: SESSION_ID,
  });
});

afterEach(() => {
  disposeController(SESSION_ID);
});

describe("terminal search options", () => {
  it("toggles case-sensitive, whole-word and regex matching through SearchOverlay on a real xterm buffer", async () => {
    const controller = createRegisteredController();
    await write(
      controller,
      [
        "Error: 404 cat catalog",
        "error: 500 Concatenate",
        "ERR: 200 ok",
      ].join("\r\n"),
    );

    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);

    try {
      await act(async () => {
        root.render(h(SearchOverlay, { onClose() {} }));
      });

      const input = host.querySelector<HTMLInputElement>("input")!;
      const count = host.querySelector<HTMLElement>(".search-count")!;
      const matchCaseBtn = host.querySelector<HTMLButtonElement>(
        'button[aria-label="Match Case"]',
      )!;
      const wholeWordBtn = host.querySelector<HTMLButtonElement>(
        'button[aria-label="Match Whole Word"]',
      )!;
      const regexBtn = host.querySelector<HTMLButtonElement>(
        'button[aria-label="Use Regular Expression"]',
      )!;

      // Case-insensitive by default ("Error" and "error"), then narrowed by Match Case.
      await act(async () => setInputValue(input, "error"));
      expect(count.textContent).toBe("1/2");
      expect(matchCaseBtn.getAttribute("aria-pressed")).toBe("false");

      await act(async () => matchCaseBtn.click());
      expect(matchCaseBtn.getAttribute("aria-pressed")).toBe("true");
      expect(count.textContent).toBe("1/1");

      // Theme refresh preserves the active search options.
      await act(async () => controller.setTheme("light"));
      expect(count.textContent).toBe("1/1");

      await act(async () => matchCaseBtn.click());
      expect(count.textContent).toBe("2/2");

      // Whole-word matching excludes "catalog" and "Concatenate" when searching "cat".
      await act(async () => setInputValue(input, "cat"));
      expect(count.textContent).toBe("3/3");

      await act(async () => wholeWordBtn.click());
      expect(wholeWordBtn.getAttribute("aria-pressed")).toBe("true");
      expect(count.textContent).toBe("1/1");

      await act(async () => wholeWordBtn.click());
      expect(count.textContent).toBe("1/3");

      // Regex matching and safe handling of an incomplete regular expression.
      await act(async () => regexBtn.click());
      expect(regexBtn.getAttribute("aria-pressed")).toBe("true");

      await act(async () => setInputValue(input, "["));
      expect(count.textContent).toBe("No results");

      await act(async () => setInputValue(input, "(error|err):\\s+\\d+"));
      expect(count.textContent).toBe("1/3");
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  });
});
