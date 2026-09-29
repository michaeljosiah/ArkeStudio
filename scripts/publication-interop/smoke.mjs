import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { build } from "esbuild";

const folder = resolve(process.argv[2] ?? "");
assert.ok(process.argv[2], "Usage: node smoke.mjs <generated fixture directory>");
await build({ entryPoints: [fileURLToPath(new URL("reader.mjs", import.meta.url))], bundle: true, format: "esm", outfile: join(folder, "reader.js"), loader: { ".css": "text" } });
await writeFile(join(folder, "reader.html"), '<!doctype html><meta charset="utf-8"><title>Readium interoperability fixture</title><style>body{font:16px sans-serif;margin:20px}#book{position:relative;width:640px;height:640px;border:1px solid #aaa}#book iframe{border:0}pre{white-space:pre-wrap}</style><h1>Readium interoperability fixture</h1><div style="width:640px;height:640px"><div id="book"></div></div><pre id="result">Testing…</pre><script type="module" src="reader.js"></script>');
// A loopback-only synthetic-fixture server, never a production publication host.
const allowed = new Set(await readdir(folder));
const mime = { ".html": "text/html", ".js": "text/javascript", ".json": "application/json", ".xhtml": "application/xhtml+xml", ".svg": "image/svg+xml", ".mp3": "audio/mpeg" };
const server = createServer(async (request, response) => {
  const name = (request.url ?? "").slice(1);
  if (!allowed.has(name) || !["GET", "HEAD"].includes(request.method)) { response.writeHead(404).end(); return; }
  try {
    const bytes = await readFile(join(folder, name));
    const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range ?? "");
    const start = range ? Number(range[1]) : 0;
    const end = range?.[2] ? Math.min(Number(range[2]), bytes.length - 1) : bytes.length - 1;
    if (start > end || start >= bytes.length) { response.writeHead(416, { "Content-Range": `bytes */${bytes.length}` }).end(); return; }
    response.writeHead(range ? 206 : 200, { "Content-Type": mime[extname(name)] ?? "application/octet-stream",
      "Content-Length": end - start + 1, "Accept-Ranges": "bytes",
      ...(range ? { "Content-Range": `bytes ${start}-${end}/${bytes.length}` } : {}) });
    response.end(request.method === "HEAD" ? undefined : bytes.subarray(start, end + 1));
  }
  catch { response.writeHead(500).end(); }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const main = join(folder, "smoke.cjs");
await writeFile(main, `const { app, BrowserWindow } = require('electron');
const { writeFile } = require('node:fs/promises');
app.commandLine.appendSwitch('autoplay-policy','no-user-gesture-required');
app.whenReady().then(async () => {
  const win = new BrowserWindow({show:false,width:1100,height:1000,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
  const blocked=[];
  win.webContents.session.webRequest.onBeforeRequest((details, callback) => {
    const permitted=details.url.startsWith(${JSON.stringify(origin + "/")}) || /^(blob:|data:|about:)/.test(details.url);
    if(!permitted) blocked.push(details.url); callback({cancel:!permitted});
  });
  try {
    await win.loadURL(${JSON.stringify(origin + "/reader.html")});
    const until=Date.now()+60000;
    while(Date.now()<until) {
      const state=await win.webContents.executeJavaScript('({result:window.interopResult,error:window.interopError})');
      if(state.error) throw new Error(state.error);
      if(state.result) {
        state.result.blockedExternalRequests=blocked;
        await writeFile(${JSON.stringify(join(folder, "reader-results.json"))},JSON.stringify(state.result,null,2)+'\\n');
        await win.webContents.executeJavaScript('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
        await writeFile(${JSON.stringify(join(folder, "reader.png"))},(await win.webContents.capturePage()).toPNG());
        console.log(JSON.stringify(state.result)); app.exit(0); return;
      }
      await new Promise(resolve=>setTimeout(resolve,100));
    }
    throw new Error('Readium smoke timed out');
  } catch(error) { console.error(error); app.exit(1); }
});`);
try {
  const require = createRequire(import.meta.url);
  const code = await new Promise((resolve, reject) => {
    const environment = { ...process.env }; delete environment.ELECTRON_RUN_AS_NODE;
    const child = spawn(require("electron"), [main], { windowsHide: true, env: environment, stdio: "inherit" });
    child.on("error", reject); child.on("exit", resolve);
  });
  assert.equal(code, 0, "Readium reader smoke must pass");
} finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
