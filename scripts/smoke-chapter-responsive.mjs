import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtemp, readFile, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { spawn, execFileSync } from "node:child_process";
import { parseHTML } from "linkedom";

// Turn 173 against the actual React screens, with the complete client cascade.
// Chrome owns hover/pointer emulation; fixture media stays on a private loopback server.
const root = fileURLToPath(new URL("../", import.meta.url));
const baseline = process.argv.includes("--baseline");
const baselineRef = baseline ? process.argv[process.argv.indexOf("--baseline") + 1] : null;
if (baseline) assert.ok(baselineRef, "--baseline requires a revision");
const dir = await mkdtemp(join(tmpdir(), "arke-chapter-"));
const main = await readFile(join(root, "packages/client/src/main.tsx"), "utf8");
const styles = [...main.matchAll(/^import "([^"]+\.css)";/gm)].filter(m => !baseline || !m[1].endsWith("/chapter-responsive.css")).map(m => m[0]).join("\n");
const { document: master } = parseHTML(await readFile(join(root, "design-system/Arke Studio.dc.html"), "utf8"));
const masterLinks = [...master.querySelectorAll("link[rel=stylesheet]")].map(e => e.outerHTML.replace('href="', 'href="/design/')).join("\n");
const masterStyles = [...master.querySelectorAll("#t173 style, #t165 style")].map(e => e.outerHTML).join("\n");
for (const id of ["ch173a1", "ch173a2", "ch173a3", "ch173b1", "ch173b2", "ch173b3", "ch173c", "ch173d", "vs165l", "vs165m"]) {
  const frame = master.getElementById(id).cloneNode(true);
  frame.querySelectorAll(".sb,.hi,style").forEach(e => e.remove());
  frame.querySelector(".viewer .vtop")?.setAttribute("style", "padding-top:0");
  frame.style.height = ["ch173c","ch173d"].includes(id) ? "1060px" : "797px";
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
import { chapterLayoutFixture, CHAPTER_BODY, CHAPTER_HASH, chapterDoor } from "../test/chapter-layout-fixture";
${styles}
let renderer;
function Navigation(){window.go=useNavigate();return null;}
window.settleLayout=async()=>{await new Promise(r=>setTimeout(r,450));await document.fonts.ready;await Promise.all([...document.images].map(i=>i.decode().catch(()=>{})));for(const a of document.getAnimations()){if(Number.isFinite(a.effect?.getComputedTiming().endTime))a.finish();else{a.pause();a.currentTime=0;}}};
window.mountLayout=async(route="cast",mode="normal")=>{
 renderer?.unmount();const state=chapterLayoutFixture(mode),world=state.world;

 const sheetRefs=Object.fromEntries(world.sheets.map(s=>[s.id,{tiles:6,productions:["saltlight","ledger"],artifacts:["a1","a2"],scenes:["s1","s2"],takesByVersion:{4:2},incomingLinks:[]}]));
 window.commands=[];const bridge={connect(){},send(raw){const m=JSON.parse(raw);window.commands.push(m);
 if(m.kind==='open-chapter')setTimeout(()=>__applyEventForTest({type:'chapter.open-result',at:'2026-09-28T14:00:00Z',requestId:m.requestId,worldId:m.worldId,productionId:m.productionId,chapterId:m.chapterId,disposition:'opened',body:mode==='source'?CHAPTER_BODY+"\\n\\n<br>":CHAPTER_BODY,version:4,hash:CHAPTER_HASH,versions:[3,2],voices:{version:4,hash:CHAPTER_HASH,derivedAt:'2026-09-28T14:00:00Z',passes:1,dropped:0,omitted:0,lines:[]}}),5);
 if(m.kind==='voice-catalogue')setTimeout(()=>__applyEventForTest({type:'voice.catalogue',at:'2026-09-28T14:00:00Z',worldId:m.worldId,voices:[{provider:'kokoro',model:'kokoro-82m',voiceId:'bm_george',label:'George',attributes:['British'],local:true,canClone:false,usedBy:[]},{provider:'kokoro',model:'kokoro-82m',voiceId:'af_bella',label:'Bella',attributes:[],local:true,canClone:false,usedBy:[]}]}),5);
 if(m.kind==='open-audiobook')setTimeout(()=>__applyEventForTest({type:'audiobook.door',at:'2026-09-28T14:00:00Z',requestId:m.requestId,worldId:m.worldId,productionId:m.productionId,door:chapterDoor()}),5);
},subscribe(){return()=>{};},coordinatorHttpBase:()=>location.origin};window.arke=bridge;__setBridgeForTest(bridge);__setStateForTest(state,{sheetRefs});__connectionStatusForTest("open");
 renderer=createRoot(document.getElementById("root"));flushSync(()=>renderer.render(<MemoryRouter initialEntries={["/w/"+world.meta.worldId+"/"+route]}><Navigation/><App/></MemoryRouter>));await window.settleLayout();
};
window.measureLayout=()=>{
 const selectors=[".fy-prodrail",".fy-chapter-card",".fy-ch__prose",".fy-rme__doc",".fy-ch__body",".fy-sw__centre",".fy-ch__panels",".fy-season-arke-rail",".fy-ch__viewline",".fy-passage-ask",".fy-ab__blocks","dialog[open]"];
 const bounds=s=>{const e=document.querySelector(s);if(!e)return null;const b=e.getBoundingClientRect();return{x:b.x,y:b.y,width:b.width,height:b.height};};
 const pages=[...document.querySelectorAll('.fy-prodmain,.fy-sw__centre,.fy-page-sheet[open],.fy-passage-ask')];
 return{viewport:[innerWidth,innerHeight],overflow:document.documentElement.scrollWidth>innerWidth || pages.some(e=>e.scrollWidth>e.clientWidth+1),sideways:pages.filter(e=>e.scrollWidth>e.clientWidth+1).map(e=>e.className),geometry:Object.fromEntries(selectors.map(s=>[s,bounds(s)]))};
};
` }, bundle:true,platform:"browser",format:"iife",define:{"import.meta.env":"{}"},
  plugins:[{name:"fixture-cascade",setup(build) {
    build.onLoad({filter:/\.(css|tsx?)$/}, async ({path}) => {
      const name=relative(root,path).replaceAll("\\","/");
      const old=baseline && ["packages/client/src/screens/production-shell.tsx","packages/client/src/screens/production-story.tsx","packages/client/src/screens/chapter-workspace.tsx","packages/client/src/screens/chapter-audiobook.tsx","packages/client/src/screens/audiobook.tsx"].includes(name);
      return {loader:path.endsWith(".css")?"css":"tsx",resolveDir:dirname(path),contents:(old?execFileSync("git",["show",baselineRef+":"+name],{cwd:root,encoding:"utf8"}):await readFile(path,"utf8")).replace(/env\(safe-area-inset-bottom(?:,\s*0px)?\)/g,"var(--smoke-safe-bottom, 0px)")};
    });
  }}],loader:{".woff":"file",".woff2":"file"},outfile:join(dir,"view.js")
});
await writeFile(join(dir,"index.html"), '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="view.css"></head><body><div id="root"></div><script src="view.js"></script></body></html>');
console.log("Chapter artifacts: " + dir);
const chrome=process.env.ARKE_CHROME ?? (process.platform === "win32" ? "C:/Program Files/Google/Chrome/Application/chrome.exe" : process.platform === "darwin" ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : "/usr/bin/google-chrome");
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
  const click=async selector=>{const point=await js(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});let r=e.getBoundingClientRect();if(r.top<0||r.bottom>innerHeight){e.scrollIntoView({block:"center",inline:"nearest"});r=e.getBoundingClientRect();}return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);await cdp("Input.dispatchMouseEvent",{type:"mouseMoved",...point});await cdp("Input.dispatchMouseEvent",{type:"mousePressed",button:"left",clickCount:1,...point});await cdp("Input.dispatchMouseEvent",{type:"mouseReleased",button:"left",clickCount:1,...point});await js("window.settleLayout()");};
  const escape=async()=>{await cdp("Input.dispatchKeyEvent",{type:"keyDown",key:"Escape",code:"Escape",windowsVirtualKeyCode:27});await cdp("Input.dispatchKeyEvent",{type:"keyUp",key:"Escape",code:"Escape",windowsVirtualKeyCode:27});await js("window.settleLayout()");};




  const key=async key=>{await cdp("Input.dispatchKeyEvent",{type:"keyDown",key,code:key,windowsVirtualKeyCode:key==='ArrowRight'?39:37});await cdp("Input.dispatchKeyEvent",{type:"keyUp",key,code:key});await js("window.settleLayout()");};

  const change=async(selector,value)=>{await js('(()=>{const e=document.querySelector('+JSON.stringify(selector)+');Object.getOwnPropertyDescriptor(e.tagName==="SELECT"?HTMLSelectElement.prototype:HTMLInputElement.prototype,"value").set.call(e,'+JSON.stringify(value)+');e.dispatchEvent(new Event(e.tagName==="SELECT"?"change":"input",{bubbles:true}));})()');await js('window.settleLayout()');};
  for(const [name,width,height,touch] of [["phone",390,797,true],["small",360,800,true],["acceptance",375,812,true],["fold",984,1092,true],["desktop",1360,850,false]]) {
    if(only&&name!==only)continue;
    await size(width,height,touch);await cdp("Emulation.setTouchEmulationEnabled",{enabled:!process.argv.includes("--hover")});
    await js('document.documentElement.style.setProperty("--smoke-safe-bottom",'+JSON.stringify(width<600?"20px":"0px")+')');
    for(const [label,route,mode] of [["chapters","p/ledger/story/chapters","normal"],["chapter","p/ledger/story/chapters/neap","normal"],["waiting","p/ledger/story/chapters/neap","waiting"],["audiobook","p/ledger/story/audiobook","normal"],["blocks","p/ledger/story/chapters/neap?view=audiobook","normal"]]) {
      await js('window.mountLayout('+JSON.stringify(route)+','+JSON.stringify(mode)+')');if(label==='waiting'&&width<600)await js('document.querySelector(".fy-passage-band")?.scrollIntoView({block:"center"})');await check(name+'-'+label);
      if(baseline)continue;
      if(label==='chapters'&&width<600){await click('.fy-chapter-card__more');await check(name+'-chapter-menu');await escape();await click('.fy-chapters-more');await check(name+'-manuscript-menu');await escape();}
      if(label==='chapter'){
        if(width<1100){await click('[aria-label="Notes"]');await check(name+'-notes');await escape();assert.equal(await js('!!document.querySelector(".fy-rme__doc")'),true);}
        // Arke's sheet, before a selection hides its press (installed app, 2026-10-05): the head names
        // the chapter, the synopsis is the Notes sheet's, and with the model chip the editor has the
        // composer's width and the tools sit under it, send inside the screen.
        if(width<1100&&!process.argv.includes('--hover')){
          assert.equal(await js('getComputedStyle(document.querySelector(".fy-sw__head > .fy-sbsynopsis")).display'),'none',name+': the synopsis is not drawn below 1100');
          await click(width<600?'button.fy-season-arke':'.fy-season-arke-rail');await check(name+'-arke');
          const arke=await js('(()=>{const sheet=document.querySelector(".fy-season-arke-sheet[open]"),b=s=>sheet.querySelector(s).getBoundingClientRect(),cx=b(".fy-cx"),ed=b(".fy-cx__editorwrap"),send=b(".fy-cx__send");return {title:sheet.querySelector(".fy-page-sheet__head h2").textContent,chip:!!sheet.querySelector(".fy-cx .fy-mchip"),composer:cx.width,editor:ed.width,editorBottom:ed.bottom,send:{left:send.left,right:send.right,top:send.top}};})()');
          assert.equal(arke.title,'Arke · Chapter 01',name+': the sheet names the chapter');
          assert.ok(arke.chip,name+': the dock has its model chip');
          assert.ok(arke.editor>=arke.composer-4,name+': the editor has the composer\'s width ('+arke.editor+' of '+arke.composer+')');
          assert.ok(arke.send.top>=arke.editorBottom-1&&arke.send.right<=width&&arke.send.left>=0,name+': send sits under the words, inside the screen');
          await escape();
        }
        await js('(()=>{const p=document.querySelector(".fy-rme__doc p:last-child"),t=p.firstChild,r=document.createRange();r.setStart(t,t.textContent.indexOf("Not the scrape"));r.setEnd(t,t.textContent.indexOf(", because the form"));const s=getSelection();s.removeAllRanges();s.addRange(r);document.dispatchEvent(new Event("selectionchange"));})()');await js('window.settleLayout()');await check(name+'-passage');
        if(!process.argv.includes('--hover')){assert.ok(await js('!!document.querySelector(".fy-passage-ask")'));if(width>=600)assert.ok(await js('document.querySelector(".fy-passage-ask").getBoundingClientRect().top>=document.querySelector(".fy-rme__doc p:last-child").getBoundingClientRect().bottom'));}
      }
      if(label==='chapter' && width>=600 && width<1100){
        await js('window.mountLayout("p/ledger/story/chapters/neap","source")');await js('(()=>{const area=document.querySelector(".fy-ch__source");area.focus();area.setSelectionRange(0,31);document.dispatchEvent(new Event("selectionchange"));})()');await js('window.settleLayout()');await check(name+'-source-passage');
        assert.ok(await js('document.querySelector(".fy-passage-anchor").getBoundingClientRect().top < document.querySelector(".fy-ch__source").getBoundingClientRect().bottom'));
      }
      // Turn 199 took the voice row off the page (it lives in the Reading sheet now); the narrator's cast card is the page's press for 165c.
      if(label==='audiobook' && width<600){await click('.fy-abshow__card--narrator');assert.ok(await js('!!document.querySelector(".fy-page-sheet[open] [data-testid=narrator-dialog]")'),name+' narrator sheet');await check(name+'-narrator');
        await click('[aria-label="Narrator"] button:last-child');assert.equal(await js('document.querySelector("[aria-label=Narrator] button:last-child").getAttribute("aria-pressed")'),'true',name+' this book');await check(name+'-narrator-book');
        await escape();assert.equal(await js('!!document.querySelector("[data-testid=narrator-dialog]")'),false,name+' narrator sheet closed');}
      if(label==='blocks'){
        await js(`(()=>{const e=document.querySelector('[data-block="p0.0"] .fy-ab__text'),t=e.firstChild,r=document.createRange();r.setStart(t,0);r.setEnd(t,20);const s=getSelection();s.removeAllRanges();s.addRange(r);document.dispatchEvent(new Event("selectionchange"));})()`);await js('window.settleLayout()');
        await js(`document.querySelector('[data-block="p0.0"]').click();window.settleLayout()`);await check(name+'-block');
        if(width<1100){assert.ok(await js('!!document.querySelector(".fy-chapter-block-sheet[open]")'));if(!process.argv.includes('--hover')){assert.ok(await js('Array.from(document.querySelectorAll(".fy-chapter-block-sheet button")).some(e=>e.textContent==="Make this a line")'));
          await click('.fy-ab__make-line > button');
          await js('Array.from(document.querySelectorAll(".fy-ab__make-line [role=menuitem]")).find(e=>e.textContent.includes("Maren Kest")).click();window.settleLayout()');
          assert.equal(await js('window.commands.findLast(m=>m.kind==="set-voice-pin")?.quote'), 'The ledger of the Vi');
          assert.equal(await js('window.commands.findLast(m=>m.kind==="set-voice-pin")?.sheet'), 'maren-kest');
}}
      }
    }
  }
  const masterRecords=[];
  for(const id of ["ch173a1","ch173a2","ch173a3","ch173b1","ch173b2","ch173b3","ch173c","ch173d","vs165l","vs165m"]){const fold=["ch173c","ch173d"].includes(id);await size(fold?984:390,fold?1060:797,true);await navigate('/'+id+'.html');await capture(id);masterRecords.push({id,geometry:await js('Object.fromEntries([".qcard",".rack",".rack4",".sheet",".canvas",".binsp"].map(s=>{const e=document.querySelector(s),r=e?.getBoundingClientRect();return[s,r?{x:r.x,y:r.y,width:r.width,height:r.height}:null]}))')});}
  await writeFile(join(dir,'master-measurements.json'),JSON.stringify(masterRecords,null,2));
  console.log(JSON.stringify({directory:dir,checks:records.length,baseline:baselineRef}));
}finally{socket?.close();child.kill();await new Promise(r=>server.close(r));}
