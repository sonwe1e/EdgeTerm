import { afterEach, expect, it } from "vitest";
import { page } from "vitest/browser";
import { TerminalController } from "../terminal";
import { mouse, pagePoint, twoFrames } from "./browserHarness";
import "../styles.css";

// Chromium dispatches real mouse moves/wheels through xterm. An SSH TUI can
// leave mouse tracking enabled when its transport dies without cleanup; the
// next shell must not receive those reports as literal typed characters.
const sentText: string[] = [];
const sentBinary: Uint8Array[] = [];
let controller: TerminalController | null = null;
let root: HTMLElement | null = null;

const write = (output: string) =>
  new Promise<void>((resolve) => controller!.term.write(output, resolve));

async function fixture() {
  await page.viewport(1440, 900);
  root = document.createElement("div");
  root.style.cssText = "display:flex;position:relative;width:900px;height:540px";
  document.body.append(root);
  controller = new TerminalController(
    "ssh-reconnect-mouse",
    {
      onData: (data) => sentText.push(data),
      onBinary: (data) => sentBinary.push(data),
      onResize() {},
      onStatus() {},
      onCommand() {},
      onCommandState() {},
      suggest: () => [],
      forgetSuggestion() {},
    },
    13,
    100,
  );
  controller.attach(root);
  controller.setVisible(true);
  controller.fit(true);
  await twoFrames();
  controller.focus();
  return controller;
}

function point(fx = 0.6, fy = 0.3) {
  const screen = root?.querySelector(".xterm-screen");
  if (!screen) throw new Error("xterm screen missing");
  return pagePoint(screen, fx, fy);
}

async function moveAndWheel() {
  const first = point(0.3, 0.3);
  const second = point(0.6, 0.3);
  await mouse.moveTo(first.x, first.y);
  await mouse.moveTo(second.x, second.y);
  await mouse.wheel(second.x, second.y, -300);
  await twoFrames();
}

afterEach(async () => {
  try {
    await mouse.forceRelease();
  } finally {
    controller?.dispose();
    root?.remove();
    controller = null;
    root = null;
    sentText.length = 0;
    sentBinary.length = 0;
  }
});

it("stops mouse reports after a dead TUI reconnects to a plain shell, but re-enables them for a new TUI", async () => {
  const terminal = await fixture();
  await write("old scrollback\r\n".repeat(180));
  expect(terminal.term.buffer.normal.baseY).toBeGreaterThan(0);

  await write("\x1b[?1049h\x1b[?1003h\x1b[?1006h");
  expect(terminal.term.modes.mouseTrackingMode).toBe("any");
  await moveAndWheel();
  expect(sentText.some((data) => /^\x1b\[<\d+;\d+;\d+[Mm]$/.test(data))).toBe(true);

  // A broken SSH connection cannot send the TUI's normal mouse-mode exit.
  terminal.setLocked(true);
  await write("");
  terminal.setLocked(false);
  await write("");
  expect(terminal.term.modes.mouseTrackingMode).toBe("none");
  expect(terminal.term.buffer.active.type).toBe("normal");

  sentText.length = 0;
  sentBinary.length = 0;
  const scrollPosition = terminal.term.buffer.normal.viewportY;
  await moveAndWheel();
  expect(terminal.term.buffer.normal.viewportY).toBeLessThan(scrollPosition);
  expect(sentText).toEqual([]);
  expect(sentBinary).toEqual([]);
  expect(terminal.term.buffer.normal.baseY).toBeGreaterThan(0);

  await write("\x1b[?1049h\x1b[?1003h\x1b[?1006h");
  sentText.length = 0;
  await moveAndWheel();
  expect(sentText.some((data) => /^\x1b\[<\d+;\d+;\d+[Mm]$/.test(data))).toBe(true);
});
