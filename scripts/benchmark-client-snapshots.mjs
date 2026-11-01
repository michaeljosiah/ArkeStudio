import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { createServer } from "node:http";
import { spawn, execFileSync } from "node:child_process";

// A real chapter view, a 13+ MB world, and 50 snapshots through the real renderer store.
// Optional --baseline <git-ref> builds the earlier client source for the same measurement.
const root = process.cwd(), at = process.argv.indexOf("--baseline"), baseline = at < 0 ? null : process.argv[at + 1];
const out = process.argv.indexOf("--output"), output = out < 0 ? "output/client-snapshots.json" : process.argv[out + 1];
const dir = await mkdtemp(join(tmpdir(), "arke-snapshots-"));
const styles = [...(await readFile(join(root, "packages/client/src/main.tsx"), "utf8")).matchAll(/^import "([^"]+\.css)";/gm)].map(match => `import "${match[1].startsWith(".") ? "./src/" + match[1].slice(2) : match[1]}";`).join("\n");
await build({ stdin: { resolveDir: join(root, "packages/client"), loader: "tsx", contents: `
${styles}
import React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { MemoryRouter, Routes, Route } from "react-router";
import { ChapterScreen } from "./src/screens/chapter-workspace";
import { __setBridgeForTest, __setStateForTest, __applyEventForTest, __handleFrameForTest } from "./src/lib/store";
import { FIXTURE_STATE } from "./test/fixture-state";
const state = structuredClone(FIXTURE_STATE), world = state.world;
const hash = "sha256:" + "a".repeat(64), chapter = { id: "neap", file: "01-neap", order: 1, title: "The counting of bells", status: "drafted", version: 4, words: 2000, bodyHash: hash };
const base = world.productions.find(p => p.meta.id === "saltlight");
world.productions.push({ ...base, meta: { ...base.meta, id: "inkbound", title: "Inkbound", format: "story" }, story: { version: 3 }, chapters: [chapter] });
const artifact = world.artifacts[0];
world.artifacts = Array.from({length: 4904}, (_, i) => ({ ...artifact, id: "ar_" + String(i).padStart(26, "0"), generation: { source: "founding", jobId: state.app.jobs[0].id, genesisId: "fixture", target: "picture", label: "Picture", prompt: "A picture. ".repeat(245), provider: "replicate", model: "test", params: {}, links: [], estimatedMicroUsd: 0, costMicroUsd: 0 } }));
const sent = [];
__setBridgeForTest({ connect(){}, subscribe(){}, send(json){ sent.push(JSON.parse(json)); } });
__setStateForTest(state, {connection: "open"});
const renderer = createRoot(document.getElementById("root"));
flushSync(() => renderer.render(<MemoryRouter initialEntries={["/w/" + world.meta.worldId + "/p/inkbound/story/chapters/neap?view=audiobook"]}><Routes><Route path="/w/:worldId/p/:prodId/story/chapters/:chapterId" element={<ChapterScreen/>}/></Routes></MemoryRouter>));
setTimeout(() => {
 const request = sent.findLast(message => message.kind === "open-chapter");
 if (!request) throw new Error("Chapter did not open");
 flushSync(() => __applyEventForTest({ type: "chapter.open-result", at: "2026-11-01T00:00:00Z", requestId: request.requestId, worldId: world.meta.worldId, productionId: "inkbound", chapterId: "neap", disposition: "opened", body: Array.from({length: 100}, (_, i) => "Maren counted the bells beside the water. Paragraph " + i + ".").join("\\n\\n"), version: 4, hash, versions: [1,2,3] }));
 window.snapshotBytes = new TextEncoder().encode(JSON.stringify({kind:"snapshot",seq:1,state})).length;
 window.receiveSnapshot = seq => { const start = performance.now(); flushSync(() => __handleFrameForTest({kind:"snapshot",seq,state})); void document.body.offsetHeight; return performance.now() - start; };
 window.chapterReady = document.querySelector('[data-testid="chapter-workspace"]') !== null;
}, 100);
` }, outfile: join(dir, "app.js"), bundle: true, format: "iife", platform: "browser", external: ["/launch-harbour.webp", "/transition-coast.png"], loader: { ".woff": "file", ".woff2": "file" }, define: { "process.env.NODE_ENV": '"production"' },
  plugins: [{ name: "unused-preview-worker", setup(builder) {
    builder.onResolve({ filter: /\?url$/ }, args => ({ path: args.path, namespace: "preview-url" }));
    builder.onLoad({ filter: /.*/, namespace: "preview-url" }, () => ({ contents: 'export default "unused-preview-worker";', loader: "js" }));
  } }, ...(baseline ? [{ name: "baseline", setup(builder) { builder.onLoad({ filter: /packages[\\/]client[\\/]src[\\/].*\.[jt]sx?$/ }, args => {
    const path = relative(root, args.path).replaceAll("\\", "/");
    try { return { contents: execFileSync("git", ["show", `${baseline}:${path}`], { cwd: root, maxBuffer: 8 * 1024 ** 2 }).toString(), loader: path.endsWith("tsx") ? "tsx" : "ts" }; } catch { return undefined; }
  }); } }] : [])],
});
await writeFile(join(dir, "index.html"), '<!doctype html><html><head><link rel="stylesheet" href="/app.css"></head><body><div id="root"></div><script src="/app.js"></script></body></html>');
const server = createServer(async (req, res) => { try { const file = req.url === "/" ? "index.html" : req.url.slice(1); if (!/^[\w.-]+$/.test(file)) throw Error("Not a fixture asset"); res.setHeader("Content-Type", file.endsWith("js") ? "text/javascript" : file.endsWith("css") ? "text/css" : file.endsWith("html") ? "text/html" : "application/octet-stream"); res.end(await readFile(join(dir, file))); } catch { res.writeHead(404); res.end(); } });
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const chrome = process.env.ARKE_CHROME ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
const child = spawn(chrome, ["--headless=new", "--no-first-run", "--no-default-browser-check", "--remote-debugging-port=0", "--user-data-dir=" + join(dir, "profile"), "about:blank"], { windowsHide: true, stdio: "ignore" });
const until = async fn => { for (let n = 0; n < 200; n++) { try { const value = await fn(); if (value) return value; } catch {} await new Promise(resolve => setTimeout(resolve, 100)); } throw new Error("Browser did not become ready"); };
let socket;
try {
  const port = await until(async () => (await readFile(join(dir, "profile/DevToolsActivePort"), "utf8")).split("\n")[0]);
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  socket = new WebSocket(targets.find(target => target.type === "page").webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  let seq = 0; const pending = new Map();
  socket.onmessage = ({ data }) => { const message = JSON.parse(data), receiver = pending.get(message.id); if (receiver) { pending.delete(message.id); message.error ? receiver.reject(Error(JSON.stringify(message.error))) : receiver.resolve(message.result); } };
  const cdp = (method, params = {}) => new Promise((resolve, reject) => { const id = ++seq; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params })); });
  const js = async expression => { const result = await cdp("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (result.exceptionDetails) throw Error(JSON.stringify(result.exceptionDetails)); return result.result.value; };
  await cdp("Performance.enable");
  await cdp("Emulation.setDeviceMetricsOverride", { width: 1360, height: 900, deviceScaleFactor: 1, mobile: false });
  await cdp("Page.navigate", { url: `http://127.0.0.1:${server.address().port}` });
  await until(() => js("window.chapterReady && typeof window.receiveSnapshot === 'function'"));
  const bytes = await js("window.snapshotBytes"); assert(bytes > 13_000_000);
  const metrics = async () => Object.fromEntries((await cdp("Performance.getMetrics")).metrics.map(row => [row.name, row.value]));
  await js("window.receiveSnapshot(1)"); await cdp("HeapProfiler.collectGarbage");
  const before = await metrics(), timings = []; let peak = before.JSHeapUsedSize;
  for (let n = 2; n <= 51; n++) { timings.push(await js(`window.receiveSnapshot(${n})`)); peak = Math.max(peak, (await metrics()).JSHeapUsedSize); }
  await cdp("HeapProfiler.collectGarbage"); const after = await metrics(); timings.sort((a,b) => a-b);
  const report = { baseline, bytes, frames: timings.length, chapterParagraphs: 100, timingIncludesFixtureSerialization: true, meanMs: timings.reduce((sum,n) => sum+n, 0)/timings.length, p95Ms: timings[47], maxMs: timings.at(-1), heapBefore: before.JSHeapUsedSize, heapAfter: after.JSHeapUsedSize, peakHeap: peak };
  await writeFile(resolve(output), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
} finally { socket?.close(); child.kill(); await new Promise(resolve => server.close(resolve)); }
