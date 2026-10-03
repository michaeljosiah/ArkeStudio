import assert from "node:assert/strict";
import { build } from "esbuild";
import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { execFileSync, spawn } from "node:child_process";

// Every window-wide dialog against the real screens and the complete client cascade: Export and
// Import manuscript, the Cut's export sheet and keyboard sheet, the voice catalogue and the clone
// dialog, at a phone, a tablet, a laptop and an ultrawide. A `position: fixed` layer is fixed to
// the window only while no ancestor has a transform, and every page head and column enters with
// `fy-fade-up`, whose transform Chrome keeps as the containing block after it settles — opened
// inside one, a dialog was a clipped box over that row (the audiobook Export, 2026-10-03).
// The animation is finished with the fixtures here, so each case gives every ancestor of the
// opener a transform of its own: the worst case the page can ever be in, and one that cannot
// pass unless the layer is drawn on the body. Each layer must then be on the body, uncontained,
// centred and fully on screen. `--baseline <rev>` renders the dialog sources as they were at
// <rev>, for the before pictures, and asserts nothing; `--out <dir>` keeps the screenshots.
const root = fileURLToPath(new URL("../", import.meta.url));
const arg = (name) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : null);
const baselineRef = arg("--baseline");
const dir = arg("--out") !== null ? resolve(arg("--out")) : await mkdtemp(join(tmpdir(), "arke-dialog-overlays-"));
await mkdir(dir, { recursive: true });
const BASELINE_FILES = [
  "packages/client/src/components/editor-dialog.tsx",
  "packages/client/src/components/clone-voice-dialog.tsx",
  "packages/client/src/screens/character-voice.tsx",
  "packages/client/src/screens/character-pages.css",
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
import { chapterLayoutFixture } from "../test/chapter-layout-fixture";
import { cutLayoutFixture } from "../test/cut-layout-fixture";
${styles}
const AT = "2026-10-03T09:00:00Z";
let renderer;
window.settleLayout=async()=>{await new Promise(r=>setTimeout(r,450));await document.fonts.ready;for(const a of document.getAnimations()){if(Number.isFinite(a.effect?.getComputedTiming().endTime))a.finish();else{a.pause();a.currentTime=0;}}};
window.mountLayout=async(fixture,route)=>{
  renderer?.unmount();
  try { localStorage.clear(); } catch {}
  const state=fixture==="cut"?cutLayoutFixture():chapterLayoutFixture("normal"),world=state.world;
  const answer=(event)=>setTimeout(()=>__applyEventForTest({at:AT,...event}),5);
  const bridge={connect(){},send(raw){const m=JSON.parse(raw);
    if(m.kind==="voice-catalogue")answer({type:"voice.catalogue",worldId:m.worldId,voices:[{provider:"kokoro",model:"kokoro-82m",voiceId:"bm_george",label:"George",attributes:["British"],local:true,canClone:false,usedBy:[]}]});
  },subscribe(){return()=>{};},coordinatorHttpBase:()=>location.origin};
  window.arke=bridge;__setBridgeForTest(bridge);__setStateForTest(state,{});__connectionStatusForTest("open");
  renderer=createRoot(document.getElementById("root"));
  flushSync(()=>renderer.render(<MemoryRouter initialEntries={["/w/"+world.meta.worldId+"/"+route]}><App/></MemoryRouter>));
  await window.settleLayout();
};
// The worst case a page can be in: every ancestor of the opener carries a transform, as the
// fy-fade-up columns do until the animation is dropped.
window.transformAncestors=(selector)=>{
  const e=document.querySelector(selector);if(!e)return 0;let n=0;
  for(let a=e.parentElement;a&&a!==document.body&&a!==document.documentElement;a=a.parentElement){a.style.transform="translateY(0.5px)";n++;}
  return n;
};
window.openerByText=(text)=>{
  const e=[...document.querySelectorAll("button")].find(b=>b.textContent.includes(text)&&b.getBoundingClientRect().width>0);
  if(!e)return null;e.setAttribute("data-smoke-opener","");return true;
};
// Where a layer is: its box against the window, whether the body holds it, and the first
// ancestor that would contain a fixed descendant (a transform, a filter, containment).
window.measureLayer=(selector,panelSelector)=>{
  const e=document.querySelector(selector);if(!e)return null;
  // The window the layer fills: the layout viewport, less a classic scrollbar if the page has one.
  const W=document.documentElement.clientWidth,H=document.documentElement.clientHeight;
  const r=e.getBoundingClientRect(),p=(panelSelector?document.querySelector(panelSelector):e).getBoundingClientRect();
  let container=null;for(let a=e.parentElement;a&&a!==document.documentElement;a=a.parentElement){const s=getComputedStyle(a);if(s.transform!=="none"||s.filter!=="none"||/layout|paint|strict|content/.test(s.contain)||(s.containerType&&s.containerType!=="normal")||s.willChange.includes("transform")){container=a.className||a.tagName;break;}}
  const top=e.matches("dialog")||e.closest("dialog")!==null;
  return{layer:{x:r.x,y:r.y,width:r.width,height:r.height},panel:{x:p.x,y:p.y,width:p.width,height:p.height,left:p.left,right:W-p.right,top:p.top,bottom:H-p.bottom},viewport:[W,H],scrim:e.classList.contains("fy-editordialog"),onBody:e.parentElement===document.body||top,container:top?null:container};
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
const server = createServer(async (req, res) => {
  try {
    const path = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
    const file = join(dir, path === "/" ? "index.html" : path.slice(1));
    assert.ok(!relative(dir, file).startsWith(".."));
    res.setHeader("Content-Type", file.endsWith(".css") ? "text/css" : file.endsWith(".js") ? "text/javascript" : file.endsWith(".html") ? "text/html" : "application/octet-stream");
    res.end(await readFile(file));
  } catch { res.writeHead(404); res.end(); }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const origin = "http://127.0.0.1:" + server.address().port;
const child = spawn(chrome, ["--headless=new", "--enable-unsafe-swiftshader", "--no-first-run", "--no-default-browser-check", "--remote-debugging-port=0", "--user-data-dir=" + join(dir, "profile"), "about:blank"], { windowsHide: true, stdio: "ignore" });
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
  const press = async (key, code, windowsVirtualKeyCode, text) => { for (const type of ["keyDown", "keyUp"]) await cdp("Input.dispatchKeyEvent", { type, key, code, windowsVirtualKeyCode, ...(type === "keyDown" && text ? { text } : {}) }); await js("window.settleLayout()"); };
  const click = async (selector) => {
    const point = await js(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)return null;e.scrollIntoView({block:"center",inline:"nearest"});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
    assert.ok(point, selector + " is on the page");
    for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) await cdp("Input.dispatchMouseEvent", { type, button: "left", clickCount: 1, ...point });
    await js("window.settleLayout()");
  };
  // Each case: where the screen is, what opens the layer (a selector, or the text of a button),
  // and which element is the layer and which is its panel. `modal` layers are centred in the
  // window from a tablet up; a phone draws them as a sheet from the bottom.
  const CASES = [
    { name: "export-manuscript", fixture: "story", route: "p/ledger/story/chapters", opener: { selector: '[data-testid="export-manuscript"]', phone: [".fy-chapters-more", "Export"] }, layer: ".fy-editordialog", panel: ".fy-editordialog__panel", modal: true },
    { name: "import-manuscript", fixture: "story", route: "p/ledger/story/chapters", opener: { selector: '[data-testid="import-manuscript"]', phone: [".fy-chapters-more", "Import"] }, layer: ".fy-editordialog", panel: ".fy-editordialog__panel", modal: true },
    { name: "cut-export", fixture: "cut", route: "p/saltlight/cut", opener: { selector: ".fy-cuthead > .ui-btn--primary", phone: [".fy-cut-back > .ui-btn"] }, layer: ".fy-editordialog, dialog[open]", panel: ".fy-editordialog__panel, dialog[open]", modal: "desktop" },
    { name: "cut-keys", fixture: "cut", route: "p/saltlight/cut", key: "?", minWidth: 1100, layer: ".fy-editordialog", panel: ".fy-editordialog__panel", modal: true },
    { name: "voice-catalogue", fixture: "story", route: "cast/maren-kest/voice", opener: { text: "Choose a voice" }, layer: ".fy-voicesheet", panel: ".fy-voicesheet", modal: "desktop" },
    { name: "voice-clone", fixture: "story", route: "cast/maren-kest/voice", opener: { text: "Clone a voice" }, layer: ".fy-clone", panel: ".fy-clone", modal: "desktop" },
  ];
  const records = [];
  const check = (record, name, kase, width) => {
    console.log(name, JSON.stringify(record));
    if (baselineRef !== null) return;
    assert.ok(record, name + " is open");
    assert.equal(record.onBody, true, name + " is drawn on the body");
    assert.equal(record.container, null, name + " has no ancestor that contains a fixed layer");
    const [vw, vh] = record.viewport, p = record.panel;
    assert.ok(p.left >= -0.5 && p.right >= -0.5, name + ": inside the window horizontally");
    assert.ok(p.top >= -0.5 && p.bottom >= -0.5, name + ": inside the window vertically");
    assert.ok(Math.abs(p.left - p.right) <= 1.5, name + ": centred across the window");
    const centredDown = kase.modal === true || (kase.modal === "desktop" && width >= 600);
    if (centredDown) assert.ok(Math.abs(p.top - p.bottom) <= 2.5 || p.height >= vh - 1, name + ": centred down the window");
    if (record.scrim) assert.deepEqual([Math.round(record.layer.x), Math.round(record.layer.y), Math.round(record.layer.width), Math.round(record.layer.height)], [0, 0, vw, vh], name + ": the scrim covers the window");
  };
  await cdp("Page.enable");
  await cdp("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
  await cdp("Page.navigate", { url: origin + "/" }); await until(() => js('typeof window.mountLayout === "function"'));
  for (const [vname, width, height, mobile] of [["phone", 390, 844, true], ["tablet", 820, 1180, true], ["laptop", 1440, 900, false], ["ultrawide", 2560, 1080, false]]) {
    if (arg("--viewport") !== null && arg("--viewport") !== vname) continue;
    await cdp("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile });
    await cdp("Emulation.setTouchEmulationEnabled", { enabled: mobile });
    for (const kase of CASES) {
      if (kase.minWidth !== undefined && width < kase.minWidth) continue;
      const name = vname + " " + kase.name;
      await js(`window.mountLayout(${JSON.stringify(kase.fixture)}, ${JSON.stringify(kase.route)})`);
      if (kase.key !== undefined) {
        await js('window.transformAncestors(".fy-timeline, .fy-cutviewer")');
        await press(kase.key, "Slash", 191, kase.key);
      } else {
        const opener = kase.opener;
        // Where the opener is at this width: the phone folds some actions into a menu.
        let selector = opener.selector;
        if (opener.text !== undefined) { assert.ok(await js(`window.openerByText(${JSON.stringify(opener.text)})`), name + ": " + opener.text + " is on the page"); selector = "[data-smoke-opener]"; }
        else if (mobile && width < 600 && opener.phone !== undefined) {
          if (opener.phone.length === 2) {
            await js(`window.transformAncestors(${JSON.stringify(opener.phone[0])})`);
            await click(opener.phone[0]);
            assert.ok(await js(`window.openerByText(${JSON.stringify(opener.phone[1])})`), name + ": " + opener.phone[1] + " is in the menu");
            selector = "[data-smoke-opener]";
          } else selector = opener.phone[0];
        }
        await js(`window.transformAncestors(${JSON.stringify(selector)})`);
        await click(selector);
      }
      await js("window.settleLayout()");
      const record = await js(`window.measureLayer(${JSON.stringify(kase.layer)}, ${JSON.stringify(kase.panel)})`);
      check(record, name, kase, width);
      records.push({ name, ...record });
      await capture(vname + "-" + kase.name);
    }
  }
  await writeFile(join(dir, "measurements.json"), JSON.stringify(records, null, 2));
  console.log(JSON.stringify({ directory: dir, checks: records.length, baseline: baselineRef }));
} finally { socket?.close(); child.kill(); await new Promise((r) => server.close(r)); }
