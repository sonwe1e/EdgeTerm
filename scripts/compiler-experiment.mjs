// Production-compiled, same-source A/B fixture. Default application build stays off.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { build, preview } from "vite";
import react from "@vitejs/plugin-react";
import { chromium } from "playwright";
const name = process.argv[2];
assert.match(name ?? "", /^[a-z0-9-]+$/, "supply a unique evidence name");
const root = process.cwd(), dir = path.resolve(".tmp", "compiler-" + name);
await mkdir(dir); // Never overwrite earlier samples.
const fixture = `import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import {flushSync} from 'react-dom';
import {FileBrowser} from '/src/components/FtpPane.tsx';
import {ModalDialog} from '/src/components/ModalDialog.tsx';
import '/src/styles.css';
const entries=Array.from({length:10000},(_,i)=>({name:'file'+i+'.dat',path:'/test/file'+i+'.dat',isDir:false,isSymlink:false,size:i,modified:1700000000+i,permissions:null,owner:null,group:null}));
const root=createRoot(document.getElementById('root')), noop=()=>{};
function Files(){const [selected,select]=useState(null);return React.createElement(FileBrowser,{title:'Remote',subtitle:'Fixture',path:'/test',draft:'/test',entries,selected,loading:false,error:null,side:'remote',draggingPath:null,dropHover:null,onItemPointerDown:(side,entry,e)=>e.currentTarget.setPointerCapture(e.pointerId),onItemPointerMove:noop,onItemPointerUp:noop,onDragCancel:noop,onDraftChange:noop,onOpenPath:noop,onHome:noop,onParent:noop,onRefresh:noop,onSelect:p=>{if(!window.rejectSelection)select(p)},onActivate:noop})}
window.mount=()=>flushSync(()=>root.render(React.createElement(Files)));
window.clear=()=>flushSync(()=>root.render(null));
window.showModal=()=>flushSync(()=>root.render(React.createElement(ModalDialog,{open:true,title:'Compiled modal',onClose:()=>window.clear()},React.createElement('input',{id:'input'}),React.createElement('button',{id:'last'},'Last'))));
window.ready=true;`;
const entry = path.join(dir, "fixture.js"), html = path.join(dir, "fixture.html");
await writeFile(entry, fixture);
await writeFile(html, `<html><head><meta charset="utf-8"><link rel="icon" href="data:,"></head><body><div id="root" style="width:1000px;height:620px;display:grid"></div><script type="module" src="./fixture.js"></script></body></html>`);
const servers = {}, compilation = [];
const findHtml = async (base) => { for (const item of await readdir(base, { withFileTypes: true })) { const file = path.join(base,item.name); if(item.isDirectory()){const found=await findHtml(file);if(found)return found;}else if(item.name.endsWith('.html'))return file;} };
let browser;
const samples = [];
try {
  for (const arm of ["off", "on"]) {
    const outDir = path.join(dir, arm);
    await build({ configFile: false, root, base: "/", logLevel: "error", define: { __EDGETERM_MAC__: "false", __EDGETERM_WINDOWS__: "true" },
      plugins: [react({ babel: { plugins: arm === "on" ? [["babel-plugin-react-compiler", { target: "19", logger: { logEvent(filename,event) { if(event.kind === "CompileSuccess") compilation.push({ filename:path.relative(root,filename), kind:event.kind }); } } }]] : [] } })],
      build: { outDir, emptyOutDir: false, rollupOptions: { input: html } } });
    const server = await preview({ configFile: false, root, build: { outDir }, preview: { host:"127.0.0.1", port:0, strictPort:false } });
    const outputHtml = await findHtml(outDir);
    servers[arm] = { server, url: server.resolvedUrls.local[0] + path.relative(outDir,outputHtml).replaceAll('\\','/') };
  }
  assert.ok(compilation.some(x=>x.filename.endsWith('FtpPane.tsx')), "Compiler did not transform the actual production component");
  browser=await chromium.launch({ channel:process.env.PERF_BROWSER || "msedge", headless:true });
  for(let i=0;i<8;i++) for(const arm of (i%2?["on","off"]:["off","on"])) {
    const context=await browser.newContext({ viewport:{width:1100,height:720} });
    const page=await context.newPage(), errors=[];
    page.on('pageerror',e=>errors.push(String(e)));
    page.on('response',r=>{if(r.status()>=400)errors.push(r.status()+':'+r.url())});
    await page.goto(servers[arm].url);await page.waitForFunction(()=>window.ready);
    const firstPaintMs=await page.evaluate(async()=>{const t=performance.now();window.mount();await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));return performance.now()-t;});
    const row=page.locator('.ftp-file-row').first();await row.click();
    await page.waitForFunction(()=>document.querySelector('.ftp-file-row.is-selected'));
    // Negative oracle control: blocked state updates must fail the selection assertion.
    await page.evaluate(()=>{window.clear();window.mount();window.rejectSelection=true;});await row.click();
    assert.equal(await page.locator('.ftp-file-row.is-selected').count(),0);
    await page.evaluate(()=>window.rejectSelection=false);await row.click();
    assert.equal(await page.locator('.ftp-file-row.is-selected').count(),1);
    const list=page.locator('.ftp-browser-list');await list.evaluate(e=>e.scrollTop=10000);
    // By `data-sort-key`, not the caption's accessible name (see the Filer
    // captions' comment: the visible column text is that name, so the
    // attribute is the stable handle for a caller).
    await page.locator('[data-sort-key="size"]').click();
    await page.waitForFunction(()=>document.querySelector('.ftp-browser-list').scrollTop===0);
    const interactionMs=await page.evaluate(async()=>{const t=performance.now();for(let n=0;n<8;n++){document.querySelector('.ftp-browser-list').scrollTop=n%2?0:100000;await new Promise(r=>requestAnimationFrame(r));}return performance.now()-t;});
    const mountedRows=await page.locator('.ftp-file-row').count();assert.ok(mountedRows<60);
    // Real pointer capture survives moving the active row outside the visible area.
    const box=await row.boundingBox();await page.mouse.move(box.x+100,box.y+10);await page.mouse.down();
    await page.mouse.move(box.x+100,box.y+60);await page.mouse.up();
    await page.evaluate(()=>window.showModal());await page.locator('#input').fill('kept');await page.locator('#last').focus();
    await page.keyboard.press('Tab');assert.equal(await page.locator('#input').evaluate(e=>e===document.activeElement),true);
    await page.keyboard.press('Escape');assert.equal(await page.locator('dialog[open]').count(),0);
    assert.deepEqual(errors,[]);
    samples.push({index:i,arm,firstPaintMs,interactionMs,mountedRows,errors});await context.close();
  }
  const median=xs=>[...xs].sort((a,b)=>a-b)[Math.floor(xs.length/2)];
  const summary=Object.fromEntries(['off','on'].map(arm=>[arm,{firstPaintMs:median(samples.filter(x=>x.arm===arm).map(x=>x.firstPaintMs)),interactionMs:median(samples.filter(x=>x.arm===arm).map(x=>x.interactionMs))}]));
  const report={browser:await browser.version(),fixtureSha256:createHash('sha256').update(fixture).digest('hex'),compilation,samples,summary,decision:'Default remains off. Synthetic production-component fixture is not desktop WebView or whole-app proof; rendering gains must justify further adoption.'};
  await writeFile(path.join(dir,'results.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({dir,summary,compiled:compilation.length}));
} finally { await browser?.close();for(const s of Object.values(servers))await new Promise(r=>s.server.httpServer.close(r)); }
