import { afterEach, expect, it, vi } from "vitest";

vi.mock("./platform", () => ({ HAS_TRAY: true, IS_MAC: true, IS_WINDOWS: false }));
vi.mock("./api", () => ({ readClipboardText: vi.fn(), writeClipboardText: vi.fn() }));

import { readClipboardText } from "./api";
import { TerminalController } from "./terminal";

const controllers: TerminalController[] = [];
const roots: HTMLElement[] = [];

function fixture() {
  const data = vi.fn();
  const confirm = vi.fn();
  const controller = new TerminalController(
    "clipboard-lifecycle",
    {
      onData: data,
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
  controller.onConfirmPaste(confirm);
  const root = document.createElement("div");
  document.body.append(root);
  controller.attach(root);
  roots.push(root);
  controllers.push(controller);
  let resolve!: (text: string) => void;
  vi.mocked(readClipboardText).mockReturnValueOnce(
    new Promise<string>((done) => {
      resolve = done;
    }),
  );
  controller.pasteFromClipboard();
  return { controller, confirm, data, resolve };
}

async function finishClipboard(resolve: (text: string) => void, text: string) {
  resolve(text);
  await Promise.resolve();
  await Promise.resolve();
}

afterEach(() => {
  for (const controller of controllers.splice(0)) controller.dispose();
  for (const root of roots.splice(0)) root.remove();
  vi.resetAllMocks();
});

it("does not raise a paste prompt after its terminal has been closed", async () => {
  const { controller, confirm, data, resolve } = fixture();
  controller.dispose();
  await finishClipboard(resolve, "first command\nsecond command");
  expect(confirm).not.toHaveBeenCalled();
  expect(data).not.toHaveBeenCalled();
});

it("does not deliver a clipboard read from the old connection after reconnect", async () => {
  const { controller, confirm, data, resolve } = fixture();
  controller.setLocked(true);
  controller.setLocked(false);
  await finishClipboard(resolve, "old clipboard");
  expect(data).not.toHaveBeenCalled();
  expect(confirm).not.toHaveBeenCalled();
});

it("still confirms a multi-line paste while its original terminal is active", async () => {
  const { confirm, data, resolve } = fixture();
  await finishClipboard(resolve, "first command\nsecond command");
  expect(confirm).toHaveBeenCalledWith("first command\nsecond command");
  expect(data).not.toHaveBeenCalled();
});

it("still delivers a single-line paste while its original terminal is active", async () => {
  const { data, resolve } = fixture();
  await finishClipboard(resolve, "current clipboard");
  expect(data).toHaveBeenCalledWith("current clipboard");
});
