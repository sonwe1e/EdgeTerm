import { describe, expect, it, vi } from "vitest";
const ipc = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: ipc.invoke, Channel: class {} }));
import { writeSessionBytes, zmodemReadBytes, zmodemWriteBytes } from "./api";

describe("binary transfer IPC", () => {
  it("sends typed subviews unchanged with Unicode metadata separately encoded", async () => {
    const view = Uint8Array.of(99, 0, 128, 255, 99).subarray(1, 4);
    const path = "C:\\测试\\é #%.bin";
    await zmodemWriteBytes(path, 1048576, view);
    const [command, bytes, options] = ipc.invoke.mock.lastCall!;
    expect(command).toBe("zmodem_write_bytes");
    expect(bytes).toBe(view);
    const metadata = new TextDecoder().decode(
      Uint8Array.from(atob(options.headers["x-edgeterm-metadata"]), (c) => c.charCodeAt(0)),
    );
    expect(JSON.parse(metadata)).toEqual({ path, offset: 1048576 });
    await writeSessionBytes("test-session", view);
    expect(ipc.invoke.mock.lastCall![0]).toBe("write_session_bytes");
    expect(ipc.invoke.mock.lastCall![1]).toBe(view);
  });
  it("keeps a raw read response in the same buffer and propagates errors", async () => {
    const buffer = Uint8Array.of(0, 128, 255).buffer;
    ipc.invoke.mockResolvedValueOnce(buffer);
    expect((await zmodemReadBytes("file", 7, 3)).buffer).toBe(buffer);
    expect(ipc.invoke).toHaveBeenLastCalledWith("zmodem_read_bytes", {
      path: "file",
      offset: 7,
      length: 3,
    });
    ipc.invoke.mockRejectedValueOnce(new Error("read failed"));
    await expect(zmodemReadBytes("file", 7, 3)).rejects.toThrow("read failed");
  });
});
