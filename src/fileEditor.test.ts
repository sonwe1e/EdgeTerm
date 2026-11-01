import { beforeEach, expect, it, vi } from "vitest";
import {
  clearRevealLine,
  closeFileEditor,
  hasUnsavedFile,
  openFileEditor,
  reloadFileEditor,
  saveFileEditor,
  useFileEditor,
} from "./fileEditor";
import * as api from "./editor/textFile";
import { ask } from "./nativeDialog";
import { useStore } from "./store";

vi.mock("./editor/textFile", () => ({ readText: vi.fn(), writeText: vi.fn() }));
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
  useStore.getState().setLanguage("en");
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

it("opens a file link at the line it printed, reading it before showing the editor", async () => {
  const opened = await openFileEditor("server-1", "/srv/train.py", { line: 238 });
  expect(opened).toBe(true);
  expect(api.readText).toHaveBeenCalledWith("server-1", "/srv/train.py");
  expect(useFileEditor.getState().target).toMatchObject({ path: "/srv/train.py", line: 238 });
  expect(useFileEditor.getState().content).toBe("before\n");
});

it("does not open an empty editor when the file cannot be read", async () => {
  vi.mocked(api.readText).mockRejectedValue({
    code: "notFound",
    message: "no such file: /srv/gone.py",
  });
  const opened = await openFileEditor("server-1", "/srv/gone.py", { line: 12 });
  expect(opened).toBe(false);
  expect(useFileEditor.getState().target).toBeNull();
  expect(useFileEditor.getState().file).toBeNull();
  expect(useStore.getState().status).toBe("Cannot open /srv/gone.py: no such file: /srv/gone.py");
});

it("clears the reveal line once the editor scrolled to it", async () => {
  await openFileEditor(null, "C:/config.txt", { line: 12 });
  expect(useFileEditor.getState().target?.line).toBe(12);
  clearRevealLine();
  expect(useFileEditor.getState().target?.line).toBeNull();
  expect(useFileEditor.getState().file?.hash).toBe("original");
});

it("ignores a line number that cannot be revealed", async () => {
  await openFileEditor(null, "C:/config.txt", { line: 0 });
  expect(useFileEditor.getState().target?.line).toBeNull();
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
