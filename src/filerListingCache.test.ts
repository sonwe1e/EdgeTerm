import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./platform", () => ({ IS_MAC: false, IS_WINDOWS: true }));
vi.mock("./components/FileIcon", () => ({ FileIcon: () => null }));
vi.mock("./actions", () => ({ revealCwdInFiler: vi.fn() }));
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }),
}));
vi.mock("./api", async (original) => ({
  ...(await original<typeof import("./api")>()),
  sftpHome: vi.fn(),
  sftpList: vi.fn(),
  localHome: vi.fn(),
  localList: vi.fn(),
  onRemoteEditState: async () => () => {},
}));

import * as api from "./api";
import { FilerPanel, sameListing } from "./components/panels/FilerPanel";
import { useStore, type Tab } from "./store";
import type { FileEntry } from "./types";

const initialState = useStore.getState();

const makeTab = (id: string): Tab => ({
  info: {
    id,
    profileId: id,
    name: id,
    kind: "ssh",
    protocol: "ssh",
    address: `${id}.example`,
    color: "#4ea1f3",
    supportsRemoteFiles: true,
    recording: null,
    legacyAlgorithms: [],
    sharedConnection: false,
  },
  profile: { id, name: id, kind: "ssh" },
  number: id === "a" ? 1 : 2,
  ordinal: 0,
  state: "connected",
  commandActivity: "idle",
  activityKind: "command",
  cols: 80,
  rows: 24,
  paneId: initialState.activePaneId,
});

const entry = (dir: string, name: string): FileEntry => ({
  path: `${dir}/${name}`, name, isDir: false, isSymlink: false,
  size: 1, modified: 1, permissions: null, owner: null, group: null,
});

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  // jsdom has no ResizeObserver; the virtual list observes its scroller.
  vi.stubGlobal("ResizeObserver", class {
    observe() {} disconnect() {}
  });
  vi.mocked(api.sftpHome).mockImplementation(async (id: string) => `/home/${id}`);
  useStore.setState(
    {
      ...initialState,
      tabs: [makeTab("a"), makeTab("b")],
      activeId: "a",
      panes: [{ id: initialState.activePaneId, activeTabId: "a" }],
    },
    true,
  );
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const switchTo = (id: string) => act(async () => useStore.getState().setActive(id));

describe("Filer listing when coming back to an SSH session", () => {
  it("shows the session's earlier rows while the fresh listing is on its way", async () => {
    let finishRevisit!: (listing: { path: string; entries: FileEntry[] }) => void;
    let visits = 0;
    vi.mocked(api.sftpList).mockImplementation(async (id: string, path: string) => {
      if (id === "a" && ++visits === 2) {
        return new Promise((resolve) => { finishRevisit = resolve; });
      }
      return { path, entries: [entry(path, `${id}-file.txt`)] };
    });

    await act(async () => root.render(h(FilerPanel)));
    expect(host.textContent).toContain("a-file.txt");
    await switchTo("b");
    expect(host.textContent).toContain("b-file.txt");

    // Back to "a": its listing is still pending. The panel must not keep
    // showing "b"'s rows, and must not sit empty either.
    await switchTo("a");
    expect(host.textContent).toContain("a-file.txt");
    expect(host.textContent).not.toContain("b-file.txt");

    await act(async () => finishRevisit({
      path: "/home/a", entries: [entry("/home/a", "a-file.txt"), entry("/home/a", "new.txt")],
    }));
    expect(host.textContent).toContain("new.txt");
  });

  it("recognises an unchanged directory so its rows are not replaced", () => {
    const rows = [entry("/d", "x"), entry("/d", "y")];
    expect(sameListing(rows, [entry("/d", "x"), entry("/d", "y")])).toBe(true);
    expect(sameListing(rows, [entry("/d", "x")])).toBe(false);
    expect(sameListing(rows, [entry("/d", "x"), { ...entry("/d", "y"), size: 2 }])).toBe(false);
  });
});
