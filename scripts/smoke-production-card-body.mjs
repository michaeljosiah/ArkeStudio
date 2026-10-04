import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { spawn } from "node:child_process";

const root = fileURLToPath(new URL("../", import.meta.url));
const dir = await mkdtemp(join(tmpdir(), "arke-production-card-"));
const styles = [...(await readFile(join(root, "packages/client/src/main.tsx"), "utf8")).matchAll(/^import "([^"]+\.css)";/gm)].map(match => match[0]).join("\n");
await build({ stdin: { resolveDir: join(root, "packages/client/src"), loader: "tsx", contents: `
import React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { MemoryRouter } from "react-router";
import { migrateLegacyScene } from "@arke-studio/contracts";
import { ProductionCardBody } from "./components/production-card-body";
import { __setStateForTest } from "./lib/store";
import { FIXTURE_STATE } from "../test/fixture-state";
${styles}
const state = structuredClone(FIXTURE_STATE), world = state.world, production = world.productions[0];
const scene = migrateLegacyScene({ id: "sc_review", slug: "review", number: 1, order: 1, title: "The forty-shot scene", status: "draft", version: 1,
  shots: Array.from({length:40}, (_, i) => ({id:"sh_"+(i+1),number:i+1,title:"Picture "+(i+1),description:"@maren-kest waits by the gate.",durationSec:4,framing:{size:"MCU",movement:"slow push"}})) });
__setStateForTest(state);
const action = { worldId: world.meta.worldId, productionId: production.meta.id, authority: {kind:"scene-store"} };
flushSync(() => createRoot(document.getElementById("root")).render(<MemoryRouter><article className="fy-actioncard"><h3>Resulting shot list</h3><ProductionCardBody action={action} preview={{kind:"scene",before:null,after:scene}} /></article></MemoryRouter>));
window.cardReady = true;
` }, bundle: true, platform: "browser", format: "iife", define: { "import.meta.env": "{}" }, loader: { ".woff": "file", ".woff2": "file" }, outfile: join(dir, "view.js") });
await writeFile(join(dir, "index.html"), '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="view.css"><style>body{margin:8px;background:var(--background)}#root{width:min(800px,100%);margin:auto}</style></head><body><div id="root"></div><script src="view.js"></script></body></html>');
const server = createServer(async (req, res) => {
  try {
    const name = new URL(req.url, "http://localhost").pathname.slice(1) || "index.html";
    if (!/^[\w.-]+$/.test(name)) throw new Error("Not a fixture asset");
    res.setHeader("Content-Type", name.endsWith(".js") ? "text/javascript" : name.endsWith(".css") ? "text/css" : name.endsWith(".html") ? "text/html" : "application/octet-stream");
    res.end(await readFile(join(dir, name)));
  } catch { res.writeHead(404); res.end(); }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const chrome = process.env.ARKE_CHROME ?? (process.platform === "win32" ? "C:/Program Files/Google/Chrome/Application/chrome.exe" : "/usr/bin/google-chrome");
const child = spawn(chrome, ["--headless=new", "--no-first-run", "--no-default-browser-check", "--remote-debugging-port=0", "--user-data-dir=" + join(dir, "profile"), "about:blank"], { windowsHide: true, stdio: "ignore" });
let socket;
const until = async read => { const end = Date.now() + 20_000; while (Date.now() < end) { try { const value = await read(); if (value) return value; } catch {} await new Promise(resolve => setTimeout(resolve, 100)); } throw new Error("Chrome did not become ready"); };
try {
  const port = await until(async () => (await readFile(join(dir, "profile/DevToolsActivePort"), "utf8")).split("\n")[0]);
  const targets = await (await fetch("http://127.0.0.1:" + port + "/json/list")).json();
  socket = new WebSocket(targets.find(target => target.type === "page").webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  let sequence = 0; const pending = new Map();
  socket.onmessage = ({ data }) => { const message = JSON.parse(data), request = pending.get(message.id); if (request) { pending.delete(message.id); message.error ? request.reject(message.error) : request.resolve(message.result); } };
  const cdp = (method, params = {}) => new Promise((resolve, reject) => { const id = ++sequence; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params })); });
  const evaluate = async expression => { const response = await cdp("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }); if (response.exceptionDetails) throw new Error(JSON.stringify(response.exceptionDetails)); return response.result.value; };
  await cdp("Page.enable"); await cdp("Page.navigate", { url: "http://127.0.0.1:" + server.address().port });
  await until(() => evaluate("window.cardReady"));
  const records = [];
  for (const width of [360, 390, 984, 1200]) {
    await cdp("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 1, mobile: false });
    await evaluate("document.fonts.ready");
    const metrics = await evaluate(`(() => { const list = document.querySelector('.fy-production-preview__rows'); const box = list.getBoundingClientRect(); list.scrollTop = list.scrollHeight;
      const last = document.querySelector('[data-testid="workspace-row-sh_40"]').getBoundingClientRect();
      return { width:innerWidth, rows:document.querySelectorAll('[data-testid^="workspace-row-"]').length,
        overflow:document.documentElement.scrollWidth>innerWidth, listWidth:box.width, scrollWidth:list.scrollWidth, scrollHeight:list.scrollHeight,
        bodiesContained:[...document.querySelectorAll('.fy-swrow__body')].every(body => {const b=body.getBoundingClientRect(); return b.left>=box.left && b.right<=box.right;}),
        lastVisible:last.top<box.bottom && last.bottom>box.top }; })()`);
    const capture = await cdp("Page.captureScreenshot", { format: "png" }); await writeFile(join(dir, `card-${width}.png`), Buffer.from(capture.data, "base64"));
    records.push(metrics); assert.equal(metrics.rows, 40); assert.equal(metrics.overflow, false, `viewport ${width}`);
    assert.ok(metrics.scrollWidth <= metrics.listWidth + 1, `card body ${width} overflows`); assert.equal(metrics.bodiesContained, true); assert.equal(metrics.lastVisible, true);
  }
  await writeFile(join(dir, "measurements.json"), JSON.stringify(records, null, 2));
  console.log(JSON.stringify({ directory: dir, records }));
} finally { socket?.close(); child.kill(); await new Promise(resolve => server.close(resolve)); }
