import { afterEach, describe, expect, it, vi } from "vitest";
import Zmodem from "zmodem.js";
vi.mock("./api", () => ({
  writeSessionBytes: vi.fn(),
  zmodemFileInfo: vi.fn(),
  zmodemReadBytes: vi.fn(),
  zmodemCreateFile: vi.fn(),
  zmodemWriteBytes: vi.fn(),
  zmodemFinishFile: vi.fn(),
}));
vi.mock("./nativeDialog", () => ({ open: vi.fn(), save: vi.fn() }));
import * as api from "./api";
import * as dialog from "./nativeDialog";
import { ZmodemController } from "./zmodem";
import { FILE_CHUNK_SIZE } from "./terminalTransfer";

const header = () =>
  Uint8Array.from(
    (
      Zmodem as typeof Zmodem & {
        Header: { build(name: string): { to_hex(): number[] } };
      }
    ).Header.build("ZRQINIT").to_hex(),
  );
const controllers: ZmodemController[] = [];
afterEach(() => {
  controllers.splice(0).forEach((c) => c.dispose());
  vi.resetAllMocks();
});

/**
 * The receive half of the ZMODEM pipeline. zmodem.test.ts drives a *send*
 * round-trip through two real controllers; this file drives the other side,
 * where the destination file is created locally and a cancel has to leave the
 * reader with something honest.
 *
 * Flush timing that decides the cancel point: BufferedFileWriter.push only
 * reaches the IPC layer when a full FILE_CHUNK_SIZE (1 MiB) has accumulated,
 * so the first zmodemWriteBytes call is the earliest signal that is
 * unambiguously mid-file.
 *
 * The pump splits outbound bytes the way the working send test does: feeding
 * zmodem.js one whole buffer recurses until the stack runs out.
 *
 * Boundary: jsdom, real zmodem.js on both ends, file I/O stubbed at the IPC
 * layer. No real disk, no real sz/rz.
 */
describe("ZMODEM receive cancellation", () => {
  it("lands what arrived when a download is cancelled mid-flight", async () => {
    // zmodemCreateFile truncates the destination and BufferedFileWriter only
    // reaches the disk on a full chunk or on finish(). Cancel used to do
    // neither, leaving a partial file that reads as finished - and the only
    // notice was a green "canceled" that never named the file.
    const size = FILE_CHUNK_SIZE + 512 * 1024;
    const content = Uint8Array.from({ length: size }, (_, i) => (i * 7) & 255);
    const notices: string[] = [];
    const errors: string[] = [];
    let cancelled = false;
    let receiver!: ZmodemController;
    vi.mocked(dialog.open).mockResolvedValue(["big.bin"]);
    vi.mocked(dialog.save).mockImplementation(async (o) => o!.defaultPath!);
    vi.mocked(api.zmodemFileInfo).mockImplementation(async (target) => ({
      name: target,
      size,
      modified: null,
    }));
    vi.mocked(api.zmodemReadBytes).mockImplementation(async (_target, offset, length) =>
      content.subarray(offset, offset + length),
    );
    vi.mocked(api.zmodemCreateFile).mockImplementation(async () => {});
    vi.mocked(api.zmodemWriteBytes).mockImplementation(async () => {
      if (!cancelled) {
        cancelled = true;
        receiver.cancel();
      }
    });
    const sender = new ZmodemController("sender", {
      toTerminal() {},
      onStatus() {},
      onNotice() {},
    });
    receiver = new ZmodemController("receiver", {
      toTerminal() {},
      onStatus() {},
      onNotice: (message, kind) => {
        if (kind === "error") errors.push(message);
        notices.push(message);
      },
    });
    controllers.push(sender, receiver);
    // Asynchronous, because a synchronous pump delivers the whole file before
    // any queued write resolves, and the cancel then lands after completion.
    // Split, because zmodem.js recurses until the stack runs out when handed
    // one whole buffer.
    vi.mocked(api.writeSessionBytes).mockImplementation(async (id, bytes) => {
      const target = id === "sender" ? receiver : sender;
      await new Promise((r) => setTimeout(r, 0));
      for (let start = 0; start < bytes.length; start += 4093)
        target.consume(bytes.subarray(start, start + 4093));
    });
    receiver.consume(header());
    for (let i = 0; i < 3000 && !cancelled; i++) await new Promise((r) => setTimeout(r, 1));
    await new Promise((r) => setTimeout(r, 200));
    // The cancellation lands first and sizes what arrived.
    const calls = vi.mocked(api.zmodemFinishFile).mock.calls;
    expect(calls[0]).toEqual(["big.bin", FILE_CHUNK_SIZE]);
    expect(notices.some((n) => n.includes("big.bin") && n.includes("incomplete"))).toBe(true);
    // The bytes already in flight still complete, but a cancelled session must
    // not then claim the file was received - that pair of lines is what the
    // guard in receiveOffer is for.
    expect(notices).not.toContain("ZMODEM received big.bin (1.50 MiB)");
  }, 20000);
});
