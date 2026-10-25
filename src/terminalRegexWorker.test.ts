import { afterEach, expect, it, vi } from "vitest";
import { TerminalRegexWorker } from "./terminalRegexWorker";
import type { RegexRequest } from "./terminalRegex";

const request: RegexRequest = {
  source: "foo",
  flags: "g",
  wholeWord: false,
  lines: [],
  selection: null,
  forward: true,
  incremental: true,
  refresh: false,
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it("reports worker creation failure without evaluating the regex on the UI thread", async () => {
  vi.stubGlobal(
    "Worker",
    class {
      constructor() {
        throw new Error("worker unavailable");
      }
    },
  );
  const worker = new TerminalRegexWorker();
  expect(await worker.search(request)).toEqual({ error: "unavailable" });
  worker.cancel();
});

it("ignores a queued old-worker message without losing ownership of its replacement", async () => {
  vi.useFakeTimers();
  const instances: FakeWorker[] = [];
  class FakeWorker {
    onmessage: ((event: { data: unknown }) => void) | null = null;
    terminate = vi.fn();
    postMessage() {}
    constructor() {
      instances.push(this);
    }
  }
  vi.stubGlobal("Worker", FakeWorker);
  const worker = new TerminalRegexWorker();
  const first = worker.search(request);
  const second = worker.search(request);
  expect(await first).toBeNull();
  instances[0].onmessage?.({ data: { matches: [], target: null } });
  worker.cancel();
  expect(await second).toBeNull();
  expect(instances[0].terminate).toHaveBeenCalledOnce();
  expect(instances[1].terminate).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});
