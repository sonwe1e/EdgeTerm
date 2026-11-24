import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureController } from "../actions";
import { focusNextRegion } from "../focusRegions";
import { leaf } from "../layout";
import { useStore, type Tab } from "../store";
import type { TerminalController } from "../terminal";
import { disposeController, setController } from "../terminalRegistry";
import { Workspace } from "./Workspace";

vi.mock("../platform", () => ({ HAS_TRAY: true, IS_MAC: false, IS_WINDOWS: true }));
vi.mock("../api", async (original) => ({
  ...(await original<typeof import("../api")>()),
  listSenderCommands: vi.fn(async () => []),
}));
vi.mock("../actions", async (original) => {
  const actual = await original<typeof import("../actions")>();
  return { ...actual, ensureController: vi.fn(actual.ensureController) };
});

const initialState = useStore.getState();
const ids = ["focus-a", "focus-b", "focus-c"];
const react = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
const mountWorkspace = () =>
  h(Workspace, { onNewSession: vi.fn(), onSaveSession: vi.fn(), onOpenProfile: vi.fn() });
const nextFrame = () =>
  act(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));

function makeTab(id: string): Tab {
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
    paneId: "main",
  };
}

function makeController() {
  const input = document.createElement("textarea");
  input.className = "xterm-helper-textarea";
  const controller = {
    attach: (host: HTMLElement) => host.append(input),
    focus: () => input.focus(),
    dispose: () => input.remove(),
    fit() {},
    setVisible() {},
    setLocked() {},
    setGutterMode() {},
    setFontSize() {},
    setLineHeight() {},
    setFontFamily() {},
    setScrollback() {},
    setCursor() {},
    setSuggestions() {},
    setPasteWarning() {},
    setCopyOnSelect() {},
    setProgramClipboard() {},
    setRightClickAction() {},
    // The "jump to latest" pill asks the controller where the viewport is;
    // this stub never scrolls, so it is always at the live end.
    isAtBottom: () => true,
    scrollToBottom() {},
    onScrollState: () => () => {},
  } as unknown as TerminalController;
  return { input, controller };
}

