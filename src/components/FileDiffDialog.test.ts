import { act, createElement as h } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const api = vi.hoisted(() => ({ compareFiles: vi.fn(), cancelFileDiff: vi.fn() }));
vi.mock("../api", () => api);
// The dialog translates its labels through the store-backed useT hook; this
// test mocks the backend and does not set up the store, so bind useT to the
// real English catalog directly (no store, no platform globals).
vi.mock("../useT", async () => {
  const i18n = await vi.importActual<typeof import("../i18n")>("../i18n");
  return {
    useT: () => (key: import("../i18n").MessageKey, params?: Record<string, string | number>) =>
      i18n.translate("en", key, params),
  };
});
import { FileDiffDialog } from "./FileDiffDialog";
import type { FileComparison } from "../api";

const result = (text = "current"): FileComparison => ({
  status: "different",
  bytesEqual: false,
  reason: null,
  alignmentSimplified: false,
  left: {
    size: 3,
    kind: "text",
    encoding: "UTF-8",
    bom: false,
    eol: "LF",
    finalNewline: true,
    lines: 1,
    sha256: null,
    preview: "",
  },
  right: {
    size: 3,
    kind: "text",
    encoding: "UTF-8",
    bom: false,
    eol: "CRLF",
    finalNewline: true,
    lines: 1,
    sha256: null,
    preview: "",
  },
  rows: [
    {
      path: "1:1",
      kind: "modified",
      leftLine: 1,
      rightLine: 1,
      left: text,
      right: "remote",
      leftEnding: "LF",
      rightEnding: "CRLF",
    },
  ],
});
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
  api.compareFiles.mockResolvedValue(result());
  api.cancelFileDiff.mockResolvedValue(undefined);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
