import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { build } from "vite";
import { DEFAULT_STORY_PDF_SETTINGS } from "@arke-studio/contracts";
import { renderStoryPdf } from "../../coordinator/src/publications/story-pdf.js";
import { authenticatedMediaHeaders } from "../../../apps/desktop/src/transport-auth.js";

// Opt-in real-browser smoke. Synthetic content, isolated profile, no installed app or user world.
const root = fileURLToPath(new URL("../../../", import.meta.url));
const electron = process.argv.includes("--electron");
await mkdir(join(root, "tmp"), { recursive: true });
const directory = await mkdtemp(join(root, "tmp/pdf-client-smoke-"));
const result = await renderStoryPdf({ title: "The Lantern Keeper", subtitle: "", leftOut: 0, words: 60, chapters: [
  { title: "One · Across the water", words: 30, blocks: [{ kind: "paragraph", runs: [{ text: "Ọlá carried ₦2,600 through the rain. “Wait,” she said. The lantern held its small circle of light." }] }, { kind: "break" }, { kind: "paragraph", runs: [{ text: "A quiet promise.", italic: true }, { text: " A new beginning.", bold: true }] }] },
  { title: "Two · A door of her own", words: 30, blocks: [{ kind: "paragraph", runs: [{ text: "The key was warm in her palm. She opened the door, and the room was hers." }] }] },
] }, { author: "Synthetic acceptance fixture", language: "en", settings: DEFAULT_STORY_PDF_SETTINGS, chapterIds: ["one", "two"] });
await writeFile(join(directory, "story.pdf"), result.bytes);
const edition = { id: "00000000-0000-4000-8000-000000000001", worldId: "01J8G0000000000000000000A1", productionId: "lantern", createdAt: "2026-10-19T12:00:00Z", fingerprint: "a".repeat(64), status: "preview", phase: "Ready to preview",
  settings: { title: "The Lantern Keeper", author: "Synthetic acceptance fixture", language: "en", description: "", label: "Draft", cover: null, chapterIds: ["one", "two"], outputs: ["pdf"], pdf: DEFAULT_STORY_PDF_SETTINGS, avoidEmDashes: false },
  files: [{ format: "pdf", name: "story.pdf", bytes: result.bytes.byteLength, sha256: result.receipt.sha256, pdf: { pageCount: result.pageCount, chapters: result.chapters, pageLabels: result.pageLabels } }] };
