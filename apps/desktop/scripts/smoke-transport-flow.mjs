import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { build } from "esbuild";
import { Transport } from "../../../packages/coordinator/src/transport.ts";
import { ReadModel } from "../../../packages/coordinator/src/read-model.ts";

// Real sandboxed file page and built preload against the changed transport, without touching
// installed app data, publishing an endpoint or invoking a provider.
const require = createRequire(import.meta.url);
const dir = await mkdtemp(join(tmpdir(), "arke-transport-flow-"));
const within = relative(tmpdir(), dir);
if (within.startsWith("..") || isAbsolute(within)) throw new Error("Smoke directory escaped tmpdir");
const state = new ReadModel("transport-smoke").getState();
const at = "2026-10-16T10:00:00Z";
state.app.jobs = [{ id: "jb_01J8F3K2QW9VZX4N7M0RTYB6HC", idempotencyKey: "01J8F3K2QW9VZX4N7M0RTYB6HC",
  worldId: "01J8F3K2QW9VZX4N7M0RTYB6HC", target: { kind: "voice-preview" }, capability: "voice-tts",
  provider: "fixture", model: "fixture", params: { text: "private narrative ".repeat(100000), purpose: "audiobook", blocks: ["one", "two"] },
  estimatedMicroUsd: 123, status: "succeeded", providerJobId: null, attempt: 1, error: null, createdAt: at, updatedAt: at }];
state.app.ledger = [{ ts: at, worldId: state.app.jobs[0].worldId, jobId: state.app.jobs[0].id,
  provider: "fixture", model: "fixture", outcome: "succeeded", estimatedMicroUsd: 123, actualMicroUsd: 123 }];
const token = randomBytes(32).toString("hex");
const transport = new Transport({ auth: { token, allowedOrigins: ["file://", "null"] }, getSnapshot: () => state,
  onMessage: message => { if (message.kind === "refresh-diagnostics") transport.broadcastSnapshot(); },
  serveFile: async path => path === "/media/test/range.txt" ? { path: join(dir, "range.txt"), contentType: "text/plain" } : null });
try {
  await writeFile(join(dir, "range.txt"), "0123456789");
  await writeFile(join(dir, "index.html"), "<!doctype html><title>Transport smoke</title>");
  await build({ entryPoints: [fileURLToPath(new URL("../src/transport-auth.ts", import.meta.url))], bundle: true,
    platform: "node", format: "cjs", outfile: join(dir, "auth.cjs") });
  const port = await transport.start();
  const preload = fileURLToPath(new URL("../dist/preload.cjs", import.meta.url));
  await writeFile(join(dir, "main.cjs"), `
const assert = require("node:assert/strict");
const { join } = require("node:path");
const { app, BrowserWindow, ipcMain } = require("electron");
const { authenticatedMediaHeaders } = require("./auth.cjs");
app.disableHardwareAcceleration(); app.setPath("userData", join(__dirname, "profile"));
const timeout = setTimeout(() => { console.error("Transport smoke timed out"); app.exit(1); }, 30000);
const sessionReady = new Promise(resolve => process.once("message", resolve));
process.send("ready");
app.whenReady().then(async () => {
  const session = await sessionReady;
  ipcMain.on("arke:startup-state-ready", event => event.sender.send("arke:startup-state", { status: "ready", ...session }));
  ipcMain.on("arke:get-theme", event => { event.returnValue = { preference: "system", resolved: "light" }; });
  const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, preload: ${JSON.stringify(preload)} } });
  window.webContents.session.webRequest.onBeforeSendHeaders((details, callback) => callback({ requestHeaders: authenticatedMediaHeaders(details, session, window.webContents.id) }));
  await window.loadFile(join(__dirname, "index.html"));
  await window.webContents.executeJavaScript('window.framesSeen = []; new Promise(resolve => window.arke.subscribe(raw => window.framesSeen.push(JSON.parse(raw)), status => { if (status === "open") resolve(true); }))');
  const read = async (command, count) => window.webContents.executeJavaScript('window.arke.send(' + JSON.stringify(JSON.stringify(command)) + '); new Promise((resolve, reject) => { const deadline = Date.now()+5000; const poll = () => { if (window.framesSeen.length >= ' + count + ') resolve(window.framesSeen.at(-1)); else if (Date.now()>deadline) reject(new Error("No frame")); else setTimeout(poll,10); }; poll(); })');
  const first = await read({ kind: "hello", retainHistory: true }, 1);
  assert.equal(first.kind, "snapshot"); assert.equal(first.state.app.jobs.length, 1);
  assert.equal(first.state.app.jobs[0].params.text, undefined);
  assert.deepEqual(first.state.app.jobs[0].params.blocks, ["one", "two"]);
  const next = await read({ kind: "refresh-diagnostics" }, 2);
  assert.deepEqual(next.retainedHistory, ["jobs", "ledger"]); assert.deepEqual(next.state.app.ledger, []);
  const reset = await read({ kind: "hello", retainHistory: true }, 3);
  assert.equal(reset.retainedHistory, undefined); assert.equal(reset.state.app.ledger[0].actualMicroUsd, 123);
  const media = await window.webContents.executeJavaScript('fetch(window.arke.coordinatorHttpBase()+"/media/test/range.txt",{headers:{Range:"bytes=2-5"}}).then(async r=>({status:r.status,body:await r.text()}))');
  assert.deepEqual(media, { status: 206, body: "2345" });
  assert.ok(!JSON.stringify(first).includes(session.token));
  assert.equal(await window.webContents.executeJavaScript('typeof process'), "undefined");
  console.log("[smoke] sandboxed file-page hello, compact/retained history, reset and authenticated media range passed");
  window.destroy(); clearTimeout(timeout); app.exit(0);
}).catch(error => { console.error(error); app.exit(1); });
`);
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(require("electron"), [join(dir, "main.cjs")], { windowsHide: true, env, stdio: ["ignore", "inherit", "inherit", "ipc"] });
  child.on("message", message => { if (message === "ready") child.send({ port, token }); });
  const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
  assert.equal(code, 0, "transport file-page smoke failed");
} finally {
  await transport.stop();
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
