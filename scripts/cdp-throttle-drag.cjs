// Throttle the renderer N x and drag the splitters with sessions flooding.
// Usage: node cdp-throttle-drag.cjs [rate=20] [rounds=10]
const { sleep, findPageWs } = require("./cdp-helpers.cjs");

async function main() {
  const rate = Number(process.argv[2] || 20);
  const rounds = Number(process.argv[3] || 10);

  const wsUrl = await findPageWs();
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = rej;
  });
  let msgId = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const { res, rej } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
    }
  };
  const send = (method, params) =>
    new Promise((res, rej) => {
      const i = ++msgId;
      pending.set(i, { res, rej });
      ws.send(JSON.stringify({ id: i, method, params: params || {} }));
    });
  const evalJs = async (expression, timeoutMs = 4000) => {
    const r = await Promise.race([
      send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }),
      sleep(timeoutMs).then(() => {
        throw new Error("EVAL_TIMEOUT");
      }),
    ]);
    if (r.exceptionDetails)
      throw new Error("page: " + JSON.stringify(r.exceptionDetails).slice(0, 200));
    return r.result && "value" in r.result ? r.result.value : undefined;
  };

  const sessions = await evalJs(`window.__TAURI_INTERNALS__.invoke("list_sessions")`);
  console.log("live sessions:", sessions.length);

  await evalJs(`(() => {
    if (!window.__diag) {
      window.__diag = { frames: 0, ro: 0 };
      const bump = () => { window.__diag.frames++; requestAnimationFrame(bump); };
      requestAnimationFrame(bump);
    }
    return "probes ready";
  })()`);

  let result = "healthy";
  try {
    await send("Emulation.setCPUThrottlingRate", { rate });
    console.log(`renderer CPU throttled ${rate}x`);

    const fire = (type, x, y) =>
      evalJs(`(() => {
      const s = document.querySelectorAll(".splitter.is-vertical")[window.__si || 0];
      if (!s) return 0;
      s.dispatchEvent(new PointerEvent(${JSON.stringify(type)}, {
        bubbles: true, cancelable: true, pointerId: 1, pointerType: "mouse",
        isPrimary: true, buttons: 1, button: 0, clientX: ${x}, clientY: ${y},
      }));
      return 1;
    })()`);

    for (let round = 1; round <= rounds; round++) {
      let before, after;
      try {
        before = await evalJs(`JSON.stringify(window.__diag)`);
      } catch {
        console.log(`round ${round}: PROBE TIMEOUT before drag (${e.message})`);
        result = "wedged";
        break;
      }
      const startX = await evalJs(
        `(() => { const s = document.querySelectorAll(".splitter.is-vertical")[0]; if (!s) return null; const r = s.getBoundingClientRect(); return Math.round(r.x); })()`,
      );
      const dir = round % 2 ? 1 : -1;
      try {
        await fire("pointerdown", startX, 400);
        for (let i = 1; i <= 15; i++) {
          await fire("pointermove", startX + dir * i * 8, 400);
          await sleep(16);
        }
        await fire("pointerup", startX + dir * 120, 400);
      } catch (e) {
        console.log(`round ${round}: drag dispatch wedged: ${e.message}`);
        result = "wedged-during-drag";
        break;
      }
      await sleep(600);
      try {
        after = await evalJs(`JSON.stringify(window.__diag)`, 5000);
      } catch {
        console.log(`round ${round}: RENDERER STOPPED RESPONDING after drag`);
        result = "wedged";
        break;
      }
      const b = JSON.parse(before),
        a = JSON.parse(after);
      console.log(`round ${round}: frames +${a.frames - b.frames} ro +${a.ro - b.ro}`);
      if (a.frames - b.frames === 0) {
        console.log(`=> rAF starved; renderer wedged`);
        result = "wedged";
        break;
      }
    }
  } finally {
    // Restore even after an exception; a wedged transport must not hang cleanup.
    try {
      await Promise.race([send("Emulation.setCPUThrottlingRate", { rate: 1 }), sleep(3000)]);
    } catch {}
    ws.close();
  }
  console.log("result:", result);
  process.exit(result === "healthy" ? 0 : 2);
}

main().catch((e) => {
  console.error(e.stack || e);
  process.exit(1);
});
