import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtemp, readFile, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { spawn, execFileSync } from "node:child_process";
import { parseHTML } from "linkedom";

// Turn 175 against the actual React screens, with the complete client cascade.
// Chrome owns hover/pointer emulation; fixture media stays on a private loopback server.
const root = fileURLToPath(new URL("../", import.meta.url));
const baseline = process.argv.includes("--baseline");
const baselineRef = baseline ? process.argv[process.argv.indexOf("--baseline") + 1] : null;
if (baseline) assert.ok(baselineRef, "--baseline requires a revision");
const dir = await mkdtemp(join(tmpdir(), "arke-settings-"));
const main = await readFile(join(root, "packages/client/src/main.tsx"), "utf8");
const styles = [...main.matchAll(/^import "([^"]+\.css)";/gm)].filter(m => !baseline || !m[1].endsWith("/settings-responsive.css")).map(m => m[0]).join("\n");
const { document: master } = parseHTML(await readFile(join(root, "design-system/Arke Studio.dc.html"), "utf8"));
const masterLinks = [...master.querySelectorAll("link[rel=stylesheet]")].map(e => e.outerHTML.replace('href="', 'href="/design/')).join("\n");
const masterStyles = [...master.querySelectorAll("#t175 style")].map(e => e.outerHTML).join("\n");
for (const id of ["st175a1", "st175a2", "st175a3", "st175b1", "st175b2", "st175b3", "st175c", "st175d"]) {
  const frame = master.getElementById(id).cloneNode(true);
  frame.querySelectorAll(".sb,.hi,style").forEach(e => e.remove());
  frame.querySelector(".viewer .vtop")?.setAttribute("style", "padding-top:0");
  frame.style.height = ["st175c","st175d"].includes(id) ? "1060px" : "797px";
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
import { settingsLayoutFixture, settingsMachineLayoutFixture } from "../test/settings-layout-fixture";
import { __resetActivityPanelForTest, openActivityPanel } from "./lib/activity-panel";
import { __resetSettingsReturnForTest } from "./lib/settings-return";
${styles}
let renderer;window.errors=[];window.addEventListener("error",e=>window.errors.push(e.error?.stack??e.message));window.addEventListener("unhandledrejection",e=>window.errors.push(String(e.reason)));
function Navigation(){window.go=useNavigate();return null;}
window.settleLayout=async()=>{await new Promise(r=>setTimeout(r,450));await document.fonts.ready;await Promise.all([...document.images].map(i=>i.decode().catch(()=>{})));for(const a of document.getAnimations()){if(Number.isFinite(a.effect?.getComputedTiming().endTime))a.finish();else{a.pause();a.currentTime=0;}}};
window.mountLayout=async(route="/settings",remote=true,machine=false)=>{
 renderer?.unmount();__resetActivityPanelForTest();__resetSettingsReturnForTest();const state=machine?settingsMachineLayoutFixture():settingsLayoutFixture(),world=state.world;
 document.querySelector('meta[name="arke-remote"]')?.remove();if(remote){const meta=document.createElement('meta');meta.name="arke-remote";meta.content="true";document.head.append(meta);}
 window.commands=[];const bridge={connect(){},send(raw){window.commands.push(JSON.parse(raw));},subscribe(){return()=>{};},coordinatorHttpBase:()=>location.origin};
 if(remote)delete window.arke;else window.arke=bridge;__setBridgeForTest(bridge);__setStateForTest(state,{setupStatus:state.app.setup});__connectionStatusForTest("open");
 renderer=createRoot(document.getElementById("root"));flushSync(()=>renderer.render(<MemoryRouter initialEntries={["/w/"+world.meta.worldId]}><Navigation/><App/></MemoryRouter>));await window.settleLayout();
 if(route==="activity"){openActivityPanel("inbox");}else if(route==="account"){document.querySelector('[data-account-control]').click();}else{window.go(route);}await window.settleLayout();
};
window.measureLayout=()=>{
 const bounds=s=>{const e=document.querySelector(s);if(!e)return null;const b=e.getBoundingClientRect();return{x:b.x,y:b.y,width:b.width,height:b.height};};
 const pages=[...document.querySelectorAll('.fy-settings__sheet,.fy-settings-phone__content,.fy-page-sheet[open]')];
 return{viewport:[innerWidth,innerHeight],overflow:document.documentElement.scrollWidth>innerWidth || pages.some(e=>e.scrollWidth>e.clientWidth+1),sideways:pages.filter(e=>e.scrollWidth>e.clientWidth+1).map(e=>e.className),geometry:Object.fromEntries(["dialog[open]",".fy-settings__sheet",".fy-settings__rail",".fy-cols__list",".fy-provider-model",".fy-ap",".fy-ap__close",".fy-seg__item",".fy-account__menu"].map(s=>[s,bounds(s)]))};
};
` }, bundle:true,platform:"browser",format:"iife",define:{"import.meta.env":"{}"},
  plugins:[{name:"fixture-cascade",setup(build) {
    build.onLoad({filter:/\.(css|tsx?)$/}, async ({path}) => {
      const name=relative(root,path).replaceAll("\\","/");
      const old=baseline && ["App.tsx","components/chrome.tsx","components/page-sheet.tsx","components/account-menu.tsx","components/activity-panel.tsx","components/queue-toaster.tsx","lib/store.ts","screens/shell.tsx","screens/settings-providers.tsx","screens/settings-models.tsx","screens/settings-remote-access.tsx"].some(p=>name==="packages/client/src/"+p);
      return {loader:path.endsWith(".css")?"css":"tsx",resolveDir:dirname(path),contents:(old?execFileSync("git",["show",baselineRef+":"+name],{cwd:root,encoding:"utf8"}):await readFile(path,"utf8")).replace(/env\(safe-area-inset-bottom(?:,\s*0px)?\)/g,"var(--smoke-safe-bottom, 0px)")};
    });
  }}],loader:{".woff":"file",".woff2":"file"},outfile:join(dir,"view.js")
});
await writeFile(join(dir,"index.html"), '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="view.css"></head><body><div id="root"></div><script src="view.js"></script></body></html>');
console.log("Settings artifacts: " + dir);
const chrome=process.env.ARKE_CHROME ?? (process.platform === "win32" ? "C:/Program Files/Google/Chrome/Application/chrome.exe" : process.platform === "darwin" ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : "/usr/bin/google-chrome");
await access(chrome);
const server=createServer(async (req,res) => {
  try {
    const path=decodeURIComponent(new URL(req.url,"http://localhost").pathname);
    if(path.startsWith("/media/") && path.includes("missing-candidate")) {res.writeHead(404);res.end();return;}
    if(path==="/remote/device"){res.setHeader("Content-Type","application/json");res.end(JSON.stringify({name:"Chrome on Android",pairedAt:Date.parse("2026-09-25T12:00:00Z"),expiresAt:Date.parse("2026-10-25T12:00:00Z")}));return;}
    const file=path.startsWith("/media/") && path.endsWith(".mp4") ? join(dir,"fixture.mp4") : path.startsWith("/media/") && path.includes("layout-take-") ? join(dir,"fixture-poster.png") : path.startsWith("/media/") ? join(root,"design-system/assets",path.includes("head-front") ? "char-maren.png" : path.includes("shot13") ? "scene4-shot13.png" : path.includes("shot15") ? "saltlight-shot15.png" : "scene4-shot12.png") : (path.startsWith("/art-styles/") || path.startsWith("/marks/") || path === "/notification-worker.js") ? join(root,"packages/client/public",path.slice(1)) : path.startsWith("/design/") ? join(root,"design-system",path.slice(8)) : join(dir,path === "/" ? "index.html" : path.slice(1));
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
  const click=async selector=>{const point=await js(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});let r=e.getBoundingClientRect();if(r.top<0||r.bottom>innerHeight){e.scrollIntoView({block:"center",inline:"nearest"});r=e.getBoundingClientRect();}return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);await cdp("Input.dispatchMouseEvent",{type:"mouseMoved",...point});await cdp("Input.dispatchMouseEvent",{type:"mousePressed",button:"left",clickCount:1,...point});await cdp("Input.dispatchMouseEvent",{type:"mouseReleased",button:"left",clickCount:1,...point});await js("window.settleLayout()");};
  const escape=async()=>{await cdp("Input.dispatchKeyEvent",{type:"keyDown",key:"Escape",code:"Escape",windowsVirtualKeyCode:27});await cdp("Input.dispatchKeyEvent",{type:"keyUp",key:"Escape",code:"Escape",windowsVirtualKeyCode:27});await js("window.settleLayout()");};




  for(const [name,width,height,touch] of [["phone",390,797,true],["small",360,800,true],["acceptance",375,812,true],["fold",984,1092,true],["desktop",1360,850,false]]) {
    if(only&&name!==only)continue;
    await size(width,height,touch);await cdp("Emulation.setTouchEmulationEnabled",{enabled:!process.argv.includes("--hover")});
    await js('document.documentElement.style.setProperty("--smoke-safe-bottom",'+JSON.stringify(width<600?"20px":"0px")+')');
    const remote = width < 1100 || process.argv.includes("--remote");
    for(const [label,route] of [["sections","/settings"],["providers","/settings/providers"],["provider","/settings/providers?provider=fal"],["general","/settings/general"],["models","/settings/models"],["remote","/settings/remote-access"],["activity","activity"],["account","account"]]) {
      await js('window.mountLayout('+JSON.stringify(route)+','+remote+')');await check(name+'-'+label);const errors=await js("window.errors");assert.deepEqual(errors,[],JSON.stringify(errors));assert.ok(await js('Array.from(document.images).filter(e=>e.getBoundingClientRect().width>0).every(e=>e.complete&&e.naturalWidth>0)'),label+' images loaded');
      if(baseline)continue;
      if(width<600){assert.ok(await js('!!document.querySelector("dialog[open]")'),label+' sheet');
        if(label==='sections'){await click('.fy-settings-sections a[href="/settings/about"]');assert.equal(await js('document.querySelector(".fy-page-sheet__body").scrollTop'),0);assert.ok(await js('document.activeElement===document.querySelector("dialog h2")'));await click('dialog [aria-label="Back"]');await click('.fy-settings-sections a[href="/settings/providers"]');assert.equal(await js('document.querySelector("dialog h2").textContent'),'Providers');await click('dialog [aria-label="Back"]');assert.equal(await js('document.querySelector("dialog h2").textContent'),'Settings');}
        if(label==='providers'){assert.equal(await js('getComputedStyle(document.querySelector(".fy-cols__pane")).display'),'none');await click('.fy-provider-row .fy-src');assert.equal(await js('getComputedStyle(document.querySelector(".fy-cols__list")).display'),'none');await click('dialog [aria-label="Back"]');assert.equal(await js('getComputedStyle(document.querySelector(".fy-cols__pane")).display'),'none');}
        if(label==='general')assert.ok(await js('Array.from(document.querySelectorAll(".ui-select__control")).every(e=>e.getBoundingClientRect().height>=44)'));
      }
      if(label==='provider' && remote){assert.equal(await js('document.querySelectorAll("input[type=password]").length'),0);assert.equal(await js('document.body.textContent.includes("NEVER-RENDER")'),false);}
      if(label==='provider' && width<1100){assert.equal(await js('!!document.querySelector("input[type=password]")'),false);assert.equal(await js('document.body.textContent.includes("NEVER-RENDER")'),false);
        assert.deepEqual(await js('(()=>{const r=document.querySelector(".fy-provider-state [role=switch]").getBoundingClientRect();return [r.width,r.height]})()'),[44,26]);
        if(width>=900)assert.ok(await js('(()=>{const [a,b]=Array.from(document.querySelectorAll(".fy-provider-model"),e=>e.getBoundingClientRect());return a.y===b.y&&b.x>a.right})()'),'two Fold model cards across');
        await click('.fy-provider-model [role=switch]');assert.equal(await js('window.commands.at(-1).kind'),'set-model-enabled');}
      if(label==='activity'&&width>=600&&width<1100){assert.equal(await js('document.querySelector(".fy-ap").getBoundingClientRect().top'),52);assert.equal(await js('document.querySelector(".fy-ap__close").getBoundingClientRect().height'),44);
        await cdp('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:30,y:250}]});await cdp('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:30,y:180}]});await cdp('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
        // Let Chrome deliver the swipe's deferred scroll before starting the separate tap.
        await js('window.settleLayout()');assert.ok(await js('!!document.querySelector(".fy-ap")'));
        await cdp('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:30,y:250}]});await cdp('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await js('window.settleLayout()');assert.equal(await js('!!document.querySelector(".fy-ap")'),false);
      }
      if(label==='activity'&&width<600){await js('document.querySelector(".fy-ap__body").scrollTop=300;document.querySelector('+JSON.stringify('.fy-ap [aria-label="Provider calls"]')+').click()');await js('window.settleLayout()');
        assert.equal(await js('document.querySelector(".fy-ap__body").scrollTop'),0);assert.ok(await js('document.activeElement===document.querySelector(".fy-activity-phone header [aria-label=Back]")'));
        await check(name+'-activity-calls');await click('.fy-activity-phone header [aria-label="Back"]');assert.equal(await js('document.querySelector(".fy-ap__body").scrollTop'),0);
      }
      if(label==='remote'&&remote){const text=await js('document.querySelector(".fy-paired-device").textContent');assert.match(text,/Chrome on Android/);assert.doesNotMatch(text,/Revoke|Approve|Pair a device/);}
    }
    if(!baseline && remote){for(const slug of ['harness','sign-in','notifications','about','appearance','adapters','diagnostics','sample-world']){await js('window.mountLayout("/settings/'+slug+'",true)');await check(name+'-'+slug);assert.equal(await js('document.querySelectorAll("input[type=password]").length'),0);}
      for(const [label,route] of [['downloads','/settings/downloads'],['local-models','/settings/models?model=gemma4-12b']]){await js('window.mountLayout('+JSON.stringify(route)+',true,true)');await check(name+'-'+label);assert.ok(await js('document.querySelector(".fy-set__row--stack").textContent.includes("On your PC")'));
        if(width<600 && label==='downloads'){assert.equal(await js('document.querySelector("dialog h2").textContent'),'Downloads');await click('dialog [aria-label="Back"]');assert.equal(await js('document.querySelector("dialog h2").textContent'),'Providers');}
        if(width<600 && label==='local-models')assert.ok(await js('(()=>{const r=document.querySelector(".fy-set__link[aria-expanded]").getBoundingClientRect();return r.width>=44 && r.height>=44})()'));
      }
    }
  }
  const masterRecords=[];
  for(const id of ["st175a1","st175a2","st175a3","st175b1","st175b2","st175b3","st175c","st175d"]){const fold=["st175c","st175d"].includes(id);await size(fold?984:390,fold?1060:797,true);await navigate('/'+id+'.html');await capture(id);masterRecords.push({id,geometry:await js('Object.fromEntries([".sheet",".sdlg",".srail",".slist",".sdet",".mtile",".apanel",".seg3"].map(s=>{const e=document.querySelector(s),r=e?.getBoundingClientRect();return[s,r?{x:r.x,y:r.y,width:r.width,height:r.height}:null]}))')});}
  await writeFile(join(dir,'master-measurements.json'),JSON.stringify(masterRecords,null,2));
  console.log(JSON.stringify({directory:dir,checks:records.length,baseline:baselineRef}));
}finally{socket?.close();child.kill();await new Promise(r=>server.close(r));}
