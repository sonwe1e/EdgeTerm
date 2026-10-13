// Full-fidelity repro attempt: a live session streaming output, IPC counting,
// and a hard splitter-drag storm (varied speed/direction, moves crossing the
// elements under the cursor like a real drag does).
const { sleep, findPageWs, connect } = require("./cdp-helpers.cjs");

async function main() {
  const cdp = await connect(await findPageWs());
  const ev = (js) => cdp.eval(js).then((r) => (r.result && "value" in r.result ? r.result.value : JSON.stringify(r.result)));
  const evOrThrow = (js) => cdp.eval(js).then((r) => {
    if (r.exceptionDetails) throw new Error("page exception: " + JSON.stringify(r.exceptionDetails).slice(0, 400));
    return r.result.value;
  });

  // 1. wrap the IPC entry point to count invokes
  console.log(await evOrThrow(`(() => {
    if (!window.__ipc) {
      window.__ipc = { n: 0, byCmd: {} };
      const orig = window.__TAURI_INTERNALS__.invoke;
      window.__TAURI_INTERNALS__.invoke = function (cmd, ...rest) {
        window.__ipc.n++;
        window.__ipc.byCmd[cmd] = (window.__ipc.byCmd[cmd] || 0) + 1;
        return orig.call(this, cmd, ...rest);
      };
    }
    return "ipc counter ready";
  })()`));

  // 2. install renderer probes
  console.log(await evOrThrow(`(() => {
    if (!window.__diag) {
      window.__diag = { frames: 0, ro: 0, wedged: false };
      const bump = () => { window.__diag.frames++; requestAnimationFrame(bump); };
      requestAnimationFrame(bump);
    }
    const pane = document.querySelector(".term-pane");
    if (!window.__diagRo && pane) {
      window.__diagRo = new ResizeObserver(() => window.__diag.ro++);
      window.__diagRo.observe(pane);
    }
    return "probes ready, pane=" + !!pane;
  })()`));

  // 3. start continuous output in the shell by typing a busy loop command
  const typeKey = (key, keyCode) => evOrThrow(`(() => {
    const ta = document.querySelector('.xterm-helper-textarea');
    if (!ta) return 'NO_TEXTAREA';
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(key)}, keyCode: ${keyCode}, which: ${keyCode}, bubbles: true, cancelable: true }));
    return 'OK';
  })()`);
  const cmd = "for /l %i in (1,0,2) do @echo hello-storm-line";
  for (const ch of cmd) {
    const code = ch.charCodeAt(0);
    const r = await typeKey(ch, code);
    if (r !== "OK") throw new Error("typing failed: " + r);
    await sleep(8);
  }
  const enter = await typeKey("Enter", 13);
  console.log("typed command, enter:", enter);
  await sleep(1500);

  // confirm output is flowing: terminal buffer line count grows
  const lines1 = await ev(`(() => { const t = document.querySelector('.xterm-rows'); return t ? t.children.length : -1; })()`);
  await sleep(1000);
  const lines2 = await ev(`(() => { const t = document.querySelector('.xterm-rows'); return t ? t.children.length : -1; })()`);
  console.log(`output lines: ${lines1} -> ${lines2} ${lines2 > lines1 ? "(streaming)" : "(NOT streaming!)"}`);

  // 4. drag storm on the splitter: real-path pointermove (elementFromPoint),
  //    alternating directions, mixed speeds, many rounds
  const ROUNDS = Number(process.argv[2] || 40);
  for (let round = 1; round <= ROUNDS; round++) {
    const dir = round % 2 === 0 ? -1 : 1;
    const stepMs = round % 3 === 0 ? 4 : round % 3 === 1 ? 16 : 30;
    const before = await ev(`JSON.stringify({ d: window.__diag, ipc: window.__ipc.n })`);
    const r = await evOrThrow(`(() => {
      const s = document.querySelector('.splitter.is-vertical');
      if (!s) return 'NO_SPLITTER';
      const rc = s.getBoundingClientRect();
      window.__rc = { x: Math.round(rc.x + rc.width / 2), y: Math.round(rc.y + rc.height / 2) };
      return JSON.stringify(window.__rc);
    })()`);
    const start = JSON.parse(r);
    const fire = (type, x, y) => evOrThrow(`(() => {
      const s = document.querySelector('.splitter.is-vertical');
      // dispatch on the splitter while captured; also on whatever is under the
      // cursor for the rest of the page to see hover, like a real drag
      s.dispatchEvent(new PointerEvent(${JSON.stringify(type)}, {
        bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse',
        isPrimary: true, buttons: 1, button: 0, clientX: ${x}, clientY: ${y},
      }));
      const under = document.elementFromPoint(${x}, ${y});
      if (under && under !== s) {
        under.dispatchEvent(new PointerEvent(${JSON.stringify(type)}, {
          bubbles: true, cancelable: true, pointerId: 2, pointerType: 'mouse',
          isPrimary: false, buttons: 1, button: 0, clientX: ${x}, clientY: ${y},
        }));
        under.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: ${x}, clientY: ${y} }));
      }
      return 1;
    })()`);
    await fire("pointerdown", start.x, start.y);
    const steps = 20;
    for (let i = 1; i <= steps; i++) {
      await fire("pointermove", start.x + dir * i * 7, start.y);
      await sleep(stepMs);
    }
    await fire("pointerup", start.x + dir * steps * 7, start.y);

    await sleep(400);
    const after = await Promise.race([
      ev(`JSON.stringify({ d: window.__diag, ipc: window.__ipc.n })`),
      sleep(4000).then(() => "EVAL_TIMEOUT"),
    ]);
    if (after === "EVAL_TIMEOUT") {
      console.log(`round ${round}: RENDERER STOPPED RESPONDING - stuck state reproduced`);
      return 2;
    }
    const b = JSON.parse(before), a = JSON.parse(after);
    const df = a.d.frames - b.d.frames, dro = a.d.ro - b.d.ro, di = a.ipc - b.ipc;
    console.log(`round ${round} (dir=${dir} step=${stepMs}ms): frames +${df} ro +${dro} ipc +${di}`);
    if (df === 0) {
      console.log(`round ${round}: rAF starved - renderer wedged. Stuck state reproduced.`);
      return 3;
    }
    if (round % 10 === 0) {
      console.log("  ipc by command so far:", JSON.stringify(await ev(`JSON.stringify(window.__ipc.byCmd)`)));
    }
  }
  console.log("storm completed; renderer healthy");
  console.log("final ipc:", JSON.stringify(await ev(`JSON.stringify(window.__ipc.byCmd)`)));
  return 0;
}

main().then(
  (code) => process.exit(code),
  (e) => { console.error(e.stack || e); process.exit(1); },
);
