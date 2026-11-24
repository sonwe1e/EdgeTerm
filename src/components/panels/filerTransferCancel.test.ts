// Cancelling a Filer copy used to wait for the copy's own promise to reject, so
// a stalled read left the bar "running" with its Cancel button. The bar now
// comes down on the cancel call's answer — which also says whether anything was
// stopped: a copy that had already finished must not be reported as cancelled,
// because the transfer centre shows those files complete. The late rejection
// and progress of a cancelled copy are dropped.
import { act, createElement as h, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../api", async (original) => ({
  ...(await original<typeof import("../../api")>()),
  newTransferId: vi.fn(() => "t-1"),
  cancelTransfer: vi.fn(async () => true),
  onRemoteEditState: vi.fn(async () => () => {}),
}));

import * as api from "../../api";
import type { Translate } from "../../i18n";
import { useStore } from "../../store";
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
    source: "",
  });
  hook = transfer;
  return h("div", { "data-status": transfer.transfer?.status ?? "idle" });
}

/** The same hook for a panel showing one session, which can switch or drop. */
function SourceHarness({ source }: { source: string }) {
  const [error, setLocalError] = useState<string | null>(null);
  const transfer = useFilerTransfer({
    setError: (next) => {
      setError(next);
      setLocalError(typeof next === "function" ? next(error) : next);
    },
    error,
    t,
    source,
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

const tabsOf = (source: string, state: string) =>
  [{ info: { id: source, kind: "ssh" }, state }] as never;

describe("a Filer transfer belongs to the panel's own source", () => {
  it("takes the bar down when the connection behind it ends", () => {
    act(() => useStore.setState({ tabs: tabsOf("s1", "connected") }));
    act(() => root.render(h(SourceHarness, { source: "s1" })));
    act(() => {
      hook.beginTransfer("upload", "big.iso", true);
    });
    expect(status()).toBe("running");

    // The session dropped while the copy ran: its Cancel pointed at a dead
    // socket, so the bar goes and the error line says why.
    act(() => useStore.setState({ tabs: tabsOf("s1", "closed") }));
    expect(status()).toBe("idle");
    expect(setError).toHaveBeenCalledWith("filer.transferConnectionLost");
  });

  it("takes the bar with it when the panel switches session", () => {
    act(() =>
      useStore.setState({
        tabs: [...(tabsOf("a", "connected") as never[]), ...(tabsOf("b", "connected") as never[])],
      }),
    );
    act(() => root.render(h(SourceHarness, { source: "a" })));
    act(() => {
      hook.beginTransfer("upload", "notes.txt", true);
    });
    expect(status()).toBe("running");

    act(() => root.render(h(SourceHarness, { source: "b" })));
    expect(status()).toBe("idle");
    expect(setError).not.toHaveBeenCalled();
  });
});

describe("cancelling a Filer transfer", () => {
  it("takes the bar down when the backend confirms the stop", async () => {
    let id: string | undefined;
    act(() => {
      id = hook.beginTransfer("upload", "notes.txt", true);
    });
    expect(status()).toBe("running");

    await act(async () => hook.cancelTransfer());
    expect(status()).toBe("cancelled");
    expect(api.cancelTransfer).toHaveBeenCalledWith(id);
  });

  it("does not claim a cancel when the copy had already finished", async () => {
    vi.mocked(api.cancelTransfer).mockResolvedValueOnce(false);
    act(() => {
      hook.beginTransfer("upload", "notes.txt", true);
    });
    await act(async () => hook.cancelTransfer());
    // The files landed: the footer says so instead of contradicting the list.
    expect(status()).not.toBe("cancelled");
  });

  it("ignores the late rejection and progress of the cancelled copy", async () => {
    let id: string | undefined;
    act(() => {
      id = hook.beginTransfer("upload", "notes.txt", true);
    });
    await act(async () => hook.cancelTransfer());

    act(() => hook.failTransfer(new Error("stream failed"), id));
    expect(status()).toBe("cancelled");
    expect(setError).not.toHaveBeenCalled();

    act(() => hook.progressFor(id)({ transferred: 512, total: 1024 }));
    expect(status()).toBe("cancelled");
  });
});
