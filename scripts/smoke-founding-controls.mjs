import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtemp, readFile, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { parseHTML } from "linkedom";

// Issue 1324: real controls and complete styles at the two reported desktop sizes.
// All state is disposable; no world, model or remote host is opened.
const root = fileURLToPath(new URL("../", import.meta.url));
const dir = await mkdtemp(join(tmpdir(), "arke-founding-controls-"));
const main = await readFile(join(root, "packages/client/src/main.tsx"), "utf8");
const styles = [...main.matchAll(/^import "([^"]+\.css)";/gm)].map(match => match[0]).join("\n");
const { document: master } = parseHTML(await readFile(join(root, "design-system/Arke Studio.dc.html"), "utf8"));
const links = [...master.querySelectorAll("link[rel=stylesheet]")].map(link => link.outerHTML.replace('href="', 'href="/design/')).join("\n");
for (const id of ["189a", "189b", "189c", "189d"]) {
  const frame = master.getElementById(id).querySelector("[data-screen-label]");
  await writeFile(join(dir, id + ".html"), '<!doctype html><html><head><meta charset="utf-8">' + links + master.querySelector("#t189 style").outerHTML +
    '<style>body{margin:0}</style></head><body>' + frame.outerHTML.replaceAll('src="assets/', 'src="/design/assets/') + '</body></html>');
}
await build({ stdin: { resolveDir: join(root, "packages/client/src"), loader: "tsx", contents: `
import React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { MemoryRouter } from "react-router";
import { GenesisBlueprintSchema, newId } from "@arke-studio/contracts";
import { NewWorldScreen } from "./screens/shell";
import { SettingsRemoteAccessScreen } from "./screens/settings-remote-access";
import { SpeakerLinesDialog } from "./screens/chapter-audiobook";
import { __setBridgeForTest, __setStateForTest, __applyEventForTest, __connectionStatusForTest } from "./lib/store";
import { FIXTURE_STATE } from "../test/fixture-state";
${styles}
let renderer;
window.errors=[];
window.addEventListener("error", event => window.errors.push(event.message));
window.addEventListener("unhandledrejection", event => window.errors.push(String(event.reason)));
window.mountControls = async mode => {
  renderer?.unmount();
  const state = structuredClone(FIXTURE_STATE);
  state.app.health.harness = { status: "healthy" };
  state.app.harnessModelStatus = { status: "ready" };
  state.app.harnessModels = [{ id: "fixture-writing", provider: "ollama", displayName: "Fixture writing model", tools: true }];
  const at = new Date().toISOString();
  const bridge = { connect(){}, subscribe(){return()=>{};}, send(raw){
    const frame=JSON.parse(raw);
    if(frame.kind==="preview-audiobook-script") queueMicrotask(()=>__applyEventForTest({ type:"audiobook.script",at,
      worldId:frame.worldId,productionId:frame.productionId,requestId:frame.requestId,lines:31,chapters:9,recorded:17,awaiting:14,notCast:0 }));
  }, remoteAccess:async()=>({status:{enabled:mode==="remote-on",running:mode==="remote-on",url:null,port:9443,
    startOnLogin:false,startupSupported:true,pairingDuration:90,devices:[],pending:[]}}) };
  window.arke=bridge; __setBridgeForTest(bridge); __setStateForTest(state); __connectionStatusForTest("open");
  if(mode==="working") {
    __applyEventForTest({type:"genesis.loaded",at,genesisId:"gen-smoke",revision:1,conversationId:newId("cv"),
      blueprint:GenesisBlueprintSchema.parse({}),turns:[{id:newId("msg"),role:"user",text:"A city beneath the harbour.",at}],attachments:[],status:"running"});
    __applyEventForTest({type:"genesis.progress",at,genesisId:"gen-smoke",label:"Thinking"});
  }
  renderer=createRoot(document.getElementById("root"));
  flushSync(()=>renderer.render(<MemoryRouter initialEntries={["/new?draft=gen-smoke"]}>
    {mode.startsWith("remote")?<SettingsRemoteAccessScreen/>:mode==="lines"?<SpeakerLinesDialog worldId={state.world.meta.worldId}
      productionId="saltlight" speaker="maren" label="Maren" tone="1" onClose={()=>{}}/>:<NewWorldScreen/>}
  </MemoryRouter>));
  await new Promise(resolve=>setTimeout(resolve,250)); await document.fonts.ready;
};
` }, bundle: true, platform: "browser", format: "iife", define: { "import.meta.env": "{}" },
  loader: { ".woff": "dataurl", ".woff2": "dataurl" }, outfile: join(dir, "view.js") });
