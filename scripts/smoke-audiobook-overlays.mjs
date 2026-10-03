import assert from "node:assert/strict";
import { build } from "esbuild";
import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { execFileSync, spawn } from "node:child_process";

// The audiobook's window-wide layers against the real screens and the complete client cascade:
// the player Listen opens and the Export sheet, from the door and from a chapter, at a phone, a
// tablet, a laptop and an ultrawide. Opened inside the door's title row — which enters with
// fy-fade-up, and a transformed ancestor contains a fixed descendant — the player was an
// invisible 847×39 box over the head and the sheet sat clipped at the top of the page (owner,
// 2026-10-03). Each layer must cover the window from the body. `--baseline <rev>` renders the
// changed screens as they were at <rev>, for the before pictures, and asserts nothing.
const root = fileURLToPath(new URL("../", import.meta.url));
const arg = (name) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : null);
const baselineRef = arg("--baseline");
const dir = arg("--out") !== null ? resolve(arg("--out")) : await mkdtemp(join(tmpdir(), "arke-audiobook-overlays-"));
await mkdir(dir, { recursive: true });
const BASELINE_FILES = [
  "packages/client/src/components/audiobook-player.tsx",
  "packages/client/src/components/audiobook-export.tsx",
  "packages/client/src/components/editor-dialog.tsx",
  "packages/client/src/screens/audiobook.tsx",
  "packages/client/src/screens/audiobook-narrator.tsx",
  "packages/client/src/screens/chapter-audiobook.tsx",
  "packages/client/src/screens/chapter-workspace.tsx",
  "packages/client/src/screens/fidelity.css",
];
const main = await readFile(join(root, "packages/client/src/main.tsx"), "utf8");
const styles = [...main.matchAll(/^import "([^"]+\.css)";/gm)].map((m) => m[0]).join("\n");
await build({
  stdin: { resolveDir: join(root, "packages/client/src"), loader: "tsx", contents: `
import React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { MemoryRouter } from "react-router";
import { App } from "./App";
import { __applyEventForTest, __setBridgeForTest, __setStateForTest, __connectionStatusForTest } from "./lib/store";
import { chapterLayoutFixture, CHAPTER_BODY, CHAPTER_HASH, chapterDoor } from "../test/chapter-layout-fixture";
${styles}
const AT = "2026-10-03T09:00:00Z";
const TARGET = "designed:dv_01M3WMVV9W7J85PPRYQJ0YB26G:1";
const TAKES = [21, 19, 0, 0];
let renderer;
window.settleLayout=async()=>{await new Promise(r=>setTimeout(r,450));await document.fonts.ready;await Promise.all([...document.images].map(i=>i.decode().catch(()=>{})));for(const a of document.getAnimations()){if(Number.isFinite(a.effect?.getComputedTiming().endTime))a.finish();else{a.pause();a.currentTime=0;}}};
function plan() {
  const block = (key, at, seconds, text) => ({ key, number: 1, file: "artifacts/" + key + ".wav", at, seconds, sentences: [{ at, text }] });
  return { productionId: "ledger", title: "The Ledger of Nights", cover: "world-art.png", chapters: [
    { chapterId: "neap", order: 1, title: "Neap", state: "read", seconds: 96, blocks: [block("title", 0, 4, "Chapter 1 · Neap"), block("p0.0", 4, 52, CHAPTER_BODY.split("\\n\\n")[0]), block("p1.0", 56, 40, CHAPTER_BODY.split("\\n\\n")[1])], gaps: [], pictures: [{ key: "p0.0", number: 2, file: "artifacts/shot12.png", at: 4, seconds: 92, short: false }], opening: "world-art.png" },
    { chapterId: "same-ink", order: 2, title: "The same ink", state: "read", seconds: 40, blocks: [block("t2", 0, 40, "Chapter 2 · The same ink")], gaps: [], pictures: [], opening: "world-art.png" },
    { chapterId: "nothing-wrong", order: 3, title: "Nothing wrong with it", state: "not read", seconds: 0, blocks: [], gaps: [{ at: 0, from: 1, to: 26 }], pictures: [], opening: "world-art.png" },
  ] };
}
window.mountLayout=async(route)=>{
  renderer?.unmount();
  try { localStorage.clear(); } catch {}
  const state=chapterLayoutFixture("normal"),world=state.world,book=world.productions[0];
  book.chapters=book.chapters.map((c,i)=>TAKES[i]>0?{...c,audiobook:{chapterVersion:c.version,hash:"h",updatedAt:AT,takes:TAKES[i],flagged:0}}:c);
  // A speaker given a designed voice with no label of its own (the owner's Ife).
  world.sheets=world.sheets.map(s=>s.id==="maren-kest"?{...s,voice:{provider:"google",model:"gemini-3.8-flash-tts",voiceId:TARGET,assignedAtVersion:s.version??1}}:s);
  world.designedVoices=[{kind:"designed",id:"dv_01M3WMVV9W7J85PPRYQJ0YB26G",revision:1,name:"Ife's voice",description:"Warm, unhurried Lagos storyteller.",language:"en-NG",provider:"google",model:"gemini-3.8-flash-tts",remoteId:"voice_mall1uvc7rp3",expiresAt:"2027-10-01T00:00:00Z",created:"2026-10-01T00:00:00Z",origin:"generated",sample:"voices/dv_01M3WMVV9W7J85PPRYQJ0YB26G.wav"}];
  const door=chapterDoor();
  door.rows=door.rows.map((row,i)=>({...row,made:Math.min(row.total,TAKES[i]),notMade:Math.max(0,row.total-TAKES[i]),seconds:TAKES[i]>0?[1864,1236][i]:null}));
  door.price={...door.price,chapters:1,blocks:26};
  const answer=(event)=>setTimeout(()=>__applyEventForTest({at:AT,...event}),5);
  window.commands=[];
  const bridge={connect(){},send(raw){const m=JSON.parse(raw);window.commands.push(m);
    if(m.kind==="open-chapter")answer({type:"chapter.open-result",requestId:m.requestId,worldId:m.worldId,productionId:m.productionId,chapterId:m.chapterId,disposition:"opened",body:CHAPTER_BODY,version:4,hash:CHAPTER_HASH,versions:[3,2],voices:{version:4,hash:CHAPTER_HASH,derivedAt:AT,passes:1,dropped:0,omitted:0,lines:[{speaker:"Maren Kest",sheet:"maren-kest",paragraph:1,occurrence:0,quote:"You do not read the ledger; you check it, the way you check a lock."}]}});
    if(m.kind==="voice-catalogue")answer({type:"voice.catalogue",worldId:m.worldId,voices:[{provider:"kokoro",model:"kokoro-82m",voiceId:"bm_george",label:"George",attributes:["British"],local:true,canClone:false,usedBy:[]},{provider:"google",model:"gemini-3.8-flash-tts",voiceId:TARGET,label:"Ife's voice",attributes:[],local:false,canClone:false,usedBy:[]}]});
    if(m.kind==="open-audiobook")answer({type:"audiobook.door",requestId:m.requestId,worldId:m.worldId,productionId:m.productionId,door});
    if(m.kind==="open-audiobook-listening")answer({type:"audiobook.listening",requestId:m.requestId,worldId:m.worldId,productionId:m.productionId,listening:plan()});
  },subscribe(){return()=>{};},coordinatorHttpBase:()=>location.origin};
  window.arke=bridge;__setBridgeForTest(bridge);__setStateForTest(state,{});__connectionStatusForTest("open");
  renderer=createRoot(document.getElementById("root"));
  flushSync(()=>renderer.render(<MemoryRouter initialEntries={["/w/"+world.meta.worldId+"/"+route]}><App/></MemoryRouter>));
  await window.settleLayout();
};
// Where a window-wide layer is: its box against the window, its parent, and the first ancestor
// that would contain a fixed descendant (a transform, a filter, layout or paint containment).
window.measureLayer=(selector)=>{
  const e=document.querySelector(selector);if(!e)return null;const r=e.getBoundingClientRect();
  let container=null;for(let a=e.parentElement;a&&a!==document.documentElement;a=a.parentElement){const s=getComputedStyle(a);if(s.transform!=="none"||s.filter!=="none"||/layout|paint|strict|content/.test(s.contain)||(s.containerType&&s.containerType!=="normal")||s.willChange.includes("transform")){container=a.className||a.tagName;break;}}
  return{x:r.x,y:r.y,width:r.width,height:r.height,viewport:[innerWidth,innerHeight],onBody:e.parentElement===document.body,inTitleRow:!!e.closest(".fy-h1row"),container};
};
` }, bundle: true, platform: "browser", format: "iife", define: { "import.meta.env": "{}" },
  plugins: [{ name: "fixture-cascade", setup(b) {
    b.onLoad({ filter: /\.(css|tsx?)$/ }, async ({ path }) => {
      const name = relative(root, path).replaceAll("\\", "/");
      const old = baselineRef !== null && BASELINE_FILES.includes(name);
      return { loader: path.endsWith(".css") ? "css" : "tsx", resolveDir: dirname(path), contents: old ? execFileSync("git", ["show", `${baselineRef}:${name}`], { cwd: root, encoding: "utf8" }) : await readFile(path, "utf8") };
    });
  } }], loader: { ".woff": "file", ".woff2": "file" }, outfile: join(dir, "view.js"),
});
await writeFile(join(dir, "index.html"), '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="view.css"></head><body><div id="root"></div><script src="view.js"></script></body></html>');
const chrome = process.env.ARKE_CHROME ?? (process.platform === "win32" ? "C:/Program Files/Google/Chrome/Application/chrome.exe" : process.platform === "darwin" ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : "/usr/bin/google-chrome");
await access(chrome);
const assets = join(root, "design-system/assets");
const server = createServer(async (req, res) => {
  try {
    const path = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
    // Fixture media: every picture the plan names is a frame from the design master; a take is not served.
    if (path.startsWith("/media/") && path.endsWith(".wav")) { res.writeHead(404); res.end(); return; }
    const file = path.startsWith("/media/") ? join(assets, path.includes("shot12") ? "scene4-shot12.png" : "saltlight-shot15.png") : join(dir, path === "/" ? "index.html" : path.slice(1));
    assert.ok([dir, assets].some((base) => { const rel = relative(base, file); return !rel.startsWith("..") && !isAbsolute(rel); }));
    res.setHeader("Content-Type", file.endsWith(".css") ? "text/css" : file.endsWith(".js") ? "text/javascript" : file.endsWith(".html") ? "text/html" : file.endsWith(".png") ? "image/png" : "application/octet-stream");
    res.end(await readFile(file));
  } catch { res.writeHead(404); res.end(); }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const origin = "http://127.0.0.1:" + server.address().port;
const child = spawn(chrome, ["--headless=new", "--enable-unsafe-swiftshader", "--autoplay-policy=no-user-gesture-required", "--no-first-run", "--no-default-browser-check", "--remote-debugging-port=0", "--user-data-dir=" + join(dir, "profile"), "about:blank"], { windowsHide: true, stdio: "ignore" });
let socket;
const settle = () => new Promise((r) => setTimeout(r, 150));
const until = async (f) => { const deadline = Date.now() + 20000; while (Date.now() < deadline) { try { const v = await f(); if (v) return v; } catch {} await settle(); } throw new Error("Timed out waiting for Chrome"); };
try {
  const port = await until(async () => (await readFile(join(dir, "profile/DevToolsActivePort"), "utf8")).split("\n")[0]);
  const targets = await (await fetch("http://127.0.0.1:" + port + "/json/list")).json();
  socket = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
  await new Promise((r, j) => { socket.onopen = r; socket.onerror = j; });
  let seq = 0; const pending = new Map();
  socket.onmessage = ({ data }) => { const m = JSON.parse(data), p = pending.get(m.id); if (p) { pending.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); } };
  const cdp = (method, params = {}) => new Promise((r, j) => { const id = ++seq; pending.set(id, { resolve: r, reject: j }); socket.send(JSON.stringify({ id, method, params })); });
  const js = async (expression) => { const r = await cdp("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails)); return r.result.value; };
  const capture = async (name) => { await js("document.fonts.ready"); await settle(); const { data } = await cdp("Page.captureScreenshot", { format: "png" }); await writeFile(join(dir, name + ".png"), Buffer.from(data, "base64")); };
  const click = async (selector) => {
    const point = await js(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)return null;e.scrollIntoView({block:"center",inline:"nearest"});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
    assert.ok(point, selector + " is on the page");
    for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) await cdp("Input.dispatchMouseEvent", { type, button: "left", clickCount: 1, ...point });
    await js("window.settleLayout()");
  };
  // The player's own Close, pressed whether or not its chrome is resting; it must leave nothing behind.
  const closePlayer = async () => { await js('document.querySelector(".abp [aria-label=Close]").click()'); await js("window.settleLayout()"); assert.equal(await js('!!document.querySelector(".fy-abplayer")'), false, "the player closed"); };
  const escape = async () => { for (const type of ["keyDown", "keyUp"]) await cdp("Input.dispatchKeyEvent", { type, key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 }); await js("window.settleLayout()"); };
  const covers = (layer, name) => {
    console.log(name, JSON.stringify(layer));
    if (baselineRef !== null) return;
    assert.ok(layer, name + " is open");
    assert.equal(layer.onBody, true, name + " is drawn on the body");
    assert.equal(layer.inTitleRow, false, name + " is not inside the title row");
    assert.equal(layer.container, null, name + " has no ancestor that contains a fixed layer");
    assert.deepEqual([layer.x, layer.y, layer.width, layer.height], [0, 0, ...layer.viewport], name + " covers the window");
  };
  await cdp("Page.enable");
  await cdp("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
  await cdp("Page.navigate", { url: origin + "/" }); await until(() => js('typeof window.mountLayout === "function"'));
  const records = [];
  for (const [name, width, height, mobile] of [["phone", 390, 844, true], ["tablet", 820, 1180, true], ["laptop", 1440, 900, false], ["ultrawide", 2560, 1080, false]]) {
    if (arg("--viewport") !== null && arg("--viewport") !== name) continue;
    await cdp("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile });
    await cdp("Emulation.setTouchEmulationEnabled", { enabled: mobile });
    await js('window.mountLayout("p/ledger/story/audiobook")');
    await capture(name + "-door");
    const head = await js('(()=>{const l=document.querySelector("[data-testid=audiobook-listen]");return l&&{primary:l.classList.contains("ui-btn--primary"),icon:!!l.querySelector("svg"),cast:document.querySelector("[data-testid=audiobook-voices]")?.textContent??""}})()');
    console.log(name, "door", JSON.stringify(head));
    if (baselineRef === null) {
      assert.equal(head?.primary, true, name + ": Listen leads the door");
      assert.equal(head?.icon, true, name + ": with a play icon");
    }
    await click('[data-testid="audiobook-listen"]');
    await until(() => js('!!document.querySelector(".abp")'));
    await js("window.settleLayout()");
    const player = await js('window.measureLayer(".fy-abplayer")');
    covers(player, name + " player");
    records.push({ name, layer: "player", ...player });
    await capture(name + "-player");
    await closePlayer();
    await click('[data-testid="audiobook-export-open"]');
    await js("window.settleLayout()");
    const sheet = await js('window.measureLayer(".fy-editordialog")');
    covers(sheet, name + " export sheet");
    const panel = await js('(()=>{const r=document.querySelector(".fy-editordialog__panel").getBoundingClientRect();return{left:r.left,right:innerWidth-r.right,top:r.top,bottom:innerHeight-r.bottom}})()');
    console.log(name, "export panel", JSON.stringify(panel));
    if (baselineRef === null) {
      assert.ok(panel.top >= 0 && panel.bottom >= 0, name + ": the sheet is inside the window");
      assert.ok(Math.abs(panel.left - panel.right) <= 1, name + ": the sheet is centred");
    }
    records.push({ name, layer: "export", ...sheet, panel });
    await capture(name + "-export");
    await escape();
    await js('window.mountLayout("p/ledger/story/chapters/neap?view=audiobook")');
    await capture(name + "-chapter");
    const chapterListen = await js('(()=>{const l=document.querySelector("[data-testid=audiobook-listen]");return l&&{primary:l.classList.contains("ui-btn--primary"),visible:l.getBoundingClientRect().width>0}})()');
    console.log(name, "chapter", JSON.stringify(chapterListen));
    if (chapterListen?.visible) {
      await click('[data-testid="audiobook-listen"]');
      await until(() => js('!!document.querySelector(".abp")'));
      await js("window.settleLayout()");
      const fromChapter = await js('window.measureLayer(".fy-abplayer")');
      covers(fromChapter, name + " player from a chapter");
      await capture(name + "-chapter-player");
      await closePlayer();
    }
    await js('window.mountLayout("p/ledger/story/chapters/neap")');
    const voices = await js('(()=>{const p=document.querySelector("[data-testid=chapter-voices]");if(!p||p.getBoundingClientRect().width===0)return null;p.scrollIntoView({block:"center"});return{text:p.textContent,overlaps:[...p.querySelectorAll(".fy-ch__who-head")].filter(h=>{const n=h.querySelector(".fy-ch__who-name > span:last-child")??h.querySelector(".fy-ch__who-name"),w=h.querySelector(".fy-ch__who-where");if(!n||!w)return false;const a=n.getBoundingClientRect(),b=w.getBoundingClientRect();return a.right>b.left+0.5&&b.right>a.left+0.5&&a.bottom>b.top+0.5&&b.bottom>a.top+0.5;}).length,cut:[...p.querySelectorAll(".fy-ch__who-name > span:last-child")].filter(e=>e.scrollWidth>e.clientWidth+1).map(e=>e.textContent)}})()');
    console.log(name, "voices", JSON.stringify(voices));
    if (voices !== null) {
      await capture(name + "-voices");
      if (baselineRef === null) {
        assert.doesNotMatch(voices.text, /designed:/, name + ": a designed voice is never named by its target");
        assert.match(voices.text, /Ife's voice/);
        assert.equal(voices.overlaps, 0, name + ": the speaker and the voice never overlap");
        assert.deepEqual(voices.cut, [], name + ": a speaker's name is never cut to fit its voice");
      }
    }
  }
  await writeFile(join(dir, "measurements.json"), JSON.stringify(records, null, 2));
  console.log(JSON.stringify({ directory: dir, checks: records.length, baseline: baselineRef }));
} finally { socket?.close(); child.kill(); await new Promise((r) => server.close(r)); }
