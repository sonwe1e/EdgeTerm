// Isolated browser regression checks: real components/CSS, synthetic files,
// mocked Tauri boundary. Never attaches to an existing app or remote server.
import { createServer } from "vite";
import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
const { chromium } = createRequire(import.meta.url)("playwright");

const html = `<!doctype html><html><head><link rel="stylesheet" href="/src/styles.css"></head>
<body><div id="root" style="height:680px;display:grid;grid-template-columns:minmax(0,1fr) 280px"></div>
<script type="module">
import React from 'react';
import {createRoot} from 'react-dom/client';
import {flushSync} from 'react-dom';
import {FtpPane} from '/src/components/FtpPane.tsx';
import {FilerPanel} from '/src/components/panels/FilerPanel.tsx';
import {useStore} from '/src/store.ts';
window.calls=[]; let serial=0;
window.__TAURI_EVENT_PLUGIN_INTERNALS__={unregisterListener:()=>{}};
const listing=path=>({path,entries:[
  {name:'folder',path:path+'/folder',isDir:true,isSymlink:false,size:0,modified:1700000000},
  ...['file10.txt','file2.txt'].map(name=>({name,path:path+'/'+name,isDir:false,isSymlink:false,size:42,modified:1700000000})),
  ...Array.from({length:230},(_,i)=>({name:'item'+i,path:path+'/item'+i,isDir:true,isSymlink:false,size:0,modified:1700000000}))
]});
window.__TAURI_INTERNALS__={
 metadata:{currentWindow:{label:'main'},currentWebview:{label:'main'}},
 transformCallback:()=>++serial, unregisterCallback:()=>{},
 invoke:async(cmd,args)=>{
   if(cmd==='sftp_home')return '/remote';
   if(cmd==='local_home')return '/local';
   if(cmd==='sftp_list'||cmd==='local_list'){const result=listing(args.path);if(window.shortList)result.entries=result.entries.slice(0,3);return result;}
   if(cmd==='plugin:event|listen')return ++serial;
   if(cmd==='plugin:event|unlisten')return;
   if(cmd==='transfer_files'){window.calls.push({cmd,items:args.items});return;}
   if(cmd==='local_rename'||cmd==='sftp_rename'){window.calls.push({cmd,args});return;}
   throw Error('Unexpected test IPC: '+cmd);
 }
};
const tab={info:{id:'fixture',kind:'sftp',address:'fixture',name:'Review fixture'},state:'connected'};
const root=createRoot(document.getElementById('root'));
window.render=(active=true)=>flushSync(()=>root.render(React.createElement(React.Fragment,null,
 React.createElement('div',{style:{position:'relative',minWidth:0}},React.createElement(FtpPane,{tab,active})),
 React.createElement('div',{id:'filer-fixture',style:{display:'flex',flexDirection:'column',minHeight:0}},React.createElement(FilerPanel)))));
window.resetSort=()=>useStore.getState().resetSettings();
window.render();window.ready=true;
</script></body></html>`;

