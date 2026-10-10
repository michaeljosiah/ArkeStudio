import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { spawn } from "node:child_process";

// Synthetic chapter, real components, own headless browser. No installed Studio or user world.
const root = fileURLToPath(new URL("../", import.meta.url));
const dir = await mkdtemp(join(tmpdir(), "arke-read-activity-"));
const styles = [...(await readFile(join(root, "packages/client/src/main.tsx"), "utf8")).matchAll(/^import "([^"]+\.css)";/gm)].map(match => match[0]).join("\n");
await build({ stdin: { resolveDir: join(root, "packages/client/src"), loader: "tsx", contents: `
import React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { MemoryRouter, Routes, Route } from "react-router";
import { ChapterScreen } from "./screens/chapter-workspace";
import { ActivityPanel } from "./components/activity-panel";
import { QueueToaster } from "./components/queue-toaster";
import { openActivityPanel, closeActivityPanel } from "./lib/activity-panel";
import { __setBridgeForTest, __setStateForTest, __applyEventForTest } from "./lib/store";
import { FIXTURE_STATE } from "../test/fixture-state";
${styles}
const state = structuredClone(FIXTURE_STATE), world = state.world;
state.app.jobs=[]; state.app.builds=[]; state.app.spend=null;
world.proposals=[]; world.referenceTakes=[]; world.externalEdits=[];
const salt=world.productions.find(p=>p.meta.id==='saltlight'), hash='sha256:'+'a'.repeat(64),at='2026-10-10T13:00:00.000Z';
world.productions.push({...salt,meta:{...salt.meta,id:'bell-watch',format:'story',title:'Bell Watch'},story:{version:3},chapters:[{id:'crossing',file:'01-crossing',order:2,title:'The crossing and the bell beyond the river',status:'drafting',version:4,words:120,bodyHash:hash}]});
window.sent=[];
__setBridgeForTest({appVersion:'fixture',platform:'test',connect(){},subscribe(){},send(json){window.sent.push(JSON.parse(json));}});
__setStateForTest(state,{connection:'open'});
flushSync(()=>createRoot(document.getElementById('root')).render(<MemoryRouter initialEntries={['/w/'+world.meta.worldId+'/p/bell-watch/story/chapters/crossing?view=audiobook']}><QueueToaster/><ActivityPanel/><Routes><Route path='/w/:worldId/p/:prodId/story/chapters/:chapterId' element={<ChapterScreen/>}/></Routes></MemoryRouter>));
window.openChapter=()=>{const ask=window.sent.findLast(m=>m.kind==='open-chapter'); if(!ask)return false; flushSync(()=>__applyEventForTest({type:'chapter.open-result',at,requestId:ask.requestId,worldId:world.meta.worldId,productionId:'bell-watch',chapterId:'crossing',disposition:'opened',body:'Maren counted the bells.\\n\\nThe river lay still.\\n\\nBeyond the trees a bell sounded once.',version:4,hash,versions:[1,2,3]}));return true;};
const ids={worldId:world.meta.worldId,productionId:'bell-watch',chapterId:'crossing'};
const read={id:'01J8F3K2QW9VZX4N7M0RTYB6HD',...ids,chapterFile:'01-crossing',chapterTitle:'The crossing and the bell beyond the river',productionTitle:'Bell Watch',worldName:'The Undersong',scope:'chapter',phase:'queued',startedAt:at,updatedAt:at,toMake:20,made:6,flagged:0,requests:4,request:2,estimatedMicroUsd:400000,models:['Gemini 2.5 Flash TTS'],local:false,jobs:[]};
window.start=()=>flushSync(()=>{__applyEventForTest({type:'audiobook.started',at,...ids,requestId:read.id,toMake:20,blocks:20,requests:4});__applyEventForTest({type:'audiobook.activity',at,run:read});});
window.phase=(phase)=>flushSync(()=>__applyEventForTest({type:'audiobook.activity',at,run:{...read,phase,...(phase==='interrupted'?{reason:'Alignment stopped. The saved blocks are still here.'}:{})}}));
window.panel=()=>flushSync(()=>openActivityPanel('inbox'));
window.fixtureReady=true;
` }, bundle: true, platform: "browser", format: "iife", define: { "import.meta.env": "{}" }, loader: { ".woff": "file", ".woff2": "file" }, outfile: join(dir, "view.js") });
await writeFile(join(dir, "index.html"), '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="view.css"><style>body{margin:0;background:var(--background)}#root{height:100dvh}</style></head><body><div id="root"></div><script src="view.js"></script></body></html>');
const server=createServer(async(req,res)=>{try{const name=new URL(req.url,"http://localhost").pathname.slice(1)||"index.html";if(!/^[\w.-]+$/.test(name))throw Error();res.setHeader("Content-Type",name.endsWith(".js")?"text/javascript":name.endsWith(".css")?"text/css":name.endsWith(".html")?"text/html":"application/octet-stream");res.end(await readFile(join(dir,name)));}catch{res.writeHead(404);res.end();}});
await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
const chrome=process.env.ARKE_CHROME??(process.platform==="win32"?"C:/Program Files/Google/Chrome/Application/chrome.exe":"/usr/bin/google-chrome");
const child=spawn(chrome,["--headless=new","--no-first-run","--no-default-browser-check","--remote-debugging-port=0","--user-data-dir="+join(dir,"profile"),"about:blank"],{windowsHide:true,stdio:"ignore"});
let socket;
const until=async read=>{const end=Date.now()+20000;while(Date.now()<end){try{const v=await read();if(v)return v;}catch{}await new Promise(r=>setTimeout(r,100));}throw Error("Fixture did not become ready");};
try{
  const port=await until(async()=>(await readFile(join(dir,"profile/DevToolsActivePort"),"utf8")).split("\n")[0]);
  const targets=await(await fetch("http://127.0.0.1:"+port+"/json/list")).json();
  socket=new WebSocket(targets.find(t=>t.type==="page").webSocketDebuggerUrl);
  await new Promise((r,j)=>{socket.onopen=r;socket.onerror=j;});
  let sequence=0;const pending=new Map();
  socket.onmessage=({data})=>{const m=JSON.parse(data),p=pending.get(m.id);if(p){pending.delete(m.id);m.error?p.reject(m.error):p.resolve(m.result);}};
  const cdp=(method,params={})=>new Promise((resolve,reject)=>{const id=++sequence;pending.set(id,{resolve,reject});socket.send(JSON.stringify({id,method,params}));});
  const evaluate=async expression=>{const r=await cdp("Runtime.evaluate",{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));return r.result.value;};
  const shot=async name=>{const r=await cdp("Page.captureScreenshot",{format:"png"});await writeFile(join(dir,name+".png"),Buffer.from(r.data,"base64"));};
  await cdp("Page.enable");const records=[];
  for(const width of [1400,390,320]){
    await cdp("Emulation.setDeviceMetricsOverride",{width,height:950,deviceScaleFactor:1,mobile:false});
    await cdp("Page.navigate",{url:"http://127.0.0.1:"+server.address().port});
    await until(()=>evaluate("window.fixtureReady"));await until(()=>evaluate("window.openChapter()"));
    await until(()=>evaluate("Boolean(document.querySelector('[data-block=\"p0.0\"]'))"));
    await evaluate("document.fonts.ready");await evaluate("window.start();window.phase('aligning')");
    await until(()=>evaluate("Boolean(document.querySelector('.fy-abreceipt'))"));
    const receipt=await evaluate(`(()=>{const e=document.querySelector('.fy-abreceipt'),r=e.getBoundingClientRect();return{left:r.left,right:r.right,overflow:e.scrollWidth>e.clientWidth+1,buttons:[...e.querySelectorAll('button')].map(b=>b.getBoundingClientRect().height)};})()`);
    assert.ok(receipt.left>=0&&receipt.right<=width+1);assert.equal(receipt.overflow,false);if(width<600)assert.ok(receipt.buttons.every(h=>h>=44));
    await shot('receipt-'+width);
    if(width<600){const footer=await evaluate(`(()=>{const e=document.querySelector('[data-testid=audiobook-hold]'),buttons=[...e.querySelectorAll('button')].map(b=>({text:b.textContent,top:b.getBoundingClientRect().top,height:b.getBoundingClientRect().height}));return{buttons,overflow:e.scrollWidth>e.clientWidth+1};})()`);assert.equal(footer.overflow,false);assert.equal(footer.buttons.length,2);assert.equal(footer.buttons[0].top,footer.buttons[1].top);assert.ok(footer.buttons.every(b=>b.height>=44));records.push({width,footer});}
    await evaluate("window.panel()");await until(()=>evaluate("Boolean(document.querySelector('.fy-abactivity'))"));
    const panel=await evaluate(`(()=>{const e=document.querySelector('.fy-ap'),r=e.getBoundingClientRect();return{left:r.left,right:r.right,overflow:e.scrollWidth>e.clientWidth+1,rows:document.querySelectorAll('[data-testid=audiobook-activity-row]').length};})()`);
    assert.ok(panel.left>=0&&panel.right<=width+1);assert.equal(panel.overflow,false);assert.equal(panel.rows,1);await shot('activity-'+width);
    await evaluate("window.phase('interrupted')");await shot('interrupted-'+width);records.push({width,receipt,panel});
  }
  await writeFile(join(dir,"measurements.json"),JSON.stringify(records,null,2));console.log(JSON.stringify({directory:dir,records}));
}finally{socket?.close();child.kill();await new Promise(resolve=>server.close(resolve));}
