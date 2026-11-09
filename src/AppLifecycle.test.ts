import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({
  close: undefined as undefined | ((event: { preventDefault: () => void }) => void),
  quit: undefined as undefined | (() => void),
  state: undefined as undefined | ((event: import("./api").StateEvent) => void),
  auth: undefined as undefined | ((prompt: import("./types").AuthPrompt) => void),
  exit: vi.fn(async () => {}),
  hide: vi.fn(async () => {}),
  answerAuth: vi.fn(async (_id: string, _responses: string[] | null) => {}),
  ownsSession: vi.fn((_id: string) => true),
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    onCloseRequested: async (callback: typeof native.close) => {
      native.close = callback;
      return () => {};
    },
  }),
}));
vi.mock("@tauri-apps/plugin-process", () => ({ exit: native.exit }));
vi.mock("./platform", () => ({ HAS_TRAY: true, IS_MAC: false, IS_WINDOWS: false }));
vi.mock("./api", async (original) => ({
  ...(await original<typeof import("./api")>()),
  showMainWindow: async () => {},
  systemMonospaceFamily: async () => null,
  setStartupTheme: async () => {},
  setCloseToTray: async () => {},
  hideMainWindow: native.hide,
  onSessionState: async (callback: typeof native.state) => {
    native.state = callback;
    return () => {};
  },
  onAuthPrompt: async (callback: typeof native.auth) => {
    native.auth = callback;
    return () => {};
  },
  answerAuthPrompt: native.answerAuth,
  onRecordingError: async () => () => {},
  onCloseToTrayChanged: async () => () => {},
  onQuitRequested: async (callback: () => void) => {
    native.quit = callback;
    return () => {};
  },
}));
vi.mock("./actions", () => ({
  acceptHostKey: vi.fn(),
  revealCwdInFiler: vi.fn(),
  sessionClosedNotice: () => "",
  shouldApplySessionState: native.ownsSession,
  splitSession: vi.fn(),
}));
vi.mock("./fileEditor", () => ({ closeFileEditor: vi.fn(async () => true) }));
vi.mock("./workspace", () => ({
  startWorkspace: () => () => {},
  flushWorkspace: vi.fn(async () => {}),
}));
vi.mock("./fonts", () => ({ applyFonts: vi.fn(), symbolFallbacks: () => [] }));
vi.mock("./updater", () => ({ useUpdater: () => ({ appVersion: "", state: {} }) }));
vi.mock("./components/MenuBar", () => ({ MenuBar: () => null }));
vi.mock("./components/Workspace", () => ({ Workspace: () => null }));
vi.mock("./components/StatusBar", () => ({ StatusBar: () => null }));
vi.mock("./components/FileEditorDialog", () => ({ FileEditorDialog: () => null }));
vi.mock("./components/AgentDialog", () => ({ AgentDialog: () => null }));
vi.mock("./components/UpdateDialog", () => ({ UpdateDialog: () => null }));
vi.mock("./components/PanelDocks", () => ({ DockArea: () => null, PanelDropOverlay: () => null }));

import App from "./App";
import type { FileTransfer } from "./api";
import { closeFileEditor } from "./fileEditor";
import { useFileTransfers } from "./fileTransfers";
import { useStore } from "./store";

const initial = useStore.getState();
let host: HTMLDivElement;
let root: Root;
const job = (status: FileTransfer["status"]): FileTransfer => ({
  id: "pending",
  sessionId: "closed-tab",
  context: null,
  revision: 1,
  name: "archive.tar",
  status,
  phase: "transferring",
  transferred: 4,
  total: 100,
  completedFiles: 0,
  totalFiles: 1,
  failedFiles: [],
  error: null,
  attempt: 1,
  options: { requests: 32, chunkKib: 128, files: 8, durable: false, tar: false, rateLimitBps: 0 },
});

beforeEach(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
  native.ownsSession.mockReturnValue(true);
  vi.mocked(closeFileEditor).mockResolvedValue(true);
  useStore.setState(
    {
      ...initial,
      language: "en",
      tabs: [],
      activeId: null,
      panels: { sessions: false, filer: false, sender: false },
      closeAction: "exit",
    },
    true,
  );
  useFileTransfers.setState({ jobs: {}, open: false });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(h(App)));
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  useStore.setState(initial, true);
  useFileTransfers.setState({ jobs: {}, open: false });
});

const alert = () => document.querySelector('[role="alertdialog"]');
const click = async (label: string) => {
  const button = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (item) => item.textContent?.trim() === label,
  );
  if (!button) throw new Error(`Missing ${label} button`);
  await act(async () => button.click());
};

