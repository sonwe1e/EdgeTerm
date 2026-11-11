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

const senderTab = (id: string, state: Tab["state"], kind: Tab["info"]["kind"] = "ssh"): Tab => ({
  info: {
    id,
    profileId: null,
    name: id,
    kind,
    protocol: kind,
    address: "fixture",
    color: null,
    supportsRemoteFiles: kind === "sftp",
    recording: null,
    legacyAlgorithms: [],
    sharedConnection: false,
  },
  profile: { id, name: id, kind },
  number: 1,
  ordinal: 0,
  state,
  commandActivity: "idle",
  activityKind: "command",
  cols: 80,
  rows: 24,
  paneId: initial.activePaneId,
});
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

it("sends a manual all-target command only to connected terminal sessions", async () => {
  useStore.setState({
    tabs: [
      senderTab("ssh-connected", "connected"),
      senderTab("ssh-2-connected", "connected"),
      senderTab("ssh-closed", "closed"),
      senderTab("ssh-connecting", "connecting"),
      senderTab("local-error", "error", "local"),
      senderTab("file-connected", "connected", "sftp"),
    ],
    activeId: "ssh-connected",
  });
  await render();
  const target = host.querySelectorAll<HTMLSelectElement>(".sender-options select")[1]!;
  await act(async () => {
    target.value = "all";
    target.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(host.querySelector('option[value="all"]')?.textContent).toBe("All Sessions (2)");
  type("whoami");
  await click(host.querySelector<HTMLButtonElement>(".sender-send:not(.is-stop)")!);
  expect(sendUnits).toHaveBeenCalledWith(
    ["ssh-connected", "ssh-2-connected"],
    ["whoami\n"],
    "lf",
    expect.any(Object),
    expect.any(Function),
  );
});

it("does not send an all-target command when no terminal session is connected", async () => {
  useStore.setState({
    tabs: [
      senderTab("ssh-closed", "closed"),
      senderTab("ssh-connecting", "connecting"),
      senderTab("file-connected", "connected", "sftp"),
    ],
    activeId: "ssh-closed",
  });
  await render();
  const target = host.querySelectorAll<HTMLSelectElement>(".sender-options select")[1]!;
  await act(async () => {
    target.value = "all";
    target.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(host.querySelector('option[value="all"]')?.textContent).toBe("All Sessions (0)");
  type("whoami");
  await click(host.querySelector<HTMLButtonElement>(".sender-send:not(.is-stop)")!);
  expect(sendUnits).not.toHaveBeenCalled();
  expect(useStore.getState().status).toBe("Sender: no connected terminal sessions");
});

it("keeps the existing no-session feedback when targeting only the current session", async () => {
  useStore.setState({ tabs: [senderTab("ssh-closed", "closed")], activeId: null });
  await render();
  type("whoami");
  await click(host.querySelector<HTMLButtonElement>(".sender-send:not(.is-stop)")!);
  expect(sendUnits).not.toHaveBeenCalled();
  expect(useStore.getState().status).toBe("Sender: no session selected");
});

it("explains zero connected terminals in Chinese when all sessions are selected", async () => {
  useStore.setState({ language: "zh-CN", tabs: [], activeId: null });
  await render();
  const target = host.querySelectorAll<HTMLSelectElement>(".sender-options select")[1]!;
  await act(async () => {
    target.value = "all";
    target.dispatchEvent(new Event("change", { bubbles: true }));
  });
  type("whoami");
  await click(host.querySelector<HTMLButtonElement>(".sender-send:not(.is-stop)")!);
  expect(sendUnits).not.toHaveBeenCalled();
  expect(useStore.getState().status).toBe("发送器：没有已连接的终端会话");
});

it.each([false, true])(
  "shows the eligible connected terminal count in the all-target option (compact=%s)",
  async (compact) => {
    useStore.setState({
      tabs: [
        senderTab("ssh-connected", "connected"),
        senderTab("local-connected", "connected", "local"),
        senderTab("ssh-closed", "closed"),
        senderTab("file-connected", "connected", "sftp"),
      ],
      activeId: "ssh-connected",
    });
    await render(compact);
    expect(host.querySelector('option[value="all"]')?.textContent).toBe("All Sessions (2)");
  },
);

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

it("previews a focused saved command and provides a keyboard-reachable options button", async () => {
  await render(true);
  const send = host.querySelector<HTMLButtonElement>(".sender-command-load")!;
  await act(async () => {
    send.focus();
    await new Promise((resolve) => setTimeout(resolve, 250));
  });
  expect(host.querySelector('[role="tooltip"]')?.textContent).toContain("status");
  const options = host.querySelector<HTMLButtonElement>('[aria-label="Options for Check status"]');
  expect(options).not.toBeNull();
  await click(options!);
  expect(document.querySelector('[role="menuitem"]')?.textContent).toContain("Edit");
});

it("localizes the expanded command's accessible name", async () => {
  useStore.setState({ language: "zh-CN" });
  await render();
  expect(host.querySelector(".sender-command-load")?.getAttribute("aria-label")).toContain("发送");
});

it("keeps IME confirmation in the tag field before opening the save menu", async () => {
  await render();
  type("status");
  const tag = host.querySelector<HTMLInputElement>(".sender-label-input")!;
  await act(async () =>
    tag.dispatchEvent(
      new KeyboardEvent("keydown", { bubbles: true, key: "Enter", isComposing: true }),
    ),
  );
  expect(host.querySelector(".context-menu")).toBeNull();
  expect(api.saveSenderCommand).not.toHaveBeenCalled();
  await act(async () =>
    tag.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" })),
  );
  expect(host.querySelector(".context-menu")).not.toBeNull();
});

it.each([".sender-command-input", ".sender-label-input"])(
  "does not cancel editing when IME Escape comes from %s",
  async (selector) => {
    await render();
    type("unfinished draft");
    await act(async () =>
      host
        .querySelector(".sender-command-tag")!
        .dispatchEvent(new MouseEvent("contextmenu", { bubbles: true })),
    );
    await click(
      [...document.querySelectorAll('[role="menuitem"]')].find(
        (element) => element.textContent?.trim() === "Edit",
      )!,
    );
    const tag = host.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector)!;
    await act(async () =>
      tag.dispatchEvent(
        new KeyboardEvent("keydown", { bubbles: true, key: "Escape", isComposing: true }),
      ),
    );
    expect(command().value).toBe("status");
    await act(async () =>
      tag.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Escape" })),
    );
    expect(command().value).toBe("unfinished draft");
  },
);
