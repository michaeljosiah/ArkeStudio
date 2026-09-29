import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtemp, readFile, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { spawn, execFileSync } from "node:child_process";
import { parseHTML } from "linkedom";

// Actual world components and the complete client cascade, in sandboxed Chromium.
// The master is rendered in the same engine; OS status bars are outside the app.

const root = fileURLToPath(new URL("../", import.meta.url));
const baseline = process.argv.includes("--baseline");
const baselineRef = baseline ? process.argv[process.argv.indexOf("--baseline") + 1] : null;
if (baseline) assert.ok(baselineRef, "--baseline requires the pre-change git revision");
const dir = await mkdtemp(join(tmpdir(), "arke-world-layout-"));
const main = await readFile(join(root, "packages/client/src/main.tsx"), "utf8");
const styles = [...main.matchAll(/^import "([^"]+\.css)";/gm)].filter(match => !baseline || !match[1].endsWith("/world.css")).map(match => match[0]).join("\n");
const { document: master } = parseHTML(await readFile(join(root, "design-system/Arke Studio.dc.html"), "utf8"));
const masterLinks = [...master.querySelectorAll("link[rel=stylesheet]")].map(link => link.outerHTML.replace('href="', 'href="/design/')).join("\n");
const masterStyles = [...master.querySelectorAll("#t160 style")].map(style => style.outerHTML).join("\n");
for (const id of ["wo160a1", "wo160a2", "wo160a3", "wo160b"]) {
  const frame = master.getElementById(id).cloneNode(true);
  frame.querySelectorAll(".sb,.hi,style").forEach(e => e.remove());
  frame.style.height = id === "wo160b" ? "1060px" : "797px";
  await writeFile(join(dir, id + ".html"), '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' + masterLinks + masterStyles +
    '<style>body{margin:0}</style></head><body>' + frame.outerHTML.replaceAll('src="assets/', 'src="/design/assets/') + '</body></html>');
}
await build({
  stdin: { resolveDir: join(root, "packages/client/src"), loader: "tsx", contents: `
import React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { MemoryRouter, Routes, Route, useNavigate } from "react-router";
import { WorldLayout, WorldOverviewScreen } from "./screens/world";
import { __setBridgeForTest, __setStateForTest } from "./lib/store";
import { FIXTURE_STATE } from "../test/fixture-state";
${styles}
let renderer;
const settle = () => new Promise(resolve => setTimeout(resolve, 120));
function Navigation() { window.go = useNavigate(); return null; }
window.mountWorld = async (mode = "normal", route = "") => {
  renderer?.unmount();
  const state = structuredClone(FIXTURE_STATE);
  const world = state.world;
  const base = world.sheets.find(s => s.type === "character");
  world.sheets = [
    ["maren-kest", "Maren Kest", "Tide-caller"], ["ilo-venn", "Ilo Venn", "Cartographer"],
    ["sereth-anwe", "Sereth Anwe", "Warden of the Vigil"], ["bray-half-hitch", "Bray Half-Hitch", "Salvage diver"],
    ["the-chorister", "The Chorister", "What the deep sends up"], ["sixth", "The Listener", ""]
  ].map(([id, name, role]) => ({...base, id, name, role}));
  world.referenceKits = []; world.proposals = [];
  const openThread = world.canon.find(c => c.status === "open");
  world.canon.push({...openThread,id:"second-open-thread",title:"The bell at low tide"});
  world.meta.logline = "A drowned god still sings beneath the harbour, and the city tunes itself to the verse.";
  world.productions = ["Saltlight", "The Vigil", "The Harbour Below"].map((title, i) => {
    const p = structuredClone(world.productions[0]); p.meta.title = title; p.meta.id = ["saltlight", "vigil", "harbour"][i]; return p;
  });
  if (mode === "long") {
    world.meta.name = "The extraordinarily long unbroken WorldName".repeat(4);
    world.sheets[0].name = "Wide Name ".repeat(15); world.sheets[0].role = "Wide role ".repeat(15);
    world.externalEdits = [{path: "canon/" + "very-long-path".repeat(20) + ".md", kind: "changed", refusal: "A file needs attention."}];
    world.problems = [{path: "sheets/" + "verylong".repeat(30), message: "Unable to parse this record", kind: "parse"}];
  }
  if (mode === "pending") {
    world.sheets = world.sheets.slice(0, 2);
    const staged = structuredClone(FIXTURE_STATE.world.proposals[0]);
    staged.proposal.kind = "new-sheet"; staged.proposal.summary = "New character: Sereth Anwe";
    staged.proposal.targets = [{path:"characters/sereth-anwe.md",baseVersion:null,baseHash:null}];
    staged.review = {targets:[{path:"characters/sereth-anwe.md",label:"Sereth Anwe",kind:"new sheet",action:"create",fields:[]}]};
    world.proposals = [staged];
  }
  window.commands = [];
  const bridge = { connect() {}, send(command) { window.commands.push(JSON.parse(command)); }, subscribe() { return () => {}; }, coordinatorHttpBase: () => location.origin };
  window.arke = bridge; __setBridgeForTest(bridge); __setStateForTest(state, mode === "pending" ? {authoring:{[world.proposals[0].proposal.id]:{status:"running"}}} : {});
  window.worldPath = "/w/" + world.meta.worldId;
  renderer = createRoot(document.getElementById("root"));
  flushSync(() => renderer.render(<MemoryRouter initialEntries={[window.worldPath + route]}>
    <Navigation /><Routes><Route path="/w/:worldId" element={<WorldLayout />}>
      <Route index element={<WorldOverviewScreen />} />
      <Route path="*" element={<div style={{height: 1800}}>Route content</div>} />
    </Route></Routes>
  </MemoryRouter>));
  await new Promise(resolve => setTimeout(resolve, 800)); await document.fonts.ready; await Promise.all([...document.images].map(i => i.decode().catch(() => {}))); await settle();
};
window.measureWorld = () => {
  const bounds = selector => { const e = document.querySelector(selector); if (!e) return null; const b = e.getBoundingClientRect(); return { x: b.x, y: b.y, width: b.width, height: b.height }; };
  const page = document.querySelector(".fy-content");
  const nav = document.querySelector(".fy-pillnav");
  return { viewport: [innerWidth, innerHeight], coarse: matchMedia("(pointer: coarse)").matches, hover: matchMedia("(hover: hover)").matches,
    overflow: document.documentElement.scrollWidth > innerWidth || page.scrollWidth > page.clientWidth,
    nav: bounds(".fy-pillnav"), active: bounds('.fy-pillnav [aria-current="page"]'),
    navScroll: nav.scrollLeft, stuck: !!document.querySelector(".fy-worldnav--stuck"),
    hero: bounds(".fy-hero"), title: bounds(".fy-hero__title"), fan: bounds(".fy-fan"), card: bounds(".fy-polaroid"),
    ctas: bounds(".fy-ctas"), cta: bounds(".fy-cta"), ctaCopy: bounds(".fy-cta__title"), glance: bounds(".fy-glance"), productions: bounds(".fy-prodstrip"), needs: bounds(".fy-needs"),
    pills: [...nav.children].map(e => e.getBoundingClientRect().height),
    controls: [...document.querySelectorAll(".fy-titlebar .fy-iconbtn")].filter(e => e.getBoundingClientRect().width).map(e => ({label:e.textContent || e.getAttribute("aria-label"),height:e.getBoundingClientRect().height})),
    frame: bounds(".fy-polaroid__frame"), ctaFrame: bounds(".fy-cta__frame"), productionFrame: bounds(".fy-prodtile__frame"),
    columns: document.querySelector(".fy-glance") && getComputedStyle(document.querySelector(".fy-glance")).gridTemplateColumns.split(" ").length,
    prodColumns: document.querySelector(".fy-prodstrip") && getComputedStyle(document.querySelector(".fy-prodstrip")).gridTemplateColumns.split(" ").length,
  };
};
` },
  bundle: true, platform: "browser", format: "iife", define: { "import.meta.env": "{}" },
  plugins: [{name: "fixture-safe-area", setup(build) {
    build.onLoad({filter: /\.css$/}, async ({path}) => ({loader:"css", resolveDir: dirname(path),
      contents: (baseline && path.endsWith("fidelity.css") ? execFileSync("git",["show",baselineRef + ":packages/client/src/screens/fidelity.css"],{cwd:root,encoding:"utf8"}) : await readFile(path,"utf8"))
        .replace(/env\(safe-area-inset-bottom(?:,\s*0px)?\)/g,"var(--smoke-safe-bottom, 0px)") }));
  }}, ...(baseline ? [{name: "desktop-before", setup(build) {
    build.onLoad({filter: /world\.tsx$/}, ({path}) => ({
      contents: execFileSync("git",["show",baselineRef + ":" + path.slice(root.length).replaceAll("\\","/")],{cwd:root,encoding:"utf8"}),
      loader: "tsx",
    }));
  }}] : [])],
  loader: { ".woff": "file", ".woff2": "file" }, outfile: join(dir, "view.js"),
});
await writeFile(join(dir, "index.html"), '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="view.css"><style>.fy-fan__drift{animation:none!important}</style></head><body><div id="root"></div><script src="view.js"></script></body></html>');
console.log("World layout artifacts: " + dir);
await browserMain();

