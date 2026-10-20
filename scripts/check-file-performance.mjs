// Standalone browser/component check; does not launch or operate a terminal.
// Requires Playwright (on NODE_PATH is also supported) and installed Chromium/Edge.
import { createServer } from "vite";
import { createRequire } from "node:module";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
const { chromium } = createRequire(import.meta.url)("playwright");

const html = `<!doctype html><html><head><link rel="stylesheet" href="/src/styles.css"></head>
<body><div id="root" style="width:1000px;height:620px;display:grid"></div>
<script type="module">
import React from 'react';
import {createRoot} from 'react-dom/client';
import {flushSync} from 'react-dom';
import {FileBrowser} from '/src/components/FtpPane.tsx';
import {VirtualFileRows} from '/src/components/VirtualFileRows.tsx';
import {ZmodemInput} from '/src/zmodemInput.ts';
import Zmodem from 'zmodem.js';
const root = createRoot(document.getElementById('root'));
const entries = Array.from({length:10000},(_,i) => ({name:'file'+i+'.dat',path:'/test/file'+i+'.dat',
  isDir:i%10===0,isSymlink:false,size:i*1000,modified:1700000000+i,permissions:null,owner:null,group:null}));
const noop=()=>{};
const browserProps=(title)=>({title,subtitle:'SFTP',path:'/test',draft:'/test',
  selected:null,loading:false,error:null,side:'remote',draggingPath:null,dropHover:null,
  onItemPointerDown:(side,entry,event)=>event.currentTarget.setPointerCapture(event.pointerId),
  onItemPointerMove:noop,onItemPointerUp:noop,onDragCancel:noop,onDraftChange:noop,onOpenPath:noop,
  onHome:noop,onParent:noop,onRefresh:noop,onSelect:noop,onActivate:noop});
window.showFiles=(count=10000)=>flushSync(()=>root.render(React.createElement(FileBrowser,
  {...browserProps('Remote'),entries:entries.slice(0,count)})));
window.showFiler=(font)=>{
 document.documentElement.style.setProperty('--panel-font-size',font+'px');
 flushSync(()=>root.render(React.createElement('div',{className:'panel-body filer-list'},
   React.createElement(VirtualFileRows,{entries,rowHeight:Math.max(24,font+10)+2,resetKey:'font'+font,
    children:e=>React.createElement('div',{className:'row filer-entry'},e.name)}))));
};
// Two mounted listings in the app's own pane slots; only the visible one is
// laid out, exactly as Workspace renders a hidden tab: the same class, the same
// percentage geometry against a positioned container.
const tabSlots=(hidden)=>[0,1].map(i=>React.createElement('div',{key:'slot'+i,
  className:'pane-slot'+(i===hidden?' is-hidden':''),
  style:{left:'0%',top:'0%',width:'100%',height:'100%'}},
  React.createElement(FileBrowser,{...browserProps('Tab '+(i+1)),entries})));
const paneStack=(slots)=>React.createElement('div',{className:'pane-stack',
  style:{position:'relative',width:'100%',height:'100%'}},slots);
window.mountTabs=()=>flushSync(()=>root.render(paneStack(tabSlots(1))));
window.switchTab=()=>flushSync(()=>root.render(paneStack(tabSlots(0))));
window.clear=()=>flushSync(()=>root.render(null));
const frames=()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
window.measureFirstPaint=async(count)=>{const start=performance.now();window.showFiles(count);await frames();return performance.now()-start;};
window.measureTabSwitch=async()=>{const start=performance.now();window.switchTab();await frames();return performance.now()-start;};
window.benchInput=()=>{
 const results={};
 for(const [name,Ctor] of [['previous',Zmodem.Sentry],['optimized',ZmodemInput]]) {
   const chunk=new Uint8Array(65536).fill(65); let count=0;
   const parser=new Ctor({to_terminal:b=>{count+=b.length;},sender:noop,on_detect:noop,on_retract:noop});
   for(let i=0;i<16;i++)parser.consume(chunk);
   const times=[];
   for(let round=0;round<3;round++) {const start=performance.now();for(let i=0;i<256;i++)parser.consume(chunk);times.push(performance.now()-start);}
   times.sort((a,b)=>a-b);results[name]={medianMs:times[1],bytesPerRun:16777216,bytesObserved:count};
 } return results;
};
window.showFiles(); window.ready=true;
</script></body></html>`;

// Thresholds are budgets for this harness only: headless Edge, synthetic
// listings, no Tauri IPC and no real terminal session. They are chosen from the
// measured headroom of one developer machine (raw numbers in
// scripts/README.md); they do not describe WebView2 frame times. Raise or lower
// them deliberately when the harness workload changes, and re-record the raw
// numbers with them.
const GATES = {
  firstPaint10kMs: 200,
  tabSwitchMs: 100,
};
const SAMPLES = 5;
const failures = [];
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
/** Records one measurement against its gate; a breach fails the whole run. */
const gate = (name, measured, limit) => {
  const pass = measured <= limit;
  console.log(`${pass ? "PASS" : "FAIL"} ${name}: ${measured.toFixed(1)} ms (gate ${limit} ms)`);
  if (!pass) failures.push(`${name}: measured ${measured.toFixed(1)} ms over ${limit} ms`);
};

