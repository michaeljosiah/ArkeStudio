import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtemp, readFile, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { spawn, execFileSync } from "node:child_process";
import { parseHTML } from "linkedom";

// Turn 169 against the actual React screens, with the complete client cascade.
// Chrome owns hover/pointer emulation; fixture media stays on a private loopback server.
const root = fileURLToPath(new URL("../", import.meta.url));
const baseline = process.argv.includes("--baseline");
const baselineRef = baseline ? process.argv[process.argv.indexOf("--baseline") + 1] : null;
if (baseline) assert.ok(baselineRef, "--baseline requires a revision");
const dir = await mkdtemp(join(tmpdir(), "arke-generate-"));
const main = await readFile(join(root, "packages/client/src/main.tsx"), "utf8");
const styles = [...main.matchAll(/^import "([^"]+\.css)";/gm)].filter(m => !baseline || !m[1].endsWith("/generate-responsive.css")).map(m => m[0]).join("\n");
const { document: master } = parseHTML(await readFile(join(root, "design-system/Arke Studio.dc.html"), "utf8"));
const masterLinks = [...master.querySelectorAll("link[rel=stylesheet]")].map(e => e.outerHTML.replace('href="', 'href="/design/')).join("\n");
const masterStyles = [...master.querySelectorAll("#t169 style")].map(e => e.outerHTML).join("\n");
for (const id of ["gn169a1", "gn169a2", "gn169a3", "gn169b1", "gn169b2", "gn169b3", "gn169c", "gn169d"]) {
  const frame = master.getElementById(id).cloneNode(true);
  frame.querySelectorAll(".sb,.hi,style").forEach(e => e.remove());
  frame.querySelector(".viewer .vtop")?.setAttribute("style", "padding-top:0");
  frame.style.height = ["gn169c","gn169d"].includes(id) ? "1060px" : "797px";
  await writeFile(join(dir, id + ".html"), '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' + masterLinks + masterStyles + '<style>body{margin:0}</style></head><body>' + frame.outerHTML.replaceAll('src="assets/', 'src="/design/assets/') + '</body></html>');
}
await build({
  stdin: { resolveDir: join(root, "packages/client/src"), loader: "tsx", contents: `
import React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { MemoryRouter, useNavigate } from "react-router";
import { App } from "./App";
import { __applyEventForTest, __setBridgeForTest, __setStateForTest, __connectionStatusForTest } from "./lib/store";
import { generateLayoutFixture, generateQuote } from "../test/generate-layout-fixture";
${styles}
let renderer;
function Navigation(){window.go=useNavigate();return null;}
window.settleLayout=async()=>{await new Promise(r=>setTimeout(r,450));await document.fonts.ready;await Promise.all([...document.images].map(i=>i.decode().catch(()=>{})));for(const a of document.getAnimations()){if(Number.isFinite(a.effect?.getComputedTiming().endTime))a.finish();else{a.pause();a.currentTime=0;}}};
window.mountLayout=async(route="cast",mode="normal")=>{
 renderer?.unmount();const state=generateLayoutFixture(mode),world=state.world;

 const sheetRefs=Object.fromEntries(world.sheets.map(s=>[s.id,{tiles:6,productions:["saltlight","ledger"],artifacts:["a1","a2"],scenes:["s1","s2"],takesByVersion:{4:2},incomingLinks:[]}]));
 window.commands=[];const bridge={connect(){},send(raw){const m=JSON.parse(raw);window.commands.push(m);if(m.kind==="frame-run-quote")queueMicrotask(()=>__applyEventForTest({type:"production.frame-run-quote",at:"2026-08-30T12:00:01Z",quote:generateQuote(m,state.app.models.disabled.includes(m.modelId)?"This model is turned off in AI models":null)}));},subscribe(){return()=>{};},coordinatorHttpBase:()=>location.origin};window.arke=bridge;__setBridgeForTest(bridge);__setStateForTest(state,{sheetRefs});__connectionStatusForTest("open");
 renderer=createRoot(document.getElementById("root"));flushSync(()=>renderer.render(<MemoryRouter initialEntries={["/w/"+world.meta.worldId+"/"+route]}><Navigation/><App/></MemoryRouter>));await window.settleLayout();
};
window.measureLayout=()=>{
 const selectors=[".fy-takegrid",".fy-take--on",".fy-takes__verdict",".fy-gen__left",".fy-gen__center",".fy-gen__strip",".fy-gen__phone-foot",".fy-swrun",".fy-swlightbox",".fy-scene-back",".fy-sw__centre",".fy-sw__context",".fy-sw__toolbar",".fy-swrow__band",".fy-swrow__frame",".fy-swrow__body",".fy-swrow__actions",".fy-shot__strip",".fy-shot__frame",".fy-shot__body",".fy-shot__section",".fy-shot__camera",".fy-swstage__viewport",".fy-swstage__timeline",".fy-sw__rail",".fy-ledger .fy-row",".fy-row__thumb","dialog[open]"];
 const bounds=s=>{const e=document.querySelector(s);if(!e)return null;const b=e.getBoundingClientRect();return{x:b.x,y:b.y,width:b.width,height:b.height};};const page=document.querySelector(".fy-sw__centre,.fy-prodmain");
 return{viewport:[innerWidth,innerHeight],overflow:document.documentElement.scrollWidth>innerWidth || !!(page&&page.scrollWidth>page.clientWidth+1),sideways:[...document.querySelectorAll('.fy-sw__centre,.fy-prodmain,.fy-shot__body')].filter(e=>e.scrollWidth>e.clientWidth+1).map(e=>e.className),geometry:Object.fromEntries(selectors.map(s=>[s,bounds(s)]))};
};
` }, bundle:true,platform:"browser",format:"iife",define:{"import.meta.env":"{}"},
  plugins:[{name:"fixture-cascade",setup(build) {
    build.onLoad({filter:/\.(css|tsx?)$/}, async ({path}) => {
      const name=relative(root,path).replaceAll("\\","/");
      const old=baseline && ["packages/client/src/screens/production-generate.tsx","packages/client/src/screens/production-takes.tsx","packages/client/src/components/take-dialogue-feedback.tsx","packages/client/src/screens/scene-workspace/frame-run.tsx","packages/client/src/screens/scene-workspace/lightbox.tsx","packages/client/src/screens/scene-workspace/workspace.tsx","packages/client/src/screens/scene-workspace/rows.tsx","packages/client/src/screens/scene-workspace/shot-page.tsx","packages/client/src/screens/scene-workspace/preview.tsx"].includes(name);
      return {loader:path.endsWith(".css")?"css":"tsx",resolveDir:dirname(path),contents:(old?execFileSync("git",["show",baselineRef+":"+name],{cwd:root,encoding:"utf8"}):await readFile(path,"utf8")).replace(/env\(safe-area-inset-bottom(?:,\s*0px)?\)/g,"var(--smoke-safe-bottom, 0px)")};
    });
  }}],loader:{".woff":"file",".woff2":"file"},outfile:join(dir,"view.js")
});
await writeFile(join(dir,"index.html"), '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="view.css"></head><body><div id="root"></div><script src="view.js"></script></body></html>');
console.log("Generate artifacts: " + dir);
execFileSync("ffmpeg",["-hide_banner","-loglevel","error","-loop","1","-i",join(root,"design-system/assets/scene4-shot12.png"),"-t","1","-vf","scale=320:180:force_original_aspect_ratio=increase,crop=320:180","-c:v","libx264","-pix_fmt","yuv420p","-y",join(dir,"fixture.mp4")],{windowsHide:true});
const chrome=process.env.ARKE_CHROME ?? (process.platform === "win32" ? "C:/Program Files/Google/Chrome/Application/chrome.exe" : process.platform === "darwin" ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : "/usr/bin/google-chrome");
execFileSync("ffmpeg",["-hide_banner","-loglevel","error","-i",join(dir,"fixture.mp4"),"-frames:v","1","-y",join(dir,"fixture-poster.png")],{windowsHide:true});
await access(chrome);
const server=createServer(async (req,res) => {
  try {
    const path=decodeURIComponent(new URL(req.url,"http://localhost").pathname);
    if(path.startsWith("/media/") && path.includes("missing-candidate")) {res.writeHead(404);res.end();return;}
    const file=path.startsWith("/media/") && path.endsWith(".mp4") ? join(dir,"fixture.mp4") : path.startsWith("/media/") && path.includes("layout-take-") ? join(dir,"fixture-poster.png") : path.startsWith("/media/") ? join(root,"design-system/assets",path.includes("head-front") ? "char-maren.png" : path.includes("shot13") ? "scene4-shot13.png" : path.includes("shot15") ? "saltlight-shot15.png" : "scene4-shot12.png") : path.startsWith("/art-styles/") ? join(root,"packages/client/public",path.slice(1)) : path.startsWith("/design/") ? join(root,"design-system",path.slice(8)) : join(dir,path === "/" ? "index.html" : path.slice(1));
    assert.ok([dir,join(root,"design-system"),join(root,"packages/client/public")].some(base=>{const rel=relative(base,file);return !rel.startsWith("..") && !isAbsolute(rel);}));
    res.setHeader("Content-Type",file.endsWith(".mp4")?"video/mp4":file.endsWith(".svg")?"image/svg+xml":file.endsWith(".css")?"text/css":file.endsWith(".js")?"text/javascript":file.endsWith(".html")?"text/html":"application/octet-stream"); res.end(await readFile(file));
  } catch {res.writeHead(404);res.end();}
});
await new Promise(r=>server.listen(0,"127.0.0.1",r));
const origin="http://127.0.0.1:"+server.address().port;
const child=spawn(chrome,["--headless=new","--enable-unsafe-swiftshader",process.argv.includes("--hover") ? "--blink-settings=primaryPointerType=4,availablePointerTypes=4,primaryHoverType=2,availableHoverTypes=2" : "--blink-settings=primaryPointerType=2,availablePointerTypes=2,primaryHoverType=0,availableHoverTypes=0","--no-first-run","--no-default-browser-check","--remote-debugging-port=0","--user-data-dir="+join(dir,"profile"),"about:blank"],{windowsHide:true,stdio:"ignore"});
let socket;
const settle=()=>new Promise(r=>setTimeout(r,150));
const until=async f=>{const deadline=Date.now()+20000;while(Date.now()<deadline){try{const v=await f();if(v)return v;}catch{}await settle();}throw new Error("Timed out waiting for Chrome");};
try {
  const port=await until(async ()=>(await readFile(join(dir,"profile/DevToolsActivePort"),"utf8")).split("\n")[0]);
  const targets=await(await fetch("http://127.0.0.1:"+port+"/json/list")).json();
  socket=new WebSocket(targets.find(t=>t.type === "page").webSocketDebuggerUrl);
  await new Promise((resolve,reject)=>{socket.onopen=resolve;socket.onerror=reject;});
  let seq=0;const pending=new Map();
  socket.onmessage=({data})=>{const m=JSON.parse(data),p=pending.get(m.id);if(p){pending.delete(m.id);m.error?p.reject(new Error(JSON.stringify(m.error))):p.resolve(m.result);}};
  const cdp=(method,params={})=>new Promise((resolve,reject)=>{const id=++seq;pending.set(id,{resolve,reject});socket.send(JSON.stringify({id,method,params}));});
  const js=async expression=>{const r=await cdp("Runtime.evaluate",{expression,awaitPromise:true,returnByValue:true,userGesture:true});if(r.exceptionDetails)throw new Error(JSON.stringify(r.exceptionDetails));return r.result.value;};
  const size=(width,height,mobile)=>cdp("Emulation.setDeviceMetricsOverride",{width,height,deviceScaleFactor:1,mobile});
  const navigate=async path=>{await cdp("Page.navigate",{url:origin+path});await until(()=>js('document.readyState === "complete"'));};
  const capture=async name=>{await js("document.fonts.ready");await settle();const {data}=await cdp("Page.captureScreenshot",{format:"png",captureBeyondViewport:false});await writeFile(join(dir,name+".png"),Buffer.from(data,"base64"));};
  await cdp("Page.enable");await cdp("Emulation.setEmulatedMedia",{features:[{name:"prefers-reduced-motion",value:"reduce"}]});
  await navigate("/");await until(()=>js('typeof window.mountLayout === "function"'));
  const records=[];
  const only=process.argv.includes("--viewport")?process.argv[process.argv.indexOf("--viewport")+1]:null;
  const check=async(name)=>{const m=await js("window.measureLayout()");records.push({name,...m});await writeFile(join(dir,"measurements.json"),JSON.stringify(records,null,2));await capture(name);if(m.overflow)console.log(name,"overflow",m.sideways,await js('Array.from(document.querySelectorAll(".fy-sw__centre *,.fy-prodmain *")).filter(e=>{const r=e.getBoundingClientRect();return e.scrollWidth>e.clientWidth+1||r.right>innerWidth||r.left<0}).map(e=>({tag:e.tagName,class:e.className,width:e.getBoundingClientRect().width,x:e.getBoundingClientRect().x,sw:e.scrollWidth,cw:e.clientWidth,text:e.textContent.slice(0,80)}))'));if(!baseline && !name.startsWith("desktop-"))assert.equal(m.overflow,false,name+" overflow");return m;};
  const click=async selector=>{const point=await js(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.scrollIntoView({block:"center",inline:"nearest"});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);await cdp("Input.dispatchMouseEvent",{type:"mouseMoved",...point});await cdp("Input.dispatchMouseEvent",{type:"mousePressed",button:"left",clickCount:1,...point});await cdp("Input.dispatchMouseEvent",{type:"mouseReleased",button:"left",clickCount:1,...point});await js("window.settleLayout()");};
  const escape=async()=>{await cdp("Input.dispatchKeyEvent",{type:"keyDown",key:"Escape",code:"Escape",windowsVirtualKeyCode:27});await cdp("Input.dispatchKeyEvent",{type:"keyUp",key:"Escape",code:"Escape",windowsVirtualKeyCode:27});await js("window.settleLayout()");};




  const key=async key=>{await cdp("Input.dispatchKeyEvent",{type:"keyDown",key,code:key,windowsVirtualKeyCode:key==='ArrowRight'?39:37});await cdp("Input.dispatchKeyEvent",{type:"keyUp",key,code:key});await js("window.settleLayout()");};
  for(const [name,width,height,touch] of [["phone",390,797,true],["small",360,800,true],["acceptance",375,812,true],["fold",984,1092,true],["desktop",1360,850,false]]) {
    if(only&&name!==only)continue;
    await size(width,height,touch);await cdp("Emulation.setTouchEmulationEnabled",{enabled:!process.argv.includes("--hover")});
    await js('document.documentElement.style.setProperty("--smoke-safe-bottom",'+JSON.stringify(width<600?"20px":"0px")+')');
    for(const [label,route,mode] of [["takes","p/saltlight/generate?shot=sh_12","normal"],["bench","p/saltlight/generate?view=bench&shot=sh_12","normal"],["contact","p/saltlight/generate?view=stills","stills"],["frames","p/saltlight/scenes/sc_04","normal"],["unavailable","p/saltlight/scenes/sc_04","unavailable"],["running","p/saltlight/scenes/sc_04","running"],["completed","p/saltlight/scenes/sc_04","completed"]]) {
      await js('window.mountLayout('+JSON.stringify(route)+','+JSON.stringify(mode)+')');await check(name+'-'+label);
      if(label==='takes'&&!baseline) {
        await click('.fy-takes__verdict > button:last-child');await check(name+'-reject');
        await click('.fy-reject-take__citations button:last-child');
        await js('(()=>{const e=document.querySelector(".fy-reject-take textarea");Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value").set.call(e,"Keep the lantern colour");e.dispatchEvent(new Event("input",{bubbles:true}));})()');
        await click('.fy-reject-take .fy-page-sheet__foot button:last-child');
        assert.deepEqual(await js('window.commands.findLast(c=>c.kind==="reject-take").citation'),{sheet:'the-vigil',field:'appearance',note:'Keep the lantern colour'});
        if(width<600){await click('.fy-takes__diagnostics');await check(name+'-diagnostics');await escape();}
        if(width<1100){await click('.fy-generate-wrap > .fy-sw__rail');await check(name+'-arke');await escape();}
      }
      if(label==='bench'&&!baseline&&width<600) {assert.ok(await js('document.querySelector(".fy-gen__strip .fy-bench__takeframe").getBoundingClientRect().height>=47'));await click('.fy-gen__arke');await check(name+'-bench-arke');await escape();await click('.fy-gen__take-menu');await check(name+'-bench-actions');await escape();await click('.fy-gen__model-row');await check(name+'-model');await escape();}
      if(label==='frames'||label==='unavailable') {await click('.fy-sw__actions > button:last-child');if(!baseline&&width<1100)await click('.fy-swgen__methods button:first-child');await check(name+'-'+(label==='frames'?'dialog':'unavailable-dialog'));if(label==='unavailable'&&!baseline&&width<1100)assert.ok(await js('document.querySelector(".fy-swgen__unavailable").getBoundingClientRect().height>0'));if(!baseline){assert.ok(await js('document.querySelector(".fy-swgen__foot").getBoundingClientRect().bottom<=innerHeight+1'));if(width<1100)assert.ok(await js('Array.from(document.querySelectorAll(".fy-swgen__scope button,.fy-swgen__models button,.fy-swgen__foot button")).every(e=>e.getBoundingClientRect().height>=44)'));}await escape();}
      if(label==='running'&&!baseline&&width<600){assert.ok(await js('getComputedStyle(document.querySelector(".fy-sw__rail")).display==="none"'));assert.ok(await js('document.querySelector(".fy-swrun").getBoundingClientRect().bottom<=innerHeight+1'));}
      if(label==='completed') {
        await click('.fy-swrun__review');await check(name+'-review');
        if(!baseline){const title=await js('document.querySelector(".fy-swlightbox img").alt');await key('ArrowRight');assert.notEqual(await js('document.querySelector(".fy-swlightbox img")?.alt'),title);await key('ArrowLeft');assert.equal(await js('document.querySelector(".fy-swlightbox img").alt'),title);
          if(width<600){const box=await js('(()=>{const r=document.querySelector(".fy-swlightbox__frame").getBoundingClientRect();return {x:r.x+r.width*.8,y:r.y+r.height*.5}})()');await cdp('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{id:0,x:box.x,y:box.y}]});for(let n=1;n<=5;n++)await cdp('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{id:0,x:box.x-n*25,y:box.y}]});await cdp('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await js('window.settleLayout()');assert.notEqual(await js('document.querySelector(".fy-swlightbox img")?.alt'),title);await key('ArrowLeft');}
        }
        await escape();
      }
    }
  }
  const masterRecords=[];
  for(const id of ["gn169a1","gn169a2","gn169a3","gn169b1","gn169b2","gn169b3","gn169c","gn169d"]){const fold=["gn169c","gn169d"].includes(id);await size(fold?984:390,fold?1060:797,true);await navigate('/'+id+'.html');await capture(id);masterRecords.push({id,geometry:await js('Object.fromEntries([".gmain",".take",".grid2",".chips",".verdict",".sheet",".dlg",".runbar",".lb",".cmp",".tstrip"].map(s=>{const e=document.querySelector(s),r=e?.getBoundingClientRect();return[s,r?{x:r.x,y:r.y,width:r.width,height:r.height}:null]}))')});}
  await writeFile(join(dir,'master-measurements.json'),JSON.stringify(masterRecords,null,2));
  console.log(JSON.stringify({directory:dir,checks:records.length,baseline:baselineRef}));
}finally{socket?.close();child.kill();await new Promise(r=>server.close(r));}
