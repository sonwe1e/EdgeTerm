import { afterEach, expect, it } from "vitest";
import { page } from "vitest/browser";
import { TerminalController } from "../terminal";
import { isWebglEnabled, setWebglEnabled } from "../terminalRegistry";
import { twoFrames, wait } from "./browserHarness";
import "../styles.css";

// Exercise a long-lived, stationary OpenCode-like alternate screen next to a
// busy, colorful TUI. The neighbor must not corrupt the stationary screen,
// even when both WebGL renderers share an atlas. All visual comparisons are
// within one browser/renderer at one size (no cross-machine golden images).
const live: { controller: TerminalController; slot: HTMLElement }[] = [];
const initialWebgl = isWebglEnabled();

function make(index: number) {
  const slot = document.createElement("div");
  slot.className = "pane-slot";
  slot.style.cssText = `position:absolute;left:${index * 560}px;top:0;width:540px;height:400px`;
  const host = document.createElement("div");
  host.className = "term-pane";
  slot.append(host);
  document.body.append(slot);

  const controller = new TerminalController(
    `color-overlay-${index}`,
    {
      onData() {},
      onResize() {},
      onStatus() {},
      onCommand() {},
      onCommandState() {},
      suggest: () => [],
      forgetSuggestion() {},
    },
    14,
    2000,
  );
  live.push({ controller, slot });
  controller.attach(host);
  controller.setVisible(true);
  controller.fit(true);
  controller.term.options.cursorBlink = false;
  return { controller, slot };
}

function write(controller: TerminalController, data: string): Promise<void> {
  return new Promise((resolve) => controller.term.write(data, resolve));
}

function visibleLayer(slot: HTMLElement, gpu: boolean) {
  const screen = slot.querySelector(".xterm-screen");
  expect(screen).not.toBeNull();
  // xterm's renderer switch must dispose the previous layer; otherwise a
  // canvas and colored DOM glyph spans can visually overlap.
  expect(screen!.querySelectorAll(":scope > canvas:not([class])").length).toBe(gpu ? 1 : 0);
  expect(screen!.querySelectorAll(":scope > .xterm-rows").length).toBe(gpu ? 0 : 1);
}

interface ScreenshotPixels {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8ClampedArray;
}

async function screenshotPixels(testId: string): Promise<ScreenshotPixels> {
  const { base64 } = await page.getByTestId(testId).screenshot({ base64: true });
  const png = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
  const bitmap = await createImageBitmap(
    new Blob([png.buffer as ArrayBuffer], { type: "image/png" }),
  );
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const context = canvas.getContext("2d", { willReadFrequently: true })!;
  context.drawImage(bitmap, 0, 0);
  const result = {
    width: canvas.width,
    height: canvas.height,
    data: context.getImageData(0, 0, canvas.width, canvas.height).data,
  };
  bitmap.close();
  return result;
}

function changedPixels(before: ScreenshotPixels, after: ScreenshotPixels): number {
  expect([after.width, after.height]).toEqual([before.width, before.height]);
  let changed = 0;
  for (let i = 0; i < before.data.length; i += 4) {
    // Ignore tiny subpixel capture differences while catching a visibly
    // wrong glyph or a new colored layer over a static line.
    const delta =
      Math.abs(before.data[i] - after.data[i]) +
      Math.abs(before.data[i + 1] - after.data[i + 1]) +
      Math.abs(before.data[i + 2] - after.data[i + 2]);
    if (delta > 48) changed++;
  }
  return changed / (before.width * before.height);
}

function colorFlood(frame: number): string {
  let frameText = "\x1b[H\x1b[2J";
  for (let row = 0; row < 18; row++) {
    frameText += `\x1b[${row + 1};1H`;
    for (let block = 0; block < 9; block++) {
      const seed = frame * 162 + row * 9 + block;
      const red = (seed * 37) % 256;
      const green = (seed * 59) % 256;
      const blue = (seed * 83) % 256;
      frameText +=
        `\x1b[38;2;${red};${green};${blue}m` +
        `\x1b[48;2;${blue};${red};${green}m` +
        `${String.fromCharCode(33 + (seed % 90))}▒▌ `;
    }
  }
  return `${frameText}\x1b[0m`;
}

afterEach(() => {
  for (const { controller, slot } of live.splice(0)) {
    controller.dispose();
    slot.remove();
  }
  setWebglEnabled(initialWebgl);
});

it.each([true, false])(
  "keeps stationary TUI glyphs and colors intact beside heavy ANSI repaint (GPU %s)",
  async (gpu) => {
    await page.viewport(1440, 900);
    setWebglEnabled(gpu);
    const busy = make(0);
    const still = make(1);
    await document.fonts.ready;

    await write(
      still.controller,
      "\x1b[?1049h\x1b[?25l\x1b[H\x1b[2J" +
        "\x1b[38;2;199;225;248m\x1b[48;2;24;35;55m" +
        " STATIONARY-OPEN-CODE-0123456789 ABCDEFGHIJ " +
        "\x1b[2;1H\x1b[38;2;242;146;90m READY: no redraw expected \x1b[0m",
    );
    await twoFrames();
    await wait(80);
    visibleLayer(still.slot, gpu);
    visibleLayer(busy.slot, gpu);
    const screen = still.slot.querySelector<HTMLElement>(".xterm-screen")!;
    screen.dataset.testid = "stationary-tui-screen";
    const before = await screenshotPixels("stationary-tui-screen");
    const first = still.controller.term.buffer.active.getLine(0)?.translateToString(true);
    expect(first).toContain("STATIONARY-OPEN-CODE");

    // 24 bounded full-screen passes: enough distinct RGB/glyph combinations
    // to exercise atlas page churn without a multi-minute benchmark.
    await write(busy.controller, "\x1b[?1049h\x1b[?25l");
    for (let frame = 0; frame < 24; frame++) {
      await write(busy.controller, colorFlood(frame));
      if (frame % 3 === 2) await twoFrames();
    }
    await twoFrames();
    await wait(80);
    visibleLayer(still.slot, gpu);
    expect(still.controller.term.buffer.active.getLine(0)?.translateToString(true)).toBe(first);
    const after = await screenshotPixels("stationary-tui-screen");
    const changed = changedPixels(before, after);
    expect(
      changed,
      `A stationary screen visibly changed after neighbor ANSI atlas churn (${gpu ? "WebGL" : "DOM"}): ${(changed * 100).toFixed(2)}% of pixels`,
    ).toBeLessThan(0.005);
  },
);

it("removes the old renderer layer when switching WebGL to DOM and back", async () => {
  await page.viewport(1440, 900);
  setWebglEnabled(true);
  const { controller, slot } = make(0);
  await write(controller, "\x1b[?1049h\x1b[?25l\x1b[38;2;220;150;80mALT-SCREEN-COLOR\x1b[0m");
  await twoFrames();
  visibleLayer(slot, true);

  setWebglEnabled(false);
  controller.refreshWebgl();
  await twoFrames();
  visibleLayer(slot, false);
  expect(slot.querySelector(".xterm-rows")?.textContent).toContain("ALT-SCREEN-COLOR");

  setWebglEnabled(true);
  controller.refreshWebgl();
  await twoFrames();
  visibleLayer(slot, true);
  expect(controller.term.buffer.active.getLine(0)?.translateToString(true)).toContain(
    "ALT-SCREEN-COLOR",
  );
});