const server = await createServer({
  // Historical builds/worktrees under .tmp are not fixture inputs. Watching
  // their large trees delays browser initialization and triggers stray reloads.
  server: { host: "127.0.0.1", port: 0, watch: { ignored: ["**/.tmp/**"] } },
  plugins: [{ name: "review-ui-harness", configureServer(server) {
    server.middlewares.use(async (req, res, next) => {
      if (req.url !== "/__review_ui") return next();
      res.setHeader("Content-Type", "text/html");
      res.end(await server.transformIndexHtml(req.url, html));
    });
  } }],
});
let browser;
try {
  await server.listen();
  browser = await chromium.launch({ channel: process.env.PERF_BROWSER || "msedge", headless: true });
  // locale "en" pins the interface language: the app takes it from the
  // browser, and the assertions below match English column captions. On a
  // machine whose browser locale is not English the localized captions broke
  // this script even though the behaviour under test was fine.
  const page = await browser.newPage({ locale: "en", viewport: { width: 1280, height: 720 } });
  const errors = [];
  page.on("pageerror", e => errors.push(String(e)));
  let confirms = 0;
  page.on("dialog", async d => { confirms++; await d.accept(); });
  await page.goto(server.resolvedUrls.local[0] + "__review_ui");
  await page.waitForFunction(() => window.ready && document.querySelectorAll('.ftp-file-row').length > 5);
  const waitFrames = () => page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
  await waitFrames();
  const browsers = page.locator('.ftp-file-browser');
  const remote = browsers.nth(0), local = browsers.nth(1);
  const drag = async (from, to, background = false) => {
    const a = await from.boundingBox(), b = await to.boundingBox();
    await page.mouse.move(a.x + 40, a.y + a.height / 2); await page.mouse.down();
    await page.mouse.move(b.x + (background ? 1 : 40), b.y + b.height / 2, { steps: 8 });
    await page.mouse.up(); await waitFrames();
  };
  const file = pane => pane.locator('.ftp-file-row[title$="/file10.txt"]');
  const folder = pane => pane.locator('.ftp-file-row[title$="/folder"]');
  await drag(file(local), folder(local));
  await drag(file(remote), folder(remote));
  assert.deepEqual(await page.evaluate(() => window.calls), []);
  assert.equal(confirms, 0);
  await drag(file(local), folder(remote));
  await drag(file(remote), folder(local));
  const refreshLists = async short => {
    await page.evaluate(value => { window.shortList = value; }, short);
    await remote.getByRole('button', { name: 'Refresh', exact: true }).click();
    await local.getByRole('button', { name: 'Refresh', exact: true }).click();
    await waitFrames();
  };
  await refreshLists(true);
  await drag(file(local), remote.locator('.ftp-browser-list'), true);
  await drag(file(remote), local.locator('.ftp-browser-list'), true);
  assert.deepEqual(await page.evaluate(() => window.calls.map(c => c.items[0])), [
    { local: '/local/file10.txt', remote: '/remote/folder/file10.txt', upload: true, directory: false },
    { local: '/local/folder/file10.txt', remote: '/remote/file10.txt', upload: false, directory: false },
    { local: '/local/file10.txt', remote: '/remote/file10.txt', upload: true, directory: false },
    { local: '/local/file10.txt', remote: '/remote/file10.txt', upload: false, directory: false },
  ]);
  assert.equal(confirms, 4); // Existing synthetic file on both target sides.
  await refreshLists(false);
  const from = await file(local).boundingBox(), list = await remote.locator('.ftp-browser-list').boundingBox();
  await page.mouse.move(from.x + 40, from.y + 10); await page.mouse.down();
  await page.mouse.move(list.x + 40, list.y + list.height - 5, { steps: 8 });
  await page.waitForFunction(() => document.querySelector('.ftp-browser-list').scrollTop > 100);
  await page.evaluate(() => window.render(false)); await waitFrames();
  assert.equal(await page.locator('.ftp-dual-pane.is-dragging').count(), 0);
  const stoppedAt = await remote.locator('.ftp-browser-list').evaluate(e => e.scrollTop);
  await waitFrames();
  assert.equal(await remote.locator('.ftp-browser-list').evaluate(e => e.scrollTop), stoppedAt);
  await page.mouse.up(); await page.evaluate(() => window.render(true)); await waitFrames();
  assert.equal(await page.evaluate(() => window.calls.length), 4);
  // By `data-sort-key`, not the caption's accessible name: the caption carries
  // its visible column text as that name (an `aria-label` there would replace
  // "Modified" with the instruction for a screen reader), so the attribute is
  // the stable handle a caller selects the caption by.
  await remote.locator('[data-sort-key="modified"]').click();
  await waitFrames();
  assert.equal(await page.locator('.ftp-browser-columns button.is-sorted,.filer-columns button.is-sorted').count(), 3);
  assert.equal(await page.locator('.ftp-browser-columns button.is-sorted,.filer-columns button.is-sorted').evaluateAll(items => items.every(e => /Modified/.test(e.textContent))), true);
  await page.evaluate(() => window.resetSort()); await waitFrames();
  assert.equal(await page.locator('.ftp-browser-columns button.is-sorted,.filer-columns button.is-sorted').evaluateAll(items => items.every(e => /Name/.test(e.textContent))), true);
  await mkdir('artifacts/performance/review', { recursive: true });
  await page.screenshot({ path: 'artifacts/performance/review/wide.png' });
  const layouts = [];
  await page.evaluate(() => {
    document.getElementById('root').style.gridTemplateColumns = 'minmax(0,1fr)';
    document.getElementById('filer-fixture').style.display = 'none';
  });
  for (const width of [800, 799, 700]) {
    await page.setViewportSize({ width, height: 720 }); await waitFrames();
    const layout = await page.evaluate(() => [...document.querySelectorAll('.ftp-browser-columns')].map(header => ({
      count: [...header.children].filter(e => getComputedStyle(e).display !== 'none').length,
      align: getComputedStyle(header.firstElementChild).textAlign,
      centers: [...header.children].filter(e => getComputedStyle(e).display !== 'none').map(e => { const r=e.getBoundingClientRect();return r.top+r.height/2; }),
    })));
    for (const h of layout) { assert.equal(h.count, 2); assert.equal(h.align, 'left'); assert(Math.abs(h.centers[0]-h.centers[1])<1, JSON.stringify({ width, layout })); }
    layouts.push({ width, layout });
  }
  await page.screenshot({ path: 'artifacts/performance/review/narrow.png' });
  assert.deepEqual(errors, []);
  const result = { browser: await browser.version(), sameSideTransfers: 0, crossPaneCopies: 4, confirms, autoScrollStoppedOnHide: true, sharedSortPanels: 3, layouts };
  await writeFile('artifacts/performance/review/results.json', JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally { if (browser) await browser.close(); await server.close(); }