const server = await createServer({
  // Historical builds/worktrees are outside this fixture's source inputs.
  server: { port: 0, strictPort: false, host: "127.0.0.1", watch: { ignored: ["**/.tmp/**"] } },
  plugins: [{ name: "file-perf-harness", configureServer(server) {
    server.middlewares.use(async (req, res, next) => {
      if (req.url !== "/__file_perf") return next();
      res.setHeader("Content-Type", "text/html");
      res.end(await server.transformIndexHtml(req.url, html));
    });
  } }],
});
let browser;
try {
  await server.listen();
  browser = await chromium.launch({ channel: process.env.PERF_BROWSER || "msedge", headless: true });
  const page = await browser.newPage({ viewport: { width: 1100, height: 720 } });
  const errors = []; page.on("pageerror", (error) => { errors.push(String(error)); console.error(error); });
  await page.goto(server.resolvedUrls.local[0] + "__file_perf");
  await page.waitForFunction(() => window.ready);
  const waitFrames = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  await waitFrames();
  const layout = () => page.evaluate(() => {
    const scroller=document.querySelector('.ftp-browser-list,.filer-list');
    const rows=[...document.querySelectorAll('.ftp-file-row,.filer-entry')];
    return { count:rows.length,height:scroller.clientHeight,scrollHeight:scroller.scrollHeight,
      last:rows.at(-1)?.textContent,rowHeight:rows[0].getBoundingClientRect().height,
      pitch:rows[1].getBoundingClientRect().top-rows[0].getBoundingClientRect().top };
  });
  const initial = await layout(); assert(initial.count < 50); assert.equal(initial.rowHeight, 29); assert.equal(initial.pitch, 29);
  const source = page.locator('.ftp-file-row').first();
  const sourcePath = await source.getAttribute('title');
  const bounds = await source.boundingBox();
  await page.mouse.move(bounds.x + 30, bounds.y + 10); await page.mouse.down();
  await page.mouse.move(bounds.x + 32, bounds.y + 10);
  await page.evaluate(() => { const el=document.querySelector('.ftp-browser-list');el.scrollTop=el.scrollHeight; });
  await waitFrames();
  assert.equal(await page.locator('.ftp-file-row').filter({hasText:'file9999.dat'}).count(), 1);
  assert.equal(await page.locator('.ftp-file-row').evaluateAll((rows,path)=>rows.some(r=>r.title===path), sourcePath), true);
  await page.mouse.up(); await waitFrames();
  const bottom = await layout(); assert(bottom.count < 50);
  assert.equal(await page.locator('.ftp-file-row').evaluateAll((rows,path)=>rows.some(r=>r.title===path), sourcePath), false);
  // By `data-sort-key`, not the caption's accessible name: the caption carries
  // its visible column text as that name (an `aria-label` there would replace
  // "Name" with the instruction "Sort by name" for a screen reader), so the
  // attribute is the stable handle a caller selects the caption by.
  await page.locator('[data-sort-key="name"]').click(); await waitFrames();
  assert.equal(await page.locator('.ftp-browser-list').evaluate(el=>el.scrollTop), 0);
  await mkdir('artifacts/performance', {recursive:true});
  await page.screenshot({path:'artifacts/performance/file-list.png'});
  const filer = [];
  for (const font of [12, 20, 30]) {
    await page.evaluate(font=>window.showFiler(font), font); await waitFrames();
    const actual=await layout(); assert.equal(actual.pitch, Math.max(24,font+10)+2);
    assert(actual.count < 50); filer.push({font,...actual});
  }
  // Gate 1: mounting a 10,000-row listing and painting it. Every sample starts
  // from an unmounted root, so each one is a first mount, not a re-render.
  const firstPaint = [];
  for (let sample = 0; sample < SAMPLES; sample++) {
    await page.evaluate(() => window.clear()); await waitFrames();
    firstPaint.push(await page.evaluate(count => window.measureFirstPaint(count), 10000));
  }
  await waitFrames();
  const painted = await layout(); assert(painted.count < 50);
  gate("first paint of a 10,000-row listing (median of " + SAMPLES + ")", median(firstPaint), GATES.firstPaint10kMs);
  // Gate 2: switching between two mounted 10,000-row listings through the app's
  // own .pane-slot/.is-hidden classes. Terminal tabs need real sessions, so they
  // are not covered here; see scripts/README.md.
  await page.evaluate(() => window.mountTabs()); await waitFrames();
  const switches = [];
  for (let sample = 0; sample < SAMPLES; sample++) {
    switches.push(await page.evaluate(() => window.measureTabSwitch()));
  }
  await waitFrames();
  const shown = await page.locator('.pane-slot:not(.is-hidden) .ftp-file-row').count();
  assert(shown > 0 && shown < 50);
  gate("tab switch between two 10,000-row listings (median of " + SAMPLES + ")", median(switches), GATES.tabSwitchMs);
  const input = {};
  const cdp = await page.context().newCDPSession(page);
  for (const rate of [1,4]) {
    await cdp.send('Emulation.setCPUThrottlingRate',{rate});
    input[rate+'xCPU']=await page.evaluate(()=>window.benchInput());
  }
  assert.deepEqual(errors, []);
  assert.deepEqual(failures, []);
  const report={browser:await browser.version(),initial,bottom,filer,
    gates:{firstPaint10k:{samples:firstPaint,medianMs:median(firstPaint),limitMs:GATES.firstPaint10kMs},
      tabSwitch:{samples:switches,medianMs:median(switches),limitMs:GATES.tabSwitchMs}},input};
  await writeFile('artifacts/performance/results.json',JSON.stringify(report,null,2));
  console.log(JSON.stringify(report,null,2));
} finally { if(browser)await browser.close();await server.close(); }
