import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ previewImageFile: vi.fn() }));
vi.mock("../api", () => api);
vi.mock("../useT", async () => {
  const i18n = await vi.importActual<typeof import("../i18n")>("../i18n");
  const translate = (key: import("../i18n").MessageKey) => i18n.translate("en", key);
  return {
    useT: () => translate,
  };
});

import type { ImagePreviewTarget } from "../imagePreview";
import { ImagePreviewDialog } from "./ImagePreviewDialog";

const target = (id = "a", name = "one.png"): ImagePreviewTarget => ({
  id,
  name,
  path: `/remote/${name}`,
  tabId: "ssh-tab",
  sessionId: "ssh-tab",
});

let root: Root;
let host: HTMLDivElement;
let createUrl: ReturnType<typeof vi.fn>;
let revokeUrl: ReturnType<typeof vi.fn>;
const button = (label: string) =>
  [...host.querySelectorAll("button")].find((element) => element.textContent === label)!;
const render = (file: ImagePreviewTarget, onClose = vi.fn()) =>
  act(async () => root.render(h(ImagePreviewDialog, { target: file, onClose })));

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  createUrl = vi.fn(() => "blob:preview-1");
  revokeUrl = vi.fn();
  Object.defineProperty(URL, "createObjectURL", { configurable: true, value: createUrl });
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: revokeUrl });
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  delete (URL as { createObjectURL?: unknown }).createObjectURL;
  delete (URL as { revokeObjectURL?: unknown }).revokeObjectURL;
});

describe("read-only, on-demand image preview modal", () => {
  it("shows SSH images using an owned Blob URL and revokes it on close", async () => {
    api.previewImageFile.mockResolvedValue(Uint8Array.of(0x89, 0x50));
    const onClose = vi.fn();
    await render(target(), onClose);
    expect(api.previewImageFile).toHaveBeenCalledWith("ssh-tab", "/remote/one.png");
    expect(createUrl).toHaveBeenCalledOnce();
    expect(host.querySelector("img")?.getAttribute("src")).toBe("blob:preview-1");
    expect(host.textContent).toContain("Read only · Maximum 16 MiB");
    act(() => button("Close").click());
    expect(onClose).toHaveBeenCalledOnce();
    await act(async () => root.render(null));
    expect(revokeUrl).toHaveBeenCalledWith("blob:preview-1");
  });

  it("offers retry after a failed read, then restores the image", async () => {
    api.previewImageFile
      .mockRejectedValueOnce({ code: "connectionFailed", message: "SSH session disconnected" })
      .mockResolvedValueOnce(Uint8Array.of(1, 2, 3));
    await render(target());
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("disconnected");
    await act(async () => button("Retry").click());
    expect(api.previewImageFile).toHaveBeenCalledTimes(2);
    expect(host.querySelector("img")).not.toBeNull();
  });

  it("ignores an old SSH response when the preview changes or closes", async () => {
    let resolveFirst!: (bytes: Uint8Array) => void;
    api.previewImageFile
      .mockImplementationOnce(
        () =>
          new Promise<Uint8Array>((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockResolvedValueOnce(Uint8Array.of(4, 5));
    await render(target());
    await render(target("b", "two.jpeg"));
    expect(host.querySelector("img")?.getAttribute("alt")).toBe("two.jpeg");
    await act(async () => resolveFirst(Uint8Array.of(6, 7)));
    expect(createUrl).toHaveBeenCalledTimes(1);
    expect(host.querySelector("img")?.getAttribute("alt")).toBe("two.jpeg");
    await act(async () => root.render(null));
    expect(revokeUrl).toHaveBeenCalledWith("blob:preview-1");
  });

  it("rejects a decoded image exceeding the pixel budget", async () => {
    api.previewImageFile.mockResolvedValue(Uint8Array.of(1));
    await render(target());
    const image = host.querySelector("img")!;
    Object.defineProperty(image, "naturalWidth", { configurable: true, value: 9000 });
    Object.defineProperty(image, "naturalHeight", { configurable: true, value: 9000 });
    act(() => image.dispatchEvent(new Event("load", { bubbles: true })));
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("safe preview limit");
    expect(host.querySelector("img")).toBeNull();
  });
});
