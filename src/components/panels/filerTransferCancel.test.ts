// Cancelling a Filer copy sent the request and waited for the backend's
// rejection before touching the footer, so a stalled network read left the
// progress bar "running" with its Cancel button until the read gave up. The
// bar now stops when the user cancels; the late rejection and progress of
// that copy are dropped.
import { act, createElement as h, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../api", async (original) => ({
  ...(await original<typeof import("../../api")>()),
  newTransferId: vi.fn(() => "t-1"),
  // A cancel that never answers: the stalled read this regression is about.
  cancelTransfer: vi.fn(() => new Promise<void>(() => {})),
  onRemoteEditState: vi.fn(async () => () => {}),
}));

import * as api from "../../api";
import type { Translate } from "../../i18n";
import { useFilerTransfer } from "./useFilerTransfer";

type Hook = ReturnType<typeof useFilerTransfer>;

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const t = ((key: string) => key) as unknown as Translate;
const setError = vi.fn();

let host: HTMLDivElement;
let root: Root;
let hook: Hook;

function Harness() {
  const [error, setLocalError] = useState<string | null>(null);
  const transfer = useFilerTransfer({
    setError: (next) => {
      setError(next);
      setLocalError(typeof next === "function" ? next(error) : next);
    },
    error,
    t,
  });
  hook = transfer;
  return h("div", { "data-status": transfer.transfer?.status ?? "idle" });
}

const status = () => host.querySelector("[data-status]")?.getAttribute("data-status");

beforeEach(() => {
  vi.clearAllMocks();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root.render(h(Harness)));
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("cancelling a Filer transfer", () => {
  it("takes the bar down as soon as the user cancels", () => {
    let id: string | undefined;
    act(() => {
      id = hook.beginTransfer("upload", "notes.txt", true);
    });
    expect(status()).toBe("running");

    act(() => hook.cancelTransfer());
    // The backend has not answered: `cancelTransfer` never resolves.
    expect(status()).toBe("cancelled");
    expect(api.cancelTransfer).toHaveBeenCalledWith(id);
  });

  it("ignores the late rejection and progress of the cancelled copy", () => {
    let id: string | undefined;
    act(() => {
      id = hook.beginTransfer("upload", "notes.txt", true);
    });
    act(() => hook.cancelTransfer());

    act(() => hook.failTransfer(new Error("stream failed"), id));
    expect(status()).toBe("cancelled");
    expect(setError).not.toHaveBeenCalled();

    act(() => hook.progressFor(id)({ transferred: 512, total: 1024 }));
    expect(status()).toBe("cancelled");
  });
});
