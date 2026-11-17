import { beforeEach, describe, expect, it, vi } from "vitest";

const platform = vi.hoisted(() => ({ mac: false, windows: true }));
const api = vi.hoisted(() => ({ writeClipboardText: vi.fn(async (_text: string) => {}) }));
const pageWrite = vi.hoisted(() => vi.fn(async (_text: string) => {}));

vi.mock("./platform", () => ({
  HAS_TRAY: true,
  get IS_MAC() {
    return platform.mac;
  },
  get IS_WINDOWS() {
    return platform.windows;
  },
}));
vi.mock("./api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api")>()),
  ...api,
}));
vi.stubGlobal("navigator", { clipboard: { writeText: pageWrite } });

import { writeSystemClipboard } from "./systemClipboard";

beforeEach(() => {
  platform.mac = false;
  platform.windows = true;
  api.writeClipboardText.mockClear();
  pageWrite.mockClear();
});

describe("copying text the user asked for", () => {
  it("writes through the process on Windows and macOS", async () => {
    await writeSystemClipboard("hello");
    expect(api.writeClipboardText).toHaveBeenCalledWith("hello");
    expect(pageWrite).not.toHaveBeenCalled();

    platform.mac = true;
    platform.windows = false;
    await writeSystemClipboard("again");
    expect(api.writeClipboardText).toHaveBeenLastCalledWith("again");
    expect(pageWrite).not.toHaveBeenCalled();
  });

  it("writes from the page where the platform allows it", async () => {
    platform.mac = false;
    platform.windows = false;
    await writeSystemClipboard("from the page");
    expect(pageWrite).toHaveBeenCalledWith("from the page");
    expect(api.writeClipboardText).not.toHaveBeenCalled();
  });
});
