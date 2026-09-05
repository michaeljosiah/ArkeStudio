import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";

// Real file-backed Files cross the sandboxed context bridge. A VM cannot establish that
// webUtils still receives their native identity, or that file:// WebSockets actually connect.
const require = createRequire(import.meta.url);
const dir = await mkdtemp(join(tmpdir(), "arke-editor-import-"));
const withinTemp = relative(tmpdir(), dir);
if (withinTemp.startsWith("..") || isAbsolute(withinTemp)) throw new Error("Temporary smoke directory escaped its parent");
const preload = fileURLToPath(new URL("../dist/preload.cjs", import.meta.url));
try {
  await writeFile(join(dir, "index.html"), '<!doctype html><input id="files" type="file" multiple>');
  await writeFile(join(dir, "first.mp4"), "first source");
  await writeFile(join(dir, "second.mp4"), "second source");
  await writeFile(join(dir, "main.cjs"), `
const assert = require("node:assert/strict");
const { join } = require("node:path");
const { randomBytes } = require("node:crypto");
const { app, BrowserWindow, ipcMain } = require("electron");
const { WebSocketServer } = require(${JSON.stringify(require.resolve("ws"))});
app.disableHardwareAcceleration();
app.setPath("userData", join(__dirname, "profile"));
const timeout = setTimeout(() => { console.error("Editor import smoke timed out"); app.exit(1); }, 30000);
app.whenReady().then(async () => {
  const token = randomBytes(32).toString("hex");
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise(resolve => server.once("listening", resolve));
  let origin;
  const frames = [];
  const imported = new Promise(resolve => server.on("connection", (socket, request) => {
    origin = request.headers.origin;
    socket.on("message", bytes => { const frame = JSON.parse(bytes.toString()); frames.push(frame); if (frame.kind === "upload-artifacts") resolve(frame); });
  }));
  ipcMain.on("arke:startup-state-ready", event => event.sender.send("arke:startup-state", { status: "ready", port: server.address().port, token }));
  const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, preload: ${JSON.stringify(preload)} } });
  await window.loadFile(join(__dirname, "index.html"));
  await window.webContents.executeJavaScript('new Promise(resolve => window.arke.subscribe(() => {}, status => { if (status === "open") resolve(true); }))');
  window.webContents.debugger.attach("1.3");
  const { root } = await window.webContents.debugger.sendCommand("DOM.getDocument");
  const { nodeId } = await window.webContents.debugger.sendCommand("DOM.querySelector", { nodeId: root.nodeId, selector: "#files" });
  const paths = [join(__dirname, "first.mp4"), join(__dirname, "second.mp4")];
  await window.webContents.debugger.sendCommand("DOM.setFileInputFiles", { nodeId, files: paths });
  const result = await window.webContents.executeJavaScript(
    'window.arke.send(JSON.stringify({kind:"hello",lastSeq:0})); window.arke.importDroppedMedia({worldId:"world",requestId:"smoke",editor:{productionId:"film",destination:24,baseRevision:0,sourceFingerprint:"story-picture-v1:1234567890abcdef"}},Array.from(document.querySelector("#files").files))'
  );
  assert.deepEqual(result, { submitted: true, unresolved: [] });
  const frame = await imported;
  assert.equal(origin, "file://");
  assert.equal(frames[0].token, token);
  assert.deepEqual(frame.sourcePaths, paths);
  assert.equal(frame.editor.destination, 24);
  assert.equal(frame.requestId, "smoke");
  const publicState = await window.webContents.executeJavaScript('JSON.stringify(window.arke.startupState())');
  assert.equal(publicState, '{"status":"ready"}');
  window.destroy();
  for (const client of server.clients) client.terminate();
  await new Promise(resolve => server.close(resolve));
  clearTimeout(timeout);
  console.log("[smoke] sandboxed file page imports ordered native files without exposing paths or credentials");
  app.exit(0);
}).catch(error => { console.error(error); app.exit(1); });
`);
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(require("electron"), [join(dir, "main.cjs")], { stdio: "inherit", windowsHide: true, env });
  const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
  assert.equal(code, 0, "sandboxed editor import smoke failed");
} finally {
  // Only the newly created temporary directory; never a checkout or shared application profile.
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