await writeFile(join(dir, "index.html"), '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="view.css"><style>html,body,#root{height:100%;margin:0}body:has(.remote-access){padding:32px;box-sizing:border-box}</style></head><body><div id="root"></div><script src="view.js"></script></body></html>');
const chrome = process.env.ARKE_CHROME ?? (process.platform === "win32" ? "C:/Program Files/Google/Chrome/Application/chrome.exe" : "/usr/bin/google-chrome");
await access(chrome);
const server = createServer(async (req, res) => {
  try {
    const path = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
    const file = path.startsWith("/design/") ? join(root, "design-system", path.slice(8)) : path.startsWith("/marks/") ? join(root, "packages/client/public", path.slice(1)) : join(dir, path === "/" ? "index.html" : path.slice(1));
    assert.ok([dir, join(root, "packages/client/public"), join(root, "design-system")].some(base => { const rel = relative(base, file); return !rel.startsWith("..") && !isAbsolute(rel); }));
    res.setHeader("Content-Type", file.endsWith(".css") ? "text/css" : file.endsWith(".js") ? "text/javascript" : file.endsWith(".svg") ? "image/svg+xml" : "text/html");
    res.end(await readFile(file));
  } catch { res.writeHead(404); res.end(); }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const child = spawn(chrome, ["--headless=new", "--no-first-run", "--no-default-browser-check", "--remote-debugging-port=0",
  "--user-data-dir=" + join(dir, "profile"), "about:blank"], { windowsHide: true, stdio: "ignore" });
let socket;
const until = async check => { const deadline = Date.now() + 20_000; while (Date.now() < deadline) { try { const value = await check(); if (value) return value; } catch {} await new Promise(resolve => setTimeout(resolve, 200)); } throw new Error("Chrome did not become ready"); };
try {
  const port = await until(async () => (await readFile(join(dir, "profile/DevToolsActivePort"), "utf8")).split("\n")[0]);
  const targets = await (await fetch("http://127.0.0.1:" + port + "/json/list")).json();
  socket = new WebSocket(targets.find(target => target.type === "page").webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  let seq = 0; const pending = new Map();
  socket.onmessage = ({ data }) => { const message = JSON.parse(data), request = pending.get(message.id); if (request) { pending.delete(message.id); message.error ? request.reject(new Error(JSON.stringify(message.error))) : request.resolve(message.result); } };
  const cdp = (method, params = {}) => new Promise((resolve, reject) => { const id = ++seq; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params })); });
  const js = async expression => { const result = await cdp("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails)); return result.result.value; };
  await cdp("Page.navigate", { url: "http://127.0.0.1:" + server.address().port + "/" });
  await until(() => js('typeof window.mountControls === "function"'));
  for (const [width, height] of [[1200, 791], [1600, 1000]]) {
    await cdp("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
    for (const mode of ["empty", "working", "remote-off", "remote-on", "lines"]) {
      await js('window.mountControls(' + JSON.stringify(mode) + ')');
      assert.deepEqual(await js("window.errors"), [], mode + " render errors");
      if (mode === "empty") {
        assert.ok(await js('!!document.querySelector("select[aria-label=\\"Writing model\\"]")'));
        assert.equal(await js('document.body.textContent.includes("Review world content")'), false);
        assert.equal(await js('document.body.textContent.includes("Available voices")'), false);
      }
      if (mode === "working") assert.ok(await js('!!document.querySelector("[role=textbox][contenteditable=false]")'), "working composer holds");
      if (mode.startsWith("remote")) {
        const rows = await js('Array.from(document.querySelectorAll(".fy-fact"), row=>({height:row.getBoundingClientRect().height,rule:getComputedStyle(row).borderBottomWidth,control:row.querySelector(".fy-default").getBoundingClientRect().width,state:row.querySelector(".fy-fact__state").getBoundingClientRect().x}))');
        assert.equal(rows.length, 3); assert.ok(rows.every(row => row.height >= 53 && row.rule === "1px" && row.control === 300));
        assert.equal(new Set(rows.map(row => row.state)).size, 1, "state column aligns");
      }
      if (mode === "lines") {
        assert.ok(await js('document.body.textContent.includes("31 lines · 9 chapters · 17 recorded · 14 awaiting")'));
        assert.equal(await js('getComputedStyle(document.querySelector(".fy-ab__speaker-dot")).width'), "8px");
      }
      const { data } = await cdp("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
      await writeFile(join(dir, `${mode}-${width}.png`), Buffer.from(data, "base64"));
    }
  }
  for (const id of ["189a", "189b", "189c", "189d"]) {
    await cdp("Emulation.setDeviceMetricsOverride", { width: 900, height: 900, deviceScaleFactor: 1, mobile: false });
    await cdp("Page.navigate", { url: "http://127.0.0.1:" + server.address().port + "/" + id + ".html" });
    await until(() => js('document.readyState === "complete" && !!document.querySelector(".v189")'));
    await js("document.fonts.ready");
    assert.ok(await js('Array.from(document.images).every(image=>image.complete&&image.naturalWidth>0)'), id + " artwork loaded");
    const { data } = await cdp("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    await writeFile(join(dir, id + ".png"), Buffer.from(data, "base64"));
  }
  console.log(JSON.stringify({ directory: dir, checks: 14 }));
} finally { socket?.close(); child.kill(); await new Promise(resolve => server.close(resolve)); }