describe("read-only file comparison", () => {
  it("renders actual comparison results and exact metadata", async () => {
    const host = document.createElement("div");
    const root = createRoot(host);
    try {
      await act(async () =>
        root.render(
          h(FileDiffDialog, {
            sessionId: "ssh",
            local: "/local",
            remote: "/remote",
            active: true,
            onClose: vi.fn(),
          }),
        ),
      );
      expect(api.compareFiles).toHaveBeenCalledWith("ssh", expect.any(String), "/local", "/remote");
      expect(host.textContent).toContain("Files differ");
      expect(host.textContent).toContain("CRLF");
      expect(host.querySelector('[data-diff-row="1:1"]')!.textContent).toContain("current");
      expect(host.querySelector("textarea,input[contenteditable]")).toBeNull();
    } finally {
      act(() => root.unmount());
    }
  });
  it("cancels backend work on selection changes and rejects stale results", async () => {
    let first!: (value: FileComparison) => void;
    api.compareFiles.mockReturnValueOnce(
      new Promise((resolve) => {
        first = resolve;
      }),
    );
    const host = document.createElement("div");
    const root = createRoot(host);
    const close = vi.fn();
    try {
      await act(async () =>
        root.render(
          h(FileDiffDialog, {
            sessionId: "ssh",
            local: "/old",
            remote: "/remote",
            active: true,
            onClose: close,
          }),
        ),
      );
      const oldId = api.compareFiles.mock.calls[0][1];
      await act(async () =>
        root.render(
          h(FileDiffDialog, {
            sessionId: "ssh",
            local: "/new",
            remote: "/remote",
            active: true,
            onClose: close,
          }),
        ),
      );
      expect(api.cancelFileDiff).toHaveBeenCalledWith(oldId);
      await act(async () => first(result("stale")));
      expect(host.textContent).toContain("current");
      expect(host.textContent).not.toContain("stale");
    } finally {
      act(() => root.unmount());
    }
  });
  it("cancels when hidden and supports an explicit retry after errors", async () => {
    api.compareFiles.mockRejectedValueOnce(new Error("permission denied"));
    const host = document.createElement("div");
    const root = createRoot(host);
    const close = vi.fn();
    const render = (active: boolean) =>
      h(FileDiffDialog, { sessionId: "ssh", local: "/a", remote: "/b", active, onClose: close });
    try {
      await act(async () => root.render(render(true)));
      expect(host.querySelector('[role="alert"]')!.textContent).toContain("permission denied");
      await act(async () =>
        [...host.querySelectorAll("button")]
          .find((b) => b.textContent === "Compare again")!
          .click(),
      );
      expect(host.querySelector('[role="alert"]')).toBeNull();
      api.compareFiles.mockReturnValueOnce(new Promise(() => {}));
      await act(async () =>
        [...host.querySelectorAll("button")]
          .find((b) => b.textContent === "Compare again")!
          .click(),
      );
      const id = api.compareFiles.mock.calls[2][1];
      await act(async () => root.render(render(false)));
      expect(api.cancelFileDiff).toHaveBeenCalledWith(id);
      expect(host.childElementCount).toBe(0);
    } finally {
      act(() => root.unmount());
    }
  });
  it("keeps a cancelled comparison stopped and reports a current cancellation failure", async () => {
    let complete!: (value: FileComparison) => void;
    let rejectCancel!: (reason: Error) => void;
    api.compareFiles.mockReturnValueOnce(
      new Promise((resolve) => {
        complete = resolve;
      }),
    );
    api.cancelFileDiff.mockReturnValueOnce(
      new Promise((_, reject) => {
        rejectCancel = reject;
      }),
    );
    const host = document.createElement("div");
    const root = createRoot(host);
    try {
      await act(async () =>
        root.render(
          h(FileDiffDialog, {
            sessionId: "ssh",
            local: "/a",
            remote: "/b",
            active: true,
            onClose: vi.fn(),
          }),
        ),
      );
      const request = api.compareFiles.mock.calls[0][1];
      await act(async () =>
        [...host.querySelectorAll("button")]
          .find((b) => b.textContent === "Cancel comparison")!
          .click(),
      );
      expect(api.cancelFileDiff).toHaveBeenCalledWith(request);
      await act(async () => complete(result("cancelled result")));
      expect(host.textContent).not.toContain("cancelled result");
      await act(async () => rejectCancel(new Error("cancellation unavailable")));
      expect(host.querySelector('[role="alert"]')!.textContent).toContain(
        "cancellation unavailable",
      );
    } finally {
      act(() => root.unmount());
    }
  });
  it.each(["retry", "selection", "hide"])(
    "ignores an old cancellation failure after %s starts a new comparison",
    async (next) => {
      let rejectCancel!: (reason: Error) => void;
      api.compareFiles.mockReturnValueOnce(new Promise(() => {}));
      api.compareFiles.mockResolvedValueOnce(result("new comparison"));
      api.cancelFileDiff.mockReturnValueOnce(
        new Promise((_, reject) => {
          rejectCancel = reject;
        }),
      );
      const host = document.createElement("div");
      const root = createRoot(host);
      const close = vi.fn();
      const render = (active = true, local = "/a") =>
        h(FileDiffDialog, { sessionId: "ssh", local, remote: "/b", active, onClose: close });
      try {
        await act(async () => root.render(render()));
        await act(async () =>
          [...host.querySelectorAll("button")]
            .find((b) => b.textContent === "Cancel comparison")!
            .click(),
        );
        if (next === "retry") {
          await act(async () =>
            [...host.querySelectorAll("button")]
              .find((b) => b.textContent === "Compare again")!
              .click(),
          );
        } else if (next === "selection") {
          await act(async () => root.render(render(true, "/new")));
        } else {
          await act(async () => root.render(render(false)));
          await act(async () => root.render(render()));
        }
        expect(api.compareFiles).toHaveBeenCalledTimes(2);
        expect(host.textContent).toContain("new comparison");
        await act(async () => rejectCancel(new Error("stale cancellation failure")));
        expect(host.querySelector('[role="alert"]')).toBeNull();
        expect(host.textContent).toContain("new comparison");
      } finally {
        act(() => root.unmount());
      }
    },
  );
});