const local = (path: string) => "./" + relative(directory, join(root, path)).replaceAll("\\", "/");
await writeFile(join(directory, "view.tsx"), `
import React from "react";
import { createRoot } from "react-dom/client";
import { StoryPdfPreview } from ${JSON.stringify(local("packages/client/src/components/story-pdf-preview.tsx"))};
import { StoryEditionFiles } from ${JSON.stringify(local("packages/client/src/components/story-publish.tsx"))};
import ${JSON.stringify(local("packages/client/src/theme/tokens/colors.css"))};
import ${JSON.stringify(local("packages/client/src/theme/tokens/typography.css"))};
import ${JSON.stringify(local("packages/client/src/theme/tokens/effects.css"))};
import ${JSON.stringify(local("packages/client/src/components/ui.css"))};
import ${JSON.stringify(local("packages/client/src/components/story-publish.css"))};
if (!window.arke) window.arke = {coordinatorHttpBase:()=>location.origin};
const edition = ${JSON.stringify(edition)};
createRoot(document.getElementById("root")).render(<main className="fy-publish"><h1>PDF preview</h1><StoryPdfPreview edition={edition}/><StoryEditionFiles edition={edition}/></main>);
window.fixtureReady = true;
`);
const sourceHtml = await readFile(join(root, "packages/client/index.html"), "utf8");
const csp = /content="(default-src[^"]+)"/.exec(sourceHtml)![1]!;
await writeFile(join(directory, "index.html"), `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="${csp}"><style>body{margin:0;background:var(--background);color:var(--foreground);font-family:system-ui}</style></head><body><div id="root"></div><script type="module" src="./view.tsx"></script></body></html>`);
await build({ root: directory, configFile: false, base: "./", logLevel: "warn", build: { outDir: "dist", emptyOutDir: true } });
const requests: string[] = [];
const capability = randomBytes(32).toString("hex"), fixtureCookie = randomBytes(16).toString("hex");
let authorizedPreviews = 0;
const server = createServer(async (request, response) => {
  const path = new URL(request.url!, "http://localhost").pathname;
  requests.push(path);
  try {
    if (path === `/story-preview-media/${edition.id}/story.pdf`) {
      if (request.headers.authorization !== `Bearer ${capability}` && !request.headers.cookie?.includes(`fixture=${fixtureCookie}`)) { response.writeHead(401); response.end(); return; }
      authorizedPreviews++;
      if (request.headers.origin === "null") response.setHeader("Access-Control-Allow-Origin", "null");
      response.setHeader("Content-Type", "application/pdf"); response.end(result.bytes); return;
    }
    const name = path.slice(1) || "index.html";
    if (!/^(?:assets\/)?[\w.-]+$/.test(name)) throw new Error("unknown file");
    response.setHeader("Content-Type", /\.m?js$/.test(name) ? "text/javascript" : name.endsWith(".css") ? "text/css" : name.endsWith(".html") ? "text/html" : "application/octet-stream");
    if (name === "index.html") response.setHeader("Set-Cookie", `fixture=${fixtureCookie}; HttpOnly; SameSite=Strict; Path=/`);
    response.end(await readFile(join(directory, "dist", name)));
  } catch { response.writeHead(404); response.end(); }
});
await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
const address = server.address() as { port: number }, origin = `http://127.0.0.1:${address.port}`;
const chrome = process.env.ARKE_CHROME ?? (process.platform === "win32" ? "C:/Program Files/Google/Chrome/Application/chrome.exe" : "/usr/bin/google-chrome");
if (electron) {
  await writeFile(join(directory, "preload.cjs"), `const { contextBridge } = require("electron"); contextBridge.exposeInMainWorld("arke", {coordinatorHttpBase:()=>${JSON.stringify(origin)}});`);
  await writeFile(join(directory, "electron.cjs"), `const {app,BrowserWindow,session}=require("electron"); app.disableHardwareAcceleration(); app.setPath("userData",${JSON.stringify(join(directory, "profile"))}); app.whenReady().then(async()=>{const window=new BrowserWindow({show:false,width:1100,height:950,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false,preload:${JSON.stringify(join(directory, "preload.cjs"))}}}); const headers=${authenticatedMediaHeaders.toString()}; session.defaultSession.webRequest.onBeforeSendHeaders((details,done)=>done({requestHeaders:headers(details,{port:${address.port},token:${JSON.stringify(capability)}},window.webContents.id)})); await window.loadFile(${JSON.stringify(join(directory, "dist/index.html"))});}); app.on("window-all-closed",()=>app.quit());`);
}
const executable = electron ? join(root, "node_modules/electron/dist", process.platform === "win32" ? "electron.exe" : "electron") : chrome;
const args = electron ? [join(directory, "electron.cjs"), "--remote-debugging-port=0"] : ["--headless=new", "--no-first-run", "--no-default-browser-check", "--remote-debugging-port=0", "--user-data-dir=" + join(directory, "profile"), "about:blank"];
const environment = { ...process.env }; delete environment.ELECTRON_RUN_AS_NODE;
const child = spawn(executable, args, { windowsHide: true, stdio: "ignore", env: environment });
let socket: WebSocket | undefined;
const errors: unknown[] = [], workerRequests: string[] = [];
const until = async (read: () => Promise<unknown>) => { const end = Date.now() + 20_000; while (Date.now() < end) { try { const value = await read(); if (value) return value; } catch {} await new Promise(resolve => setTimeout(resolve, 100)); } throw new Error("PDF browser fixture did not become ready: " + directory); };
try {
  const port = await until(async () => (await readFile(join(directory, "profile/DevToolsActivePort"), "utf8")).split("\n")[0]);
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json() as { type: string; webSocketDebuggerUrl: string }[];
  socket = new WebSocket(targets.find(target => target.type === "page")!.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket!.addEventListener("open", resolve, { once: true }); socket!.addEventListener("error", reject, { once: true }); });
  let sequence = 0; const pending = new Map<number, { resolve: (value: any) => void; reject: (error: unknown) => void }>();
  socket.addEventListener("message", ({ data }) => { const message = JSON.parse(String(data)), request = pending.get(message.id); if (request) { pending.delete(message.id); message.error ? request.reject(message.error) : request.resolve(message.result); } else if (message.method === "Runtime.exceptionThrown" || (message.method === "Log.entryAdded" && message.params.entry.level === "error")) errors.push(message); else if (message.method === "Network.requestWillBeSent" && /pdf\.worker.*\.mjs$/.test(message.params.request.url)) workerRequests.push(message.params.request.url); });
  const cdp = (method: string, params = {}): Promise<any> => new Promise((resolve, reject) => { const id = ++sequence; pending.set(id, { resolve, reject }); socket!.send(JSON.stringify({ id, method, params })); });
  const evaluate = async (expression: string) => { const value = await cdp("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }); if (value.exceptionDetails) throw new Error(JSON.stringify(value.exceptionDetails)); return value.result.value; };
  await cdp("Page.enable"); await cdp("Runtime.enable"); await cdp("Log.enable"); await cdp("Network.enable");
  const records: unknown[] = [];
  for (const width of [1100, 390, 320]) {
    await cdp("Emulation.setDeviceMetricsOverride", { width, height: 950, deviceScaleFactor: 1, mobile: false });
    await evaluate("window.fixtureReady = false");
    await cdp("Page.navigate", { url: electron ? pathToFileURL(join(directory, "dist/index.html")).href : origin });
    await until(() => evaluate("window.fixtureReady === true"));
    await until(() => evaluate('document.querySelector(".fy-pdf-status")?.textContent === "File page 1 of ' + result.pageCount + '"'));
    await new Promise(resolve => setTimeout(resolve, 250));
    await evaluate(`(()=>{const e=document.querySelector('.fy-pdf-chapters select');e.value='${result.chapters[0]!.physicalPage}';e.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await until(() => evaluate('document.querySelector(".fy-pdf-text")?.textContent.includes("₦2,600") && document.querySelector(".fy-pdf-viewport")?.getAttribute("aria-busy") === "false"'));
    await new Promise(resolve => setTimeout(resolve, 250));
    await until(() => evaluate('document.querySelector(".fy-pdf-text")?.textContent.includes("₦2,600") && document.querySelector(".fy-pdf-viewport")?.getAttribute("aria-busy") === "false"'));
    const geometry = await evaluate(`(()=>{const e=document.querySelector('.fy-pdf-preview'),r=e.getBoundingClientRect(),p=document.querySelector('.fy-pdf-text span'),pr=p?.getBoundingClientRect()??{width:0,height:0},c=document.querySelector('canvas');const range=document.createRange();range.selectNodeContents(document.querySelector('.fy-pdf-text'));getSelection().removeAllRanges();getSelection().addRange(range);return{left:r.left,right:r.right,overflow:document.documentElement.scrollWidth>innerWidth+1,textWidth:pr.width,textHeight:pr.height,selected:getSelection().toString(),canvasWidth:c.width,canvasHeight:c.height,native:!!document.querySelector('iframe,object,embed'),save:[...document.querySelectorAll('a')].some(a=>a.textContent.includes('Save'))};})()`);
    assert.ok(geometry.left >= 0 && geometry.right <= width + 1); assert.equal(geometry.overflow, false); assert.ok(geometry.textWidth > 0 && geometry.textHeight > 0); assert.match(geometry.selected, /₦2,600/); assert.equal(geometry.native, false); assert.equal(geometry.save, false);
    await evaluate("getSelection().removeAllRanges()");
    const capture = await cdp("Page.captureScreenshot", { format: "png" }); await writeFile(join(directory, `preview-${width}.png`), Buffer.from(capture.data, "base64"));
    if (width === 1100) {
      await evaluate(`(async()=>{const chapters=document.querySelector('.fy-pdf-chapters select'),zoom=document.querySelector('.fy-pdf-toolbar select');for(let i=0;i<12;i++){chapters.value=String(i%2?${result.chapters[0]!.physicalPage}:${result.chapters[1]!.physicalPage});chapters.dispatchEvent(new Event('change',{bubbles:true}));zoom.value=String(i%2?1:2);zoom.dispatchEvent(new Event('change',{bubbles:true}));await new Promise(requestAnimationFrame);}chapters.value='${result.chapters[1]!.physicalPage}';chapters.dispatchEvent(new Event('change',{bubbles:true}));zoom.value='1.5';zoom.dispatchEvent(new Event('change',{bubbles:true}));})()`);
      await until(() => evaluate(`document.querySelector('.fy-pdf-status')?.textContent==='File page ${result.chapters[1]!.physicalPage} of ${result.pageCount}' && document.querySelector('.fy-pdf-text')?.textContent.includes('the room was hers.')`));
      assert.equal(await evaluate("document.querySelector('[role=alert]')?.textContent??null"), null);
      assert.ok(await evaluate(`document.querySelector('canvas').width > ${geometry.canvasWidth}`));
    }
    await evaluate("document.querySelector('.fy-pdf-toolbar button').focus()");
    await cdp("Input.dispatchKeyEvent", { type: "keyDown", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
    assert.equal(await evaluate("document.activeElement.type"), "number");
    records.push({ width, ...geometry });
  }
  assert.ok(workerRequests.length, "the real bundled PDF worker loaded under the app CSP");
  assert.ok(authorizedPreviews >= 3);
  assert.equal(requests.some(path => path.startsWith("/story-edition-media")), false);
  assert.deepEqual(errors.filter(error => !JSON.stringify(error).includes("favicon")), []);
  await writeFile(join(directory, "evidence.json"), JSON.stringify({ records, requests, errors }, null, 2));
  console.log(JSON.stringify({ directory, host: electron ? "sandboxed Electron file page" : "Chrome", widths: [1100, 390, 320], pageCount: result.pageCount, worker: true, selectableText: true, previewOnly: true, authorizedPreviews }));
} catch (error) {
  await writeFile(join(directory, "failure.json"), JSON.stringify({ error: String(error), errors, workerRequests, requests }, null, 2));
  throw error;
} finally { socket?.close(); child.kill(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
