import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtemp, readFile, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { spawn, execFileSync } from "node:child_process";
import { parseHTML } from "linkedom";

// Turn 162 against the actual React screens, with the complete client cascade.
// Chrome owns hover/pointer emulation; fixture media stays on a private loopback server.
const root = fileURLToPath(new URL("../", import.meta.url));
const baseline = process.argv.includes("--baseline");
const baselineRef = baseline ? process.argv[process.argv.indexOf("--baseline") + 1] : null;
if (baseline) assert.ok(baselineRef, "--baseline requires a revision");
const dir = await mkdtemp(join(tmpdir(), "arke-character-layout-"));
const main = await readFile(join(root, "packages/client/src/main.tsx"), "utf8");
const styles = [...main.matchAll(/^import "([^"]+\.css)";/gm)].filter(m => !baseline || !m[1].endsWith("/character-pages.css")).map(m => m[0]).join("\n");
const { document: master } = parseHTML(await readFile(join(root, "design-system/Arke Studio.dc.html"), "utf8"));
const masterLinks = [...master.querySelectorAll("link[rel=stylesheet]")].map(e => e.outerHTML.replace('href="', 'href="/design/')).join("\n");
const masterStyles = [...master.querySelectorAll("#t162 style")].map(e => e.outerHTML).join("\n");
for (const id of ["ch162a1", "ch162a2", "ch162a3", "ch162b1", "ch162b2", "ch162b3", "ch162c", "ch162d"]) {
  const frame = master.getElementById(id).cloneNode(true);
  frame.querySelectorAll(".sb,.hi,style").forEach(e => e.remove());
  frame.style.height = id === "ch162c" || id === "ch162d" ? "1060px" : "797px";
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
import { VoiceSampleReviewSchema } from "@arke-studio/contracts";
${styles}
let renderer;
function Navigation() { window.go = useNavigate(); return null; }
window.mountCharacter = async (route = "kit", mode = "normal") => {
  renderer?.unmount();
  const state = structuredClone(FIXTURE_STATE), world = state.world;
  state.app.health.voice = {status:"healthy"}; state.app.jobs = [];
  state.app.manifest.models.push({id:"gpt-image-2",provider:"openai",capability:"image",displayName:"GPT Image 2",accepts:{referenceImages:16,referenceRoles:false,startFrame:false,endFrame:false},limits:{tiers:{"1K":"1024x1024","2K":"2048x2048"}},pricing:{kind:"perImage",microUsdPerImage:40000}});
  state.app.routing.defaults.image="gpt-image-2";
  state.app.providers=[...state.app.providers.filter(p=>p.id!=="openai"),{id:"openai",configured:true,validation:"valid",probes:[{capability:"image",available:true}],fault:null}];
  world.proposals = []; world.problems = []; world.externalEdits = [];
  const sheet = world.sheets.find(s => s.id === "maren-kest");
  sheet.sections = [...sheet.sections.filter(s => !s.heading.startsWith("Voice")), {heading:"Voice",body:"Low and even. Speaks to the water before she speaks to people."}];
  if(mode === "long") { sheet.name = "MarenWithAnUnbrokenLongName".repeat(5); sheet.role = "TidecallerWithAnUnbrokenLongRole".repeat(4); }
  const kit = world.referenceKits.find(k => k.sheetId === sheet.id);
  kit.looks = ["Oilskin, storm light", "Hood down, dusk", "On the Vigil stair", "After the crossing", "Council coat"].map((prompt,i)=>({id:"look-"+i,file:"looks/look-"+i+".png",kind:"costume",prompt,acceptedAt:"2026-09-27T10:0"+(5-i)+":00Z"}));
  kit.designatedVoiceSample = {file:"voice-sample.wav",source:"voice-take",designatedAt:"2026-09-27T10:00:00Z"};
  world.referenceCandidates[sheet.id]=["references/maren-kest/candidates/photo-a.png","references/maren-kest/candidates/photo-b.png"];
  if(mode === "pending") world.referenceTakes = ["sheet","look"].map((kind,i)=>({id:"tk_01J8F00000000000000000000"+i,coversShots:[],kind,reference:{sheetId:sheet.id},provider:"openai",model:"gpt-image-2",provenance:{canonRevision:42,sheets:{[sheet.id]:4}},prompt:"A new "+kind,references:[],params:{},cost:{estimatedMicroUsd:40000,actualMicroUsd:40000},dispatchedAt:"2026-09-27T12:00:00Z",completedAt:"2026-09-27T12:01:00Z",media:kind+".png"}));
  const voices={ [sheet.id]: {extracted:[],ranked:["Harbour glass","Low tide","Brine and bell","Kokoro · af_sky"].map((label,i)=>({candidate:{provider:i===3?"kokoro":"elevenlabs",model:i===3?"kokoro-82m":"eleven_multilingual_v2",voiceId:i===0?sheet.voice.voiceId:"voice-"+i,label,attributes:["warm","measured"],local:i===3,canClone:false},matched:[],overlap:0})),previewLine:{text:"The verse, under the water.",source:"own-line"},cloudPreviewMicroUsd:30000,previewMicroUsdByVoice:{},notices:{}} };
  window.commands = [];
  const bridge = { connect() {}, send(command) { window.commands.push(JSON.parse(command)); }, subscribe() { return () => {}; }, coordinatorHttpBase: () => location.origin };
  window.arke = bridge; __setBridgeForTest(bridge); __setStateForTest(state,{voiceCandidates:voices});
  window.characterPath = "/w/" + world.meta.worldId + "/cast/maren-kest/";
  renderer = createRoot(document.getElementById("root"));
  flushSync(() => renderer.render(<MemoryRouter initialEntries={[window.characterPath + route]}><Navigation /><App /></MemoryRouter>));
  await window.settleCharacter();
};
window.settleCharacter = async () => { await new Promise(r => setTimeout(r, 850)); await document.fonts.ready; await Promise.all([...document.images].map(i => i.decode().catch(() => {}))); };
window.reviewSample = () => {
  [...document.querySelectorAll('.fy-vssource button')].find(b=>b.textContent==='Review').click();
  const command=window.commands.findLast(c=>c.kind==='prepare-character-voice-sample');
  const at="2026-09-27T12:01:00Z", hash="sha256:"+"a".repeat(64);
  const technical={container:"wav",codec:"pcm_s16le",sampleFormat:"s16",sampleRateHz:48000,channels:1,bitDepth:16,durationSec:8,sizeBytes:768044};
  const report={schemaVersion:1,sourceHash:hash,analyzer:{id:"arke-pcm-qc",version:1,policyVersion:1},analyzedAt:at,technical,measurements:{samplePeakDbfs:-3,rmsDbfs:-18,fullScaleSampleCount:0,leadingSilenceSec:0,trailingSilenceSec:0,longestInternalSilenceSec:0,dcOffset:0},checks:Object.fromEntries(["decode","duration","technicalFormat","clipping","silence","dcOffset","truePeak","lufs","noiseFloor","snr","speechPresence","musicLikelihood","multipleSpeakers","transcriptMatch"].map(code=>[code,{code,outcome:"pass"}]))};
  const review=VoiceSampleReviewSchema.parse({operationId:"00000000-0000-4000-8000-000000000000",sheetId:command.sheetId,sourceFile:"source.wav",preparedFile:"prepared.wav",provenance:{schemaVersion:1,source:{kind:"legacy-character-sample",sheetId:command.sheetId,sourceFile:"source.wav",legacySource:"voice-take",legacyDesignatedAt:at,sourceMediaHash:hash},sourceTechnical:technical,outputHash:hash,outputTechnical:technical,preparation:[],qualityReport:report,createdAt:at}});
  __applyEventForTest({type:"voice.sample-result",at,requestId:command.requestId,worldId:command.worldId,sheetId:command.sheetId,status:"prepared",review});
};
window.measureCharacter = () => {
  const bounds = s => { const e = document.querySelector(s); if(!e) return null; const b=e.getBoundingClientRect(); return {x:b.x,y:b.y,width:b.width,height:b.height}; };
  const page = document.querySelector(".fy-content");
  const selectors = [".fy-titlebar", ".fy-pillnav", ".fy-character-head", ".fy-character-tabs", ".fy-reference-grid", ".fy-reference-card", ".fy-reference-card__image--photo", ".fy-reference-card__image--sheet", ".fy-looks-composer", ".fy-looks-results__grid", ".fy-voicehero", ".fy-voicehero__art", ".fy-voiceways", ".fy-voicetile"];
  const dialog=document.querySelector('.fy-gendialog[open],.fy-voicesheet,.fy-clone,.fy-voices');
  return {viewport:[innerWidth,innerHeight],coarse:matchMedia("(pointer:coarse)").matches,hover:matchMedia("(hover:hover)").matches,
    overflow:document.documentElement.scrollWidth>innerWidth || (page && page.scrollWidth>page.clientWidth),
    sideways:[...document.querySelectorAll('.fy-gendialog[open] .fy-gendialog__columns,.fy-character-sheet-body,.fy-clone__body,.fy-vsbody')].filter(e=>e.clientWidth && e.scrollWidth>e.clientWidth+1).map(e=>e.className),
    geometry:Object.fromEntries(selectors.map(s=>[s,bounds(s)])),
    active:[...document.querySelectorAll('.fy-character-tabs [aria-current="page"]')].map(e=>e.textContent),
    dialog:dialog && {rect:bounds('.fy-gendialog[open],.fy-voicesheet,.fy-clone,.fy-voices'),position:getComputedStyle(dialog).position,overflow:dialog.scrollWidth>dialog.clientWidth,
      foot:bounds('.fy-gendialog[open] .fy-gendialog__actions,.fy-voicesheet__foot,.fy-clone .fy-voices__foot,.fy-voices > .fy-voices__foot')}
  };
};
` }, bundle:true,platform:"browser",format:"iife",define:{"import.meta.env":"{}"},
  plugins:[{name:"fixture-cascade",setup(build) {
    build.onLoad({filter:/\.(css|tsx)$/}, async ({path}) => {
      const name=relative(root,path).replaceAll("\\","/");
      const old=baseline && ["packages/client/src/screens/world.tsx","packages/client/src/screens/fidelity.css","packages/client/src/screens/character-reference.tsx","packages/client/src/screens/character-voice.tsx","packages/client/src/components/generation-dialog.tsx","packages/client/src/components/character-voice-sample.tsx"].includes(name);
      return {loader:path.endsWith(".css")?"css":"tsx",resolveDir:dirname(path),contents:(old?execFileSync("git",["show",baselineRef+":"+name],{cwd:root,encoding:"utf8"}):await readFile(path,"utf8")).replace(/env\(safe-area-inset-bottom(?:,\s*0px)?\)/g,"var(--smoke-safe-bottom, 0px)")};
    });
  }}],loader:{".woff":"file",".woff2":"file"},outfile:join(dir,"view.js")
});
await writeFile(join(dir,"index.html"), '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="view.css"></head><body><div id="root"></div><script src="view.js"></script></body></html>');
console.log("Character layout artifacts: " + dir);
const chrome=process.env.ARKE_CHROME ?? (process.platform === "win32" ? "C:/Program Files/Google/Chrome/Application/chrome.exe" : process.platform === "darwin" ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : "/usr/bin/google-chrome");
await access(chrome);
const server=createServer(async (req,res) => {
  try {
    const path=decodeURIComponent(new URL(req.url,"http://localhost").pathname);
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
  await navigate("/");await until(()=>js('typeof window.mountCharacter === "function"'));
  const records=[];
  const only=process.argv.includes("--viewport")?process.argv[process.argv.indexOf("--viewport")+1]:null;
  for(const [name,width,height,touch] of (baseline ? [["desktop",1360,850,false]] : [["desktop",1360,850,false],["fold",984,1060,true],["phone",390,797,true],["phone375",375,812,true],["phone360",360,800,true],["narrow",600,850,true]]).filter(v=>!only||v[0]===only)) {
    await size(width,height,touch);if(touch)await cdp("Emulation.setTouchEmulationEnabled",{enabled:true});
    await js('document.documentElement.style.setProperty("--smoke-safe-bottom","'+(touch?20:0)+'px")');
    for(const route of ["kit","looks","voice"]) {
      await js('window.mountCharacter('+JSON.stringify(route)+')');
      if(route === "looks") await js('document.querySelector(".fy-looks-results__grid > div > button")?.click(); window.settleCharacter()');
      const m=await js("window.measureCharacter()");records.push({name,route,...m});await capture(name+"-"+route);
      assert.equal(m.overflow,false,name+" "+route+" horizontal overflow");
      assert.equal(m.coarse,touch,name+" pointer");assert.equal(m.hover,!touch,name+" hover");
      if(!baseline)assert.deepEqual(m.active,[route === "kit"?"Reference":route === "looks"?"More looks":"Voice"]);
    }
    for(const [dialog,route,open] of (process.argv.includes("--pages-only") ? [] : [
      ["explore","looks",'document.querySelector(".fy-looks-composer .ui-btn").click()'],
      ["choose","voice",'window.go(window.characterPath+"voice?choose=1")'],
      ["clone","voice",'window.go(window.characterPath+"voice?record=1")'],
      ["sample","voice",'window.go(window.characterPath+"voice?sample=1")'],
      ["sheet","kit",'window.go(window.characterPath+"model-sheet")'],
      ["photo","kit",'window.go(window.characterPath+"main-photo")']
    ])) {
      await js('window.mountCharacter('+JSON.stringify(route)+')');
      await js('document.querySelector(".fy-content").scrollTop=350;'+open+';window.settleCharacter()');
      const m=await js("window.measureCharacter()");records.push({name,overlay:dialog,...m});await capture(name+"-"+dialog);
      if(!baseline){assert.ok(m.dialog,name+" "+dialog+" opens");assert.equal(m.dialog.position,"fixed");if(width<1100)assert.equal(m.dialog.overflow,false,name+" "+dialog+" overflow");assert.deepEqual(m.sideways,[],name+" "+dialog+" scrolling body overflow");assert.ok(m.dialog.rect.x>=0 && m.dialog.rect.x+m.dialog.rect.width<=width+1,name+" "+dialog+" within viewport");if(width<600){assert.equal(m.dialog.rect.y,193);assert.ok(m.dialog.foot.y+m.dialog.foot.height<=height+1,name+" "+dialog+" footer");}}
      if(dialog === "sample") {await js("window.reviewSample();window.settleCharacter()");assert.equal(await js('!!document.querySelector("[data-testid=voice-review]")'),true);await capture(name+"-review");}
    }
    if(!baseline && width < 600) {
      for(const route of ["kit","looks","voice"]){await js('window.mountCharacter('+JSON.stringify(route)+',"long")');assert.equal((await js("window.measureCharacter()")).overflow,false,name+" "+route+" long names");}
      await js('window.mountCharacter("kit","pending")');await js('document.querySelector(".fy-reference-candidates").scrollIntoView({block:"center"})');await capture(name+"-candidate");
      assert.equal(await js('getComputedStyle(document.querySelector(".fy-reference-candidate")).flexWrap'),"wrap");
      await js('window.mountCharacter("looks","pending");');await js('document.querySelector(".fy-looks-results__grid > div > button").click()');
      await capture(name+"-pending-look");await js('[...document.querySelectorAll(".fy-looks-footer button")].find(b=>b.textContent==="Accept look").click()');
      assert.ok(await js('window.commands.some(c=>c.kind==="accept-character-look")'),"the held bar accepts the selected take");
    }
  }
  await writeFile(join(dir,"measurements.json"),JSON.stringify(records,null,2));
  if(!baseline){
    // Also exercise the full browser viewport; the paired master crops exclude OS chrome.
    await size(984,1092,true);
    for(const route of ["kit","looks","voice"]){await navigate("/");await until(()=>js('typeof window.mountCharacter === "function"'));await js('window.mountCharacter('+JSON.stringify(route)+')');assert.equal((await js("window.measureCharacter()")).overflow,false,"984x1092 "+route);await capture("fold-full-"+route);}
    const masterMeasurements={};
    for(const id of ["ch162a1","ch162a2","ch162a3","ch162b1","ch162b2","ch162b3","ch162c","ch162d"]){
      await size(id.endsWith("c")||id.endsWith("d")?984:390,id.endsWith("c")||id.endsWith("d")?1060:797,true);await navigate("/"+id+".html");await capture(id);
      masterMeasurements[id]=await js('Object.fromEntries([".chead",".tabs",".rcard",".rcard .img",".rgrid",".vhero",".vhero .art",".tiles",".tile",".door",".lgrid",".sheet"].map(s=>{const e=document.querySelector(s); const b=e?.getBoundingClientRect();return [s,b?{x:b.x,y:b.y,width:b.width,height:b.height}:null]}))');
    }
    await writeFile(join(dir,"master-measurements.json"),JSON.stringify(masterMeasurements,null,2));
    for(const [id,name,route,pairs] of [
      ["ch162a1","phone","kit",[[".tabs",".fy-character-tabs"],[".rcard",".fy-reference-card"],[".rcard .img",".fy-reference-card__image--photo"]]],
      ["ch162a2","phone","looks",[[".tabs",".fy-character-tabs"],[".door",".fy-looks-composer"]]],
      ["ch162a3","phone","voice",[[".tabs",".fy-character-tabs"],[".vhero .art",".fy-voicehero__art"]]],
      ["ch162c","fold","kit",[[".tabs",".fy-character-tabs"],[".rcard",".fy-reference-card"],[".rcard .img",".fy-reference-card__image--photo"]]],
      ["ch162d","fold","voice",[[".tabs",".fy-character-tabs"],[".vhero",".fy-voicehero"],[".tiles",".fy-voiceways"]]]
    ]) {
      const actual=records.find(r=>r.name===name && r.route===route);if(!actual)continue;
      for(const [design,app]of pairs)for(const key of ["x","y","width","height"])assert.ok(Math.abs(masterMeasurements[id][design][key]-actual.geometry[app][key])<=1,id+" "+app+" "+key+" matches master");
    }
  }
  console.log("Character layout checks passed");
} finally {socket?.close();child.kill();server.close();}
