import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";

import { useStore, type Tab } from "../store";
import { QuitConfirmDialog } from "./QuitConfirmDialog";

// The quit confirmation assembled "Quit with <b>3 active sessions</b>?" in JSX,
// with the space between its words written by hand. Nothing pinned what a user
// reads before losing their sessions; this does, in both languages.
const tab = (id: string) =>
  ({
    info: {
      id,
      profileId: id,
      name: "Session " + id,
      kind: "ssh",
      protocol: "ssh",
      address: "host:22",
      color: "#4ea1f3",
      supportsRemoteFiles: true,
      recording: null,
      legacyAlgorithms: [],
      sharedConnection: false,
    },
    profile: { id, name: "Session " + id, kind: "ssh" },
    number: 1,
    ordinal: 0,
    state: "connected",
    commandActivity: "idle",
    activityKind: "command",
    paneId: "pane-1",
    directories: { terminal: "/srv", filer: "/data" },
  }) as unknown as Tab;

const initialState = useStore.getState();
let root: Root;

const bodyText = () => (document.body.textContent ?? "").replace(/\s+/g, " ");

const mount = () => {
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => {
    root.render(h(QuitConfirmDialog, { onConfirm: () => undefined, onCancel: () => undefined }));
  });
};

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  useStore.setState(
    { ...initialState, language: "en", tabs: [tab("a"), tab("b"), tab("c")], activeId: "a" },
    true,
  );
});

afterEach(() => {
  act(() => root.unmount());
  document.body.textContent = "";
  useStore.setState(initialState, true);
});

it("counts the sessions it is about to close", () => {
  mount();
  expect(bodyText()).toContain("Quit with 3 active sessions?");
});

it("says the same thing in Chinese", () => {
  useStore.setState({ language: "zh-CN" });
  mount();
  expect(bodyText()).toContain("退出时将断开 3 个活动会话？");
});
