import { createElement as h } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { page, userEvent } from "vitest/browser";

import App from "../App";
import { defaultShortcuts } from "../shortcuts";
import { tabTitle, useStore, type Tab } from "../store";
import { disposeController } from "../terminalRegistry";
import { browserAfterEach, mount, twoFrames } from "./browserHarness";
import "../styles.css";

/**
 * Naming a tab, end to end: F2 on a tab and on the strip itself, the field
 * arrives preselected, Enter commits and hands focus back to the tab, Escape
 * keeps the old name, an empty or unchanged name does not freeze a custom
 * title, and only the label — never the number or the free gap — opens it.
 */

let serial = 0;
window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
(window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
  metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
  transformCallback: () => ++serial,
  unregisterCallback() {},
  async invoke(command: string) {
    if (command === "plugin:event|listen") return ++serial;
    if (command.startsWith("list_")) return [];
    if (command === "plugin:app|version") return "1.7.7";
    if (command === "portable_mode") return false;
    return null;
  },
};

const initial = useStore.getState();

const tab = (id: string, number: number): Tab => ({
  info: {
    id,
    name: id,
    kind: "ssh",
    protocol: "ssh",
    profileId: "p-" + id,
    address: id + ".internal",
    color: null,
    supportsRemoteFiles: false,
    recording: null,
    legacyAlgorithms: [],
    sharedConnection: false,
  },
  profile: { id: "p-" + id, name: id, kind: "ssh", host: id + ".internal", username: "deploy" },
  number,
  ordinal: 0,
  state: "connected",
  commandActivity: "idle",
  activityKind: "command",
  paneId: "root",
});

const tabElement = (id: string) => document.querySelector<HTMLElement>(`.tab[data-tab-id="${id}"]`);
const label = (id: string) => tabElement(id)?.querySelector<HTMLElement>(".tab-label") ?? null;
const field = () => document.querySelector<HTMLInputElement>(".tab-rename");
const titleOf = (id: string) => useStore.getState().tabs.find((item) => item.info.id === id)?.title;

const press = (element: Element, pointerId: number) => {
  for (const type of ["pointerdown", "pointerup"]) {
    element.dispatchEvent(
      new PointerEvent(type, {
        pointerId,
        button: 0,
        isPrimary: true,
        bubbles: true,
        cancelable: true,
      }),
    );
  }
};

describe("renaming a tab", () => {
  // No saved workspace from another file may restore extra terminals under
  // this test: their mount-time focus would race the one under assertion.
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(async () => {
    await browserAfterEach();
    disposeController("a");
    disposeController("b");
    useStore.setState(initial, true);
  });

  it("renames from the keyboard, from the strip, and only from the label", async () => {
    await page.viewport(1440, 900);
    useStore.getState().setShortcuts(defaultShortcuts());
    useStore.setState({
      ...initial,
      tabs: [tab("a", 1), tab("b", 2)],
      activeId: "a",
      panes: [{ id: "root", activeTabId: "a" }],
      layout: { kind: "leaf", paneId: "root" },
      activePaneId: "root",
      gpuRenderer: false,
      panels: { sessions: false, filer: false, sender: false },
    });
    useStore.getState().setLanguage("en");
    mount(h(App));
    await twoFrames();
    await twoFrames();
    expect(label("a")?.textContent).toBe("a");

    // 1. F2 on the tab: the field arrives focused, with the whole name
    // selected, so typing replaces it rather than appending.
    // The strip owns the keyboard first, the way F6 hands it over. Focusing a
    // tab while the store still points focus at the terminal is not a state
    // the app produces: pointer activation deliberately moves focus into the
    // shell, and a terminal arriving a frame later then pulls it back.
    useStore.getState().setActive("a", "strip");
    tabElement("a")!.focus();
    await twoFrames();
    expect(document.activeElement, "the tab owns the keyboard").toBe(tabElement("a"));
    await userEvent.keyboard("{F2}");
    await twoFrames();
    expect(field(), "F2 starts a rename").not.toBeNull();
    expect(field()!.value).toBe("a");
    expect(document.activeElement, "the field has focus").toBe(field());
    await userEvent.keyboard("deploy db");
    expect(field()!.value, "typing replaced the selected name").toBe("deploy db");

    await userEvent.keyboard("{Enter}");
    await twoFrames();
    expect(field(), "Enter closes the field").toBeNull();
    expect(label("a")?.textContent).toBe("deploy db");
    expect(titleOf("a")).toBe("deploy db");
    expect(tabElement("a")!.getAttribute("aria-label"), "the accessible name follows").toContain(
      "deploy db",
    );
    expect(
      document.activeElement?.closest(".xterm"),
      "a committed name hands the keys to the shell, not to <body>",
    ).not.toBeNull();
    expect(titleOf("b"), "the neighbour never got a custom title").toBeUndefined();

    // 2. F2 with focus on the strip itself (what F6 hands over).
    document.querySelector<HTMLElement>(".tabstrip")!.focus();
    await userEvent.keyboard("{F2}");
    await twoFrames();
    expect(field(), "F2 works from the strip too").not.toBeNull();
    expect(field()!.value, "it edits the shown tab").toBe("deploy db");

    // 3. Escape keeps the old name.
    await userEvent.keyboard("junk");
    await userEvent.keyboard("{Escape}");
    await twoFrames();
    expect(label("a")?.textContent).toBe("deploy db");
    expect(titleOf("a")).toBe("deploy db");
    expect(
      document.activeElement,
      "a cancelled rename leaves focus somewhere real, not on <body>",
    ).not.toBe(document.body);

    // 4. Only the label arms the double press: the number area does not.
    press(tabElement("a")!.querySelector(".tab-index")!, 21);
    press(tabElement("a")!.querySelector(".tab-index")!, 22);
    await twoFrames();
    expect(field(), "pressing the number twice does not rename").toBeNull();

    // 5. Double-pressing the label does open it.
    press(label("a")!, 31);
    press(label("a")!, 32);
    await twoFrames();
    expect(field(), "pressing the label twice renames").not.toBeNull();

    // 6. Committing the default name clears the custom title instead of
    // freezing it.
    await userEvent.keyboard("{Control>}a{/Control}{Backspace}");
    await userEvent.keyboard("{Enter}");
    await twoFrames();
    expect(titleOf("a"), "cleared back to the session name").toBeUndefined();
    expect(label("a")?.textContent).toBe("a");
    // Reset is back to disabled for a tab without a custom name.
    expect(tabTitle(useStore.getState().tabs[0])).toBe("a");
  });
});