it.each(["queued", "running", "pausing", "paused", "retrying", "cancelling"] as const)(
  "confirms menu quit for a %s background transfer even without a live tab",
  async (status) => {
    useFileTransfers.getState().update(job(status));
    await act(async () => native.quit!());
    expect(native.exit).not.toHaveBeenCalled();
    expect(alert()?.textContent).toContain("1 unfinished file transfer");
    expect(document.activeElement?.textContent).toBe("Cancel");
    await click("Cancel");
    expect(alert()).toBeNull();
    expect(native.exit).not.toHaveBeenCalled();
  },
);

it("protects native window close and only exits after confirmation", async () => {
  useFileTransfers.getState().update(job("running"));
  const preventDefault = vi.fn();
  await act(async () => native.close!({ preventDefault }));
  expect(preventDefault).toHaveBeenCalledTimes(1);
  expect(native.exit).not.toHaveBeenCalled();
  expect(alert()).not.toBeNull();
  await click("Quit");
  expect(native.exit).toHaveBeenCalledWith(0);
});

it("applies the same transfer guard to Exit from the close-choice dialog", async () => {
  act(() => useStore.setState({ closeAction: "ask" }));
  useFileTransfers.getState().update(job("paused"));
  await act(async () => native.close!({ preventDefault: vi.fn() }));
  await click("Quit");
  expect(native.exit).not.toHaveBeenCalled();
  expect(alert()?.textContent).toContain("1 unfinished file transfer");
});

it("keeps tray hiding non-destructive without a quit confirmation", async () => {
  act(() => useStore.setState({ closeAction: "tray" }));
  useFileTransfers.getState().update(job("running"));
  await act(async () => native.close!({ preventDefault: vi.fn() }));
  expect(native.hide).toHaveBeenCalledTimes(1);
  expect(native.exit).not.toHaveBeenCalled();
  expect(alert()).toBeNull();
});

it.each(["complete", "error", "cancelled"] as const)(
  "does not block exit for a %s transfer",
  async (status) => {
    useFileTransfers.getState().update(job(status));
    await act(async () => native.quit!());
    expect(alert()).toBeNull();
    expect(native.exit).toHaveBeenCalledTimes(1);
  },
);

it("still honors the editor's cancelled discard after confirming transfers", async () => {
  useFileTransfers.getState().update(job("running"));
  vi.mocked(closeFileEditor).mockResolvedValue(false);
  await act(async () => native.quit!());
  await click("Quit");
  expect(closeFileEditor).toHaveBeenCalledTimes(1);
  expect(native.exit).not.toHaveBeenCalled();
});

const authQuestion: import("./types").AuthPrompt = {
  id: "auth-round",
  sessionId: "cancelled-session",
  address: "example.invalid:22",
  username: "tester",
  name: "Verification",
  instructions: "",
  prompts: [{ prompt: "Code", echo: false }],
};

it("releases a late cancelled connection's auth round instead of displaying it", async () => {
  native.ownsSession.mockReturnValue(false);
  await act(async () => native.auth!(authQuestion));
  expect(native.answerAuth).toHaveBeenCalledWith("auth-round", null);
  expect(useStore.getState().authPrompts).toEqual([]);
  expect(document.querySelector(".auth-prompt-dialog")).toBeNull();
  expect(native.ownsSession).toHaveBeenCalledWith("cancelled-session");
});

it("still displays a current connection's auth question without cancelling it", async () => {
  await act(async () => native.auth!(authQuestion));
  expect(useStore.getState().authPrompts).toEqual([authQuestion]);
  expect(native.answerAuth).not.toHaveBeenCalled();
  expect(document.querySelector(".auth-prompt-dialog")?.textContent).toContain("Verification");
});

it("does not apply a retired connection's late native state event", async () => {
  const id = "retired-session";
  act(() =>
    useStore.getState().addTab(
      {
        id,
        profileId: "late-profile",
        name: "Local",
        kind: "local",
        protocol: "local",
        address: "",
        color: null,
        supportsRemoteFiles: false,
        recording: null,
        legacyAlgorithms: [],
        sharedConnection: false,
      },
      { id: "late-profile", name: "Local", kind: "local" },
      "connecting",
    ),
  );
  native.ownsSession.mockReturnValue(false);
  await act(async () => native.state!({ id, state: "error", message: "obsolete error" }));
  expect(useStore.getState().tabs.find((tab) => tab.info.id === id)?.state).toBe("connecting");
  expect(useStore.getState().error).not.toBe("obsolete error");
});
