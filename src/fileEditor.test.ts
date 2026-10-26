import { beforeEach, expect, it, vi } from "vitest";
import {
  closeFileEditor,
  hasUnsavedFile,
  openFileEditor,
  reloadFileEditor,
  saveFileEditor,
  useFileEditor,
} from "./fileEditor";
import * as api from "./workbench/api";
import { ask } from "./nativeDialog";

vi.mock("./workbench/api", () => ({ readText: vi.fn(), writeText: vi.fn() }));
vi.mock("./nativeDialog", () => ({ ask: vi.fn() }));
const original = useFileEditor.getState();

it("does not replace edits typed while a reload is in flight", async () => {
  await openFileEditor(null, "C:/config.txt");
  let finish!: (file: Awaited<ReturnType<typeof api.readText>>) => void;
  vi.mocked(api.readText).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const pending = reloadFileEditor();
  useFileEditor.setState({ content: "typed while loading" });
  finish({ ...useFileEditor.getState().file!, content: "from disk", hash: "new" });
  await pending;
  expect(useFileEditor.getState().content).toBe("typed while loading");
  expect(useFileEditor.getState().file?.hash).toBe("original");
  expect(hasUnsavedFile()).toBe(true);
});
beforeEach(() => {
  useFileEditor.setState(original, true);
  vi.resetAllMocks();
  vi.mocked(api.readText).mockResolvedValue({
    path: "/resolved/config.txt",
    content: "before\r\n",
    hash: "original",
    size: 8,
    eol: "crlf",
    bom: true,
    encoding: "UTF-8",
    modifiedAt: null,
    permissions: null,
  });
  vi.mocked(api.writeText).mockResolvedValue({
    path: "/resolved/config.txt",
    hash: "saved",
    size: 5,
    uncertain: false,
    backup: null,
    temp: null,
    note: "",
  });
});

it("writes to the original remote session with the original hash and preserves edits typed during save", async () => {
  await openFileEditor("server-1", "/link/config.txt");
  useFileEditor.setState({ content: "save this\n" });
  let finish!: (value: Awaited<ReturnType<typeof api.writeText>>) => void;
  vi.mocked(api.writeText).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const pending = saveFileEditor();
  expect(api.writeText).toHaveBeenCalledWith(
    "server-1",
    expect.objectContaining({
      path: "/resolved/config.txt",
      expectedHash: "original",
      content: "save this\n",
      eol: "crlf",
      bom: true,
    }),
  );
  useFileEditor.setState({ content: "more edits\n" });
  finish({
    path: "/resolved/config.txt",
    hash: "next",
    size: 5,
    uncertain: false,
    backup: null,
    temp: null,
    note: "",
  });
  await pending;
  expect(hasUnsavedFile()).toBe(true);
  expect(useFileEditor.getState().content).toBe("more edits\n");
  await saveFileEditor();
  expect(api.writeText).toHaveBeenLastCalledWith(
    "server-1",
    expect.objectContaining({ expectedHash: "next", content: "more edits\n" }),
  );
  expect(hasUnsavedFile()).toBe(false);
});

it("retains the draft after a conflict and after declining close", async () => {
  await openFileEditor(null, "C:/config.txt");
  useFileEditor.setState({ content: "my draft" });
  vi.mocked(api.writeText).mockRejectedValue({ code: "conflict", message: "changed outside" });
  await saveFileEditor();
  expect(useFileEditor.getState()).toMatchObject({
    content: "my draft",
    conflict: true,
    busy: false,
  });
  expect(await closeFileEditor()).toBe(false);
  expect(useFileEditor.getState().file?.hash).toBe("original");
  vi.mocked(ask).mockResolvedValue(true);
  expect(await closeFileEditor()).toBe(true);
  expect(useFileEditor.getState().target).toBeNull();
});

it("does not report an uncertain remote write as saved", async () => {
  await openFileEditor("server", "/config.txt");
  useFileEditor.setState({ content: "draft" });
  vi.mocked(api.writeText).mockResolvedValue({
    path: "/config.txt",
    hash: "unknown",
    size: 0,
    uncertain: true,
    temp: "/recovery",
    backup: null,
    note: "verify the server",
  });
  await saveFileEditor();
  expect(hasUnsavedFile()).toBe(true);
  expect(useFileEditor.getState()).toMatchObject({
    saved: false,
    error: "verify the server",
    content: "draft",
  });
});
