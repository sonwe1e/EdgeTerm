import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("./platform", () => ({ HAS_TRAY: true, IS_MAC: true, IS_WINDOWS: false }));
vi.mock("./api", async (original) => ({
  ...(await original<typeof import("./api")>()),
  sessionCwd: vi.fn(),
  writeSession: vi.fn(async () => undefined),
  resizeSession: vi.fn(async () => undefined),
}));
vi.mock("./editor/textFile", () => ({ readText: vi.fn(), writeText: vi.fn() }));
vi.mock("./nativeDialog", () => ({ ask: vi.fn() }));

import * as api from "./api";
import * as textFiles from "./editor/textFile";
import { ensureController } from "./actions";
import { closeFileEditor, openFileEditor, useFileEditor } from "./fileEditor";
import { ask } from "./nativeDialog";
import { useStore, type Tab } from "./store";
import { disposeController } from "./terminalRegistry";
import type { Callbacks } from "./terminalShared";

const initialStore = useStore.getState();
const initialEditor = useFileEditor.getState();
const id = "file-link-actions";
let clickLink: NonNullable<Callbacks["onFileLink"]>;

const tick = async () => {
  for (let i = 0; i < 16; i++) await Promise.resolve();
};

beforeEach(async () => {
  vi.resetAllMocks();
  useFileEditor.setState(initialEditor, true);
  await closeFileEditor();
  const tab: Tab = {
    info: {
      id,
      profileId: id,
      name: "file links",
      kind: "ssh",
      protocol: "ssh",
      address: "fixture:22",
      color: null,
      supportsRemoteFiles: true,
      recording: null,
      legacyAlgorithms: [],
      sharedConnection: false,
    },
    profile: { id, name: "file links", kind: "ssh", host: "fixture" },
    number: 1,
    ordinal: 0,
    state: "connected",
    commandActivity: "idle",
    activityKind: "command",
    cols: 80,
    rows: 24,
    paneId: initialStore.activePaneId,
  };
  useStore.setState({ ...initialStore, tabs: [tab], activeId: id }, true);
  vi.mocked(api.sessionCwd).mockResolvedValue("/current");
  vi.mocked(textFiles.readText).mockImplementation(async (_sessionId, path) => ({
    path,
    content: "original\n",
    hash: "original",
    size: 9,
    eol: "lf",
    bom: false,
    encoding: "UTF-8",
    modifiedAt: null,
    permissions: null,
  }));
  // Use the real callback wired into the controller, not a duplicate link algorithm.
  const controller = await ensureController(id);
  clickLink = (controller as unknown as { callbacks: Callbacks }).callbacks.onFileLink!;
});

afterEach(() => {
  disposeController(id);
  useFileEditor.setState(initialEditor, true);
  useStore.setState(initialStore, true);
});

it("does not reopen an older terminal click after its directory lookup yields to another file", async () => {
  let resolveDirectory!: (path: string) => void;
  vi.mocked(api.sessionCwd).mockImplementationOnce(
    () => new Promise((resolve) => (resolveDirectory = resolve)),
  );
  clickLink("older.py", 5, "/attributed");
  await openFileEditor(id, "/newer.py");
  resolveDirectory("/current");
  await tick();
  expect(useFileEditor.getState().target?.path).toBe("/newer.py");
  expect(textFiles.readText).toHaveBeenCalledTimes(1);
});

it("stops candidate fallback when the user declines to discard an edited file", async () => {
  await openFileEditor(id, "/draft.py");
  useFileEditor.setState({ content: "unsaved draft" });
  vi.mocked(ask).mockResolvedValue(false);
  clickLink("other.py", 5, "/attributed");
  await tick();
  expect(ask).toHaveBeenCalledTimes(1);
  expect(useFileEditor.getState().target?.path).toBe("/draft.py");
  expect(useFileEditor.getState().content).toBe("unsaved draft");
  expect(textFiles.readText).toHaveBeenCalledTimes(1);
});

it("still tries the current directory when the attributed file cannot be read", async () => {
  vi.mocked(textFiles.readText).mockRejectedValueOnce(new Error("not found"));
  clickLink("train.py", 17, "/old-project");
  await tick();
  expect(textFiles.readText).toHaveBeenNthCalledWith(1, id, "/old-project/train.py");
  expect(textFiles.readText).toHaveBeenNthCalledWith(2, id, "/current/train.py");
  expect(useFileEditor.getState().target).toMatchObject({ path: "/current/train.py", line: 17 });
});

it("does not start a directory lookup while the editor is saving", async () => {
  useFileEditor.setState({ busy: true });
  clickLink("train.py", 1, "/attributed");
  await tick();
  expect(api.sessionCwd).not.toHaveBeenCalled();
  expect(textFiles.readText).not.toHaveBeenCalled();
});
