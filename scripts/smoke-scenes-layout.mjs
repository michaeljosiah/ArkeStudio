import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtemp, readFile, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { spawn, execFileSync } from "node:child_process";
import { parseHTML } from "linkedom";

// Turn 168 against the actual React screens, with the complete client cascade.
// Chrome owns hover/pointer emulation; fixture media stays on a private loopback server.
const root = fileURLToPath(new URL("../", import.meta.url));
const baseline = process.argv.includes("--baseline");
const baselineRef = baseline ? process.argv[process.argv.indexOf("--baseline") + 1] : null;
if (baseline) assert.ok(baselineRef, "--baseline requires a revision");
const dir = await mkdtemp(join(tmpdir(), "arke-scenes-"));
const main = await readFile(join(root, "packages/client/src/main.tsx"), "utf8");
const styles = [...main.matchAll(/^import "([^"]+\.css)";/gm)].filter(m => !baseline || !m[1].endsWith("/scene-workspace/responsive.css")).map(m => m[0]).join("\n");
const { document: master } = parseHTML(await readFile(join(root, "design-system/Arke Studio.dc.html"), "utf8"));
const masterLinks = [...master.querySelectorAll("link[rel=stylesheet]")].map(e => e.outerHTML.replace('href="', 'href="/design/')).join("\n");
const masterStyles = [...master.querySelectorAll("#t168 style")].map(e => e.outerHTML).join("\n");
for (const id of ["sw168a1", "sw168a2", "sw168a3", "sw168b1", "sw168b2", "sw168b3", "sw168c", "sw168d"]) {
  const frame = master.getElementById(id).cloneNode(true);
  frame.querySelectorAll(".sb,.hi,style").forEach(e => e.remove());
  frame.querySelector(".viewer .vtop")?.setAttribute("style", "padding-top:0");
  frame.style.height = ["sw168c","sw168d"].includes(id) ? "1060px" : "797px";
  await writeFile(join(dir, id + ".html"), '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' + masterLinks + masterStyles + '<style>body{margin:0}</style></head><body>' + frame.outerHTML.replaceAll('src="assets/', 'src="/design/assets/') + '</body></html>');
}
await build({
  stdin: { resolveDir: join(root, "packages/client/src"), loader: "tsx", contents: `
import React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { MemoryRouter, useNavigate } from "react-router";
import { App } from "./App";
import { __setBridgeForTest, __setStateForTest, __connectionStatusForTest } from "./lib/store";
import { scenesLayoutFixture } from "../test/scenes-layout-fixture";
${styles}
let renderer;
function Navigation(){window.go=useNavigate();return null;}
window.settleLayout=async()=>{await new Promise(r=>setTimeout(r,450));await document.fonts.ready;await Promise.all([...document.images].map(i=>i.decode().catch(()=>{})));for(const a of document.getAnimations()){if(Number.isFinite(a.effect?.getComputedTiming().endTime))a.finish();else{a.pause();a.currentTime=0;}}};
window.mountLayout=async(route="cast",mode="normal")=>{
 renderer?.unmount();const state=scenesLayoutFixture(mode),world=state.world;

 const sheetRefs=Object.fromEntries(world.sheets.map(s=>[s.id,{tiles:6,productions:["saltlight","ledger"],artifacts:["a1","a2"],scenes:["s1","s2"],takesByVersion:{4:2},incomingLinks:[]}]));
 window.commands=[];const bridge={connect(){},send(raw){window.commands.push(JSON.parse(raw));},subscribe(){return()=>{};},coordinatorHttpBase:()=>location.origin};window.arke=bridge;__setBridgeForTest(bridge);__setStateForTest(state,{sheetRefs});__connectionStatusForTest("open");
 renderer=createRoot(document.getElementById("root"));flushSync(()=>renderer.render(<MemoryRouter initialEntries={["/w/"+world.meta.worldId+"/"+route]}><Navigation/><App/></MemoryRouter>));await window.settleLayout();
};
window.measureLayout=()=>{
 const selectors=[".fy-scene-back",".fy-sw__centre",".fy-sw__context",".fy-sw__toolbar",".fy-swrow__band",".fy-swrow__frame",".fy-swrow__body",".fy-swrow__actions",".fy-shot__strip",".fy-shot__frame",".fy-shot__body",".fy-shot__section",".fy-shot__camera",".fy-swstage__viewport",".fy-swstage__timeline",".fy-sw__rail",".fy-ledger .fy-row",".fy-row__thumb","dialog[open]"];
 const bounds=s=>{const e=document.querySelector(s);if(!e)return null;const b=e.getBoundingClientRect();return{x:b.x,y:b.y,width:b.width,height:b.height};};const page=document.querySelector(".fy-sw__centre,.fy-prodmain");
 return{viewport:[innerWidth,innerHeight],overflow:document.documentElement.scrollWidth>innerWidth || !!(page&&page.scrollWidth>page.clientWidth+1),sideways:[...document.querySelectorAll('.fy-sw__centre,.fy-prodmain,.fy-shot__body')].filter(e=>e.scrollWidth>e.clientWidth+1).map(e=>e.className),geometry:Object.fromEntries(selectors.map(s=>[s,bounds(s)]))};
};
` }, bundle:true,platform:"browser",format:"iife",define:{"import.meta.env":"{}"},
  plugins:[{name:"fixture-cascade",setup(build) {
    build.onLoad({filter:/\.(css|tsx?)$/}, async ({path}) => {
      const name=relative(root,path).replaceAll("\\","/");
      const old=baseline && ["packages/client/src/screens/production-shell.tsx","packages/client/src/screens/production-story.tsx","packages/client/src/screens/fidelity.css","packages/client/src/screens/scene-workspace/workspace.tsx","packages/client/src/screens/scene-workspace/shot-page.tsx","packages/client/src/screens/scene-workspace/shot-fields.tsx","packages/client/src/screens/scene-workspace/rows.tsx","packages/client/src/screens/scene-workspace/frame-actions.tsx","packages/client/src/screens/scene-workspace/stage.tsx","packages/client/src/screens/scene-workspace/flow.tsx","packages/client/src/components/page-sheet.tsx"].includes(name);
      if (!baseline && name.endsWith("/stage-viewport.ts")) {
        // Inspect the real Three controls only in this browser fixture. Production bundles
        // expose no viewport internals; the assertions send real CDP touch events below.
        const contents = (await readFile(path,"utf8")).replace("this.controls = controls;", "this.controls = controls; Object.assign(window, { smokeStage: this, smokeTracks: [] }); const track = this.events.trackpick; this.events = { ...this.events, trackpick: id => { window.smokeTracks.push(id); track(id); } };");
        return {loader:"ts",resolveDir:dirname(path),contents};
      }
      return {loader:path.endsWith(".css")?"css":"tsx",resolveDir:dirname(path),contents:(old?execFileSync("git",["show",baselineRef+":"+name],{cwd:root,encoding:"utf8"}):await readFile(path,"utf8")).replace(/env\(safe-area-inset-bottom(?:,\s*0px)?\)/g,"var(--smoke-safe-bottom, 0px)")};
    });
  }}],loader:{".woff":"file",".woff2":"file"},outfile:join(dir,"view.js")
});
await writeFile(join(dir,"index.html"), '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="view.css"></head><body><div id="root"></div><script src="view.js"></script></body></html>');
console.log("Scenes artifacts: " + dir);
const chrome=process.env.ARKE_CHROME ?? (process.platform === "win32" ? "C:/Program Files/Google/Chrome/Application/chrome.exe" : process.platform === "darwin" ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : "/usr/bin/google-chrome");
await access(chrome);
const server=createServer(async (req,res) => {
  try {
    const path=decodeURIComponent(new URL(req.url,"http://localhost").pathname);
    if(path.startsWith("/media/") && path.includes("missing-candidate")) {res.writeHead(404);res.end();return;}
    const file=path.startsWith("/media/") ? join(root,"design-system/assets",path.includes("head-front") ? "char-maren.png" : path.includes("shot13") ? "scene4-shot13.png" : path.includes("shot15") ? "saltlight-shot15.png" : "scene4-shot12.png") : path.startsWith("/art-styles/") ? join(root,"packages/client/public",path.slice(1)) : path.startsWith("/design/") ? join(root,"design-system",path.slice(8)) : join(dir,path === "/" ? "index.html" : path.slice(1));
    assert.ok([dir,join(root,"design-system"),join(root,"packages/client/public")].some(base=>{const rel=relative(base,file);return !rel.startsWith("..") && !isAbsolute(rel);}));
    res.setHeader("Content-Type",file.endsWith(".svg")?"image/svg+xml":file.endsWith(".css")?"text/css":file.endsWith(".js")?"text/javascript":file.endsWith(".html")?"text/html":"application/octet-stream"); res.end(await readFile(file));
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



  for(const [name,width,height,touch] of [["phone",390,797,true],["small",360,800,true],["acceptance",375,812,true],["tablet",600,850,true],["fold",984,1060,true],["fold-full",984,1092,true],["desktop",1360,850,false]]){
    if(only&&only!==name)continue;
    await size(width,height,touch);await cdp("Emulation.setTouchEmulationEnabled",{enabled:!process.argv.includes("--hover")});
    await js('document.documentElement.style.setProperty("--smoke-safe-bottom",'+JSON.stringify(width<600?"20px":"0px")+')');
    for(const [label,route,mode] of [["scenes","p/saltlight/scenes","normal"],["scene","p/saltlight/scenes/sc_04","normal"],["empty","p/saltlight/scenes/sc_04","empty"],["shot","p/saltlight/scenes/sc_04/shots/sh_12","normal"],["stage","p/saltlight/scenes/sc_04/shots/sh_12?view=stage","normal"]]){
      await cdp("Input.dispatchMouseEvent",{type:"mouseMoved",x:0,y:0});
      await js('window.mountLayout('+JSON.stringify(route)+','+JSON.stringify(mode)+')');await check(name+'-'+label);
      if(baseline)continue;
      if(label==='scenes'&&width<600) assert.equal(Math.round((await js('document.querySelector(".fy-row").getBoundingClientRect().height'))),76);
      if(label==='scene'){
        if(width<600){assert.equal(await js('Array.from(document.querySelectorAll("[role=radio]")).some(e=>e.textContent==="Flow")'),false);assert.equal(await js('!!document.querySelector(".fy-production-mobile-nav")'),false);}
        if(!process.argv.includes('--hover')||width<1100){await click('.fy-swrow__frameactions > button:last-child');await check(name+'-shot-actions');assert.equal(await js('document.querySelector(".fy-frame-actions-sheet[open]")!==null'),true);await escape();}
        if(width<1100){await click('.fy-sw__rail');await check(name+'-arke');await escape();}
        if(width<600){
          await click('.fy-swrow__frameactions > button:last-child');
          await js('Array.from(document.querySelectorAll(".fy-frame-actions-sheet[open] button")).find(e=>e.textContent.startsWith("Variants")).click()');await js('window.settleLayout()');
          await check(name+'-variants');assert.ok(await js('!!document.querySelector(".fy-swvariants[open]")'));await escape();
          await click('.fy-sw__actions > button:last-child');await check(name+'-generate');
          assert.ok(await js('document.querySelector(".fy-swgen__foot").getBoundingClientRect().bottom <= innerHeight+1'),'generation actions stay in the sheet');await escape();
          await click('.fy-scene-back > button:last-child');await js('Array.from(document.querySelectorAll(".fy-scene-page-menu[open] button")).find(e=>e.textContent==="Show boards").click()');await js('window.settleLayout()');
          await click('[aria-label^="View board sheet "]');await check(name+'-board-sheet');assert.ok(await js('!!document.querySelector(".fy-swboard-sheet[open]")'));await escape();
        }
        if(width>=600&&!process.argv.includes('--hover')){await js('Array.from(document.querySelectorAll("[role=radio]")).find(e=>e.textContent==="Flow").click()');await js('window.settleLayout()');await check(name+'-flow-list');}
      }
      if(label==='shot'){
        if(width<600){await js('document.querySelector(".fy-sw").scrollTop=document.querySelector(".fy-shot__section[data-field=Camera]").getBoundingClientRect().top-16');await check(name+'-fields');}
      }
      if(label==='stage'&&!process.argv.includes('--hover')){
        if (name === 'phone') {
          const pose = () => js('({ position: window.smokeStage.view.position.toArray(), target: window.smokeStage.controls.target.toArray(), distance: window.smokeStage.view.position.distanceTo(window.smokeStage.controls.target) })');
          const box=await js('(()=>{const r=window.smokeStage.renderer.domElement.getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height}})()');
          const touch=async(type,points)=>cdp('Input.dispatchTouchEvent',{type,touchPoints:points.map(([id,x,y])=>({id,x,y,radiusX:1,radiusY:1,force:1}))});
          const x=box.x+box.w*.45,y=box.y+box.h*.6;
          const before=await pose();
          await touch('touchStart',[[0,x,y]]);for(let i=1;i<=5;i++)await touch('touchMove',[[0,x+i*9,y-i*3]]);await touch('touchEnd',[]);await js('window.settleLayout()');
          const orbit=await pose();assert.notDeepEqual(orbit.position,before.position,'one finger orbits');
          await touch('touchStart',[[0,x-30,y],[1,x+30,y]]);for(let i=1;i<=5;i++)await touch('touchMove',[[0,x-30+i*5,y+i*3],[1,x+30+i*5,y+i*3]]);await touch('touchEnd',[]);await js('window.settleLayout()');
          const pan=await pose();assert.notDeepEqual(pan.target,orbit.target,'two fingers pan');
          await touch('touchStart',[[0,x-20,y],[1,x+20,y]]);for(let i=1;i<=5;i++)await touch('touchMove',[[0,x-20-i*6,y],[1,x+20+i*6,y]]);await touch('touchEnd',[]);await js('window.settleLayout()');
          const zoom=await pose();assert.ok(Math.abs(zoom.distance-pan.distance)>.05,'pinch zooms');
          await js('(()=>{const v=window.smokeStage;v.view.position.fromArray('+JSON.stringify(before.position)+');v.controls.target.fromArray('+JSON.stringify(before.target)+');v.controls.update()})()');await js('window.settleLayout()');
          // Project a figure through the current camera, so this does not depend on a screenshot coordinate.
          const figure=await js('(()=>{const v=window.smokeStage,p=v.walkers[0].position.clone();p.y+=.85;p.project(v.view);const r=v.renderer.domElement.getBoundingClientRect();return {x:r.x+(p.x+1)*r.width/2,y:r.y+(1-p.y)*r.height/2}})()');
          await js('window.touchLog=[];for(const type of ["pointerdown","pointerup","pointermove","pointercancel"])window.smokeStage.renderer.domElement.addEventListener(type,e=>window.touchLog.push({type:e.type,x:e.clientX,y:e.clientY,pointer:e.pointerType}))');
          for(let tap=0;tap<2;tap++){await touch('touchStart',[[0,figure.x,figure.y]]);await touch('touchEnd',[]);}
          await writeFile(join(dir,'touch-debug.json'),JSON.stringify({figure,box,zoom,events:await js('window.touchLog'),target:await js('document.elementFromPoint('+figure.x+','+figure.y+')?.outerHTML.slice(0,300)'),hits:await js('(()=>{const v=window.smokeStage;v.canvasPoint({clientX:'+figure.x+',clientY:'+figure.y+'});return v.ray.intersectObjects(v.castGroup.children,true).map(h=>v.tagOf(h.object))})()')},null,2));
          await js('window.settleLayout()');assert.deepEqual(await js('window.smokeTracks'),['maren-kest'],'double-tap follows the touched figure');
          await writeFile(join(dir,'touch-gestures.json'),JSON.stringify({before,orbit,pan,zoom,follow:['maren-kest']},null,2));
        }
        const door=await js('!!document.querySelector(".fy-stage-inspector-open")');
        if(door){await click('.fy-stage-inspector-open');await check(name+'-inspector');await escape();}
      }
    }
  }
  const masterRecords=[];
  for(const id of ["sw168a1","sw168a2","sw168a3","sw168b1","sw168b2","sw168b3","sw168c","sw168d"]){const fold=["sw168c","sw168d"].includes(id);await size(fold?984:390,fold?1060:797,true);await navigate('/'+id+'.html');await capture(id);masterRecords.push({id,geometry:await js('Object.fromEntries([".back2",".ctxrow",".tb",".shot",".shot .fr",".shot .b",".shot .ac",".strip2",".fcard",".cam",".stage",".tline",".arke",".srow",".srow img",".sheet",".rowL",".shotgrid"].map(s=>{const e=document.querySelector(s),r=e?.getBoundingClientRect();return[s,r?{x:r.x,y:r.y,width:r.width,height:r.height}:null]}))')});}
  await writeFile(join(dir,'master-measurements.json'),JSON.stringify(masterRecords,null,2));
  console.log(JSON.stringify({directory:dir,checks:records.length,baseline:baselineRef}));
}finally{socket?.close();child.kill();await new Promise(r=>server.close(r));}
