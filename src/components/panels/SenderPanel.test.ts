import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("../../api", async (original) => ({
  ...(await original<typeof import("../../api")>()),
  listSenderCommands: vi.fn(),
  saveSenderCommand: vi.fn(),
  deleteSenderCommand: vi.fn(),
}));
vi.mock("../../senderSend", async (original) => ({
  ...(await original<typeof import("../../senderSend")>()),
  sendUnits: vi.fn(async () => ({ sent: ["sender-session"], skipped: [] })),
}));

import * as api from "../../api";
import { sendUnits } from "../../senderSend";
import { useStore, type Tab } from "../../store";
import type { SavedCommand } from "../../types";
import { SenderPanel } from "./SenderPanel";

const initial = useStore.getState();
const saved: SavedCommand = {
  id: "status",
  name: "Check status",
  text: "status",
  ending: "crlf",
  scope: { type: "global" },
};
let host: HTMLDivElement;
let root: Root;
const click = (element: Element) =>
  act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
const command = () => host.querySelector<HTMLTextAreaElement>("textarea")!;
const type = (value: string) =>
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
      command(),
      value,
    );
    command().dispatchEvent(new Event("input", { bubbles: true }));
  });
const render = (compact = false) =>
  act(async () =>
    root.render(
      h(SenderPanel, {
        compact,
        canCompact: true,
        onExpandedChange: vi.fn(),
      }),
    ),
  );

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
  vi.mocked(api.listSenderCommands).mockResolvedValue([saved]);
  useStore.setState({ ...initial, language: "en", tabs: [], activeId: null });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  useStore.setState(initial);
});

it("restores the compose draft after editing a saved command across the split library", async () => {
  await render();
  type("unfinished draft");
  await act(async () =>
    host
      .querySelector(".sender-command-tag")!
      .dispatchEvent(new MouseEvent("contextmenu", { bubbles: true })),
  );
  const edit = [...document.querySelectorAll('[role="menuitem"]')].find(
    (e) => e.textContent?.trim() === "Edit",
  )!;
  await click(edit);
  expect(command().value).toBe("status");
  await act(async () =>
    command().dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Escape" })),
  );
  expect(command().value).toBe("unfinished draft");
  expect(api.saveSenderCommand).not.toHaveBeenCalled();
});

it("sends a compact saved command with its stored ending to the active session", async () => {
  const tab: Tab = {
    info: {
      id: "sender-session",
      profileId: null,
      name: "Local",
      kind: "local",
      protocol: "local",
      address: "",
      color: "",
      supportsRemoteFiles: false,
      recording: null,
      legacyAlgorithms: [],
      sharedConnection: false,
    },
    profile: { id: "", name: "Local", kind: "local" },
    number: 1,
    ordinal: 0,
    state: "connected",
    commandActivity: "idle",
    activityKind: "command",
    cols: 80,
    rows: 24,
    paneId: initial.activePaneId,
  };
  useStore.setState({ tabs: [tab], activeId: tab.info.id });
  await render(true);
  await click(host.querySelector(".sender-command-load")!);
  // The fifth argument is the per-line progress callback the quickbar's
  // sending mark and the compose row's line counter read.
  expect(sendUnits).toHaveBeenCalledWith(
    ["sender-session"],
    ["status\r\n"],
    "crlf",
    expect.any(Object),
    expect.any(Function),
  );
});

it("reloads the mounted library after imports and discards a stale edit", async () => {
  await render();
  await act(async () =>
    host
      .querySelector(".sender-command-tag")!
      .dispatchEvent(new MouseEvent("contextmenu", { bubbles: true })),
  );
  await click(
    [...document.querySelectorAll('[role="menuitem"]')].find(
      (e) => e.textContent?.trim() === "Edit",
    )!,
  );
  expect(host.querySelector(".sender-command-tag.is-editing")).not.toBeNull();
  vi.mocked(api.listSenderCommands).mockResolvedValue([
    { ...saved, id: "new", name: "Imported", text: "new" },
  ]);
  await act(async () =>
    useStore.setState((s) => ({ senderLibraryVersion: s.senderLibraryVersion + 1 })),
  );
  expect(host.querySelector(".sender-command-load")?.textContent).toBe("Imported");
  expect(host.textContent).not.toContain("Check status");
  expect(host.querySelector(".sender-command-tag.is-editing")).toBeNull();
});
