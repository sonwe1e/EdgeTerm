// Real WebView2 -> Tauri raw binary IPC, using only newly created test files.
// Run against an explicitly selected disposable portable instance.
import assert from "node:assert/strict";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { chromium } from "playwright";

const target = process.env.EDGETERM_CDP_TARGET_ID;
assert.ok(target, "Select the disposable page with EDGETERM_CDP_TARGET_ID");
assert.ok(process.argv[2], "Pass a new output directory under .tmp");
const output = resolve(process.argv[2]);
const temporary = await realpath(resolve(".tmp"));
assert.ok(output.startsWith(temporary + sep), "Only repository .tmp output is allowed");
const parent = await realpath(resolve(output, ".."));
assert.ok(parent === temporary || parent.startsWith(temporary + sep));
await mkdir(output); // Do not overwrite earlier files or evidence.
const browser = await chromium.connectOverCDP(process.env.EDGETERM_CDP_URL || "http://127.0.0.1:9241");
const result = { checked: [], errors: [] };
try {
  let page;
  for (const candidate of browser.contexts().flatMap((context) => context.pages())) {
    const session = await candidate.context().newCDPSession(candidate);
    const { targetInfo } = await session.send("Target.getTargetInfo");
    await session.detach();
    if (targetInfo.targetId === target) page = candidate;
  }
  assert.ok(page && /tauri.localhost/.test(page.url()), "Select the disposable EdgeTerm page");
  assert.equal(await page.evaluate(() => window.__TAURI_INTERNALS__.invoke("portable_mode")), true);
  page.on("pageerror", (error) => result.errors.push(String(error)));
  result.browser = await browser.version();
  result.checked = await Promise.all(Array.from({ length: 8 }, async (_, index) => {
    const path = join(output, `测试 é #%-${index}.bin`);
    const length = 1024 * 1024;
    const expected = Buffer.from(Array.from({ length }, (_, offset) => (offset + index) % 256));
    await writeFile(path, Buffer.alloc(length));
    await page.evaluate(async ({ path, index, length }) => {
      const backing = new Uint8Array(length + 26).fill(0xee);
      const bytes = backing.subarray(13, 13 + length);
      for (let offset = 0; offset < length; offset++) bytes[offset] = (offset + index) % 256;
      const metadata = new TextEncoder().encode(JSON.stringify({ path, offset: 0 }));
      const header = btoa(Array.from(metadata, (byte) => String.fromCharCode(byte)).join(""));
      await window.__TAURI_INTERNALS__.invoke("zmodem_write_bytes", bytes, {
        headers: { "x-edgeterm-metadata": header },
      });
    }, { path, index, length });
    assert.ok((await readFile(path)).equals(expected), "Acknowledged bytes must be immediately readable");
    const readBack = await page.evaluate(async ({ path, index }) => {
      const bytes = new Uint8Array(await window.__TAURI_INTERNALS__.invoke("zmodem_read_bytes", {
        path, offset: 101, length: 257,
      }));
      return bytes.length === 257 && bytes.every((byte, offset) => byte === (offset + 101 + index) % 256);
    }, { path, index });
    assert.equal(readBack, true, "Raw binary responses must preserve bytes and file offsets");
    return { file: `测试 é #%-${index}.bin`, bytes: length, typedArrayOffset: 13, readOffset: 101 };
  }));
  assert.deepEqual(result.errors, []);
  result.passed = true;
} catch (error) {
  result.passed = false;
  result.failure = String(error);
  process.exitCode = 1;
} finally {
  await writeFile(join(output, "results.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
  await browser.close();
}
