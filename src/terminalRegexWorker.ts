import type { RegexRequest, RegexResponse } from "./terminalRegex";

type Result = RegexResponse | { error: "timeout" | "unavailable" } | null;

/** A superseded or timed-out regex must not keep consuming a worker thread. */
export class TerminalRegexWorker {
  private pending: (() => void) | null = null;

  cancel() {
    this.pending?.();
  }

  search(request: RegexRequest): Promise<Result> {
    this.cancel();
    return new Promise((resolve) => {
      let worker: Worker | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let settled = false;
      const finish = (result: Result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        worker?.terminate();
        this.pending = null;
        resolve(result);
      };
      this.pending = () => finish(null);
      try {
        worker = new Worker(new URL("./terminalRegex.worker.ts", import.meta.url), {
          type: "module",
        });
        worker.onmessage = (event: MessageEvent<RegexResponse>) => finish(event.data);
        worker.onerror = (event) => {
          event.preventDefault();
          finish({ error: "unavailable" });
        };
        worker.onmessageerror = () => finish({ error: "unavailable" });
        // Includes worker startup. Failure is explicit and retryable; never
        // fall back to evaluating the same expression on the main thread.
        timer = setTimeout(() => finish({ error: "timeout" }), 1500);
        worker.postMessage(request);
      } catch {
        finish({ error: "unavailable" });
      }
    });
  }
}
