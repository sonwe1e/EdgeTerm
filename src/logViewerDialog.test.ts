import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("./api", async (original) => ({
  ...(await original<typeof import("./api")>()),
  readLogWindow: vi.fn(),
  sftpDownload: vi.fn(),
  watchRemoteEdit: vi.fn(),
  remoteEditPath: vi.fn(),
}));

import * as api from "./api";
import { LogViewerDialog, type LogViewerTarget } from "./components/LogViewerDialog";
import { useStore } from "./store";

const initial = useStore.getState();
const target = (sessionId: string): LogViewerTarget => ({
  sessionId,
  sourceTabId: sessionId,
  path: "/logs/worker.log",
  name: "worker.log",
});
const fixture = (content: string, overrides: Partial<api.LogWindow> = {}): api.LogWindow => ({
  path: "/logs/worker.log",
  start: 8 * 1024 * 1024 * 1024,
  end: 8 * 1024 * 1024 * 1024 + content.length,
  size: 8 * 1024 * 1024 * 1024 + content.length,
  content,
  encoding: "UTF-8",
  modifiedAt: 42,
  ...overrides,
});

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
  useStore.getState().setLanguage("en");
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  useStore.setState(initial, true);
  useStore.getState().setLanguage(initial.language);
});

it("reads only a bounded window and does not touch writable remote edit APIs", async () => {
  vi.mocked(api.readLogWindow).mockResolvedValue(fixture("last result ready"));
  await act(async () => root.render(h(LogViewerDialog, { target: target("ssh-a"), onClose() {} })));
  expect(api.readLogWindow).toHaveBeenCalledExactlyOnceWith(
    "ssh-a",
    "/logs/worker.log",
    null,
    true,
    null,
  );
  expect(host.querySelector(".log-viewer-text")?.textContent).toContain("last result ready");
  expect(host.querySelector(".log-viewer-search")?.getAttribute("placeholder")).toBe(
    "Find in loaded window",
  );
  expect(api.remoteEditPath).not.toHaveBeenCalled();
  expect(api.sftpDownload).not.toHaveBeenCalled();
  expect(api.watchRemoteEdit).not.toHaveBeenCalled();
});

it("locks the first page's detected encoding while paging through a log", async () => {
  vi.mocked(api.readLogWindow)
    .mockResolvedValueOnce(fixture("尾部", { encoding: "GBK" }))
    .mockResolvedValueOnce(fixture("上一段", { encoding: "GBK" }));
  await act(async () => root.render(h(LogViewerDialog, { target: target("ssh-a"), onClose() {} })));
  const earlier = [...host.querySelectorAll("button")].find((button) =>
    button.textContent?.includes("Earlier"),
  );
  expect(earlier).toBeDefined();
  await act(async () => earlier?.click());
  expect(api.readLogWindow).toHaveBeenNthCalledWith(
    2,
    "ssh-a",
    "/logs/worker.log",
    8 * 1024 * 1024 * 1024,
    true,
    "GBK",
  );
});

it("invalidates a pending SSH A response when viewer switches to SSH B", async () => {
  let finishA: ((result: api.LogWindow) => void) | undefined;
  vi.mocked(api.readLogWindow).mockImplementation((id) => {
    if (id === "ssh-a") {
      return new Promise((resolve) => {
        finishA = resolve;
      });
    }
    return Promise.resolve(fixture("only-server-B"));
  });
  await act(async () =>
    root.render(h(LogViewerDialog, { key: "a", target: target("ssh-a"), onClose() {} })),
  );
  expect(finishA).toBeTypeOf("function");
  await act(async () =>
    root.render(h(LogViewerDialog, { key: "b", target: target("ssh-b"), onClose() {} })),
  );
  expect(host.textContent).toContain("only-server-B");
  await act(async () => finishA?.(fixture("secret-from-A")));
  expect(host.textContent).not.toContain("secret-from-A");
});
