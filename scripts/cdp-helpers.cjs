// Shared CDP helpers for driving the real EdgeTerm page.
const WS_PORT = 9222;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function findPageWs() {
  const targetId = process.env.EDGETERM_CDP_TARGET_ID;
  if (!targetId) throw new Error("Set EDGETERM_CDP_TARGET_ID to a disposable EdgeTerm page's id from /json/list; automatic page selection is disabled");
  const res = await fetch(`http://127.0.0.1:${WS_PORT}/json/list`);
  const targets = await res.json();
  const page = targets.find(t => t.type === "page" && t.id === targetId && /EdgeTerm/i.test(t.title));
  if (!page) throw new Error("no page target");
  return page.webSocketDebuggerUrl;
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let id = 0;
    const pending = new Map();
    ws.onopen = () =>
      resolve({
        eval: (expression) => {
          let timer;
          const result = new Promise((res2, rej2) => {
            const msgId = ++id;
            pending.set(msgId, { res2, rej2 });
            timer = setTimeout(() => {
              pending.delete(msgId);
              rej2(new Error("EVAL_TIMEOUT"));
            }, 5000);
            ws.send(JSON.stringify({ id: msgId, method: "Runtime.evaluate", params: { expression, returnByValue: true, awaitPromise: true } }));
          });
          return result.finally(() => clearTimeout(timer));
        },
        close: () => ws.close(),
      });
    ws.onerror = () => reject(new Error("ws error"));
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) {
        const { res2, rej2 } = pending.get(msg.id);
        pending.delete(msg.id);
        msg.error ? rej2(new Error(JSON.stringify(msg.error))) : res2(msg.result);
      }
    };
  });
}

// click helper usable via eval: finds by text within a selector and mousedowns
// (the app reacts to mousedown for menus, click for buttons)
const CLICK_JS = (selector, text) => `
  (() => {
    const els = [...document.querySelectorAll(${JSON.stringify(selector)})];
    const el = els.find((e) => e.textContent.trim().startsWith(${JSON.stringify(text)}));
    if (!el) return 'NOT_FOUND:' + els.map((e) => e.textContent.trim().slice(0, 20)).join('|');
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    el.click();
    return 'OK';
  })()
`;

module.exports = { sleep, findPageWs, connect, CLICK_JS };
