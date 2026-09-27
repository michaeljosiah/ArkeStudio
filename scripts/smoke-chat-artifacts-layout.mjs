import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtemp, readFile, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { spawn, execFileSync } from "node:child_process";
import { parseHTML } from "linkedom";

// Turn 164 against the actual React screens, with the complete client cascade.
// Chrome owns hover/pointer emulation; fixture media stays on a private loopback server.
const root = fileURLToPath(new URL("../", import.meta.url));
const baseline = process.argv.includes("--baseline");
const baselineRef = baseline ? process.argv[process.argv.indexOf("--baseline") + 1] : null;
if (baseline) assert.ok(baselineRef, "--baseline requires a revision");
const dir = await mkdtemp(join(tmpdir(), "arke-chat-artifacts-"));
const main = await readFile(join(root, "packages/client/src/main.tsx"), "utf8");
const styles = [...main.matchAll(/^import "([^"]+\.css)";/gm)].filter(m => !baseline || !m[1].endsWith("/chat-artifacts.css")).map(m => m[0]).join("\n");
const { document: master } = parseHTML(await readFile(join(root, "design-system/Arke Studio.dc.html"), "utf8"));
const masterLinks = [...master.querySelectorAll("link[rel=stylesheet]")].map(e => e.outerHTML.replace('href="', 'href="/design/')).join("\n");
const masterStyles = [...master.querySelectorAll("#t164 style")].map(e => e.outerHTML).join("\n");
for (const id of ["wc164a1", "wc164a2", "wc164a3", "wc164b1", "wc164b2", "wc164b3", "wc164c", "wc164d"]) {
  const frame = master.getElementById(id).cloneNode(true);
  frame.querySelectorAll(".sb,.hi,style").forEach(e => e.remove());
  frame.querySelector(".viewer .vtop")?.setAttribute("style", "padding-top:0");
  frame.style.height = id === "wc164c" || id === "wc164d" ? "1060px" : "797px";
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
import { chatArtifactsFixture, CHAT_ID } from "../test/chat-artifacts-fixture";
${styles}
let renderer;
function Navigation() { window.go = useNavigate(); return null; }
window.settleLayout = async () => { await new Promise(r => setTimeout(r, 700)); await document.fonts.ready; };
window.mountLayout = async (route="chat", mode="normal") => {
  renderer?.unmount();
  const state=chatArtifactsFixture(), world=state.world;
  if(mode==="long") {
    world.conversations[0].title="UnbrokenConversationTitle".repeat(20);
    state.worldChat.messages.push({...state.worldChat.messages[0],id:"msg_long",text:"UnbrokenTranscript".repeat(120)});
    for(const item of world.artifacts) item.file="LongArtifactFilename".repeat(8)+".png";
  }
  window.commands=[];window.worldId=world.meta.worldId;window.chatId=CHAT_ID;window.fixture=state;
  const bridge={connect(){},send(raw){const command=JSON.parse(raw);window.commands.push(command);
    if(command.kind==="world-chat-create")setTimeout(()=>{const copy=structuredClone(state);copy.worldChat={...copy.worldChat,conversationId:"cv_01J8F3K2QW9VZX4N7M0RTYB6HN",messages:[],points:[]};copy.world.conversations.push({...copy.world.conversations[0],id:copy.worldChat.conversationId,title:"New conversation",pointCount:0});__setStateForTest(copy);},0);
  },subscribe(){return ()=>{};},coordinatorHttpBase:()=>location.origin};
  window.arke=bridge;__setBridgeForTest(bridge);__setStateForTest(state);__connectionStatusForTest("open");
  renderer=createRoot(document.getElementById("root"));
  flushSync(()=>renderer.render(<MemoryRouter initialEntries={["/w/"+world.meta.worldId+"/"+(route==="conversation"?"chat/"+CHAT_ID:route)]}><Navigation/><App/></MemoryRouter>));
  await window.settleLayout();
};
window.measureLayout=()=>{
  const selectors=[".fy-titlebar",".fy-pillnav",".fy-chatnav",".fy-gate",".fy-gate__main",".fy-gate__side",".fy-chat__composer",".fy-chat__phonehead",".fy-chat__phonesub",".fy-chatnav__phonehead",".fy-chatnav__row",".fy-chat__accept",".fy-artifacts-head",".fy-hero__title",".fy-artifacts-door",".fy-artifact-grid",".fy-gridcard",".fy-artifact-frame",".fy-artview__panel",".fy-artview__head",".fy-artview__stage",".fy-artview__foot",".fy-held-bar",".fy-thread-peek",".fy-page-sheet[open]",".fy-page-sheet__foot"];
  const bounds=s=>{const e=document.querySelector(s);if(!e)return null;const b=e.getBoundingClientRect();return {x:b.x,y:b.y,width:b.width,height:b.height};};
  const page=document.querySelector(".fy-content");
  return {viewport:[innerWidth,innerHeight],coarse:matchMedia("(pointer:coarse)").matches,hover:matchMedia("(hover:hover)").matches,
    overflow:document.documentElement.scrollWidth>innerWidth || (page&&page.scrollWidth>page.clientWidth+1),geometry:Object.fromEntries(selectors.map(s=>[s,bounds(s)])),
    bubbles:[...document.querySelectorAll(".fy-chat__bubble")].slice(0,4).map(e=>{const b=e.getBoundingClientRect();return {x:b.x,y:b.y,width:b.width,height:b.height};}),
    columns:document.querySelector(".fy-artifact-grid")&&getComputedStyle(document.querySelector(".fy-artifact-grid")).gridTemplateColumns.split(" ").length,
    sideways:[...document.querySelectorAll(".fy-page-sheet__body,.fy-held-bar,.fy-artview__panel,.fy-gate__side")].filter(e=>e.clientWidth&&e.scrollWidth>e.clientWidth+1).map(e=>e.className)};
};
` }, bundle:true,platform:"browser",format:"iife",define:{"import.meta.env":"{}"},
  plugins:[{name:"fixture-cascade",setup(build) {
    build.onLoad({filter:/\.(css|tsx)$/}, async ({path}) => {
      const name=relative(root,path).replaceAll("\\","/");
      const old=baseline && ["packages/client/src/screens/world.tsx","packages/client/src/screens/world-chat.tsx","packages/client/src/components/artifact-viewer.tsx"].includes(name);
      return {loader:path.endsWith(".css")?"css":"tsx",resolveDir:dirname(path),contents:(old?execFileSync("git",["show",baselineRef+":"+name],{cwd:root,encoding:"utf8"}):await readFile(path,"utf8")).replace(/env\(safe-area-inset-bottom(?:,\s*0px)?\)/g,"var(--smoke-safe-bottom, 0px)")};
    });
  }}],loader:{".woff":"file",".woff2":"file"},outfile:join(dir,"view.js")
});
await writeFile(join(dir,"index.html"), '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="view.css"></head><body><div id="root"></div><script src="view.js"></script></body></html>');
console.log("Chat/Artifacts layout artifacts: " + dir);
const chrome=process.env.ARKE_CHROME ?? (process.platform === "win32" ? "C:/Program Files/Google/Chrome/Application/chrome.exe" : process.platform === "darwin" ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : "/usr/bin/google-chrome");
await access(chrome);
const server=createServer(async (req,res) => {
  try {
    const path=decodeURIComponent(new URL(req.url,"http://localhost").pathname);
    if(path.startsWith("/media/") && path.includes("missing-candidate")) {res.writeHead(404);res.end();return;}
    const file=path.startsWith("/media/") ? join(root,"design-system/assets",path.includes("drowned-quarter")?"drowned-quarter.png":path.includes("posters")?"saltlight-shot15.png":"world-undersong.png") : path.startsWith("/design/") ? join(root,"design-system",path.slice(8)) : join(dir,path === "/" ? "index.html" : path.slice(1));
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
  await navigate("/");await until(()=>js('typeof window.mountLayout === "function"'));
  const records=[];
  const only=process.argv.includes("--viewport")?process.argv[process.argv.indexOf("--viewport")+1]:null;
  const escape=async()=>{await cdp("Input.dispatchKeyEvent",{type:"keyDown",key:"Escape",code:"Escape",windowsVirtualKeyCode:27,nativeVirtualKeyCode:27});await cdp("Input.dispatchKeyEvent",{type:"keyUp",key:"Escape",code:"Escape",windowsVirtualKeyCode:27,nativeVirtualKeyCode:27});await js("window.settleLayout()");};
  const check=async(name,route)=>{const m=await js("window.measureLayout()");records.push({name,route,...m});await writeFile(join(dir,"measurements.json"),JSON.stringify(records,null,2));await capture(name+"-"+route);if(m.overflow)console.log(name,route,await js('({widths:[innerWidth,document.documentElement.scrollWidth,document.querySelector(".fy-content").clientWidth,document.querySelector(".fy-content").scrollWidth],offenders:[...document.querySelectorAll(".fy-content *")].filter(e=>{const r=e.getBoundingClientRect();return r.right>innerWidth+1}).map(e=>[e.className,e.getBoundingClientRect().right]).slice(0,20)})'));if(!baseline)assert.equal(m.overflow,false,name+" "+route+" overflow");assert.deepEqual(m.sideways,[],name+" "+route+" inner overflow");return m;};
  for(const [name,width,height,touch] of (baseline?[["desktop",1360,850,false]]:[["desktop",1360,850,false],["fold",984,1060,true],["phone",390,797,true],["phone375",375,812,true],["phone360",360,800,true],["narrow",600,850,true],["viewer860",860,900,true]]).filter(v=>!only||v[0]===only)) {
    await size(width,height,touch);await cdp("Emulation.setTouchEmulationEnabled",{enabled:touch});
    await js('document.documentElement.style.setProperty("--smoke-safe-bottom","'+(touch?20:0)+'px")');
    for(const route of ["chat","conversation","artifacts"]) {
      await js('window.mountLayout('+JSON.stringify(route)+')');const m=await check(name,route);
      assert.equal(m.coarse,touch);assert.equal(m.hover,!touch);
      if(!baseline&&route==="artifacts")assert.equal(m.columns,width<600?2:width<1100?3:4);
      if(!baseline&&width===984&&route==="conversation"){assert.equal(m.geometry[".fy-chatnav"].width,48);assert.equal(m.geometry[".fy-gate__side"].width,340);await js('[...document.querySelectorAll("button")].find(e=>e.getAttribute("aria-label")==="Show history").click();window.settleLayout()');await check(name,"history");assert.equal((await js("window.measureLayout()")).geometry[".fy-chatnav"].width,236);}
      if(!baseline&&width<600&&route==="chat") {
        assert.equal(await js('!!document.querySelector(".fy-chatnav--screen")'),true);
        await js('document.querySelector(".fy-chatnav__more").click();window.settleLayout()');await check(name,"row-menu");assert.ok(await js('document.querySelector(".fy-page-sheet").open'));await escape();
        await js('document.querySelector(".fy-chatnav__phonehead button").click();window.settleLayout()');assert.ok(await js('window.commands.some(c=>c.kind==="world-chat-create")'));assert.ok(await js('!!document.querySelector("[data-screen=world-chat-conversation]")'));
      }
      if(!baseline&&width<600&&route==="conversation") {
        assert.ok(await js('parseFloat(getComputedStyle(document.querySelector(".fy-chat__wrap")).paddingBottom)>=document.querySelector(".fy-held-bar").getBoundingClientRect().height'));
        await js('document.querySelector(".fy-thread-peek").click();window.settleLayout()');await check(name,"understood");
        await js('document.querySelector(".fy-page-sheet__foot button").click()');assert.ok(await js('window.commands.some(c=>c.kind==="world-chat-wrap-up")'));
        await escape();
        await js('[...document.querySelectorAll("button")].find(e=>e.getAttribute("aria-label")==="Conversation options").click();window.settleLayout()');assert.ok(await js('document.querySelector(".fy-page-sheet").open'));await escape();
      }
      if(route==="artifacts") {
        await js('[...document.querySelectorAll(".fy-filterchip")].find(e=>e.textContent.startsWith("Images")).click();window.settleLayout()');
        await js('document.querySelector(".fy-gridcard__open").click();window.settleLayout()');await check(name,"viewer");
        if(!baseline&&width<860) {
          assert.equal(await js('document.querySelector(".fy-artview__foot span").textContent'),"1 of 2");
          await js('[...document.querySelectorAll("button")].find(e=>e.getAttribute("aria-label")==="Next artifact").click();window.settleLayout()');assert.equal(await js('document.querySelector(".fy-artview__foot span").textContent'),"2 of 2");
          await js('[...document.querySelectorAll("button")].find(e=>e.getAttribute("aria-label")==="Previous artifact").click();window.settleLayout()');
          await js('document.querySelector(".fy-artview__details").click();window.settleLayout()');await check(name,"details");await escape();assert.ok(await js('document.querySelector(".fy-artview").open'),"closing Details keeps the viewer open");
          await js('(()=>{const e=document.querySelector(".fy-artview__stage");const touch=(x)=>new Touch({identifier:1,target:e,clientX:x,clientY:350});e.dispatchEvent(new TouchEvent("touchstart",{bubbles:true,touches:[touch(280)]}));e.dispatchEvent(new TouchEvent("touchend",{bubbles:true,changedTouches:[touch(90)]}));})();window.settleLayout()');assert.equal(await js('document.querySelector(".fy-artview__foot span").textContent'),"2 of 2");
        }
        await escape();
      }
    }
    if(!baseline&&width<600)for(const route of ["chat","conversation","artifacts"]){await js('window.mountLayout('+JSON.stringify(route)+',"long")');await check(name,"long-"+route);}
  }
  if(!baseline) {
    const measurements={};
    for(const id of ["wc164a1", "wc164a2", "wc164a3", "wc164b1", "wc164b2", "wc164b3", "wc164c", "wc164d"]) {
      const fold=id==="wc164c"||id==="wc164d";
      await size(fold?984:390,fold?1060:797,true);await navigate("/"+id+".html");await capture(id);
      measurements[id]=await js('Object.fromEntries([".head","h1",".chead",".csub",".conv",".wgate",".wnav",".wmain",".wside",".grid2a",".grid3",".acard",".fr",".sheet",".foot",".peek",".viewer",".vtop",".stage",".vfoot"].map(s=>{const b=document.querySelector(s)?.getBoundingClientRect();return [s,b?{x:b.x,y:b.y,width:b.width,height:b.height}:null]}))');
    }
    await writeFile(join(dir,"master-measurements.json"),JSON.stringify(measurements,null,2));
    // Content counts and record names vary; the frame geometry comes directly from turn 164.
    const close = (actual, expected, keys, label) => {
      assert.ok(actual && expected, label + " is rendered");
      for (const key of keys) assert.ok(Math.abs(actual[key]-expected[key]) <= 1, label + " " + key + ": " + actual[key] + " vs " + expected[key]);
    };
    const find = (name, route) => records.find(row=>row.name===name && row.route===route)?.geometry;
    const phoneChat=find("phone","conversation"), phoneShelf=find("phone","artifacts"), phoneViewer=find("phone","viewer"), foldChat=find("fold","conversation"), foldShelf=find("fold","artifacts");
    for (const [actual, id, pairs] of [
      [phoneChat,"wc164a2",[[".fy-chat__phonehead",".chead"],[".fy-chat__phonesub",".csub"],[".fy-thread-peek",".peek"]]],
      [phoneShelf,"wc164b1",[[".fy-artifact-frame",".fr"]]],
      [phoneViewer,"wc164b2",[[".fy-artview__panel",".viewer"],[".fy-artview__head",".vtop"],[".fy-artview__stage",".stage"],[".fy-artview__foot",".vfoot"]]],
      [find("phone","understood"),"wc164a3",[[".fy-page-sheet[open]",".sheet"]]],
      [find("phone","details"),"wc164b3",[[".fy-page-sheet[open]",".sheet"]]],
      [foldChat,"wc164c",[[".fy-gate",".wgate"],[".fy-chatnav",".wnav"],[".fy-gate__main",".wmain"],[".fy-gate__side",".wside"]]],
      [foldShelf,"wc164d",[[".fy-artifact-frame",".fr"]]],
    ]) if(actual) for(const [app, master] of pairs) close(actual[app],measurements[id][master],["x","y","width","height"],id+" "+app);

    await size(984,1092,true);await navigate("/");await until(()=>js('typeof window.mountLayout==="function"'));
    for(const route of ["chat","conversation","artifacts"]){await js('window.mountLayout('+JSON.stringify(route)+')');await check("fold-full",route);}
  }
  console.log("Chat/Artifacts layout checks passed");
} finally {socket?.close();child.kill();server.close();}