async function browserMain() {
  const chrome = process.env.ARKE_CHROME ?? (process.platform === "win32" ? "C:/Program Files/Google/Chrome/Application/chrome.exe" : process.platform === "darwin" ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : "/usr/bin/google-chrome");
  await access(chrome);
  const server = createServer(async (request, response) => {
    try {
      const path = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
      let file;
      if (path.startsWith("/media/")) {
        const portraits = { "maren-kest": "char-maren.png", "ilo-venn": "char-ilo.png", "sereth-anwe": "char-sereth.png", "bray-half-hitch": "char-bray.png", "the-chorister": "char-chorister.png", "the-saltmarket": "drowned-quarter.png" };
        const image = Object.entries(portraits).find(([id]) => path.includes("/" + id + "/"))?.[1] ?? (path.includes("/vigil/") ? "scene4-shot12.png" : path.includes("/harbour/") ? "banner-story.png" : "saltlight-shot15.png");
        file = join(root, "design-system/assets", image);
      } else file = path.startsWith("/design/") ? join(root, "design-system", path.slice(8)) : join(dir, path === "/" ? "index.html" : path.slice(1));
      if (![dir, join(root,"design-system")].some(base => {
        const rel = relative(base,file); return !rel.startsWith("..") && !isAbsolute(rel);
      })) throw new Error("Outside the fixture roots");
      response.setHeader("Content-Type", file.endsWith(".css") ? "text/css" : file.endsWith(".js") ? "text/javascript" : file.endsWith(".html") ? "text/html" : "application/octet-stream");
      response.end(await readFile(file));
    } catch { response.writeHead(404); response.end(); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = "http://127.0.0.1:" + server.address().port;
  const child = spawn(chrome, ["--headless=new", "--disable-gpu", "--blink-settings=primaryPointerType=4,availablePointerTypes=4,primaryHoverType=2,availableHoverTypes=2", "--no-first-run", "--no-default-browser-check", "--remote-debugging-port=0", "--user-data-dir=" + join(dir,"profile"), "about:blank"], { windowsHide: true, stdio: "ignore" });
  let socket;
  const settle = () => new Promise(resolve => setTimeout(resolve, 150));
  const until = async work => {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) { try { const value = await work(); if(value) return value; } catch {} await settle(); }
    throw new Error("Timed out waiting for headless Chrome");
  };
  try {
    const port = await until(async () => (await readFile(join(dir,"profile/DevToolsActivePort"),"utf8")).split("\n")[0]);
    const targets = await (await fetch("http://127.0.0.1:" + port + "/json/list")).json();
    socket = new WebSocket(targets.find(t => t.type === "page").webSocketDebuggerUrl);
    await new Promise((resolve,reject) => {socket.onopen = resolve; socket.onerror = reject;});
    let sequence = 0;
    const pending = new Map();
    socket.onmessage = ({data}) => {const m = JSON.parse(data); const p = pending.get(m.id); if(p) {pending.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result);}};
    const cdp = (method,params={}) => new Promise((resolve,reject) => {const id=++sequence;pending.set(id,{resolve,reject});socket.send(JSON.stringify({id,method,params}));});
    const js = async expression => {const r=await cdp("Runtime.evaluate",{expression,awaitPromise:true,returnByValue:true,userGesture:true});if(r.exceptionDetails)throw new Error(JSON.stringify(r.exceptionDetails));return r.result.value;};
    const size = (width,height,mobile) => cdp("Emulation.setDeviceMetricsOverride",{width,height,deviceScaleFactor:1,mobile});
    const navigate = async path => {await cdp("Page.navigate",{url:origin+path});await until(()=>js('document.readyState === "complete"'));};
    const capture = async name => {
      await js("document.fonts.ready.then(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))");
      await settle();
      const {data} = await cdp("Page.captureScreenshot",{format:"png",captureBeyondViewport:false});
      await writeFile(join(dir,name + ".png"),Buffer.from(data,"base64"));
    };
    await cdp("Page.enable");
    await cdp("Emulation.setEmulatedMedia",{features:[{name:"prefers-reduced-motion",value:"reduce"}]});
    await navigate("/"); await until(()=>js('typeof window.mountWorld === "function"'));
  const records = [];
  for (const [name, width, height, touch] of (baseline ? [["desktop",1360,850,false]] : [
    ["desktop",1360,850,false], ["fold",984,1060,true], ["phone",390,797,true],
    ["phone-375",375,812,true], ["phone-360",360,800,true], ["narrow",600,850,true],
  ])) {
    await size(width, height, touch);
    if (touch) await cdp("Emulation.setTouchEmulationEnabled", {enabled: true});
    await cdp("Emulation.setEmulatedMedia", {features: [{name:"prefers-reduced-motion",value:"reduce"},{name:"hover",value:touch ? "none" : "hover"},{name:"pointer",value:touch ? "coarse" : "fine"}]});
    await js('document.documentElement.style.setProperty("--smoke-safe-bottom", "' + (touch ? 20 : 0) + 'px")');
    await js("window.mountWorld()");
    const m = await js("window.measureWorld()"); records.push({name,...m});
    await capture(name);
    assert.equal(m.overflow,false,name + " sideways overflow");
    assert.ok(m.ctaCopy.width >= 75,name + " action-card copy has room to read");
    assert.equal(m.coarse,touch,name + " pointer emulation");
    assert.equal(m.hover,!touch,name + " hover emulation");
    if (touch) { assert.ok(m.pills.every(h => h === 40),name + " pill height"); assert.ok(m.controls.every(c => c.height >= 44),JSON.stringify(m.controls)); }
    if (width < 600) {
      assert.equal(m.columns,2); assert.equal(m.prodColumns,1); assert.equal(m.ctaFrame.width,72); assert.equal(await js('document.querySelector(".fy-polaroid__frame").offsetHeight'),150); assert.equal(m.productionFrame.width,96);
      await js('document.querySelector(".fy-content").scrollTop += document.querySelector(".fy-cta").getBoundingClientRect().top - 123'); await settle();
      const glance = await js("window.measureWorld()");
      assert.equal(glance.stuck,true); records.push({name:name + "-glance",...glance}); await capture(name + "-glance");
      await js('document.querySelector(".fy-content").scrollTop += document.querySelector(".fy-wsection--productions").getBoundingClientRect().top - 127'); await settle(); await capture(name + "-productions");
      records.push({name:name + "-productions",...await js("window.measureWorld()")});
      await js('window.go(window.worldPath + "/canon")'); await settle();
      const canon = await js("window.measureWorld()");
      assert.ok(canon.active.x >= 0 && canon.active.x + canon.active.width <= width - 20, "Canon is visible on arrival");
      await capture(name + "-canon");
      await js('window.go(window.worldPath + "/locations")'); await settle();
      assert.equal(await js('document.querySelector(".fy-pillnav [aria-current=page]").textContent'),"Cast");
      await js('window.mountWorld("long")'); assert.equal((await js("window.measureWorld()")).overflow,false,"long banner/name overflow"); await capture(name + "-long");
      await js('window.mountWorld("pending")');
      assert.ok(await js('document.querySelector(".fy-polaroid--pending .fy-loading") !== null'),"pending cast keeps the live indicator");
      assert.equal(await js('getComputedStyle(document.querySelector(".fy-polaroid__frame--pending")).borderTopStyle'),"dashed");
      await capture(name + "-pending");
      await js('document.querySelector(".fy-hero__title").click()'); await settle();
      assert.equal(await js('document.activeElement.contentEditable'),"true","rename focuses on the first press");
      await cdp("Input.insertText",{text:" Renamed"});
      await cdp("Input.dispatchKeyEvent",{type:"keyDown",key:"Enter",code:"Enter",windowsVirtualKeyCode:13});
      assert.ok(await js('window.commands.some(c => c.kind === "rename-world" && c.name.endsWith(" Renamed"))'),"Enter commits the rename");
    } else { assert.equal(m.columns,4); assert.equal(m.prodColumns,3); }
  }
  await writeFile(join(dir,"measurements.json"),JSON.stringify(records,null,2));
  if (baseline) return;
  for (const id of ["wo160a1","wo160a2","wo160a3","wo160b"]) {
    await size(id === "wo160b" ? 984 : 390,id === "wo160b" ? 1060 : 797, true);
    await navigate("/" + id + ".html");
    await js("Promise.all([...document.images].map(i => i.decode()))"); await capture(id);
    const bounds = await js(`Object.fromEntries(["strip","hero","castrow","fan","pol","ctas","cta","glance","prods","needs"].map(c => { const e=document.querySelector("."+c);const b=e?.getBoundingClientRect();return [c,b && {x:b.x,y:b.y,width:b.width,height:b.height}]; }))`);
    await writeFile(join(dir,id + ".json"),JSON.stringify(bounds,null,2));
    const name = {wo160a1:"phone",wo160a2:"phone-glance",wo160a3:"phone-productions",wo160b:"fold"}[id];
    const actual = records.find(r => r.name === name);
    assert.ok(actual,"missing implementation frame for " + id);
    const pairs = id === "wo160a3" ? [["productions","prods"],["needs","needs"]] : id === "wo160a2" ? [["cta","cta"],["glance","glance"]] :
      [["hero","hero"],["fan",id === "wo160b" ? "fan" : "castrow"],["card","pol"],["ctas","ctas"],["cta","cta"]];
    for (const [appKey,masterKey] of pairs) for (const axis of ["x","y","width","height"]) {
      assert.ok(Math.abs(actual[appKey][axis] - bounds[masterKey][axis]) <= 1,
        name + " " + appKey + "." + axis + ": " + actual[appKey][axis] + " versus master " + bounds[masterKey][axis]);
    }
  }
  } finally { socket?.close(); child.kill(); server.close(); }
}
