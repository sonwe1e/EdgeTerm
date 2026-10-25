// Does a session die under output flood alone, or only flood + drag?
// Usage: node cdp-flood-test.cjs [mode]  mode: flood | flood+drag
const { sleep, findPageWs, CLICK_JS } = require("./cdp-helpers.cjs");

async function main() {
  const mode = process.argv[2] || "flood";
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
  const evalJs = async (expression) => {
    const r = await Promise.race([
      send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }),
      sleep(5000).then(() => {
        throw new Error("EVAL_TIMEOUT");
      }),
    ]);
    if (r.exceptionDetails)
      throw new Error("page: " + JSON.stringify(r.exceptionDetails).slice(0, 300));
    return r.result && "value" in r.result ? r.result.value : undefined;
  };
  const invoke = (cmd, args) =>
    evalJs(`window.__TAURI_INTERNALS__.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(args)})`);
  if ((await invoke("list_sessions")).length !== 0)
    throw new Error("Flood diagnostics require an empty disposable app instance");

  // open a fresh Local shell session through the UI
  await evalJs(CLICK_JS(".menu-item", "Session"));
  await sleep(300);
  console.log("new session menu:", await evalJs(CLICK_JS(".menu-entry", "New Session")));
  await sleep(400);
  console.log(
    "pick Local shell:",
    await evalJs(`(() => {
    const el = [...document.querySelectorAll("button.protocol-option")].find((e) => e.textContent.includes("Local shell"));
    if (!el) return "NOT_FOUND";
    el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    el.click();
    return "OK";
  })()`),
  );
  await sleep(300);
  console.log("connect:", await evalJs(CLICK_JS(".btn.is-primary", "Connect")));

  let sessions = [];
  for (let i = 0; i < 15 && !sessions.length; i++) {
    await sleep(1000);
    sessions = await invoke("list_sessions").catch((e) => {
      console.log("list error:", e.message);
      return [];
    });
    console.log(`waiting for session... ${i}s -> ${sessions.length}`);
  }
  if (!sessions.length) throw new Error("session did not open");
  if (sessions.length !== 1 || sessions[0].kind !== "local")
    throw new Error("Expected exactly one new local session");
  const id = sessions[0].id;
  console.log(`session ${id} open (mode=${mode})`);
  let failed = false;
  try {
    await invoke("write_session", {
      id,
      data: "for /l %i in (1,0,2) do @echo flood-line-marker\r",
    });
    console.log("flood started");

    const fire = (type, x, y) =>
      evalJs(`(() => {
      const s = document.querySelector(".splitter.is-vertical");
      if (!s) return 0;
      s.dispatchEvent(new PointerEvent(${JSON.stringify(type)}, {
        bubbles: true, cancelable: true, pointerId: 1, pointerType: "mouse",
        isPrimary: true, buttons: 1, button: 0, clientX: ${x}, clientY: ${y},
      }));
      return 1;
    })()`);

    const t0 = Date.now();
    for (let tick = 1; tick <= 20; tick++) {
      if (mode === "flood+drag") {
        // one drag round per tick
        const startX = await evalJs(
          `(() => { const s = document.querySelector(".splitter.is-vertical"); if (!s) return null; const r = s.getBoundingClientRect(); return Math.round(r.x); })()`,
        );
        if (startX != null) {
          await fire("pointerdown", startX, 400);
          const dir = tick % 2 ? 1 : -1;
          for (let i = 1; i <= 15; i++) {
            await fire("pointermove", startX + dir * i * 8, 400);
            await sleep(16);
          }
          await fire("pointerup", startX + dir * 120, 400);
        }
      }
      await sleep(1000);
      let alive = null;
      try {
        const res = await Promise.race([
          invoke("list_sessions"),
          sleep(4000).then(() => "TIMEOUT"),
        ]);
        alive = res === "TIMEOUT" ? "invoke-timeout" : res.length;
      } catch (e) {
        alive = "invoke-error: " + e.message.slice(0, 80);
      }
      const tabCount = await evalJs(`document.querySelectorAll(".tab").length`).catch(() => "?");
      const wedgedPage = await Promise.race([
        evalJs(`Date.now()`).then(() => false),
        sleep(2500).then(() => true),
      ]);
      console.log(
        `t+${Math.round((Date.now() - t0) / 1000)}s sessions=${JSON.stringify(alive)} tabs=${tabCount} rendererEvalHangs=${wedgedPage}`,
      );
      if (typeof alive !== "number" || alive !== 1 || wedgedPage) {
        console.log("=> SESSION DIED OR PIPE WEDGED at tick " + tick);
        failed = true;
        break;
      }
    }
  } finally {
    await Promise.race([invoke("close_session", { id }).catch(() => {}), sleep(3000)]);
    ws.close();
  }
  console.log("done");
  process.exit(failed ? 2 : 0);
}

main().catch((e) => {
  console.error(e.stack || e);
  process.exit(1);
});
