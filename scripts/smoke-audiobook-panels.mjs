import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { spawn } from "node:child_process";

const root = fileURLToPath(new URL("../", import.meta.url));
const dir = await mkdtemp(join(tmpdir(), "arke-audiobook-panels-"));
const styles = [...(await readFile(join(root, "packages/client/src/main.tsx"), "utf8")).matchAll(/^import "([^"]+\.css)";/gm)].map(match => match[0]).join("\n");
await build({ stdin: { resolveDir: join(root, "packages/client/src"), loader: "tsx", contents: `
import React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { MemoryRouter, Routes, Route } from "react-router";
import { ChapterScreen } from "./screens/chapter-workspace";
import { __setBridgeForTest, __setStateForTest, __applyEventForTest } from "./lib/store";
import { FIXTURE_STATE } from "../test/fixture-state";
${styles}
const state = structuredClone(FIXTURE_STATE), world = state.world;
const salt = world.productions.find(p=>p.meta.id==='saltlight');
const hash='sha256:'+'a'.repeat(64), at='2026-10-10T13:00:00.000Z';
world.productions.push({...salt,meta:{...salt.meta,id:'inkbound',format:'story',title:'Inkbound'},story:{version:3},chapters:[{id:'neap',file:'01-neap',order:2,title:'The counting of bells',status:'drafting',version:4,words:120,bodyHash:hash}]});
window.sent=[];
__setBridgeForTest({appVersion:'fixture',platform:'test',connect(){},subscribe(){},send(json){window.sent.push(JSON.parse(json));}});
__setStateForTest(state,{connection:'open'});
flushSync(()=>createRoot(document.getElementById('root')).render(<MemoryRouter initialEntries={['/w/'+world.meta.worldId+'/p/inkbound/story/chapters/neap?view=audiobook']}><Routes><Route path='/w/:worldId/p/:prodId/story/chapters/:chapterId' element={<ChapterScreen/>}/></Routes></MemoryRouter>));
window.openChapter=()=>{const ask=window.sent.findLast(m=>m.kind==='open-chapter'); if(!ask)return false; flushSync(()=>__applyEventForTest({type:'chapter.open-result',at,requestId:ask.requestId,worldId:world.meta.worldId,productionId:'inkbound',chapterId:'neap',disposition:'opened',body:'Maren counted the bells.\\n\\nThe harbour lay still.\\n\\nSix, and the tide <br> not yet called.',version:4,hash,versions:[1,2,3]})); return true;};
const ids={worldId:world.meta.worldId,productionId:'inkbound',chapterId:'neap'};
window.propose=()=>flushSync(()=>__applyEventForTest({type:'illustration.finished',at,...ids,outcome:'proposed',proposal:{proposalId:'ill-1',hash,rows:Array.from({length:9},(_,i)=>({block:'p'+i+'.0',textHash:'t',title:'The harbour '+(i+1),at:i*45,prompt:'Quiet water beside the harbour.',who:[],estimatedMicroUsd:40000})),model:{provider:'fal',id:'stair-image',name:'Stair Image',references:2},aspect:'16:9',seconds:420,estimated:true,standing:0}}));
window.quote=()=>flushSync(()=>{__applyEventForTest({type:'audiobook.started',at,...ids,requestId:'01J8F3K2QW9VZX4N7M0RTYB6H1',toMake:4,blocks:4});__applyEventForTest({type:'audiobook.priced',at,...ids,characters:120,estimatedMicroUsd:4600,confirmationToken:'fixture-token',voices:[{label:'Kore',provider:'google',characters:120,estimatedMicroUsd:4600}],requests:1,perParagraph:4});});
window.fixtureReady=true;
` }, bundle: true, platform: "browser", format: "iife", define: { "import.meta.env": "{}" }, loader: { ".woff": "file", ".woff2": "file" }, outfile: join(dir, "view.js") });
await writeFile(join(dir, "index.html"), '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="view.css"><style>body{margin:8px;background:var(--background)}#root{width:100%;height:100dvh;}body{margin:0}</style></head><body><div id="root"></div><script src="view.js"></script></body></html>');
const server = createServer(async (req, res) => {
  try {
    const name = new URL(req.url, "http://localhost").pathname.slice(1) || "index.html";
    if (!/^[\w.-]+$/.test(name)) throw new Error("Not a fixture asset");
    res.setHeader("Content-Type", name.endsWith(".js") ? "text/javascript" : name.endsWith(".css") ? "text/css" : name.endsWith(".html") ? "text/html" : "application/octet-stream");
    res.end(await readFile(join(dir, name)));
  } catch { res.writeHead(404); res.end(); }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const chrome = process.env.ARKE_CHROME ?? (process.platform === "win32" ? "C:/Program Files/Google/Chrome/Application/chrome.exe" : "/usr/bin/google-chrome");
const child = spawn(chrome, ["--headless=new", "--no-first-run", "--no-default-browser-check", "--remote-debugging-port=0", "--user-data-dir=" + join(dir, "profile"), "about:blank"], { windowsHide: true, stdio: "ignore" });
let socket;
const until = async read => { const end = Date.now() + 20_000; while (Date.now() < end) { try { const value = await read(); if (value) return value; } catch {} await new Promise(resolve => setTimeout(resolve, 100)); } throw new Error("Chrome did not become ready"); };
try {
  const port = await until(async () => (await readFile(join(dir, "profile/DevToolsActivePort"), "utf8")).split("\n")[0]);
  const targets = await (await fetch("http://127.0.0.1:" + port + "/json/list")).json();
  socket = new WebSocket(targets.find(target => target.type === "page").webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  let sequence = 0; const pending = new Map();
  socket.onmessage = ({ data }) => { const message = JSON.parse(data), request = pending.get(message.id); if (request) { pending.delete(message.id); message.error ? request.reject(message.error) : request.resolve(message.result); } };
  const cdp = (method, params = {}) => new Promise((resolve, reject) => { const id = ++sequence; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params })); });
  const evaluate = async expression => { const response = await cdp("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }); if (response.exceptionDetails) throw new Error(JSON.stringify(response.exceptionDetails)); return response.result.value; };
  await cdp("Page.enable");
  console.log("Fixture directory",dir);
  const records = [];
  for (const width of [1800, 1200, 800, 390]) {
    await cdp("Emulation.setDeviceMetricsOverride", { width, height: 950, deviceScaleFactor: 1, mobile: false });
    await cdp("Page.navigate", { url: "http://127.0.0.1:" + server.address().port });
    await until(() => evaluate("window.fixtureReady"));
    await until(() => evaluate("window.openChapter()"));
    await until(() => evaluate("Boolean(document.querySelector('[data-block=\"p0.0\"]'))"));
    assert.equal(await evaluate("Boolean(document.querySelector('.fy-abp'))"),false,'opening must not select a block');
    await evaluate("document.querySelector('[data-testid=audiobook-arke]')?.click(); document.querySelector('[data-block=\"p0.0\"]').click()");
    await until(()=>evaluate("Boolean(document.querySelector('.fy-abp'))"));
    await evaluate("window.propose()");
    await until(()=>evaluate("Boolean(document.querySelector('.fy-ills-modal[open]'))")).catch(async error=>{ console.log(await evaluate("document.body.innerText.slice(-6000)")); throw error; });
    const measure = () => evaluate(`(()=>{const dialog=document.querySelector('dialog[open]'), box=dialog.getBoundingClientRect();const btn=dialog.querySelector('[data-testid=illustration-accept], [data-testid=audiobook-confirm]'), r=btn.getBoundingClientRect();return {width:innerWidth,open:document.querySelectorAll('dialog[open]').length,overflow:dialog.scrollWidth>dialog.clientWidth+1,contained:r.left>=box.left&&r.right<=box.right&&r.top>=box.top&&r.bottom<=box.bottom,focusInside:dialog.contains(document.activeElement),modal:dialog.matches(':modal')};})()`);
    const first=await measure(); assert.equal(first.open,1);assert.equal(first.modal,true);assert.equal(first.focusInside,true);assert.equal(first.overflow,false);assert.equal(first.contained,true);
    for(let i=0;i<25;i++)await cdp('Input.dispatchKeyEvent',{type:'keyDown',key:'Tab',code:'Tab',windowsVirtualKeyCode:9});
    assert.equal((await measure()).focusInside,true,'Tab stays inside proposal');
    // An asynchronous read quote must stand in front of an already open block and proposal.
    await evaluate("window.quote()");
    await until(()=>evaluate("Boolean(document.querySelector('dialog[open] [data-testid=read-sheet]'))"));
    const quote=await measure();assert.equal(quote.open,1);assert.equal(quote.contained,true);assert.equal(quote.overflow,false);
    for(const name of ['read']){const capture=await cdp('Page.captureScreenshot',{format:'png'});await writeFile(join(dir,`${name}-${width}.png`),Buffer.from(capture.data,'base64'));}
    await cdp('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
    await cdp('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
    await until(()=>evaluate("Boolean(document.querySelector('.fy-ills-modal[open]'))"));
    const capture=await cdp('Page.captureScreenshot',{format:'png'});await writeFile(join(dir,`illustrate-${width}.png`),Buffer.from(capture.data,'base64'));
    const button=await evaluate("(()=>{const r=document.querySelector('[data-testid=illustration-accept]').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()");
    await cdp('Input.dispatchMouseEvent',{type:'mousePressed',...button,button:'left',clickCount:1});await cdp('Input.dispatchMouseEvent',{type:'mouseReleased',...button,button:'left',clickCount:1});
    await until(()=>evaluate("!document.querySelector('.fy-ills-modal[open]')"));
    assert.equal(await evaluate("window.sent.filter(m=>m.kind==='accept-illustration').length"),1,'one acceptance');
    assert.equal(await evaluate("window.sent.filter(m=>m.kind==='read-audiobook' || m.kind==='voice-preview').length"),0,'no background purchase');
    records.push({proposal:first,quote});
  }
  await writeFile(join(dir,'measurements.json'),JSON.stringify(records,null,2));
  console.log(JSON.stringify({directory:dir,records}));
} finally { socket?.close(); child.kill(); await new Promise(resolve => server.close(resolve)); }
