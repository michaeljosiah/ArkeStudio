import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { build } from "esbuild";
import { ClientMessageSchema } from "@arke-studio/contracts";
import { WorldStore } from "../packages/coordinator/src/world/store.js";
import { createChapter, createProduction, openChapter, saveChapter } from "../packages/coordinator/src/productions/ops.js";

// Opt-in native acceptance: actual editors, Electron visibility and the fenced chapter writer.
// Only a disposable copy of the repository fixture is opened. No provider or installed app runs.
const root = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(import.meta.url);
const directory = await mkdtemp(join(tmpdir(), "arke-hidden-autosave-"));
const within = relative(tmpdir(), directory);
if (within.startsWith("..") || isAbsolute(within)) throw new Error("Smoke directory escaped its parent");
let store: WorldStore | undefined;
let child: ReturnType<typeof spawn> | undefined;
try {
  const world = join(directory, "world");
  await cp(join(root, "fixtures/worlds/the-undersong"), world, { recursive: true });
  store = await WorldStore.open(world);
  await createProduction(store, { title: "Autosave smoke", format: "story" });
  await createChapter(store, "autosave-smoke", { title: "One", order: 1 });
  await saveChapter(store, "autosave-smoke", "one", "The lantern stayed alight.");
  const bundle = store.getBundle();
  await build({
    stdin: { resolveDir: join(root, "packages/client"), loader: "tsx", contents: `
import React from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Routes, Route } from "react-router";
import { ChapterScreen } from "./src/screens/chapter-workspace";
import { __setBridgeForTest, __setStateForTest, __applyEventForTest } from "./src/lib/store";
import { FIXTURE_STATE } from "./test/fixture-state";
const world = ${JSON.stringify(bundle)};
window.sent = [];
window.hiddenAt = null;
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") window.hiddenAt = performance.now();
});
__setBridgeForTest({ connect() {}, subscribe() {}, send(json) {
  const message = JSON.parse(json);
  window.sent.push({ ...message, sentAt: performance.now(), visibility: document.visibilityState });
  window.smoke.send(json);
} });
window.smoke.subscribe(event => __applyEventForTest(event));
__setStateForTest({ ...FIXTURE_STATE, world }, { connection: "open" });
createRoot(document.getElementById("root")).render(
  <MemoryRouter initialEntries={["/w/" + world.meta.worldId + "/p/autosave-smoke/story/chapters/one"]}>
    <Routes><Route path="/w/:worldId/p/:prodId/story/chapters/:chapterId" element={<ChapterScreen />} /></Routes>
  </MemoryRouter>);
` },
    bundle: true, outfile: join(directory, "view.js"), platform: "browser", format: "esm", external: ["/*.webp", "/*.png"],
    define: { "process.env.NODE_ENV": '"production"', "import.meta.env": "{}" },
    loader: { ".css": "empty", ".woff2": "dataurl" }, logLevel: "warning",
    plugins: [{ name: "unused-media-url", setup(build) {
      build.onResolve({ filter: /\?url$/ }, args => ({ path: args.path, namespace: "unused-media-url" }));
      build.onLoad({ filter: /.*/, namespace: "unused-media-url" }, () => ({ contents: 'export default "";' }));
    } }],
  });
  await writeFile(join(directory, "index.html"), '<!doctype html><meta charset="utf-8"><div id="root"></div><script type="module" src="view.js"></script>');
  await writeFile(join(directory, "preload.cjs"), `
const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("smoke", {
  send: json => ipcRenderer.send("smoke:command", json),
  subscribe: fn => ipcRenderer.on("smoke:event", (_event, value) => fn(value)),
});
`);
  await writeFile(join(directory, "main.cjs"), `
const assert = require("node:assert/strict");
const { app, BrowserWindow, ipcMain } = require("electron");
const { join } = require("node:path");
app.setPath("userData", join(__dirname, "profile"));
app.disableHardwareAcceleration();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let win;
const evaluate = code => win.webContents.executeJavaScript(code);
async function until(code) {
  const end = Date.now() + 10000;
  while (Date.now() < end) { if (await evaluate(code)) return; await sleep(25); }
  throw new Error("Timed out: " + code + " " + JSON.stringify({ minimized: win.isMinimized(), visible: win.isVisible(), throttling: win.webContents.getBackgroundThrottling(), page: await evaluate('({ visibility: document.visibilityState, sent: window.sent, text: document.body.textContent.slice(-1000) })') }));
}
ipcMain.on("smoke:command", (_event, json) => process.send({ command: json }));
process.on("message", value => { if (value.event && !win.isDestroyed()) win.webContents.send("smoke:event", value.event); });
app.whenReady().then(async () => {
  try {
    win = new BrowserWindow({ show: false, width: 1100, height: 800,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, preload: join(__dirname, "preload.cjs") } });
    win.webContents.on("console-message", details => { if (details.level === "error") console.error(details.message); });
    await win.loadFile(join(__dirname, "index.html"));
    win.show();
    await until('!!document.querySelector(".tiptap") && document.visibilityState === "visible"');
    const results = [];
    for (const mode of ["rich", "source"]) {
      if (mode === "source") {
        await evaluate('Array.from(document.querySelectorAll("button")).find(b => b.textContent === "Markdown source").click()');
        await until('!!document.querySelector("textarea.fy-ch__source")');
      }
      for (const transition of ["hide", "minimize"]) {
        console.log("Checking " + mode + " " + transition);
        const selector = mode === "rich" ? ".tiptap" : "textarea.fy-ch__source";
        await evaluate('{ window.sent.length = 0; window.hiddenAt = null; const editor = document.querySelector(' + JSON.stringify(selector) + '); editor.focus(); document.execCommand("selectAll"); }');
        await win.webContents.insertText("Synthetic " + mode + " " + transition + " saved before background timers.");
        win[transition]();
        await until('window.sent.some(m => m.kind === "save-chapter")');
        const sent = await evaluate('window.sent.find(m => m.kind === "save-chapter")');
        const hiddenAt = await evaluate('window.hiddenAt');
        if (transition === "hide") assert.equal(sent.visibility, "hidden");
        else assert.ok(win.isMinimized());
        // Some Windows display sessions keep a minimised renderer visible; then its normal
        // debounce still runs. A real hidden transition must flush before that debounce.
        if (hiddenAt !== null) assert.ok(sent.sentAt - hiddenAt < 500, "hide must flush before the 1200ms debounce: " + (sent.sentAt - hiddenAt));
        await until('document.body.textContent.includes("Saved · v")');
        results.push({ mode, transition, visibility: sent.visibility, flushMs: hiddenAt === null ? null : Math.round(sent.sentAt - hiddenAt) });
        // Another editor update must reach disk without a new visibility event.
        const count = await evaluate('window.sent.filter(m => m.kind === "save-chapter").length');
        await win.webContents.insertText(" Another hidden edit.");
        await until('window.sent.filter(m => m.kind === "save-chapter").length > ' + count + ' && document.body.textContent.includes("Saved · v")');
        win.restore(); win.show();
        await until('document.visibilityState === "visible"');
        await sleep(100);
      }
    }
    console.log(JSON.stringify({ host: "sandboxed Electron file page", results }));
    win.destroy(); app.exit(0);
  } catch (error) { console.error(error); app.exit(1); }
});
`);
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  child = spawn(require("electron") as string, [join(directory, "main.cjs")], { env, windowsHide: true, stdio: ["ignore", "inherit", "inherit", "ipc"] });
  const active = store;
  let commands = Promise.resolve();
  let saved = 0;
  const reply = (event: unknown) => {
    // A failed native assertion can close Electron while its last save is still landing.
    if (child?.connected) child.send({ event }, error => { if (error) console.error(error.message); });
  };
  child.on("message", (value: { command?: string }) => {
    if (!value.command) return;
    const message = ClientMessageSchema.parse(JSON.parse(value.command));
    commands = commands.then(async () => {
      const at = new Date().toISOString();
      if (message.kind === "open-chapter") {
        const { body, version, hash, versions } = await openChapter(active, "autosave-smoke", "one");
        reply({ body, version, hash, versions, at, type: "chapter.open-result", requestId: message.requestId,
          worldId: bundle.meta.worldId, productionId: "autosave-smoke", chapterId: "one", disposition: "opened" });
      } else if (message.kind === "save-chapter") {
        const result = await saveChapter(active, "autosave-smoke", "one", message.body, { baseHash: message.baseHash });
        const disk = await readFile(join(world, "productions/autosave-smoke/chapters/one.md"), "utf8");
        assert.ok(disk.includes(message.body), "the acknowledgement must follow persistence");
        saved++;
        reply({ ...result, at, type: "chapter.save-result", requestId: message.requestId,
          worldId: bundle.meta.worldId, productionId: "autosave-smoke", chapterFile: "one", disposition: "saved" });
      }
    }).catch(error => { console.error(error); child!.kill(); });
  });
  const deadline = setTimeout(() => child?.kill(), 90_000);
  const code = await new Promise<number | null>((resolve, reject) => { child!.once("error", reject); child!.once("exit", resolve); });
  clearTimeout(deadline);
  await commands;
  assert.equal(code, 0, "native autosave smoke exited successfully");
  assert.equal(saved, 8, "rich/source × hide/minimise × pending/background edits persisted");
  console.log(`Verified ${saved} chapter saves on disk.`);
} finally {
  if (child && child.exitCode === null) child.kill();
  await store?.close();
  await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
