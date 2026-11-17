import { beforeEach, describe, expect, it, vi } from "vitest";

const openUrl = vi.fn<(url: string) => Promise<void>>();
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: (url: string) => openUrl(url) }));
vi.mock("./api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api")>()),
  openLocalPath: vi.fn(async (path: string) => {
    throw new Error(`no handler for ${path}`);
  }),
}));

import { openExternalLink, revealLocalPath } from "./openExternal";
import { useStore } from "./store";

beforeEach(() => {
  openUrl.mockReset();
  useStore.getState().setError(null);
});

describe("an action the user asked for", () => {
  it("leaves the error area alone when the link opens", async () => {
    openUrl.mockResolvedValue(undefined);
    await openExternalLink("https://example.com/");
    expect(openUrl).toHaveBeenCalledWith("https://example.com/");
    expect(useStore.getState().error).toBeNull();
  });

  it("shows why a link could not be opened instead of swallowing it", async () => {
    openUrl.mockRejectedValue(new Error("no default browser"));
    await openExternalLink("https://example.com/");
    // The visible surface: the status bar's error, which stays until dismissed.
    expect(useStore.getState().error).toContain("no default browser");
    // The message names what failed to open, so it can be reported as it stands.
    expect(useStore.getState().error).toContain("https://example.com/");
  });

  it("shows why a folder could not be revealed", async () => {
    await revealLocalPath("/tmp/recordings");
    expect(useStore.getState().error).toContain("/tmp/recordings");
  });
});
