// Exploratory checks in an explicitly selected disposable dev app:
// 1. Display Settings has the GPU row; toggling it unloads/reloads WebGL.
// 2. Throttled fit still converges: after a splitter drag the terminal grid
//    ends at the size its pane settled on (once the trailing fit lands).
const { sleep, findPageWs, connect, CLICK_JS } = require("./cdp-helpers.cjs");
const assert = require("node:assert/strict");

async function main() {
  const cdp = await connect(await findPageWs());
  const ev = (js) =>
    cdp.eval(js).then((r) => {
      if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 250));
      return r.result.value;
    });

  let createdId;
  try {
    assert.equal((await ev('window.__TAURI_INTERNALS__.invoke("list_sessions")')).length, 0, "Use an empty disposable app");
    // open a Local shell session
    await ev(CLICK_JS(".menu-item", "Session"));
    await sleep(400);
    await ev(CLICK_JS(".menu-entry", "New Session"));
    await sleep(500);
    await ev('(() => { const el = [...document.querySelectorAll("button.protocol-option")].find((e) => e.textContent.includes("Local shell")); el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); el.click(); return "picked"; })()');
    await sleep(300);
    await ev(CLICK_JS(".btn.is-primary", "Connect"));
    await sleep(2500);

    const sessions = await ev('window.__TAURI_INTERNALS__.invoke("list_sessions")');
    assert.equal(sessions.length, 1, "Expected one newly opened session");
    assert.equal(sessions[0].kind, "local");
    createdId = sessions[0].id;
    const statusCols = () =>
      ev('(() => { const s = document.querySelector("[class*=status]")?.textContent || ""; const m = s.match(/Window (\\d+)×(\\d+)/); return m ? Number(m[1]) + "x" + Number(m[2]) : null; })()');
    const webglCanvasCount = () =>
      ev('(() => { const pane = document.querySelector(".term-pane"); return pane ? pane.querySelectorAll("canvas:not([class])").length : -1; })()');
    const paneWidth = () =>
      ev('Math.round(document.querySelector(".term-pane").getBoundingClientRect().width)');

    console.log("initial grid:", await statusCols(), "pane:", await paneWidth(), "webgl canvases:", await webglCanvasCount());

    // --- fix 2: throttled fit converges after a drag ---
    const fire = (type, x) =>
      ev(`(() => {
        const ss = [...document.querySelectorAll(".splitter.is-vertical")];
        const s = ss[0];
        if (!s) return 0;
        s.dispatchEvent(new PointerEvent(${JSON.stringify(type)}, {
          bubbles: true, cancelable: true, pointerId: 1, pointerType: "mouse",
          isPrimary: true, buttons: 1, button: 0, clientX: ${x}, clientY: 400,
        }));
        return 1;
      })()`);
    const x0 = await ev('Math.round(document.querySelector(".splitter.is-vertical").getBoundingClientRect().x)');
    const before = { grid: await statusCols(), pane: await paneWidth() };
    await fire("pointerdown", x0);
    for (let i = 1; i <= 12; i++) {
      await fire("pointermove", x0 + i * 10);
      await sleep(16);
    }
    await fire("pointerup", x0 + 120);
    // while the drag may have fit recently, the trailing fit lands within the
    // throttle interval; wait past it before asserting
    await sleep(1200);
    const after = { grid: await statusCols(), pane: await paneWidth() };
    console.log("drag: grid", before.grid, "->", after.grid, "| pane", before.pane, "->", after.pane);
    assert(before.grid && after.grid, "Terminal grid could not be observed");
    assert.notEqual(before.pane, after.pane, "Synthetic drag did not resize the pane; no result");
    const [bc] = after.grid.split("x").map(Number);
    const [bcols] = before.grid.split("x").map(Number);
    assert.notEqual(bcols, bc, "Columns did not change with the pane");
    console.log("Columns changed; this does not measure final grid/pane agreement or frame timing");

    // --- fix 1: the GPU row exists and toggling swaps renderers live ---
    await ev(CLICK_JS(".menu-item", "View"));
    await sleep(350);
    await ev(CLICK_JS(".menu-entry", "Display Settings"));
    await sleep(500);
    const row = await ev('!!document.querySelector(".gpu-setting")');
    console.log("Display Settings has GPU row:", row ? "PASS" : "FAIL");
    assert(row, "Missing GPU setting");
    if (row) {
      await ev('(() => { const box = document.querySelector(".gpu-setting input"); box.click(); return "unchecked"; })()');
      await ev(CLICK_JS(".btn.is-primary", "Apply"));
      await sleep(1200);
      const off = { canvases: await webglCanvasCount(), stored: await ev('localStorage.getItem("edgeterm.gpuRenderer")') };
      console.log("after disable: webgl canvases:", off.canvases, "stored:", off.stored);
      // re-enable through the dialog again
      await ev(CLICK_JS(".menu-item", "View"));
      await sleep(350);
      await ev(CLICK_JS(".menu-entry", "Display Settings"));
      await sleep(500);
      await ev('(() => { const box = document.querySelector(".gpu-setting input"); box.click(); return "checked"; })()');
      await ev(CLICK_JS(".btn.is-primary", "Apply"));
      await sleep(1500);
      const on = { canvases: await webglCanvasCount(), stored: await ev('localStorage.getItem("edgeterm.gpuRenderer")') };
      console.log("after re-enable: webgl canvases:", on.canvases, "stored:", on.stored);
      assert(off.canvases === 0 && on.canvases > 0, "Renderer toggle failed or WebGL is unavailable");
    }
  } finally {
    if (createdId) await Promise.race([
      ev(`window.__TAURI_INTERNALS__.invoke("close_session", {id:${JSON.stringify(createdId)}})`).catch(() => {}),
      sleep(3000),
    ]);
    cdp.close();
  }
  process.exit(0);
}

main().catch((e) => { console.error(e.stack || e); process.exit(1); });
