import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  registerSnippetOpener,
  registerSnippetRunner,
  registerSnippetSaver,
  requestSnippetRun,
  requestSnippetSave,
  requestSnippetsOpen,
} from "./snippetActions";
import { useStore } from "./store";

const snippet = { id: "s1", name: "Logs", command: "tail -f app.log" };

describe("the snippet runner other surfaces use", () => {
  beforeEach(() => {
    registerSnippetRunner(null);
    useStore.setState({ status: "" });
  });

  it("hands the snippet to the registered runner", () => {
    const runner = vi.fn();
    registerSnippetRunner(runner);
    requestSnippetRun(snippet);
    expect(runner).toHaveBeenCalledWith(snippet);
  });

  it("falls back to sending directly when nothing registered", () => {
    requestSnippetRun(snippet);
    // No connected shell in this fixture: the send path refuses and says why.
    expect(useStore.getState().status).toContain("shell");
  });

  it("asks the registered saver for the last command", () => {
    const saver = vi.fn();
    registerSnippetSaver(saver);
    requestSnippetSave();
    expect(saver).toHaveBeenCalledTimes(1);
    registerSnippetSaver(null);
  });

  it("doing nothing is safe when no saver is registered", () => {
    registerSnippetSaver(null);
    expect(() => requestSnippetSave()).not.toThrow();
  });

  it("opens the manager through the registered opener", () => {
    const opener = vi.fn();
    registerSnippetOpener(opener);
    requestSnippetsOpen();
    expect(opener).toHaveBeenCalledTimes(1);
    registerSnippetOpener(null);
  });

  it("doing nothing is safe when no opener is registered", () => {
    registerSnippetOpener(null);
    expect(() => requestSnippetsOpen()).not.toThrow();
  });
});
