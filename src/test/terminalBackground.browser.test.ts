import { afterEach, expect, it, vi } from "vitest";
import { TerminalController } from "../terminal";
import { isWebglEnabled, setWebglEnabled } from "../terminalRegistry";
import { twoFrames } from "./browserHarness";
import "../styles.css";

let controller: TerminalController | null = null;
let slot: HTMLElement | null = null;
const previousWebgl = isWebglEnabled();

afterEach(() => {
  controller?.dispose();
  controller = null;
  slot?.remove();
  slot = null;
  setWebglEnabled(previousWebgl);
  vi.restoreAllMocks();
});

it("parses a scrolling hidden terminal and paints its latest viewport on return", async () => {
  setWebglEnabled(false);
  slot = document.createElement("div");
  slot.className = "pane-slot";
  slot.style.cssText = "position:absolute;left:0;top:0;width:900px;height:480px";
  const host = document.createElement("div");
  host.className = "term-pane";
  slot.append(host);
  document.body.append(slot);
  controller = new TerminalController(
    "background-output-fixture",
    {
      onData() {},
      onResize() {},
      onStatus() {},
      onCommand() {},
      onCommandState() {},
      suggest: () => [],
      forgetSuggestion() {},
    },
    13,
    1000,
  );
  controller.attach(host);
  controller.setVisible(true);
  controller.fit(true);
  await twoFrames();
  slot.classList.add("is-hidden");
  controller.setVisible(false);
  await twoFrames();

  const semantic = (controller as unknown as { semantic: { refreshSemanticColors(): void } })
    .semantic;
  const paint = vi.spyOn(semantic, "refreshSemanticColors");
  const scroll = vi.fn();
  controller.term.onScroll(scroll);
  const bytes = new TextEncoder().encode("host 10.0.0.1 up\r\n".repeat(300));
  await new Promise<void>((resolve) => controller!.write(bytes, resolve));
  await twoFrames();
  expect(scroll).toHaveBeenCalled();
  expect(paint).not.toHaveBeenCalled();

  const buffer = controller.term.buffer.active;
  const row = buffer.viewportY;
  expect(buffer.getLine(row)?.translateToString(true)).toContain("10.0.0.1");
  expect(buffer.getLine(row)?.getCell(5)?.isFgRGB()).toBe(false);
  slot.classList.remove("is-hidden");
  controller.setVisible(true);
  controller.fit(true);
  await twoFrames();
  expect(buffer.getLine(row)?.getCell(5)?.isFgRGB()).toBe(true);
  expect(slot.querySelector(".xterm-rows")?.textContent).toContain("10.0.0.1");
});
