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

function decodeImage(width = 2000, height = 1200, stageWidth = 800, stageHeight = 600) {
  const stage = host.querySelector<HTMLDivElement>(".image-preview-stage")!;
  Object.defineProperty(stage, "clientWidth", { configurable: true, value: stageWidth });
  Object.defineProperty(stage, "clientHeight", { configurable: true, value: stageHeight });
  vi.spyOn(stage, "getBoundingClientRect").mockReturnValue({
    x: 0,
    y: 0,
    left: 0,
    top: 0,
    width: stageWidth,
    height: stageHeight,
    right: stageWidth,
    bottom: stageHeight,
    toJSON: () => ({}),
  });
  act(() => window.dispatchEvent(new Event("resize")));
  const image = host.querySelector("img")!;
  Object.defineProperty(image, "naturalWidth", { configurable: true, value: width });
  Object.defineProperty(image, "naturalHeight", { configurable: true, value: height });
  act(() => image.dispatchEvent(new Event("load", { bubbles: true })));
  return { stage, image };
}

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
    expect(host.querySelector("dialog")?.getAttribute("aria-label")).toBe("Image preview");
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

  it("distinguishes Fit from real 100% pixels and tracks stage resize", async () => {
    api.previewImageFile.mockResolvedValue(Uint8Array.of(1));
    await render(target());
    const { image, stage } = decodeImage();
    expect(image.style.transform).toContain("scale(0.388)");
    expect(host.querySelector("output")?.textContent).toBe("39%");

    act(() => button("100%").click());
    expect(image.style.transform).toContain("scale(1)");
    expect(host.querySelector("output")?.textContent).toBe("100%");
    expect(button("100%").getAttribute("aria-pressed")).toBe("true");

    Object.defineProperty(stage, "clientWidth", { configurable: true, value: 1000 });
    Object.defineProperty(stage, "clientHeight", { configurable: true, value: 700 });
    act(() => window.dispatchEvent(new Event("resize")));
    expect(image.style.transform).toContain("scale(1)");

    act(() => button("Fit").click());
    expect(image.style.transform).toContain("scale(0.488)");
    expect(button("Fit").getAttribute("aria-pressed")).toBe("true");
  });

  it("zooms about the wheel pointer without scrolling and pans a larger image", async () => {
    api.previewImageFile.mockResolvedValue(Uint8Array.of(1));
    await render(target());
    const { stage, image } = decodeImage();
    const wheel = new WheelEvent("wheel", {
      bubbles: true,
      cancelable: true,
      deltaY: -120,
      clientX: 600,
      clientY: 150,
    });
    act(() => stage.dispatchEvent(wheel));
    expect(wheel.defaultPrevented).toBe(true);
    expect(Number(image.style.transform.match(/scale\(([^)]+)\)/)?.[1])).toBeGreaterThan(0.388);

    act(() => button("100%").click());
    const before = image.style.transform;
    const down = new MouseEvent("pointerdown", {
      bubbles: true,
      button: 0,
      clientX: 300,
      clientY: 300,
    });
    Object.defineProperty(down, "pointerId", { value: 8 });
    act(() => stage.dispatchEvent(down));
    const move = new MouseEvent("pointermove", { bubbles: true, clientX: 350, clientY: 280 });
    Object.defineProperty(move, "pointerId", { value: 8 });
    act(() => stage.dispatchEvent(move));
    expect(image.style.transform).not.toBe(before);
    expect(stage.classList.contains("is-dragging")).toBe(true);
    const up = new MouseEvent("pointerup", { bubbles: true });
    Object.defineProperty(up, "pointerId", { value: 8 });
    act(() => stage.dispatchEvent(up));
    expect(stage.classList.contains("is-dragging")).toBe(false);
  });

  it("resets zoom and pan for a newly opened image", async () => {
    api.previewImageFile.mockResolvedValue(Uint8Array.of(1));
    await render(target());
    const { image } = decodeImage();
    act(() => button("100%").click());
    expect(image.style.transform).toContain("scale(1)");

    await render(target("another", "next.webp"));
    const next = decodeImage(1600, 900);
    expect(next.image.getAttribute("alt")).toBe("next.webp");
    expect(next.image.style.transform).toContain("scale(0.485)");
    expect(host.querySelector("output")?.textContent).toBe("49%");
  });
});
