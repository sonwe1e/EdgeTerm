// Measure pane/xterm/canvas size evolution during a splitter drag to detect a
// layout feedback loop (RO -> fit -> canvas -> layout -> RO ...).
const { sleep, findPageWs, connect } = require("./cdp-helpers.cjs");

async function main() {
  const cdp = await connect(await findPageWs());
  const ev = (js) =>
    cdp.eval(js).then((r) => {
      if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 200));
      return r.result.value;
    });

  const MEASURE = `(() => {
    const pane = document.querySelector(".term-pane");
    const xterm = pane.querySelector(".xterm");
    const screen = pane.querySelector(".xterm-screen");
    const canvas = pane.querySelector("canvas");
    const r = (p) => (p ? Math.round(p.getBoundingClientRect().width) + "x" + Math.round(p.getBoundingClientRect().height) : "-");
    return JSON.stringify({
      pane: r(pane), xterm: r(xterm), screen: r(screen),
      canvasCss: canvas ? r(canvas) : "-",
      canvasPx: canvas ? canvas.width + "x" + canvas.height : "-",
    });
  })()`;

  console.log("base:", await ev(MEASURE));
  await ev(`(() => {
    window.__sizes = [];
    const p = document.querySelector(".term-pane");
    const ro = new ResizeObserver(() => {
      const r = p.getBoundingClientRect();
      window.__sizes.push(Math.round(r.width) + "x" + Math.round(r.height));
    });
    ro.observe(p);
    return "ok";
  })()`);

  const fire = (type, x, si) =>
    ev(`(() => {
      const s = document.querySelectorAll(".splitter.is-vertical")[${si}];
      s.dispatchEvent(new PointerEvent(${JSON.stringify(type)}, {
        bubbles: true, cancelable: true, pointerId: 1, pointerType: "mouse",
        isPrimary: true, buttons: 1, button: 0, clientX: ${x}, clientY: 500,
      }));
      return 1;
    })()`);

  const si = await ev(`Math.max(0, document.querySelectorAll(".splitter.is-vertical").length - 1)`);
  console.log("using splitter index", si);
  const x0 = await ev(`Math.round(document.querySelectorAll(".splitter.is-vertical")[${si}].getBoundingClientRect().x)`);
  await fire("pointerdown", x0, si);
  for (let i = 1; i <= 10; i++) {
    await fire("pointermove", x0 + i * 8, si);
    await sleep(25);
  }
  await fire("pointerup", x0 + 80, si);
  await sleep(1000);

  console.log("after:", await ev(MEASURE));
  console.log("pane sizes seen:", await ev(`JSON.stringify(window.__sizes.slice(0, 60))`));
  console.log(
    "status:",
    await ev(`(() => { const s = document.querySelector("[class*=status]")?.textContent || ""; const m = s.match(/Window (\\d+)×(\\d+)/); return m ? m[1] + "x" + m[2] : s.slice(0, 50); })()`),
  );
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
