import zlib from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  buildZip,
  crc32,
  diagnosticsArchive,
  portableArchive,
  zipEntry,
} from "./package-release.mjs";

/** Reads the archive back the way an unpacker does: local headers, then the
 *  end-of-central-directory record that has to point at the same bytes. */
function readArchive(buffer) {
  const entries = [];
  let offset = 0;
  while (offset + 30 <= buffer.length && buffer.readUInt32LE(offset) === 0x04034b50) {
    const method = buffer.readUInt16LE(offset + 8);
    const crc = buffer.readUInt32LE(offset + 14);
    const compressed = buffer.readUInt32LE(offset + 18);
    const size = buffer.readUInt32LE(offset + 22);
    const nameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    const name = buffer.subarray(offset + 30, offset + 30 + nameLength).toString("utf8");
    const bodyStart = offset + 30 + nameLength + extraLength;
    const body = buffer.subarray(bodyStart, bodyStart + compressed);
    entries.push({
      name,
      method,
      crc,
      size,
      data: method === 8 ? zlib.inflateRawSync(body) : body,
    });
    offset = bodyStart + compressed;
  }
  const end = buffer.length - 22;
  return {
    entries,
    centralOffset: offset,
    eocd: {
      signature: buffer.readUInt32LE(end),
      count: buffer.readUInt16LE(end + 10),
      size: buffer.readUInt32LE(end + 12),
      offset: buffer.readUInt32LE(end + 16),
    },
  };
}

describe("release archives", () => {
  it("computes the standard CRC-32 of a known string", () => {
    expect(crc32(Buffer.from("123456789"))).toBe(0xcbf43926);
  });

  it("round-trips every entry and points the central directory at them", () => {
    const entries = [
      zipEntry("README.txt", Buffer.from("hello world", "utf8")),
      zipEntry("data/", Buffer.alloc(0), { directory: true }),
      zipEntry("big.bin", Buffer.alloc(1024 * 1024 + 1, 7)),
    ];
    const archive = buildZip(entries);
    const read = readArchive(archive);

    expect(read.entries.map((entry) => entry.name)).toEqual(["README.txt", "data/", "big.bin"]);
    expect(read.entries[0].method).toBe(8);
    expect(read.entries[0].data.toString("utf8")).toBe("hello world");
    expect(read.entries[1].method).toBe(0);
    expect(read.entries[1].size).toBe(0);
    // Large binaries are deflated too: that is what makes the portable zip
    // about half the size of the executable it carries.
    expect(read.entries[2].method).toBe(8);
    expect(read.entries[2].data.length).toBe(1024 * 1024 + 1);

    expect(read.eocd.signature).toBe(0x06054b50);
    expect(read.eocd.count).toBe(3);
    expect(read.eocd.offset).toBe(read.centralOffset);
    expect(read.eocd.offset + read.eocd.size).toBe(archive.length - 22);
    for (const entry of read.entries) expect(entry.crc).toBe(crc32(entry.data));
  });

  it("produces identical bytes for identical input", () => {
    const build = () => buildZip([zipEntry("a.txt", Buffer.from("same bytes", "utf8"))]);
    expect(build().equals(build())).toBe(true);
  });

  it("puts the executable, the readme and the portable data folder in the zip", () => {
    const exe = Buffer.from("MZ fake executable");
    const archive = portableArchive("9.9.9", exe);
    expect(archive.name).toBe("EdgeTerm_9.9.9_x64-portable.zip");

    const read = readArchive(archive.buffer);
    const byName = new Map(read.entries.map((entry) => [entry.name, entry]));
    expect([...byName.keys()]).toEqual(["EdgeTerm.exe", "README.txt", "data/"]);
    expect(byName.get("EdgeTerm.exe").data.equals(exe)).toBe(true);
    expect(byName.get("data/").size).toBe(0);
    // The readme has to say what enables portable mode, not just how to run it.
    expect(byName.get("README.txt").data.toString("utf8")).toContain("data folder");
  });

  it("bundles both diagnostic scripts with their usage note", () => {
    const archive = diagnosticsArchive("9.9.9", [
      ["diagnose-hang.ps1", Buffer.from("param()")],
      ["diagnose-hang.cmd", Buffer.from("powershell")],
    ]);
    const read = readArchive(archive.buffer);
    expect(read.entries.map((entry) => entry.name)).toEqual([
      "diagnose-hang.ps1",
      "diagnose-hang.cmd",
      "README.txt",
    ]);
    expect(read.entries[2].data.toString("utf8")).toContain("does not upload anything");
  });
});
