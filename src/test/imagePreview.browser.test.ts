import { createElement as h } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { page } from "vitest/browser";

vi.mock("../api", () => ({
  // Known 1×1 PNG. The real browser must decode it from a Blob URL.
  previewImageFile: async () =>
    Uint8Array.from(
      atob(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=",
      ),
      (character) => character.charCodeAt(0),
    ),
}));

import { ImagePreviewDialog } from "../components/ImagePreviewDialog";
import { useStore } from "../store";
import { browserAfterEach, mount, twoFrames } from "./browserHarness";
import "../styles.css";

const initial = useStore.getState();
afterEach(async () => {
  await browserAfterEach();
  useStore.setState(initial, true);
});

it("decodes a real Blob image and keeps its modal usable on a narrow viewport", async () => {
  useStore.setState({ language: "en" });
  await page.viewport(390, 640);
  mount(
    h(ImagePreviewDialog, {
      target: {
        id: "image-browser-contract",
        tabId: null,
        sessionId: null,
        path: "C:/preview/test.png",
        name: "test.png",
      },
      onClose: () => {},
    }),
  );
  await expect
    .poll(() => document.querySelector<HTMLImageElement>(".image-preview-stage img")?.naturalWidth)
    .toBe(1);
  await twoFrames();
  const dialog = document.querySelector<HTMLElement>(".image-preview-dialog")!;
  const stage = document.querySelector<HTMLElement>(".image-preview-stage")!;
  const footer = document.querySelector<HTMLElement>(".image-preview-dialog .dialog-footer")!;
  const rect = dialog.getBoundingClientRect();
  expect(rect.width).toBeLessThanOrEqual(window.innerWidth - 23);
  expect(rect.width).toBeGreaterThan(window.innerWidth * 0.9);
  expect(rect.height).toBeLessThanOrEqual(window.innerHeight - 23);
  expect(rect.height).toBeGreaterThan(window.innerHeight * 0.85);
  expect(stage.clientHeight).toBeGreaterThan(0);
  expect(footer.getBoundingClientRect().bottom).toBeLessThanOrEqual(window.innerHeight);

  const fit = [...footer.querySelectorAll("button")].find((item) => item.textContent === "Fit")!;
  const actual = [...footer.querySelectorAll("button")].find(
    (item) => item.textContent === "100%",
  )!;
  expect(fit.getBoundingClientRect().right).toBeLessThanOrEqual(window.innerWidth);
  expect(actual.getBoundingClientRect().right).toBeLessThanOrEqual(window.innerWidth);
  expect(fit.getAttribute("aria-pressed")).toBe("true");
  actual.click();
  await expect.poll(() => actual.getAttribute("aria-pressed")).toBe("true");

  const wheel = new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: -120 });
  stage.dispatchEvent(wheel);
  expect(wheel.defaultPrevented).toBe(true);
  await expect
    .poll(() => Number(document.querySelector("output")?.textContent?.replace("%", "")))
    .toBeGreaterThan(100);
  fit.click();
  await expect.poll(() => document.querySelector("output")?.textContent).toBe("100%");
});
