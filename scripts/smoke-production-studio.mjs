import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { spawn } from "node:child_process";

const root = fileURLToPath(new URL("../", import.meta.url));
const dir = await mkdtemp(join(tmpdir(), "arke-production-studio-"));
const styles = [...(await readFile(join(root, "packages/client/src/main.tsx"), "utf8")).matchAll(/^import "([^"]+\.css)";/gm)].map(match => match[0]).join("\n");
await build({ stdin: { resolveDir: join(root, "packages/client/src"), loader: "tsx", contents: `
import React, {useState} from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { MemoryRouter } from "react-router";
import { migrateLegacyScene, orderedShots, stageShot, seedStoryPictureTimeline, newId } from "@arke-studio/contracts";
import { ProductionStudio } from "./components/production-studio";
import { StudioToggle, StudioSidebar } from "./components/production-studio-context";
import { ConversationPermissionCard } from "./components/conversation";
import { __setStateForTest, __setBridgeForTest } from "./lib/store";
import { FIXTURE_STATE } from "../test/fixture-state";
${styles}
const state=structuredClone(FIXTURE_STATE), world=state.world, production=world.productions[0], scene=production.scenes[0];
const current=orderedShots(scene);current[0].staging=stageShot(current[0],{cast:[],sets:[],durationSec:current[0].durationSec??4});production.timeline={status:"ready",timeline:seedStoryPictureTimeline(production)};
const after=migrateLegacyScene({id:scene.id,slug:scene.slug,number:scene.number,order:scene.order,title:"The forty-shot scene",status:"draft",version:scene.version+1,
  shots:Array.from({length:40},(_,i)=>current[i]??{id:"sh_review_"+i,number:i+1,title:"Picture "+(i+1),description:"Maren waits by the gate.",durationSec:4})});
const action={actionId:newId("act"),conversationId:newId("cv"),turnId:newId("turn"),worldId:world.meta.worldId,productionId:production.meta.id,actorId:"local-user",scope:"production",
 actionKind:"world-chat-production-scene-command",authorityKind:"scene-store",cardFamily:"command",targets:[{kind:"scene",id:scene.id}],payloadDigest:"a".repeat(64),baseObservations:[],dependencies:[],createdAt:"2026-10-04T12:00:00Z",authority:{kind:"scene-store",id:scene.id},authorityRevision:scene.version,previewDigest:"b".repeat(64),
 shown:{title:"Review forty shots",consequence:"Updates the shot list",affectedTargets:[],ripples:[],permissionReason:"authored-change",body:{family:"command",commands:[{label:"Edit scene"}],expectedResult:"Scene updated",undoAvailable:true},productionPreview:{kind:"scene",before:scene,after}},status:"pending",preparedAt:"2026-10-04T12:00:00Z",availableDecisions:["approve","deny"]};
const initial={conversationId:action.conversationId,status:"open",initiative:"collaborate",hasMore:false,runStatus:null,runStartedAt:null,retrievalUnavailable:false,attachments:[],seq:1,actions:[action],points:[],messages:[]};
window.dispatches=[]; __setBridgeForTest({connect(){},send(message){window.dispatches.push(message)}});__setStateForTest(state);
function View(){const[workspace,setWorkspace]=useState(initial);
 window.addCard=()=>flushSync(()=>setWorkspace({...initial,actions:[action,{...action,actionId:newId("act"),actionKind:"world-chat-production-metadata",targets:[{kind:"production",id:production.meta.id}],shown:{...action.shown,productionPreview:{kind:"production",title:"Next target",medium:"film",productionKind:"short",aspect:"16:9",frameRate:24,series:null,season:null,episodes:0,style:null,model:null}}}]}));
 return <ProductionStudio world={world} productionId={production.meta.id} entry={{kind:"production",productionId:production.meta.id}} workspace={workspace} docked
 understanding={<div><h2>What it understood</h2><input aria-label="Understanding draft" defaultValue="A quiet lobby"/></div>}
 proposal={<div><h2>Staged proposal</h2><input aria-label="Proposal draft" defaultValue="The next scene"/></div>}>
  <aside className="fy-arke"><header className="fy-arke__head"><b>Arke</b><StudioToggle/></header><div className="fy-arke__log"><ConversationPermissionCard action={action} conversationSeq={1}/></div>
    <div className="fy-arke__strip"><StudioSidebar/></div><div className="fy-arke__foot"><textarea aria-label="Unsent words" defaultValue="Unsent draft"/></div></aside>
 </ProductionStudio>;
}
flushSync(()=>createRoot(document.getElementById("root")).render(<MemoryRouter><View/></MemoryRouter>));window.cardReady=true;
` }, bundle:true,platform:"browser",format:"iife",define:{"import.meta.env":"{}"},loader:{".woff":"file",".woff2":"file"},outfile:join(dir,"view.js") });
await writeFile(join(dir, "index.html"), '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="view.css"><style>body{margin:8px;background:var(--background)}#root{width:min(360px,100%);height:calc(100dvh - 16px);margin:auto}</style></head><body><div id="root"></div><script src="view.js"></script></body></html>');
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
  const records=[];
  for(const width of [360,390,984,1200]){
    await cdp("Emulation.setDeviceMetricsOverride",{width,height:900,deviceScaleFactor:1,mobile:false});
    await cdp("Page.navigate",{url:"http://127.0.0.1:"+server.address().port}); await until(()=>evaluate("window.cardReady"));
    await evaluate("document.fonts.ready");
    await evaluate(`window.originalComposer=document.querySelector('[aria-label="Unsent words"]');window.originalCard=document.querySelector('[data-action-id]');void 0;`);
    const click=async text=>evaluate(`(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent===${JSON.stringify(text)}&&b.getBoundingClientRect().width>0);if(!b)throw new Error('No visible button');b.click();})()`);
    await click("Studio"); await click("Show");
    const metrics=await evaluate(`(()=>{const studio=document.querySelector('.fy-production-studio'), thread=document.querySelector('.fy-production-studio__thread'),canvas=document.querySelector('.fy-production-studio__canvas');return {width:innerWidth,
      overflow:document.documentElement.scrollWidth>innerWidth, rows:canvas.querySelectorAll('[data-testid^="workspace-row-"]').length,
      threadVisible:getComputedStyle(thread).display!=='none',canvasVisible:getComputedStyle(canvas).display!=='none',
      composerPreserved:window.originalComposer===document.querySelector('[aria-label="Unsent words"]'),dispatches:window.dispatches.length,
      contained:[...canvas.querySelectorAll('.fy-swrow__body')].every(b=>b.getBoundingClientRect().right<=canvas.getBoundingClientRect().right)};})()`);
    assert.equal(metrics.overflow,false);assert.equal(metrics.rows,40);assert.equal(metrics.contained,true);assert.equal(metrics.composerPreserved,true);assert.equal(metrics.dispatches,0);assert.equal(metrics.canvasVisible,true);assert.equal(metrics.threadVisible,width>=600);
    await click("Pin canvas"); await evaluate("window.addCard()");
    assert.equal(await evaluate("document.querySelectorAll('[data-pending-preview] [data-testid^=workspace-row-]').length"),40);
    await cdp("Page.captureScreenshot",{format:"png"}).then(c=>writeFile(join(dir,`studio-${width}.png`),Buffer.from(c.data,"base64")));
    if(width<600){await click("Back to card");}
    await click("Open full size");
    assert.equal(await evaluate("document.querySelector('.fy-production-studio__full-card [data-action-id]')===window.originalCard"),true);
    assert.equal(await evaluate("document.querySelectorAll('[data-action-id]').length"),1);
    await click("Back to card");
    assert.equal(await evaluate("window.originalComposer===document.querySelector('[aria-label=\"Unsent words\"]')"),true);
    if(width<600) await click("Canvas");
    await click("Shots");
    await click("Board");
    assert.ok(await evaluate("document.querySelector('.fy-production-studio__canvas [aria-label=\"Resulting board grid\"]')!==null"));
    await click("Stage");
    assert.equal(await evaluate("document.querySelectorAll('.fy-production-studio__canvas [data-testid=workspace-stage]').length"),1);
    await cdp("Page.captureScreenshot",{format:"png"}).then(c=>writeFile(join(dir,`studio-stage-${width}.png`),Buffer.from(c.data,"base64")));
    await click("Cut");
    assert.equal(await evaluate("document.querySelectorAll('.fy-production-studio__canvas .fy-production-timeline').length"),1);
    await click("What it understood");await click("Proposal");
    assert.equal(await evaluate("document.querySelector('[aria-label=\"Proposal draft\"]').value"),"The next scene");
    const closeButtons=await evaluate("[...document.querySelectorAll('.fy-production-studio__head button')].filter(b=>b.textContent==='Close Studio').map(b=>b.textContent)");
    await evaluate("[...document.querySelectorAll('.fy-production-studio__head button')].find(b=>b.textContent==='Close Studio').click()");
    await click("Widen dock");
    assert.equal(await evaluate("document.querySelector('.fy-production-studio-owner').dataset.wide"),"true");
    assert.equal(await evaluate("window.dispatches.length"),0);
    records.push(metrics);
  }
  await writeFile(join(dir,"measurements.json"),JSON.stringify(records,null,2));console.log(JSON.stringify({directory:dir,records}));
} finally { socket?.close(); child.kill(); await new Promise(resolve=>server.close(resolve)); }
