import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtemp, readFile, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { spawn, execFileSync } from "node:child_process";
import { parseHTML } from "linkedom";

// Turn 163 against the actual React screens, with the complete client cascade.
// Chrome owns hover/pointer emulation; fixture media stays on a private loopback server.
const root = fileURLToPath(new URL("../", import.meta.url));
const baseline = process.argv.includes("--baseline");
const baselineRef = baseline ? process.argv[process.argv.indexOf("--baseline") + 1] : null;
if (baseline) assert.ok(baselineRef, "--baseline requires a revision");
const dir = await mkdtemp(join(tmpdir(), "arke-bible-canon-"));
const main = await readFile(join(root, "packages/client/src/main.tsx"), "utf8");
const styles = [...main.matchAll(/^import "([^"]+\.css)";/gm)].filter(m => !baseline || !m[1].endsWith("/bible-canon.css")).map(m => m[0]).join("\n");
const { document: master } = parseHTML(await readFile(join(root, "design-system/Arke Studio.dc.html"), "utf8"));
const masterLinks = [...master.querySelectorAll("link[rel=stylesheet]")].map(e => e.outerHTML.replace('href="', 'href="/design/')).join("\n");
const masterStyles = [...master.querySelectorAll("#t163 style")].map(e => e.outerHTML).join("\n");
for (const id of ["cn163a1", "cn163a2", "cn163a3", "cn163b1", "cn163b2", "cn163b3", "cn163c1", "cn163c2", "cn163c3", "cn163d", "cn163e"]) {
  const frame = master.getElementById(id).cloneNode(true);
  frame.querySelectorAll(".sb,.hi,style").forEach(e => e.remove());
  frame.style.height = id === "cn163d" || id === "cn163e" ? "1060px" : "797px";
  await writeFile(join(dir, id + ".html"), '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' + masterLinks + masterStyles + '<style>body{margin:0}</style></head><body>' + frame.outerHTML.replaceAll('src="assets/', 'src="/design/assets/') + '</body></html>');
}
await build({
  stdin: { resolveDir: join(root, "packages/client/src"), loader: "tsx", contents: `
import React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { MemoryRouter, useNavigate } from "react-router";
import { App } from "./App";
import { __setBridgeForTest, __setStateForTest, __applyEventForTest } from "./lib/store";
import { FIXTURE_STATE } from "../test/fixture-state";
${styles}
let renderer;
function Navigation() { window.go = useNavigate(); return null; }
window.settleCanon = async () => { await new Promise(r => setTimeout(r, 850)); await document.fonts.ready; };
window.mountCanon = async (route="bible", mode="normal") => {
  renderer?.unmount();
  const state=structuredClone(FIXTURE_STATE), world=state.world;
  state.app.health.harness={status:"healthy"};state.app.health.voice={status:"healthy"};state.app.jobs=[];
  world.proposals=[];world.problems=[];world.externalEdits=[];world.meta.canonRevision=104;
  world.bible={present:true,version:7,updated:"2026-09-27",text:"## The tides\\n\\nThe tide is the world’s clock and its accountant. Nothing in the harbour is scheduled; it is owed. Tide-callers pay in hearing, and the harbour keeps the ledger.\\n\\n## The verse\\n\\nThe drowned god sings, and the city tunes itself to the verse. Bells are rung to answer it, never to lead it. When the verse rises early, everyone on the Vigil knows before the bell does.\\n\\n## What I have not decided\\n\\nWhether the Chorister is one person or an office…".replaceAll("\\\\n","\\n")};
  if(mode==="long") world.bible.text += "\\n\\n" + ("A very long document continues with more ideas. ".repeat(200)) + "\\n\\n## The end\\n\\nThe last section.";
  const base=world.canon[0];
  world.canon=[
    {...base,id:"CANON-002",type:"rule",status:"settled",title:"Tide-calling",body:"A tide-caller pulls the water where it needs to go and pays for it in hearing, one ear and then the other.",introducedAt:3,settledAt:12,amendedAt:42},
    {...base,id:"CANON-044",type:"thread",status:"open",title:"Who taught the Chorister?",body:"Someone had to teach the Chorister the verse. Who was alive to do it?",introducedAt:41},
    {...base,id:"CANON-019",type:"location",status:"settled",title:"The Vigil holds the harbour mouth",body:"The Vigil is the last light before open water. Its keepers ring the answer to the verse.",introducedAt:5,settledAt:19},
    ...["lore","timeline","faction","tone"].map((type,i)=>({...base,id:"CANON-00"+(i+5),type,status:"settled",title:"Harbour memory",body:"The tide keeps its own account."}))
  ];
  if(mode==="long") for(const entry of world.canon){entry.title="UnbrokenLongTitle".repeat(12);entry.body="UnbrokenLongStatement".repeat(60);}
  window.commands=[];window.worldId=world.meta.worldId;
  const bridge={connect(){},send(raw){window.commands.push(JSON.parse(raw));},subscribe(){return ()=>{};},coordinatorHttpBase:()=>location.origin};
  window.arke=bridge;__setBridgeForTest(bridge);
  __setStateForTest(state,{canonRefs:{"CANON-002":{canonRevision:104,citedBy:{sheets:[{id:"maren-kest",atVersion:4}],entries:["CANON-019"],productions:[]},history:[{ts:"2026-09-20T12:00:00Z",source:"form",canonRevisionAfter:42,fieldsChanged:["statement"]},{ts:"2026-09-22T12:00:00Z",source:"studio",canonRevisionAfter:104,fieldsChanged:["accepted as canon"]}],historyTruncated:false,ripples:[{kind:"contradiction-candidates",summary:"2 contradiction candidates",targets:["CANON-019"]}]}}});
  renderer=createRoot(document.getElementById("root"));
  flushSync(()=>renderer.render(<MemoryRouter initialEntries={["/w/"+world.meta.worldId+"/"+route]}><Navigation/><App/></MemoryRouter>));
  await window.settleCanon();
};
window.fill=(selector,value)=>{const e=document.querySelector(selector);const proto=e instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,"value").set.call(e,value);e.dispatchEvent(new Event("input",{bubbles:true}));};
window.quoteBible=(c)=>__applyEventForTest({type:"voice.audio",at:"2026-09-27T12:00:00Z",worldId:window.worldId,requestId:c.requestId,sheetVersion:7,purpose:"bible-section",sectionHeading:c.sectionHeading,provider:"elevenlabs",model:"eleven_multilingual_v2",voiceId:"narrator",status:"confirmation-required",format:"wav",file:null,cached:false,characterCount:300,estimatedMicroUsd:4000,confirmationToken:"quote"});
window.answer=(outcome="answer")=>{const command=window.commands.findLast(c=>c.kind==="canon-ask");__applyEventForTest({type:"canon.answer",at:"2026-09-27T12:00:00Z",worldId:window.worldId,askId:command.askId,result:outcome==="answer"?{outcome:"answer",searched:33,claims:[{text:"The keepers on the Vigil ring the answer to the verse.",entryId:"CANON-019",excerpt:"Its keepers ring the answer to the verse."}]}:{outcome:"refusal",cause:"not-decided",searched:33,closest:[{entryId:"CANON-019",title:"The Vigil holds the harbour mouth"}]}});};
window.measureCanon=()=>{
  const selectors=[".fy-titlebar",".fy-pillnav",".fy-document-head",".fy-hero__title",".fy-biblegrid",".fy-biblegrid__side",".fy-rme__doc",".fy-canon-grid",".fy-gridcard",".fy-askbar",".fy-entry__main",".fy-entry__side",".fy-gate__main",".fy-gate__side",".fy-held-bar",".fy-page-sheet[open]",".fy-page-sheet__foot"];
  const bounds=s=>{const e=document.querySelector(s);if(!e)return null;const b=e.getBoundingClientRect();return {x:b.x,y:b.y,width:b.width,height:b.height};};
  const page=document.querySelector(".fy-content");
  return {viewport:[innerWidth,innerHeight],coarse:matchMedia("(pointer:coarse)").matches,hover:matchMedia("(hover:hover)").matches,
    overflow:document.documentElement.scrollWidth>innerWidth || (page&&page.scrollWidth>page.clientWidth+1),geometry:Object.fromEntries(selectors.map(s=>[s,bounds(s)])),
    columns:document.querySelector(".fy-canon-grid")&&getComputedStyle(document.querySelector(".fy-canon-grid")).gridTemplateColumns.split(" ").length,
    bar:document.querySelector(".fy-held-bar")&&{position:getComputedStyle(document.querySelector(".fy-held-bar")).position,padding:getComputedStyle(document.querySelector("[data-screen]:not([data-screen=world-layout])")).paddingBottom},
    sideways:[...document.querySelectorAll(".fy-page-sheet__body,.fy-held-bar,.fy-entry__side,.fy-gate__side")].filter(e=>e.clientWidth&&e.scrollWidth>e.clientWidth+1).map(e=>e.className)};
};
` }, bundle:true,platform:"browser",format:"iife",define:{"import.meta.env":"{}"},
  plugins:[{name:"fixture-cascade",setup(build) {
    build.onLoad({filter:/\.(css|tsx)$/}, async ({path}) => {
      const name=relative(root,path).replaceAll("\\","/");
      const old=baseline && ["packages/client/src/screens/world.tsx","packages/client/src/screens/bible.tsx","packages/client/src/components/read-aloud-confirmation.tsx"].includes(name);
      return {loader:path.endsWith(".css")?"css":"tsx",resolveDir:dirname(path),contents:(old?execFileSync("git",["show",baselineRef+":"+name],{cwd:root,encoding:"utf8"}):await readFile(path,"utf8")).replace(/env\(safe-area-inset-bottom(?:,\s*0px)?\)/g,"var(--smoke-safe-bottom, 0px)")};
    });
  }}],loader:{".woff":"file",".woff2":"file"},outfile:join(dir,"view.js")
});
await writeFile(join(dir,"index.html"), '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="view.css"></head><body><div id="root"></div><script src="view.js"></script></body></html>');
console.log("Bible/Canon layout artifacts: " + dir);
const chrome=process.env.ARKE_CHROME ?? (process.platform === "win32" ? "C:/Program Files/Google/Chrome/Application/chrome.exe" : process.platform === "darwin" ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : "/usr/bin/google-chrome");
await access(chrome);
const server=createServer(async (req,res) => {
  try {
    const path=decodeURIComponent(new URL(req.url,"http://localhost").pathname);
    if(path.startsWith("/media/") && path.includes("missing-candidate")) {res.writeHead(404);res.end();return;}
    const file=path.startsWith("/media/") ? join(root,"design-system/assets",path.includes("sheet") || path.includes("compilation") ? "maren-sheet-pitchboard.png" : path.includes("look-0") ? "art-direction-cinematic.png" : path.includes("look-2") ? "art-direction-world.png" : "char-maren.png") : path.startsWith("/design/") ? join(root,"design-system",path.slice(8)) : join(dir,path === "/" ? "index.html" : path.slice(1));
    assert.ok([dir,join(root,"design-system")].some(base=>{const rel=relative(base,file);return !rel.startsWith("..") && !isAbsolute(rel);}));
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
  await navigate("/");await until(()=>js('typeof window.mountCanon === "function"'));
  const records=[];
  const only=process.argv.includes("--viewport")?process.argv[process.argv.indexOf("--viewport")+1]:null;
  for(const [name,width,height,touch] of (baseline?[["desktop",1360,850,false]]:[["desktop",1360,850,false],["fold",984,1060,true],["phone",390,797,true],["phone375",375,812,true],["phone360",360,800,true],["narrow",600,850,true],["threshold",844,900,true]]).filter(v=>!only||v[0]===only)) {
    await size(width,height,touch);if(touch)await cdp("Emulation.setTouchEmulationEnabled",{enabled:true});
    await js('document.documentElement.style.setProperty("--smoke-safe-bottom","'+(touch?20:0)+'px")');
    for(const [route,label] of [["bible","bible"],["canon","canon"],["canon/CANON-002","entry"],["canon/CANON-044/thread","thread"],["canon/new","new"]]) {
      await js('window.mountCanon('+JSON.stringify(route)+')');
      const m=await js("window.measureCanon()");records.push({name,route:label,...m});await writeFile(join(dir,"measurements.json"),JSON.stringify(records,null,2));await capture(name+"-"+label);
      if(m.overflow && !baseline && width<1100) console.log(name,label,await js('[...document.querySelectorAll(".fy-content *")].filter(e=>e.getBoundingClientRect().right>document.querySelector(".fy-content").clientWidth+1).slice(0,12).map(e=>[e.className,e.getBoundingClientRect().right,e.scrollWidth,e.clientWidth])'));
      if(!baseline&&width<1100)assert.equal(m.overflow,false,name+" "+label+" horizontal overflow");
      assert.deepEqual(m.sideways,[],name+" "+label+" inner overflow");
      assert.equal(m.coarse,touch);assert.equal(m.hover,!touch);
      if(!baseline && label==="canon")assert.equal(m.columns,width<600?1:width<900?2:3);
      if(!baseline && width===984 && label==="bible")assert.equal(m.geometry[".fy-biblegrid__side"].width,240);
      if(!baseline && width===984 && label==="thread")assert.equal(m.geometry[".fy-gate__side"].width,340);
      if(!baseline && width<600 && m.bar) {
        assert.equal(await js('(()=>{const page=document.querySelector(".fy-held-anchor").closest("[data-screen]");return parseFloat(getComputedStyle(page).paddingBottom)>=document.querySelector(".fy-held-bar").getBoundingClientRect().height})()'),true,name+" reserves the actual bottom bar");
      }
      if(!baseline && width<844 && label==="bible") {
        await js('document.querySelector(".fy-bible-contents").click();window.settleCanon()');await capture(name+"-contents");
        assert.ok(await js('document.querySelector(".fy-page-sheet").open'));
        await js('document.querySelector(".fy-bible__versions button").click()');
        assert.ok(await js('window.commands.some(c=>c.kind==="restore-bible"&&c.version===6)'));
        await js('document.querySelector(".fy-bible__tocrow .ui-iconbtn").click();window.settleCanon()');
        assert.ok(await js('window.commands.some(c=>c.kind==="read-bible-section")'));
        await js('(()=>{const c=window.commands.findLast(c=>c.kind==="read-bible-section");window.quoteBible(c)})();window.settleCanon()');
        assert.equal(await js('!!document.querySelector(".fy-page-sheet .fy-read-confirmation")'),true,"the read quote stays in the modal layer");
        assert.deepEqual((await js("window.measureCanon()")).sideways,[]);
        await js('[...document.querySelectorAll(".fy-read-confirmation button")].find(b=>b.textContent.startsWith("Confirm ")).click();window.settleCanon()');
        assert.ok(await js('window.commands.some(c=>c.kind==="read-bible-section"&&c.confirmationToken==="quote")'));
        await capture(name+"-read-confirmed");
        await js('document.querySelectorAll(".fy-bible__tocname")[1].click();window.settleCanon()');
        assert.equal(await js('!!document.querySelector(".fy-page-sheet[open]")'),false);
        assert.equal(await js('window.getSelection()?.anchorNode?.textContent'),"The verse");
      }
      if(!baseline && width<600 && label==="entry") {
        assert.equal(await js('getComputedStyle(document.querySelector(".fy-textactions")).opacity'),"1");
        await js('document.querySelector(".fy-entry-actions .ui-btn").click();window.settleCanon()');await capture(name+"-amend");
        assert.ok(await js('!!document.querySelector(".fy-entry-amendment")'));
      }
      if(!baseline && width<600 && label==="thread") {
        await js('document.querySelector(".fy-thread-peek").click();window.settleCanon()');
        await js('window.fill(".fy-page-sheet textarea","Odile Kest taught the Chorister the verse, and never told her daughter.");window.settleCanon()');
        await capture(name+"-settle");
        const rect=await js('window.measureCanon().geometry[".fy-page-sheet__foot"]');assert.ok(rect.y+rect.height<=height+1);
        await js('document.querySelector(".fy-page-sheet__foot button").click();window.settleCanon()');
        assert.ok(await js('window.commands.some(c=>c.kind==="settle-thread"&&c.statement.startsWith("Odile"))'));
        await cdp("Input.dispatchKeyEvent",{type:"keyDown",key:"Escape",code:"Escape",windowsVirtualKeyCode:27,nativeVirtualKeyCode:27});await cdp("Input.dispatchKeyEvent",{type:"keyUp",key:"Escape",code:"Escape",windowsVirtualKeyCode:27,nativeVirtualKeyCode:27});await js("window.settleCanon()");
        assert.equal(await js('!!document.querySelector(".fy-page-sheet[open]")'),false);
        await size(984,1060,true);await js("window.settleCanon()");
        assert.equal(await js('document.querySelector(".fy-thread-edit textarea").value'),"Odile Kest taught the Chorister the verse, and never told her daughter.","the draft survives unfolding");
        await size(width,height,true);await js("window.settleCanon()");
      }
      if(!baseline && width<600 && label==="new") {
        await js('window.fill("[data-screen=new-canon] input","Tide-calling");window.fill("[data-screen=new-canon] textarea","A caller cannot move a tide she has not stood in.");window.settleCanon()');
        await capture(name+"-new-filled");await js('document.querySelector(".fy-new-canon-actions .ui-btn--primary").click()');
        assert.ok(await js('window.commands.some(c=>c.kind==="stage-canon-entry")'));
      }
    }
    if(!baseline && width<600) {
      for(const outcome of ["answer","refusal"]) {
        await js('window.mountCanon("canon")');await js('window.fill(".fy-askbar input","Who rings the bells?");window.settleCanon()');
        await js('document.querySelector(".fy-askbar button").click();window.settleCanon()');await js('window.answer('+JSON.stringify(outcome)+');window.settleCanon()');
        assert.equal((await js("window.measureCanon()")).overflow,false);await capture(name+"-"+outcome);
      }
      for(const route of ["bible","canon","canon/CANON-002","canon/CANON-044/thread"]) {
        await js('window.mountCanon('+JSON.stringify(route)+',"long")');assert.equal((await js("window.measureCanon()")).overflow,false,name+" long "+route);
      }
    }
  }
  await writeFile(join(dir,"measurements.json"),JSON.stringify(records,null,2));
  if(!baseline){
    const measurements={};
    for(const id of ["cn163a1","cn163a2","cn163a3","cn163b1","cn163b2","cn163b3","cn163c1","cn163c2","cn163c3","cn163d","cn163e"]){
      const fold=id==="cn163d"||id==="cn163e";
      await size(fold?984:390,fold?1060:797,true);await navigate("/"+id+".html");await capture(id);
      measurements[id]=await js('Object.fromEntries([".head","h1",".doc",".bgrid",".rail",".ask",".ccard",".sheet",".foot",".abar",".gate",".gs"].map(s=>{const b=document.querySelector(s)?.getBoundingClientRect();return [s,b?{x:b.x,y:b.y,width:b.width,height:b.height}:null]}))');
    }
    await writeFile(join(dir,"master-measurements.json"),JSON.stringify(measurements,null,2));
    await size(984,1092,true);await navigate("/");await until(()=>js('typeof window.mountCanon==="function"'));
    for(const route of ["bible","canon","canon/CANON-002","canon/CANON-044/thread","canon/new"]){await js('window.mountCanon('+JSON.stringify(route)+')');assert.equal((await js("window.measureCanon()")).overflow,false);await capture("fold-full-"+route.replaceAll("/","-"));}
  }
  console.log("Bible/Canon layout checks passed");
} finally {socket?.close();child.kill();server.close();}
