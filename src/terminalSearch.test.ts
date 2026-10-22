import { act, createElement as h } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./platform", () => ({
  HAS_TRAY: true,
  IS_MAC: false,
  IS_WINDOWS: true,
}));

import { SearchOverlay } from "./components/SearchOverlay";
import { useStore, type Tab } from "./store";
import { TerminalController } from "./terminal";
import { disposeController, setController } from "./terminalRegistry";

const SESSION_ID = "search-session";

const hosts: HTMLElement[] = [];

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

/**
 * A controller with its xterm opened in jsdom, so the find engine gets the
 * real selection service (the current match is the terminal selection).
 */
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
  const host = document.createElement("div");
  document.body.append(host);
  hosts.push(host);
  controller.term.open(host);
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

/** Esc pressed in the terminal goes through xterm's key filter. */
function escapeInTerminal(controller: TerminalController): boolean {
  return (
    controller as unknown as {
      keyboard: { filterKey(event: KeyboardEvent): boolean };
    }
  ).keyboard.filterKey(new KeyboardEvent("keydown", { key: "Escape" }));
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
  for (const host of hosts.splice(0)) host.remove();
  document.body.replaceChildren();
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

      // Regex matching and the localized status for an incomplete pattern.
      await act(async () => regexBtn.click());
      expect(regexBtn.getAttribute("aria-pressed")).toBe("true");

      await act(async () => setInputValue(input, "["));
      expect(count.textContent).toBe("Invalid regular expression");

      await act(async () => setInputValue(input, "(error|err):\\s+\\d+"));
      // The current match (the "cat" hit) stays put, so the search resumes
      // at the first match after it.
      expect(count.textContent).toBe("2/3");
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  });

  it("searches only the selection and explains a toggle without one", async () => {
    const controller = createRegisteredController();
    await write(
      controller,
      ["foo 0", "foo 1", "foo 2", "foo 3"].join("\r\n"),
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
      const scopeBtn = host.querySelector<HTMLButtonElement>(
        'button[aria-label="Find in Selection"]',
      )!;

      // No selection yet: the toggle stays off and the box says why.
      await act(async () => scopeBtn.click());
      expect(scopeBtn.getAttribute("aria-pressed")).toBe("false");
      expect(count.textContent).toBe("No selection");

      // A user selection, then a search of all four rows. An incremental
      // search starts from the selection, so it lands on its first match.
      controller.term.selectLines(1, 2);
      await act(async () => setInputValue(input, "foo"));
      expect(count.textContent).toBe("2/4");

      // Find in Selection takes the selection the search replaced.
      await act(async () => scopeBtn.click());
      expect(scopeBtn.getAttribute("aria-pressed")).toBe("true");
      expect(count.textContent).toBe("1/2");

      // Turning it off searches the whole buffer again.
      await act(async () => scopeBtn.click());
      expect(scopeBtn.getAttribute("aria-pressed")).toBe("false");
      expect(count.textContent).toBe("2/4");

      // Alt+L (⌥⌘L on macOS) toggles Find in Selection from the keyboard.
      await act(async () => {
        input.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "l",
            code: "KeyL",
            altKey: true,
            bubbles: true,
          }),
        );
      });
      expect(scopeBtn.getAttribute("aria-pressed")).toBe("true");
      expect(count.textContent).toBe("1/2");
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  });

  it("closes on Esc from the box and from the terminal", async () => {
    const controller = createRegisteredController();
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const onClose = vi.fn();

    try {
      await act(async () => {
        root.render(h(SearchOverlay, { onClose }));
      });

      const input = host.querySelector<HTMLInputElement>("input")!;
      await act(async () => {
        input.focus();
      });
      await act(async () => {
        input.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
        );
      });
      expect(onClose).toHaveBeenCalledTimes(1);
      // Closing from the box hands focus back to the terminal.
      expect(document.activeElement).toBe(controller.term.textarea);

      // Esc pressed in the terminal closes it too, without reaching the shell.
      expect(escapeInTerminal(controller)).toBe(false);
      expect(onClose).toHaveBeenCalledTimes(2);
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  });
});
