import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { FileIcon } from "./FileIcon";
import type { ThemeMode } from "../types";

// The icon theme is a lazy import inside FileIcon, so the test drives the
// real sequence and keeps its phases apart. The beforeAll below loads the
// module once (the first load transforms the whole icon map under the
// runner); the component's internal `theme` variable is still set by its own
// effect, whose promise resolves from the warmed module registry. Each
// polling tick wraps ONLY its timer in act, so any state update that timer
// unblocks is flushed to the DOM before the next check - polling inside one
// long act would hold the flush until the act ends.
let host: HTMLDivElement;
let root: Root;

function render(name: string, isDir: boolean, theme: ThemeMode) {
  act(() => {
    root.render(h(FileIcon, { name, isDir, theme }));
  });
}

async function waitForImg() {
  for (let ticks = 0; ticks < 500; ticks += 1) {
    if (host.querySelector("img")) return;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
}

describe("FileIcon", () => {
  beforeAll(
    async () => {
      (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
      await import("../fileIcons");
    },
    30000,
  );

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  afterAll(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = undefined;
  });

  it("draws the img once the lazy theme arrives", async () => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);

    render("package.json", false, "dark");
    await waitForImg();
    const img = host.querySelector("img");
    expect(img).not.toBeNull();
    const { fileIconSource } = await import("../fileIcons");
    expect(img?.getAttribute("src")).toBe(
      fileIconSource("package.json", false, "dark"),
    );
    expect(img?.getAttribute("draggable")).toBe("false");
  });

  it("switches to the theme's own icon when the theme changes", async () => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);

    render("sconstruct", false, "dark");
    await waitForImg();
    const before = host.querySelector("img")?.getAttribute("src");
    render("sconstruct", false, "light");
    const after = host.querySelector("img")?.getAttribute("src");
    expect(after).toBeTruthy();
    expect(after).not.toBe(before);
  });
});
