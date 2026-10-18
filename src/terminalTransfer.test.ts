import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("./api", () => ({
  zmodemWriteBytes: vi.fn(async () => {}), zmodemFinishFile: vi.fn(async () => {}),
  zmodemReadBytes: vi.fn(),
}));
import * as api from "./api";
import { BufferedFileWriter, ChunkedFileReader, FILE_CHUNK_SIZE } from "./terminalTransfer";
afterEach(() => vi.clearAllMocks());

describe("binary file streaming", () => {
  // The chunk size is a cross-language contract: `write_transfer_bytes` in
  // src-tauri/src/commands/binary_transfer.rs rejects anything larger than its
  // own ZMODEM_FILE_CHUNK_SIZE. Asserting the literal keeps this side pinned.
  it("uses 1 MiB chunks, the Rust transfer limit", () => {
    expect(FILE_CHUNK_SIZE).toBe(1_048_576);
  });

  it("owns queued input, writes bounded chunks in order and finishes at the exact size", async () => {
    const progress = vi.fn();
    const writer = new BufferedFileWriter("file", progress, vi.fn());
    const input = new Uint8Array(1_048_576 + 17).fill(128);
    input[0] = 0; input[input.length - 1] = 255;
    writer.push(input); input.fill(42);
    expect(await writer.finish()).toBe(1_048_576 + 17);
    const calls = vi.mocked(api.zmodemWriteBytes).mock.calls;
    expect(calls.map((c) => [c[1], c[2].length])).toEqual([[0, 1_048_576], [1_048_576, 17]]);
    expect(calls[0][2][0]).toBe(0);
    expect(calls[1][2][16]).toBe(255);
    expect(api.zmodemFinishFile).toHaveBeenCalledWith("file", 1_048_576 + 17);
  });
  it("reports disk failure once and does not finalize incomplete output", async () => {
    const failure = new Error("disk full");
    vi.mocked(api.zmodemWriteBytes).mockRejectedValueOnce(failure);
    const onError = vi.fn();
    const writer = new BufferedFileWriter("file", vi.fn(), onError);
    writer.push(new Uint8Array(1_048_576));
    await writer.whenFailed;
    writer.push(Uint8Array.of(1));
    await expect(writer.finish()).rejects.toThrow("disk full");
    expect(onError).toHaveBeenCalledTimes(1);
    expect(api.zmodemFinishFile).not.toHaveBeenCalled();
  });
  it("caches raw reads and keeps the prior offset valid after a failed read", async () => {
    vi.mocked(api.zmodemReadBytes).mockResolvedValueOnce(new Uint8Array(1_048_576).fill(7));
    const reader = new ChunkedFileReader("file", 1_048_576 * 2);
    expect(await reader.read(0, 3)).toEqual(Uint8Array.of(7, 7, 7));
    await reader.read(10, 3);
    expect(api.zmodemReadBytes).toHaveBeenCalledTimes(1);
    vi.mocked(api.zmodemReadBytes).mockRejectedValueOnce(new Error("read failed"));
    await expect(reader.read(1_048_576, 3)).rejects.toThrow("read failed");
    expect(await reader.read(0, 3)).toEqual(Uint8Array.of(7, 7, 7));
    expect(api.zmodemReadBytes).toHaveBeenCalledTimes(2);
  });
});
