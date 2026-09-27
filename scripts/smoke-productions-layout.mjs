import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtemp, readFile, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { spawn, execFileSync } from "node:child_process";
import { parseHTML } from "linkedom";

// Turn 166 against the actual React screens, with the complete client cascade.
// Chrome owns hover/pointer emulation; fixture media stays on a private loopback server.
const root = fileURLToPath(new URL("../", import.meta.url));
const baseline = process.argv.includes("--baseline");
const baselineRef = baseline ? process.argv[process.argv.indexOf("--baseline") + 1] : null;
if (baseline) assert.ok(baselineRef, "--baseline requires a revision");
const dir = await mkdtemp(join(tmpdir(), "arke-productions-"));
const main = await readFile(join(root, "packages/client/src/main.tsx"), "utf8");
const styles = [...main.matchAll(/^import "([^"]+\.css)";/gm)].filter(m => !baseline || !m[1].endsWith("/productions.css")).map(m => m[0]).join("\n");
const { document: master } = parseHTML(await readFile(join(root, "design-system/Arke Studio.dc.html"), "utf8"));
const masterLinks = [...master.querySelectorAll("link[rel=stylesheet]")].map(e => e.outerHTML.replace('href="', 'href="/design/')).join("\n");
const masterStyles = [...master.querySelectorAll("#t166 style")].map(e => e.outerHTML).join("\n");
for (const id of ["pr166a1", "pr166a2", "pr166a3", "pr166b1", "pr166b2", "pr166b3", "pr166c"]) {
  const frame = master.getElementById(id).cloneNode(true);
  frame.querySelectorAll(".sb,.hi,style").forEach(e => e.remove());
  frame.querySelector(".viewer .vtop")?.setAttribute("style", "padding-top:0");
  frame.style.height = id === "pr166c" ? "1060px" : "797px";
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
import { productionsLayoutFixture, episodicLayoutFixture } from "../test/productions-layout-fixture";
${styles}
let renderer;
function Navigation() { window.go = useNavigate(); return null; }
window.settleLayout = async () => { await new Promise(r => setTimeout(r, 700)); await document.fonts.ready; };
window.mountLayout = async (route="productions", mode="normal") => {
  renderer?.unmount();
  const state=mode==="episodic"?episodicLayoutFixture():productionsLayoutFixture(), world=state.world;
  if(mode==="long")for(const p of world.productions){p.meta.title="UnbrokenProductionTitle".repeat(15);p.meta.logline="UnbrokenLogline".repeat(60);}
  if(mode==="dayone"){const p=world.productions[1];p.scenes=[];p.takes=[];p.narrative=null;p.story=null;}
  window.commands=[];window.worldId=world.meta.worldId;window.fixture=state;
  const bridge={connect(){},send(raw){window.commands.push(JSON.parse(raw));},subscribe(){return ()=>{};},coordinatorHttpBase:()=>location.origin};
  window.arke=bridge;__setBridgeForTest(bridge);__setStateForTest(state);__connectionStatusForTest("open");
  renderer=createRoot(document.getElementById("root"));
  flushSync(()=>renderer.render(<MemoryRouter initialEntries={["/w/"+world.meta.worldId+"/"+route]}><Navigation/><App/></MemoryRouter>));
  await window.settleLayout();
};
window.measureLayout=()=>{
  const selectors=[".fy-titlebar",".fy-worldnav",".fy-productions-head",".fy-prodcard",".fy-prodcard__frame",".fy-newprodcard",".fy-production-doors",".fy-door",".fy-production-step__panel",".fy-held-bar",".fy-production-mobile-nav .fy-prodrail__switch",".fy-production-pages",".fy-prodrail",".fy-production-drawer[open]",".fy-prodmain",".fy-h1row",".fy-production-setup-row",".fy-threadcard",".fy-nextcard",".fy-nextcard__frame",".fy-cliprow",".fy-clip__frame",".fy-page-sheet[open]",".fy-page-sheet__foot"];
  const bounds=s=>{const e=document.querySelector(s);if(!e)return null;const b=e.getBoundingClientRect();return {x:b.x,y:b.y,width:b.width,height:b.height};};
  const scrollers=[...document.querySelectorAll(".fy-content,.fy-prodmain,.fy-page-sheet__body,.fy-held-bar")];
  return {viewport:[innerWidth,innerHeight],coarse:matchMedia("(pointer:coarse)").matches,hover:matchMedia("(hover:hover)").matches,
    overflow:document.documentElement.scrollWidth>innerWidth || scrollers.some(e=>e.clientWidth&&e.scrollWidth>e.clientWidth+1),geometry:Object.fromEntries(selectors.map(s=>[s,bounds(s)])),heading:document.querySelector(".fy-h1")?{text:document.querySelector(".fy-h1").textContent,style:getComputedStyle(document.querySelector(".fy-h1")).font,width:document.querySelector(".fy-h1").getBoundingClientRect().width,height:document.querySelector(".fy-h1").getBoundingClientRect().height}:null,
    sideways:scrollers.filter(e=>e.clientWidth&&e.scrollWidth>e.clientWidth+1).map(e=>e.className)};
};
` }, bundle:true,platform:"browser",format:"iife",define:{"import.meta.env":"{}"},
  plugins:[{name:"fixture-cascade",setup(build) {
    build.onLoad({filter:/\.(css|tsx)$/}, async ({path}) => {
      const name=relative(root,path).replaceAll("\\","/");
      const old=baseline && ["packages/client/src/screens/world.tsx","packages/client/src/screens/production-shell.tsx","packages/client/src/screens/production-dashboard.tsx","packages/client/src/screens/development.tsx"].includes(name);
      return {loader:path.endsWith(".css")?"css":"tsx",resolveDir:dirname(path),contents:(old?execFileSync("git",["show",baselineRef+":"+name],{cwd:root,encoding:"utf8"}):await readFile(path,"utf8")).replace(/env\(safe-area-inset-bottom(?:,\s*0px)?\)/g,"var(--smoke-safe-bottom, 0px)")};
    });
  }}],loader:{".woff":"file",".woff2":"file"},outfile:join(dir,"view.js")
});
await writeFile(join(dir,"index.html"), '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="view.css"></head><body><div id="root"></div><script src="view.js"></script></body></html>');
console.log("Productions layout artifacts: " + dir);
const chrome=process.env.ARKE_CHROME ?? (process.platform === "win32" ? "C:/Program Files/Google/Chrome/Application/chrome.exe" : process.platform === "darwin" ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : "/usr/bin/google-chrome");
await access(chrome);
const server=createServer(async (req,res) => {
  try {
    const path=decodeURIComponent(new URL(req.url,"http://localhost").pathname);
    if(path.startsWith("/media/") && path.includes("missing-candidate")) {res.writeHead(404);res.end();return;}
    const file=path.startsWith("/media/") ? join(root,"design-system/assets",path.includes("ledger")?"banner-story.png":path.includes("B2")?"scene4-shot12.png":path.includes("B3")?"scene4-shot13.png":"saltlight-shot15.png") : path.startsWith("/design/") ? join(root,"design-system",path.slice(8)) : path.startsWith("/doors/") || path.startsWith("/video-kinds/") ? join(root,"packages/client/public",path.slice(1)) : join(dir,path === "/" ? "index.html" : path.slice(1));
    assert.ok([dir,join(root,"design-system"),join(root,"packages/client/public")].some(base=>{const rel=relative(base,file);return !rel.startsWith("..") && !isAbsolute(rel);}));
    res.setHeader("Content-Type",file.endsWith(".css")?"text/css":file.endsWith(".js")?"text/javascript":file.endsWith(".html")?"text/html":"application/octet-stream"); res.end(await readFile(file));
  } catch {res.writeHead(404);res.end();}
});
await new Promise(r=>server.listen(0,"127.0.0.1",r));
const origin="http://127.0.0.1:"+server.address().port;
const child=spawn(chrome,["--headless=new","--disable-gpu","--blink-settings=primaryPointerType=4,availablePointerTypes=4,primaryHoverType=2,availableHoverTypes=2","--no-first-run","--no-default-browser-check","--remote-debugging-port=0","--user-data-dir="+join(dir,"profile"),"about:blank"],{windowsHide:true,stdio:"ignore"});
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
  const check=async(name)=>{const m=await js("window.measureLayout()");records.push({name,...m});await writeFile(join(dir,"measurements.json"),JSON.stringify(records,null,2));await capture(name);if(m.overflow)console.log(name,"overflow",m.sideways,await js('Array.from(document.querySelectorAll(".fy-page-sheet__body,.fy-page-sheet__body *")).filter(e=>{const r=e.getBoundingClientRect();return e.scrollWidth>e.clientWidth+1||r.right>innerWidth||r.left<0}).map(e=>({tag:e.tagName,class:e.className,width:e.getBoundingClientRect().width,x:e.getBoundingClientRect().x,sw:e.scrollWidth,cw:e.clientWidth,text:e.textContent.slice(0,80)}))'));if(!baseline && !name.startsWith("desktop-"))assert.equal(m.overflow,false,name+" overflow");return m;};
  const click=async selector=>{const point=await js(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.scrollIntoView({block:"nearest",inline:"nearest"});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);await cdp("Input.dispatchMouseEvent",{type:"mouseMoved",...point});await cdp("Input.dispatchMouseEvent",{type:"mousePressed",button:"left",clickCount:1,...point});await cdp("Input.dispatchMouseEvent",{type:"mouseReleased",button:"left",clickCount:1,...point});await js("window.settleLayout()");};
  const escape=async()=>{await cdp("Input.dispatchKeyEvent",{type:"keyDown",key:"Escape",code:"Escape",windowsVirtualKeyCode:27});await cdp("Input.dispatchKeyEvent",{type:"keyUp",key:"Escape",code:"Escape",windowsVirtualKeyCode:27});await js("window.settleLayout()");};
  for(const [name,width,height,touch] of [["phone",390,797,true],["small",360,800,true],["acceptance",375,812,true],["tablet",600,850,true],["fold",984,1060,true],["fold-full",984,1092,true],["desktop",1360,850,false]]) {
    if(only&&only!==name)continue;
    await size(width,height,touch);await cdp("Emulation.setTouchEmulationEnabled",{enabled:touch});await js(`document.documentElement.style.setProperty("--smoke-safe-bottom","${width<600?20:0}px")`);
    for(const route of ["productions","productions/new","p/saltlight","p/ledger"]){await js(`window.mountLayout(${JSON.stringify(route)})`);await check(name+"-"+route.replaceAll("/","-"));
      if(!baseline && route==="productions") {
        assert.equal(await js('matchMedia("(pointer: coarse)").matches'),touch,"real Chrome pointer band");
        assert.equal(await js('getComputedStyle(document.querySelector(".fy-prodcard")).transform === "none"'),touch,"touch cards stand straight");
      }
    }
    await js('window.mountLayout("productions/new")');await click(".fy-door:nth-child(3)");await check(name+"-step");
    if(!baseline && width<600){assert.ok(await js('!!document.querySelector(".fy-held-bar")'));assert.equal(await js('getComputedStyle(document.querySelector(".fy-held-bar")).paddingBottom'),"34px","held footer includes safe area");}
    await js('window.mountLayout("p/saltlight")');
    if(width<600 && !baseline){await js('document.querySelector(".fy-prodmain").scrollTop=document.querySelector(".fy-cliprow").getBoundingClientRect().top-document.querySelector(".fy-prodmain").getBoundingClientRect().top-74');await check(name+"-latest");await js('document.querySelector(".fy-prodmain").scrollTop=0');}
    await click(".fy-prodrail__switch");await check(name+"-switch");
    if(!baseline && width>=600){assert.equal(await js('document.activeElement===document.querySelector(".fy-switchmenu [role=menuitem]")'),true,"menu opens with focus");await cdp("Input.dispatchKeyEvent",{type:"keyDown",key:"ArrowDown",code:"ArrowDown",windowsVirtualKeyCode:40});assert.equal(await js('document.activeElement===document.querySelectorAll(".fy-switchmenu [role=menuitem]")[1]'),true,"menu arrows work immediately");}
    if(!baseline && width<600)assert.ok(await js('!!document.querySelector(".fy-page-sheet[open]")'));
    if(!baseline && width>=600){await size(width-15,height,touch);await js("window.settleLayout()");assert.ok(await js('!!document.querySelector(".fy-switchmenu,.fy-production-switch-sheet[open]")'),"switch menu survives resize");await size(width,height,touch);}
    await escape();
    if(!baseline && width<1100){await click(".fy-production-setup-row");await check(name+"-settings");await escape();}
    await js('window.mountLayout("p/saltlight", "episodic")');await check(name+"-season");
    if(!baseline && width<1100){assert.equal(await js('document.querySelector(".fy-prodwrap > .fy-arke")'),null);await click(".fy-season-arke");await check(name+"-arke");await escape();}
    if(!baseline && width<1100){await js('window.mountLayout("p/saltlight/episodes/ep_watch-1", "episodic")');assert.equal(await js('!!document.querySelector(".fy-arkewrap > .fy-arke")'),false,"episode dock leaves the side");await click(".fy-season-arke");await check(name+"-episode-arke");await escape();}
    await js('window.mountLayout("p/saltlight", "dayone")');await check(name+"-dayone");
    if(!baseline && width<1100){await js('window.mountLayout("p/saltlight/cut")');assert.equal(await js('document.querySelector(".fy-prodrail--folded")'),null,"touch never gets marks-only rail");if(width>=600){await js('document.querySelector(".fy-production-drawer-toggle").focus()');await click(".fy-production-drawer-toggle");await capture(name+"-drawer");assert.ok(await js('!!document.querySelector(".fy-production-drawer[open]")'));await escape();assert.equal(await js('document.activeElement.classList.contains("fy-production-drawer-toggle")'),true,"drawer restores focus");}else{assert.ok(await js('(()=>{const e=document.querySelector(".fy-production-page--active"),r=e.getBoundingClientRect();return e.textContent==="Cut"&&r.left>=0&&r.right<=innerWidth})()'),"active page scrolls into view");}}
    if(!baseline && width<600){for(const route of ["productions","p/saltlight"]){await js(`window.mountLayout(${JSON.stringify(route)},"long")`);await check(name+"-long-"+route.replaceAll("/","-"));}}
  }
  const masterRecords=[];
  for(const id of ["pr166a1","pr166a2","pr166a3","pr166b1","pr166b2","pr166b3","pr166c"]){await size(id==="pr166c"?984:390,id==="pr166c"?1060:797,true);await navigate("/"+id+".html");await capture(id);masterRecords.push({id,geometry:await js('Object.fromEntries([".bar",".pbar",".strip",".head",".pcard",".pdoor",".switch",".pstrip",".prail",".pmain",".setup",".tcard",".ncard",".clips",".sheet",".sheet .hd",".sheet .bd",".sheet .ft"].map(s=>{const e=document.querySelector(s),r=e?.getBoundingClientRect();return [s,r?{x:r.x,y:r.y,width:r.width,height:r.height}:null]}))')});}
  await writeFile(join(dir,"master-measurements.json"),JSON.stringify(masterRecords,null,2));
  if(!baseline){
    const pairs=[
      ["phone-productions",".fy-prodcard","pr166a1",".pcard",["x","y","width","height"]],
      ["phone-productions-new",".fy-door","pr166a2",".pdoor",["x","y","width","height"]],
      ["phone-p-saltlight",".fy-production-mobile-nav .fy-prodrail__switch","pr166b1",".switch",["x","y","width","height"]],
      ["phone-p-saltlight",".fy-production-setup-row","pr166b1",".setup",["x","y","width","height"]],
      ["phone-switch",".fy-page-sheet[open]","pr166b3",".sheet",["x","y","width","height"]],
      ["phone-switch",".fy-page-sheet__foot","pr166b3",".sheet .ft",["x","y","width","height"]],
      ["fold-p-saltlight",".fy-prodrail","pr166c",".prail",["x","y","width"]],
      ["fold-p-saltlight",".fy-production-setup-row","pr166c",".setup",["x","y","width","height"]],
      ["fold-p-saltlight",".fy-threadcard","pr166c",".tcard",["x","y","width","height"]],
      ["fold-p-saltlight",".fy-nextcard","pr166c",".ncard",["x","y","width","height"]],
      ["fold-p-saltlight",".fy-cliprow","pr166c",".clips",["x","y","width","height"]],
    ];
    for(const [name,selector,id,reference,keys] of pairs){
      const actual=records.find(r=>r.name===name)?.geometry[selector];if(!actual)continue;
      const expected=masterRecords.find(r=>r.id===id).geometry[reference];
      for(const key of keys)assert.ok(Math.abs(actual[key]-expected[key])<=1,`${name} ${selector} ${key}: ${actual[key]} vs master ${expected[key]}`);
    }
  }
  console.log(JSON.stringify({directory:dir,checks:records.length,baseline:baselineRef}));
} finally {socket?.close();child.kill();server.close();}
