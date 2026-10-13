import { afterEach, describe, expect, it, vi } from "vitest";
import Zmodem from "zmodem.js";
vi.mock("./api", () => ({
  writeSessionBytes: vi.fn(), zmodemFileInfo: vi.fn(), zmodemReadBytes: vi.fn(),
  zmodemCreateFile: vi.fn(), zmodemWriteBytes: vi.fn(), zmodemFinishFile: vi.fn(),
}));
vi.mock("./nativeDialog", () => ({ open: vi.fn(), save: vi.fn() }));
import * as api from "./api";
import * as dialog from "./nativeDialog";
import { ZmodemController } from "./zmodem";
import { FILE_CHUNK_SIZE } from "./terminalTransfer";

const header = () => Uint8Array.from((Zmodem as typeof Zmodem & {
  Header: { build(name: string): { to_hex(): number[] } };
}).Header.build("ZRQINIT").to_hex());
const controllers: ZmodemController[] = [];
afterEach(() => { controllers.splice(0).forEach((c) => c.dispose()); vi.resetAllMocks(); });

describe("ZMODEM controller binary pipeline", () => {
  it("round-trips a multi-chunk binary file and empty file through the real controllers", async () => {
    const content = Uint8Array.from({ length: FILE_CHUNK_SIZE + 513 }, (_, i) => (i * 31) & 255);
    const source = new Map([["binary.dat", content], ["empty.dat", new Uint8Array()]]);
    const written = new Map<string, Uint8Array[]>();
    vi.mocked(dialog.open).mockResolvedValue([...source.keys()]);
    vi.mocked(dialog.save).mockImplementation(async (options) => options!.defaultPath!);
    vi.mocked(api.zmodemFileInfo).mockImplementation(async (path) => ({ name: path, size: source.get(path)!.length, modified: null }));
    vi.mocked(api.zmodemReadBytes).mockImplementation(async (path, offset, length) => source.get(path)!.slice(offset, offset + length));
    vi.mocked(api.zmodemCreateFile).mockImplementation(async (path) => { written.set(path, []); });
    vi.mocked(api.zmodemWriteBytes).mockImplementation(async (path, _offset, bytes) => { written.get(path)!.push(bytes.slice()); });
    let finish!: () => void;
    const completed = new Promise<void>((r) => { finish = r; });
    const notices: string[] = [];
    const errors: string[] = [];
    const terminal: Uint8Array[] = [];
    const sender = new ZmodemController("sender", { toTerminal() {}, onStatus() {},
      onNotice: (message, kind) => {
        if (kind === "error") errors.push(message);
        notices.push(message);
      },
    });
    const receiver = new ZmodemController("receiver", { toTerminal: (b) => terminal.push(b), onStatus() {},
      onNotice: (message, kind) => {
        if (kind === "error") errors.push(message);
        if (message === "ZMODEM: received 2 files") finish();
      },
    });
    controllers.push(sender, receiver);
    vi.mocked(api.writeSessionBytes).mockImplementation(async (id, bytes) => {
      const target = id === "sender" ? receiver : sender;
      // Emulate bounded backend reads with a deliberately awkward split.
      for (let start = 0; start < bytes.length; start += 4093) target.consume(bytes.subarray(start, start + 4093));
    });
    receiver.consume(header());
    await completed;
    // Sender completion may be one promise continuation behind the receiver.
    for (let i = 0; i < 8; i++) await Promise.resolve();
    const received = written.get("binary.dat")!;
    const joined = new Uint8Array(received.reduce((n, b) => n + b.length, 0));
    let offset = 0; for (const part of received) { joined.set(part, offset); offset += part.length; }
    expect(joined).toEqual(content);
    expect(written.get("empty.dat")).toEqual([]);
    expect(api.zmodemFinishFile).toHaveBeenCalledWith("binary.dat", content.length);
    expect(api.zmodemFinishFile).toHaveBeenCalledWith("empty.dat", 0);
    expect(errors).toEqual([]);
    expect(notices).toContain("ZMODEM: sent 2 files");
    const after = new TextEncoder().encode("after transfer\r\n");
    receiver.consume(after);
    expect(terminal[terminal.length - 1]).toBe(after);
    expect(sender.isActive()).toBe(false); expect(receiver.isActive()).toBe(false);
  }, 15000);

  it("keeps cancellation and disposed-input behavior", () => {
    vi.mocked(api.writeSessionBytes).mockResolvedValue();
    const terminal = vi.fn(); const notice = vi.fn();
    const receiver = new ZmodemController("receiver", { toTerminal: terminal, onStatus() {}, onNotice: notice });
    controllers.push(receiver);
    receiver.consume(header());
    expect(receiver.isActive()).toBe(true);
    expect(receiver.cancel()).toBe(true);
    expect(notice).toHaveBeenCalledWith("ZMODEM: transfer canceled", "success");
    receiver.dispose(); terminal.mockClear();
    receiver.consume(Uint8Array.of(65));
    expect(terminal).not.toHaveBeenCalled();
  });
});
