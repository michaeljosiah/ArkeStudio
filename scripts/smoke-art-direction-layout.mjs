import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtemp, readFile, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { spawn, execFileSync } from "node:child_process";
import { parseHTML } from "linkedom";

// Turn 167 against the actual React screens, with the complete client cascade.
// Chrome owns hover/pointer emulation; fixture media stays on a private loopback server.
const root = fileURLToPath(new URL("../", import.meta.url));
const baseline = process.argv.includes("--baseline");
const baselineRef = baseline ? process.argv[process.argv.indexOf("--baseline") + 1] : null;
if (baseline) assert.ok(baselineRef, "--baseline requires a revision");
const dir = await mkdtemp(join(tmpdir(), "arke-art-direction-"));
const main = await readFile(join(root, "packages/client/src/main.tsx"), "utf8");
const styles = [...main.matchAll(/^import "([^"]+\.css)";/gm)].filter(m => !baseline || !m[1].endsWith("/art-direction.css")).map(m => m[0]).join("\n");
const { document: master } = parseHTML(await readFile(join(root, "design-system/Arke Studio.dc.html"), "utf8"));
const masterLinks = [...master.querySelectorAll("link[rel=stylesheet]")].map(e => e.outerHTML.replace('href="', 'href="/design/')).join("\n");
const masterStyles = [...master.querySelectorAll("#t167 style")].map(e => e.outerHTML).join("\n");
for (const id of ["ad167a1", "ad167a2", "ad167b1", "ad167b2", "ad167b3", "ad167c", "ad167d"]) {
  const frame = master.getElementById(id).cloneNode(true);
  frame.querySelectorAll(".sb,.hi,style").forEach(e => e.remove());
  frame.querySelector(".viewer .vtop")?.setAttribute("style", "padding-top:0");
  frame.style.height = ["ad167c","ad167d"].includes(id) ? "1060px" : "797px";
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
import { artDirectionLayoutFixture } from "../test/art-direction-layout-fixture";
${styles}
let renderer;
function Navigation(){window.go=useNavigate();return null;}
window.settleLayout=async()=>{await new Promise(r=>setTimeout(r,450));await document.fonts.ready;await Promise.all([...document.images].map(i=>i.decode().catch(()=>{})));for(const a of document.getAnimations()){if(Number.isFinite(a.effect?.getComputedTiming().endTime))a.finish();else{a.pause();a.currentTime=0;}}};
window.mountLayout=async(route="cast",mode="normal")=>{
 renderer?.unmount();const state=artDirectionLayoutFixture(mode),world=state.world;
 
 const sheetRefs=Object.fromEntries(world.sheets.map(s=>[s.id,{tiles:6,productions:["saltlight","ledger"],artifacts:["a1","a2"],scenes:["s1","s2"],takesByVersion:{4:2},incomingLinks:[]}]));
 window.commands=[];const bridge={connect(){},send(raw){window.commands.push(JSON.parse(raw));},subscribe(){return()=>{};},coordinatorHttpBase:()=>location.origin};window.arke=bridge;__setBridgeForTest(bridge);__setStateForTest(state,{sheetRefs});__connectionStatusForTest("open");
 renderer=createRoot(document.getElementById("root"));flushSync(()=>renderer.render(<MemoryRouter initialEntries={["/w/"+world.meta.worldId+"/"+route]}><Navigation/><App/></MemoryRouter>));await window.settleLayout();
};
window.measureLayout=()=>{
 const selectors=[".fy-artdirection",".fy-artdirection__pictures",".fy-artpicture",".fy-artdirection__master",".fy-artdirection__detail",".fy-artdirection__keyart",".fy-artdirection__history",".fy-artproposal",".fy-artproposal__ripple",".fy-artproposal__foot",".fy-artproposal__previews",".fy-gendialog[open]",".fy-gendialog[open] .fy-gendialog__previews",".fy-gendialog[open] .fy-gendialog__compose",".fy-titlebar",".fy-worldnav",".fy-sheetkinds",".fy-cast-mobile-head",".fy-feature",".fy-feature__frame",".fy-ledger",".fy-ledger .fy-row",".fy-kind-head",".fy-kind-grid",".fy-kind-grid .fy-gridcard",".fy-kind-grid .fy-gridcard__frame",".fy-sheet",".fy-sheet__header",".fy-character-overview-tabs",".fy-sheet__side",".fy-designcard",".fy-designcard__frame",".fy-overview-sheet",".fy-sheet__main",".fy-sheet__actions",".fy-voicecard",".fy-sheet__grid",".fy-props-grid"];
 const bounds=s=>{const e=document.querySelector(s);if(!e)return null;const b=e.getBoundingClientRect();return{x:b.x,y:b.y,width:b.width,height:b.height};};const page=document.querySelector(".fy-content");
 return{viewport:[innerWidth,innerHeight],overflow:document.documentElement.scrollWidth>innerWidth || !!(page&&page.scrollWidth>page.clientWidth+1),sideways:[...document.querySelectorAll('.fy-content,.fy-sheet,.fy-split')].filter(e=>e.scrollWidth>e.clientWidth+1).map(e=>e.className),geometry:Object.fromEntries(selectors.map(s=>[s,bounds(s)]))};
};
` }, bundle:true,platform:"browser",format:"iife",define:{"import.meta.env":"{}"},
  plugins:[{name:"fixture-cascade",setup(build) {
    build.onLoad({filter:/\.(css|tsx)$/}, async ({path}) => {
      const name=relative(root,path).replaceAll("\\","/");
      const old=baseline && ["packages/client/src/screens/art-direction.tsx","packages/client/src/screens/character-pages.css","packages/client/src/components/generation-dialog.tsx"].includes(name);
      return {loader:path.endsWith(".css")?"css":"tsx",resolveDir:dirname(path),contents:(old?execFileSync("git",["show",baselineRef+":"+name],{cwd:root,encoding:"utf8"}):await readFile(path,"utf8")).replace(/env\(safe-area-inset-bottom(?:,\s*0px)?\)/g,"var(--smoke-safe-bottom, 0px)")};
    });
  }}],loader:{".woff":"file",".woff2":"file"},outfile:join(dir,"view.js")
});
await writeFile(join(dir,"index.html"), '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="view.css"></head><body><div id="root"></div><script src="view.js"></script></body></html>');
console.log("Art direction artifacts: " + dir);
const chrome=process.env.ARKE_CHROME ?? (process.platform === "win32" ? "C:/Program Files/Google/Chrome/Application/chrome.exe" : process.platform === "darwin" ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : "/usr/bin/google-chrome");
await access(chrome);
const server=createServer(async (req,res) => {
  try {
    const path=decodeURIComponent(new URL(req.url,"http://localhost").pathname);
    if(path.startsWith("/media/") && path.includes("missing-candidate")) {res.writeHead(404);res.end();return;}
    const file=path.startsWith("/media/") ? join(root,"design-system/assets",path.includes("master-look") || path.includes("preview-") ? "art-direction-world.png" : "world-undersong.png") : path.startsWith("/art-styles/") ? join(root,"packages/client/public",path.slice(1)) : path.startsWith("/design/") ? join(root,"design-system",path.slice(8)) : join(dir,path === "/" ? "index.html" : path.slice(1));
    assert.ok([dir,join(root,"design-system"),join(root,"packages/client/public")].some(base=>{const rel=relative(base,file);return !rel.startsWith("..") && !isAbsolute(rel);}));
    res.setHeader("Content-Type",file.endsWith(".svg")?"image/svg+xml":file.endsWith(".css")?"text/css":file.endsWith(".js")?"text/javascript":file.endsWith(".html")?"text/html":"application/octet-stream"); res.end(await readFile(file));
  } catch {res.writeHead(404);res.end();}
});
await new Promise(r=>server.listen(0,"127.0.0.1",r));
const origin="http://127.0.0.1:"+server.address().port;
const child=spawn(chrome,["--headless=new","--disable-gpu",process.argv.includes("--hover") ? "--blink-settings=primaryPointerType=4,availablePointerTypes=4,primaryHoverType=2,availableHoverTypes=2" : "--blink-settings=primaryPointerType=2,availablePointerTypes=2,primaryHoverType=0,availableHoverTypes=0","--no-first-run","--no-default-browser-check","--remote-debugging-port=0","--user-data-dir="+join(dir,"profile"),"about:blank"],{windowsHide:true,stdio:"ignore"});
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
  const check=async(name)=>{const m=await js("window.measureLayout()");records.push({name,...m});await writeFile(join(dir,"measurements.json"),JSON.stringify(records,null,2));await capture(name);if(m.overflow)console.log(name,"overflow",m.sideways,await js('Array.from(document.querySelectorAll(".fy-content *")).filter(e=>{const r=e.getBoundingClientRect();return e.scrollWidth>e.clientWidth+1||r.right>innerWidth||r.left<0}).map(e=>({tag:e.tagName,class:e.className,width:e.getBoundingClientRect().width,x:e.getBoundingClientRect().x,sw:e.scrollWidth,cw:e.clientWidth,text:e.textContent.slice(0,80)}))'));if(!baseline && !name.startsWith("desktop-"))assert.equal(m.overflow,false,name+" overflow");return m;};
  const click=async selector=>{const point=await js(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.scrollIntoView({block:"center",inline:"nearest"});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);await cdp("Input.dispatchMouseEvent",{type:"mouseMoved",...point});await cdp("Input.dispatchMouseEvent",{type:"mousePressed",button:"left",clickCount:1,...point});await cdp("Input.dispatchMouseEvent",{type:"mouseReleased",button:"left",clickCount:1,...point});await js("window.settleLayout()");};
  const escape=async()=>{await cdp("Input.dispatchKeyEvent",{type:"keyDown",key:"Escape",code:"Escape",windowsVirtualKeyCode:27});await cdp("Input.dispatchKeyEvent",{type:"keyUp",key:"Escape",code:"Escape",windowsVirtualKeyCode:27});await js("window.settleLayout()");};


  for(const [name,width,height,touch] of [["phone",390,797,true],["small",360,800,true],["acceptance",375,812,true],["tablet",600,850,true],["fold",984,1060,true],["fold-full",984,1092,true],["edge",1100,850,false],["desktop",1360,850,false]]){
   if(only&&only!==name)continue;
   await js('document.documentElement.style.setProperty("--smoke-safe-bottom",'+JSON.stringify(width<600?"20px":"0px")+')');await size(width,height,touch);await cdp("Emulation.setTouchEmulationEnabled",{enabled:!process.argv.includes("--hover")});
   for(const [label,route,mode] of [["tab","art-direction","normal"],["empty","art-direction","empty"],["long","art-direction","long"],["draft","art-direction/propose","normal"],["staged","art-direction/propose","staged"]]){
    await cdp("Input.dispatchMouseEvent",{type:"mouseMoved",x:0,y:0});
    await js('window.mountLayout('+JSON.stringify(route)+','+JSON.stringify(mode)+')');await check(name+'-'+label);
    if(!baseline && label==="tab") {
      const doors=await js('Array.from(document.querySelectorAll(".fy-artdirection__hover")).map(e=>({pointer:getComputedStyle(e).pointerEvents,opacity:getComputedStyle(e).opacity,y:e.getBoundingClientRect().y,frameBottom:e.parentElement.querySelector(".fy-artdirection__master,.fy-artdirection__keyart")?.getBoundingClientRect().bottom}))');
      for(const door of doors) if(process.argv.includes("--hover")) assert.equal(door.pointer,"none"); else {assert.equal(door.opacity,"1");assert.equal(door.pointer,"auto");assert.ok(door.y>=door.frameBottom);}
      if(width<600){await js('document.querySelector(".fy-content").scrollTop=document.querySelector(".fy-artdirection__detail").getBoundingClientRect().top-109');await check(name+'-words');await click('.fy-artdirection__models-row');await check(name+'-models');await escape();}
      await click('.fy-artdirection__hover button');if(!baseline)await click('dialog[open] .fy-gendialog__previews-grid button');await check(name+'-generate');
      if(width<600){const first=await js('document.querySelector("dialog[open] .fy-gendialog__previews").getBoundingClientRect().top<document.querySelector("dialog[open] .fy-gendialog__compose").getBoundingClientRect().top');assert.ok(first,"previews precede words");}
      await escape();
    }
    if(!baseline && width<600 && (label==="draft"||label==="staged")) {
      assert.ok(await js('document.querySelector(".fy-artproposal__foot").getBoundingClientRect().bottom<=innerHeight+1'));
      assert.ok(await js('document.querySelector(".fy-artproposal__foot").textContent.includes('+JSON.stringify(label==='draft'?'Set the look':'Accept · world look')+')'));
    }
   }
   if(!baseline && width<600) {
    await js('window.mountLayout("art-direction","wide")');
    assert.equal(await js('getComputedStyle(document.querySelector(".fy-artdirection__detail h1")).webkitLineClamp'),"none");
    await js('document.querySelector(".fy-artdirection__detail").scrollIntoView({block:"start"})');await check(name+'-wide-title');
    await click('.fy-artdirection__history');await check(name+'-history');
    assert.ok(await js('document.querySelector("dialog[open]").textContent.includes("Remaining visual guidance")'));await escape();
   }
   if(!baseline && width===1100) {
    await js('window.mountLayout("art-direction")');
    assert.ok(await js('(()=>{const master=document.querySelector(".fy-artdirection__master"),pictures=document.querySelector(".fy-artdirection__pictures");return Math.abs(master.getBoundingClientRect().width-pictures.getBoundingClientRect().width)<2})()'));
   }
  }
  const masterRecords=[];
  for(const id of ["ad167a1","ad167a2","ad167b1","ad167b2","ad167b3","ad167c","ad167d"]){const fold=["ad167c","ad167d"].includes(id);await size(fold?984:390,fold?1060:797,true);await navigate('/'+id+'.html');await capture(id);masterRecords.push({id,geometry:await js('Object.fromEntries([".pic",".pic .fr",".pic .cap",".doors",".adrow",".addet",".hrow",".gtop",".gmain",".gside",".prev2",".rip",".gp"].map(s=>{const e=document.querySelector(s),r=e?.getBoundingClientRect();return[s,r?{x:r.x,y:r.y,width:r.width,height:r.height}:null]}))')});}
  await writeFile(join(dir,'master-measurements.json'),JSON.stringify(masterRecords,null,2));
  console.log(JSON.stringify({directory:dir,checks:records.length,baseline:baselineRef}));
}finally{socket?.close();child.kill();await new Promise(r=>server.close(r));}