describe("workspace tab focus", () => {
  let host: HTMLDivElement;
  let root: Root;
  let terminals: ReturnType<typeof makeController>[];
  let labels: HTMLElement[];
  const mountedState = () => ({
    tabs: ids.map(makeTab),
    activeId: ids[0],
    panes: [{ id: "main", activeTabId: ids[0] }],
    layout: leaf("main"),
    activePaneId: "main",
  });
  const key = (from: number, value: string) =>
    labels[from].dispatchEvent(
      new KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true }),
    );
  const pointer = (to: number) => {
    labels[to].dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    // jsdom does not synthesize tabindex focus from mouse input.
    labels[to].focus();
  };
  const selectByArrow = () => {
    labels[0].focus();
    act(() => {
      key(0, "ArrowRight");
    });
  };
  const mount = async () => {
    await act(async () => root.render(mountWorkspace()));
    await nextFrame();
    labels = ids.map((id) => host.querySelector<HTMLElement>(`#tab-${id}`)!);
    expect(document.activeElement).toBe(terminals[0].input);
  };

  beforeEach(() => {
    HTMLElement.prototype.scrollIntoView ??= () => {};
    react.IS_REACT_ACT_ENVIRONMENT = true;
    vi.clearAllMocks();
    localStorage.clear();
    useStore.setState({ ...initialState, ...mountedState(), language: "en" }, true);
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    terminals = ids.map(() => makeController());
    terminals.forEach(({ controller }, i) => setController(ids[i], controller));
  });

  afterEach(() => {
    act(() => root.unmount());
    for (const id of ids) disposeController(id);
    host.remove();
    useStore.setState(initialState, true);
    react.IS_REACT_ACT_ENVIRONMENT = false;
  });

  it("hands the keyboard back to the terminal when a background tab closes", async () => {
    await mount();
    // The tab's close control had focus; closing removes it, so focus falls to
    // the document unless something claims it. The shown session keeps the
    // keyboard, and the next keystroke must not vanish.
    labels[1].focus();
    await act(async () => {
      await useStore.getState().closeTab(ids[1]);
    });
    await nextFrame();
    expect(document.activeElement).toBe(terminals[0].input);
  });

  it("keeps focus on roving labels across terminal frames and repeated End/Home", async () => {
    await mount();
    selectByArrow();
    expect(document.activeElement).toBe(labels[1]);
    await nextFrame();
    expect(document.activeElement).toBe(labels[1]);
    act(() => {
      key(1, "End");
    });
    await nextFrame();
    expect(document.activeElement).toBe(labels[2]);
    expect(useStore.getState().activeId).toBe(ids[2]);
    act(() => {
      key(2, "Home");
    });
    await nextFrame();
    expect(document.activeElement).toBe(labels[0]);
    expect(useStore.getState().activeId).toBe(ids[0]);
  });

  it.each(["pointer", "programmatic"] as const)(
    "focuses the terminal after %s activation",
    async (mode) => {
      await mount();
      act(() => (mode === "pointer" ? pointer(1) : useStore.getState().setActive(ids[1])));
      expect(useStore.getState().activeId).toBe(ids[1]);
      await nextFrame();
      expect(document.activeElement).toBe(terminals[1].input);
    },
  );

  it.each(["pointer", "Enter", "programmatic"] as const)(
    "lets %s on the already selected label enter the terminal",
    async (mode) => {
      await mount();
      selectByArrow();
      await nextFrame();
      expect(document.activeElement).toBe(labels[1]);
      act(() => {
        if (mode === "pointer") pointer(1);
        else if (mode === "Enter") key(1, "Enter");
        else useStore.getState().setActive(ids[1]);
      });
      await nextFrame();
      expect(document.activeElement).toBe(terminals[1].input);
    },
  );

  it("does not override explicit focus movement before the activation frame", async () => {
    await mount();
    const other = document.createElement("button");
    host.append(other);
    selectByArrow();
    other.focus();
    await nextFrame();
    expect(document.activeElement).toBe(other);
  });

  it("honors consecutive F6 region moves before the activation frame", async () => {
    await mount();
    const other = document.createElement("button");
    other.dataset.focusRegion = "other";
    host.append(other);
    const region = (node: HTMLElement) => node.closest<HTMLElement>("[data-focus-region]")!;
    selectByArrow();
    for (const node of [region(labels[1]), region(terminals[1].input), other]) {
      vi.spyOn(node, "getClientRects").mockReturnValue([new DOMRect()] as unknown as DOMRectList);
    }
    expect(focusNextRegion(1)).toBe(true);
    expect(document.activeElement).toBe(terminals[1].input);
    expect(focusNextRegion(1)).toBe(true);
    expect(document.activeElement).toBe(other);
    await nextFrame();
    expect(document.activeElement).toBe(other);
  });

  it("does not take label focus when a roved-to controller arrives late", async () => {
    const normalEnsure = vi.mocked(ensureController).getMockImplementation()!;
    let attach!: (controller: TerminalController) => void;
    const slow = new Promise<TerminalController>((resolve) => {
      attach = resolve;
    });
    vi.mocked(ensureController).mockImplementation((id) =>
      id === ids[1] ? slow : normalEnsure(id),
    );
    try {
      await mount();
      selectByArrow();
      await nextFrame();
      expect(document.activeElement).toBe(labels[1]);
      await act(async () => attach(terminals[1].controller));
      await nextFrame();
      expect(document.activeElement).toBe(labels[1]);
    } finally {
      vi.mocked(ensureController).mockImplementation(normalEnsure);
    }
  });

  it("focuses the terminal after F6 enters the region before its controller arrives", async () => {
    const normalEnsure = vi.mocked(ensureController).getMockImplementation()!;
    let attach!: (controller: TerminalController) => void;
    const slow = new Promise<TerminalController>((resolve) => {
      attach = resolve;
    });
    vi.mocked(ensureController).mockImplementation((id) =>
      id === ids[1] ? slow : normalEnsure(id),
    );
    try {
      await mount();
      selectByArrow();
      await nextFrame();
      expect(document.activeElement).toBe(labels[1]);

      // F6 leaves the strip for the terminal region. Its controller is still
      // on its way, so only the pane slot can take the focus.
      const strip = labels[1].closest<HTMLElement>('[data-focus-region="tabs"]')!;
      const slot = host.querySelector<HTMLElement>('.pane-slot[data-focus-region="terminal"]')!;
      for (const node of [strip, slot]) {
        vi.spyOn(node, "getClientRects").mockReturnValue([new DOMRect()] as unknown as DOMRectList);
      }
      expect(focusNextRegion(1)).toBe(true);
      expect(document.activeElement).toBe(slot);
      // Entering the pane is what ends the roving intent: without this, the
      // controller's arrival still sees "strip" and leaves the keyboard on
      // the slot instead of the terminal.
      expect(useStore.getState().tabFocusTarget).toBe("terminal");

      await act(async () => attach(terminals[1].controller));
      await nextFrame();
      expect(document.activeElement).toBe(terminals[1].input);
    } finally {
      vi.mocked(ensureController).mockImplementation(normalEnsure);
    }
  });

  it("keeps the roving label focused and the active tab unchanged when a background tab closes", async () => {
    await mount();
    selectByArrow();
    await nextFrame();
    expect(document.activeElement).toBe(labels[1]);
    expect(useStore.getState().activeId).toBe(ids[1]);

    // A tab the user is not looking at leaves without taking the keyboard
    // back to a terminal: the strip is still where they were, and closing a
    // background tab is no reason to change which session is shown.
    await act(async () => {
      await useStore.getState().closeTab(ids[2]);
    });
    await nextFrame();
    expect(useStore.getState().activeId).toBe(ids[1]);
    expect(useStore.getState().tabFocusTarget).toBe("strip");
    expect(document.activeElement).toBe(labels[1]);
  });

  it("focuses a remounted terminal after a later ordinary activation", async () => {
    await mount();
    selectByArrow();
    const other = document.createElement("button");
    host.append(other);
    other.focus();
    act(() => useStore.getState().setActive(ids[2]));
    await nextFrame();
    act(() => useStore.getState().setActive(ids[1]));
    await act(async () => {
      root.render(null);
    });
    await act(async () => {
      root.render(mountWorkspace());
    });
    await nextFrame();
    expect(document.activeElement).toBe(terminals[1].input);
  });
});
