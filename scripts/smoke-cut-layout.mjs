import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtemp, readFile, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { spawn, execFileSync } from "node:child_process";
import { parseHTML } from "linkedom";

// Turn 170 against the actual React screens, with the complete client cascade.
// Chrome owns hover/pointer emulation; fixture media stays on a private loopback server.
const root = fileURLToPath(new URL("../", import.meta.url));
const baseline = process.argv.includes("--baseline");
const baselineRef = baseline ? process.argv[process.argv.indexOf("--baseline") + 1] : null;
if (baseline) assert.ok(baselineRef, "--baseline requires a revision");
const dir = await mkdtemp(join(tmpdir(), "arke-cut-"));
const main = await readFile(join(root, "packages/client/src/main.tsx"), "utf8");
const styles = [...main.matchAll(/^import "([^"]+\.css)";/gm)].filter(m => !baseline || !m[1].endsWith("/editor-responsive.css")).map(m => m[0]).join("\n");
const { document: master } = parseHTML(await readFile(join(root, "design-system/Arke Studio.dc.html"), "utf8"));
const masterLinks = [...master.querySelectorAll("link[rel=stylesheet]")].map(e => e.outerHTML.replace('href="', 'href="/design/')).join("\n");
const masterStyles = [...master.querySelectorAll("#t170 style")].map(e => e.outerHTML).join("\n");
for (const id of ["ct170a1", "ct170a2", "ct170a3", "ct170b1", "ct170b2", "ct170b3", "ct170c", "ct170d"]) {
  const frame = master.getElementById(id).cloneNode(true);
  frame.querySelectorAll(".sb,.hi,style").forEach(e => e.remove());
  frame.querySelector(".viewer .vtop")?.setAttribute("style", "padding-top:0");
  frame.style.height = id === "ct170c" ? "1060px" : id === "ct170d" ? "375px" : "797px";
  await writeFile(join(dir, id + ".html"), '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' + masterLinks + masterStyles + '<style>body{margin:0}</style></head><body>' + frame.outerHTML.replaceAll('assets/', '/design/assets/') + '</body></html>');
}
await build({
  stdin: { resolveDir: join(root, "packages/client/src"), loader: "tsx", contents: `
import React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { MemoryRouter, useNavigate } from "react-router";
import { App } from "./App";
import { __applyEventForTest, __setBridgeForTest, __setStateForTest, __connectionStatusForTest } from "./lib/store";
import { cutLayoutFixture } from "../test/cut-layout-fixture";
${styles}
let renderer;
function Navigation(){window.go=useNavigate();return null;}
window.settleLayout=async()=>{await new Promise(r=>setTimeout(r,450));await document.fonts.ready;await Promise.all([...document.images].map(i=>i.decode().catch(()=>{})));for(const a of document.getAnimations()){if(Number.isFinite(a.effect?.getComputedTiming().endTime))a.finish();else{a.pause();a.currentTime=0;}}};
window.mountLayout=async(route="cast",mode="normal")=>{
 renderer?.unmount();const state=cutLayoutFixture(),world=state.world;

 const sheetRefs=Object.fromEntries(world.sheets.map(s=>[s.id,{tiles:6,productions:["saltlight","ledger"],artifacts:["a1","a2"],scenes:["s1","s2"],takesByVersion:{4:2},incomingLinks:[]}]));
 window.commands=[];const bridge={connect(){},send(raw){window.commands.push(JSON.parse(raw));},subscribe(){return()=>{};},coordinatorHttpBase:()=>location.origin};window.arke=mode==="remote"?undefined:bridge;document.querySelector('meta[name="arke-remote"]')?.remove();if(mode==="remote"){const marker=document.createElement("meta");marker.name="arke-remote";marker.content="true";document.head.append(marker);}__setBridgeForTest(bridge);__setStateForTest(state,{sheetRefs});__connectionStatusForTest("open");
 renderer=createRoot(document.getElementById("root"));flushSync(()=>renderer.render(<MemoryRouter initialEntries={["/w/"+world.meta.worldId+"/"+route]}><Navigation/><App/></MemoryRouter>));await window.settleLayout();
};
window.measureLayout=()=>{
 const selectors=[".fy-cut-back",".fy-cutviewer",".fy-cut-clock",".fy-timeline",".fy-timeline__canvas",".fy-cut-tools",".fy-cutside__panel--inspect",".fy-cut-arke-rail",".fy-track__label",".fy-pictlane",".fy-typedlane",".fy-playhead","dialog[open]"];
 const bounds=s=>{const e=document.querySelector(s);if(!e)return null;const b=e.getBoundingClientRect();return{x:b.x,y:b.y,width:b.width,height:b.height};};
 return{viewport:[innerWidth,innerHeight],overflow:document.documentElement.scrollWidth>innerWidth,geometry:Object.fromEntries(selectors.map(s=>[s,bounds(s)]))};
};
` }, bundle:true,platform:"browser",format:"iife",define:{"import.meta.env":"{}"},
  plugins:[{name:"fixture-cascade",setup(build) {
    build.onLoad({filter:/\.(css|tsx?)$/}, async ({path}) => {
      const name=relative(root,path).replaceAll("\\","/");
      const changed=["cut.tsx","editor-audio.tsx","editor-timeline.tsx","editor-gesture.ts","editor-transport.tsx","editor-library.tsx","editor-inspector.tsx","editor-clip-menu.tsx","editor-tracks.tsx","editor-export.tsx","editor-preview.tsx","editor-subtitles.tsx","production-shell.tsx"];
      const old=baseline && changed.some(file=>name==="packages/client/src/screens/"+file);
      let contents=old?execFileSync("git",["show",baselineRef+":"+name],{cwd:root,encoding:"utf8"}):await readFile(path,"utf8");
      if(name==="packages/client/src/screens/cut.tsx")contents=contents.replace("const transport = useCutTransport(filmSec);","const transport = useCutTransport(filmSec); Object.assign(window,{cutTransport:transport});");
      return {loader:path.endsWith(".css")?"css":"tsx",resolveDir:dirname(path),contents:contents.replace(/env\(safe-area-inset-bottom(?:,\s*0px)?\)/g,"var(--smoke-safe-bottom, 0px)")};
    });
  }}],loader:{".woff":"file",".woff2":"file"},outfile:join(dir,"view.js")
});
await writeFile(join(dir,"index.html"), '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="view.css"></head><body><div id="root"></div><script src="view.js"></script></body></html>');
console.log("Cut artifacts: " + dir);
const shotAssets={6:"saltlight-shot15.png",7:"scene4-shot12b-detail.png",12:"scene4-shot12.png",13:"scene4-shot13.png",14:"scene4-shot14.png",15:"scene4-shot15.png"};
for(const [number,asset] of Object.entries(shotAssets))execFileSync("ffmpeg",["-hide_banner","-loglevel","error","-loop","1","-framerate","2","-i",join(root,"design-system/assets",asset),"-t","70","-vf","scale=1280:720:force_original_aspect_ratio=increase,crop=1280:720","-c:v","libx264","-preset","ultrafast","-pix_fmt","yuv420p","-y",join(dir,`shot${number}.mp4`)],{windowsHide:true});
execFileSync("ffmpeg",["-hide_banner","-loglevel","error","-f","lavfi","-i","anullsrc=r=24000:cl=mono","-t","67","-y",join(dir,"fixture.wav")],{windowsHide:true});
const chrome=process.env.ARKE_CHROME ?? (process.platform === "win32" ? "C:/Program Files/Google/Chrome/Application/chrome.exe" : process.platform === "darwin" ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : "/usr/bin/google-chrome");
execFileSync("ffmpeg",["-hide_banner","-loglevel","error","-i",join(dir,"shot12.mp4"),"-frames:v","1","-y",join(dir,"fixture-poster.png")],{windowsHide:true});
await access(chrome);
const server=createServer(async (req,res) => {
  try {
    const path=decodeURIComponent(new URL(req.url,"http://localhost").pathname);
    if(path.startsWith("/media/") && path.includes("missing-candidate")) {res.writeHead(404);res.end();return;}
    const shotNumber=path.match(/cut-shot(\d+)/)?.[1]??12;
    const file=path.startsWith("/media/") && path.endsWith(".mp4") ? join(dir,`shot${shotNumber}.mp4`) : path.startsWith("/media/") && path.endsWith(".wav") ? join(dir,"fixture.wav") : path.startsWith("/media/") && path.includes("cut-shot") ? join(root,"design-system/assets",shotAssets[shotNumber]??shotAssets[12]) : path.startsWith("/media/") && path.includes("layout-take-") ? join(dir,"fixture-poster.png") : path.startsWith("/media/") ? join(root,"design-system/assets",path.includes("head-front") ? "char-maren.png" : path.includes("shot13") ? "scene4-shot13.png" : path.includes("shot15") ? "saltlight-shot15.png" : "scene4-shot12.png") : path.startsWith("/art-styles/") ? join(root,"packages/client/public",path.slice(1)) : path.startsWith("/design/") ? join(root,"design-system",path.slice(8)) : join(dir,path === "/" ? "index.html" : path.slice(1));
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

  const touchDrag=async(points,end)=>{await cdp('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:points});for(let n=1;n<=6;n++)await cdp('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:points.map((p,i)=>({...p,x:p.x+(end[i].x-p.x)*n/6,y:p.y+(end[i].y-p.y)*n/6}))});await cdp('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await js('window.settleLayout()');};
  for(const [name,width,height,touch] of [["phone",390,797,true],["small",360,800,true],["acceptance",375,812,true],["turned",812,375,true],["fold",984,1092,true],["desktop",1360,850,false]]){
    if(only&&name!==only)continue;
    const phone=width<600||height<600;
    await size(width,height,touch);await cdp("Emulation.setTouchEmulationEnabled",{enabled:touch&&!process.argv.includes("--hover")});
    await js('document.documentElement.style.setProperty("--smoke-safe-bottom",'+JSON.stringify(width<600?"20px":"0px")+')');
    await js('window.mountLayout("p/saltlight/cut");');await js('window.cutTransport.seek(21); window.settleLayout()');
    await until(()=>js('[...document.querySelectorAll(".fy-cutviewer video")].filter(v=>v.style.opacity!=="0").every(v=>v.readyState>=2&&!v.seeking)'));
    if(!baseline&&name==='fold')await js('document.querySelector(".fy-timeline__canvas").scrollLeft=304');
    await check(name+'-cut');
    await js('document.querySelector("[data-clip=cl_12]").click()');await check(name+'-picked');
    if(!baseline&&width<1100){
      if(phone){await click('.fy-cut-tools button:nth-child(3)');await check(name+'-trim');await escape();await click('.fy-cut-tools button:last-child');await check(name+'-menu');await escape();await js('document.querySelector(".fy-timeline__canvas").click()');}
      await click('.fy-cut-tools button:first-child');await check(name+'-library');
      if(phone){await click('.fy-artpanel__add');await check(name+'-picker');await escape();await escape();}
      else await click('.fy-artpanel__close');
      if(phone)await click('.fy-cut-back > .ui-btn');else await click('.fy-cuthead > .ui-btn--primary');
      await check(name+'-export');await escape();
      if(phone)await click('.fy-cut-tools button:last-child');else await click('.fy-cut-arke-rail');
      await check(name+'-arke');await escape();
      if(phone&&!process.argv.includes('--hover')){
        const before=await js('window.cutTransport.timeRef.current');
        const box=await js('(()=>{const r=document.querySelector(".fy-pictlane").getBoundingClientRect();return {x:innerWidth*.6,y:r.top+40}})()');
        await touchDrag([{id:0,...box}],[{x:box.x-65,y:box.y}]);
        assert.ok(await js('window.cutTransport.timeRef.current')>before,'lanes scrub under the held playhead');
        const zoomBefore=await js('getComputedStyle(document.querySelector(".fy-cutcols")).getPropertyValue("--cut-zoom")');
        await touchDrag([{id:0,x:90,y:box.y},{id:1,x:200,y:box.y}],[{x:60,y:box.y},{x:240,y:box.y}]);
        assert.ok(Number(await js('getComputedStyle(document.querySelector(".fy-cutcols")).getPropertyValue("--cut-zoom")'))>Number(zoomBefore),'pinch zoom');
        await check(name+'-gestures');
      }
      if(name==='small'){
        await js('window.mountLayout("p/saltlight/cut","remote")');await click('.fy-cut-tools button:first-child');
        assert.equal(await js('document.querySelector(".fy-cut-library-import").disabled'),true);
        await js('document.querySelector(".fy-cut-library-import").click()');
        assert.equal(await js('window.commands.some(m=>m.kind==="upload-artifacts")'),false);
        await check(name+'-remote-library');await escape();
      }
    }
  }
  for(const id of ["ct170a1","ct170a2","ct170a3","ct170b1","ct170b2","ct170b3","ct170c","ct170d"]){await size(id==='ct170c'?984:id==='ct170d'?812:390,id==='ct170c'?1060:id==='ct170d'?375:797,true);await navigate('/'+id+'.html');await capture(id);}
  console.log(JSON.stringify({directory:dir,checks:records.length,baseline:baselineRef}));
}finally{socket?.close();child.kill();await new Promise(r=>server.close(r));}
