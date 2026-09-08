import assert from "node:assert/strict";
import { cp, mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { EventEmitter, on } from "node:events";
import { Coordinator } from "../../../packages/coordinator/src/coordinator.ts";
import { FsWorldProvider } from "../../../packages/coordinator/src/world/provider.ts";

// Host Node owns the real coordinator; Electron exercises the built file page and sandboxed
// preload. The scripted writing harness makes this reproducible without paid provider calls.
const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL("../../../", import.meta.url));
const dir = await mkdtemp(join(tmpdir(), "arke-production-setup-"));
const withinTemp = relative(tmpdir(), dir);
if (withinTemp.startsWith("..") || isAbsolute(withinTemp)) throw new Error("Smoke directory escaped its parent");
const worldId = "01J8F3K2QW9VZX4N7M0RTYB6HC";
const worldDir = join(dir, "worlds", "the-undersong");
const bus = new EventEmitter();
let runs = 0;
const adapter = {
  id: "smoke", capabilities: () => new Set(["events"]), readiness: () => ({ ready: true }),
  knownInputTokenLimit: () => 128_000,
  createSession: async () => ({ sessionId: "setup-smoke" }),
  streamEvents: signal => (async function* () {
    try { for await (const [event] of on(bus, "event", { signal })) yield event; }
    catch (error) { if (error.name !== "AbortError") throw error; }
  })(),
  dispatchAsync: async ({ sessionId, parts }) => {
    runs++;
    const prompt = parts.map(part => part.text ?? "").join("");
    assert.match(prompt, /Current world records, read this turn/);
    assert.match(prompt, /the exact revision you may update/);
    bus.emit("event", { type: "message.completed", sessionId, text: JSON.stringify({
      reply: "The bell calls a ferryman home, but his return becomes a departure. We can develop the ending next.",
      candidateOperations: [], groupOperations: [],
      setupUpdate: { expectedRevision: 1, fields: { title: "The last crossing", kind: "film",
        narrative: { question: "What does it cost to return?", direction: "A return becomes a departure." },
        openQuestions: ["Who stays behind?"] },
        scenes: [
          { key: "arrival", title: "Arrival", synopsis: "The boat returns at dusk.", scriptBlocks: [{ id: "blk_arrival", kind: "action", text: "A rope falls into the water. The bell answers." }] },
          { key: "bell", title: "The bell", synopsis: "An answer arrives from the far shore." },
          { key: "departure", title: "Departure", synopsis: "The empty boat leaves." },
        ] },
    }) });
    return { ok: true };
  },
};
let coordinator;
let provider;
const observed = [];
try {
  await cp(join(root, "fixtures", "worlds", "the-undersong"), worldDir, { recursive: true });
  provider = new FsWorldProvider(dir);
  coordinator = new Coordinator({ provider, adapter,
    observeEvent: event => { observed.push({ type: event.type, detail: event.detail, status: event.state?.status }); }, transportAuth: { token: randomBytes(32).toString("hex"), allowedOrigins: ["file://", "null"] }, changeLogPath: join(dir, "logs", "changes.jsonl"), appVersion: "smoke" });
  const { port, token } = await coordinator.start();
  await writeFile(join(dir, "main.cjs"), `(${electronMain.toString()})().catch(error => { console.error(error); require("electron").app.exit(1); });`);
  // Private main-process environment, then private startup IPC. Windows Electron does not
  // expose the parent stdin pipe. No capability goes into process arguments or renderer URLs.
  const child = spawn(require("electron"), [join(dir, "main.cjs")], {
    windowsHide: true, stdio: ["ignore", "inherit", "inherit"],
    env: { ...process.env, ARKE_SMOKE_CONFIG: JSON.stringify({ port, token, worldId, dir,
      preload: join(root, "apps", "desktop", "dist", "preload.cjs"),
      page: join(root, "packages", "client", "dist", "index.html"),
    }) },
  });
  const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
  if (code !== 0) console.error(JSON.stringify({ observed, externalEdits: provider.openStore()?.getBundle().externalEdits }));
  assert.equal(code, 0);
  assert.equal(runs, 1, "one writing turn; no replay on review/create/reload");
  assert.equal(observed.some(event => /^(job|bench|render|take|provider-call)\./.test(event.type)), false, "setup starts no media work");
  const productionDir = join(worldDir, "productions", "the-last-crossing");
  const narrative = JSON.parse(await readFile(join(productionDir, "narrative.json"), "utf8"));
  assert.equal(narrative.direction, "A return becomes a departure.");
  const scene = JSON.parse(await readFile(join(productionDir, "scenes", "arrival.json"), "utf8"));
  assert.equal(scene.script.blocks[0].text, "A rope falls into the water. The bell answers.");
  console.log(`Production setup file-page smoke passed. Screenshots: ${dir}`);
} finally {
  await coordinator?.stop();
  await provider?.close();
  // Keep screenshots for inspection; the disposable world and private Electron profile go away.
  for (const name of ["worlds", "profile", "logs", "main.cjs"]) await rm(join(dir, name), { recursive: true, force: true });
}

async function electronMain() {
  const { app, BrowserWindow, ipcMain } = require("electron");
  const assert = require("node:assert/strict");
  const { writeFile } = require("node:fs/promises");
  const { join } = require("node:path");
  const config = JSON.parse(process.env.ARKE_SMOKE_CONFIG);
  delete process.env.ARKE_SMOKE_CONFIG;
  app.disableHardwareAcceleration();
  app.setPath("userData", join(config.dir, "profile"));
  const timer = setTimeout(() => { console.error("Production setup smoke timed out"); app.exit(1); }, 120_000);
  await app.whenReady();
  ipcMain.on("arke:startup-state-ready", event => {
    event.sender.send("arke:startup-state", { status: "ready", port: config.port, token: config.token });
  });
  const window = new BrowserWindow({ show: false, width: 1440, height: 1000,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, preload: config.preload } });
  window.webContents.on("console-message", (_event, level, message) => {
    if (level >= 2) console.error("renderer:", String(message).replace(/[a-f0-9]{64}/g, "[redacted]"));
  });
  const js = source => window.webContents.executeJavaScript(source);
  const until = async condition => {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (await js(condition)) return;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error(`Timed out: ${condition}\n${await js("document.body.innerText")}`);
  };
  const click = text => js(`[...document.querySelectorAll('button')].find(button => button.textContent.trim() === ${JSON.stringify(text)})?.click()`);
  const shot = async name => {
    await js("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
    await writeFile(join(config.dir, `${name}.png`), (await window.webContents.capturePage()).toPNG());
  };
  await window.loadFile(config.page, { hash: `/w/${config.worldId}/productions/new` });
  await until("[...document.querySelectorAll('button')].some(button => button.textContent.includes('Make a film'))");
  await js("[...document.querySelectorAll('button')].find(button => button.textContent.includes('Make a film')).click()");
  await until("document.body.innerText.includes('revision 1')");
  await js("document.querySelector('[role=textbox]').focus(); document.execCommand('insertText', false, 'A ferryman hears the bell calling him home. Develop three scenes for a short film.');");
  await until("!document.querySelector('button[aria-label=Send]').disabled");
  await js("document.querySelector('button[aria-label=Send]').click()");
  await until("document.body.innerText.includes('revision 2') && document.body.innerText.includes('Who stays behind?') && !document.body.innerText.includes('Thinking')");
  assert.ok(await js("document.querySelector('button[aria-label=Send]').getBoundingClientRect().bottom <= innerHeight"), "composer remains inside the window");
  assert.ok(await js("document.querySelector('#setup-outline').clientHeight < document.querySelector('#setup-outline').scrollHeight"), "outline independently scrolls");
  await shot("setup-wide");
  window.setContentSize(780, 900);
  await until("getComputedStyle(document.querySelector('.fy-production-setup__tabs')).display === 'flex'");
  await js("document.getElementById('setup-conversation-tab').focus()");
  window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Right" });
  window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Right" });
  await until("document.activeElement.id === 'setup-outline-tab' && document.getElementById('setup-outline-tab').getAttribute('aria-selected') === 'true'");
  assert.ok(await js("document.documentElement.scrollWidth <= innerWidth"), "narrow layout has no horizontal overflow");
  await shot("setup-narrow");
  await click("Review production");
  await until("[...document.querySelectorAll('button')].some(button => button.textContent === 'Create production' && !button.disabled)");
  await js("document.querySelector('.fy-production-setup__review').scrollIntoView()");
  await shot("setup-review");
  await click("Create production");
  await until("location.hash.endsWith('/p/the-last-crossing')");
  await js(`location.hash = '/w/${config.worldId}/p/the-last-crossing/story'`);
  await until("document.body.innerText.includes('From production setup')");
  await js("[...document.querySelectorAll('summary')].find(item => item.textContent === 'From production setup').click()");
  assert.ok(await js("document.body.innerText.includes('Who stays behind?')"), "creation keeps the open questions visible");
  await js(`location.hash = '/w/${config.worldId}/p/the-last-crossing/narrative'`);
  await until("document.querySelector('[data-screen=production-narrative] textarea')?.value === 'What does it cost to return?'");
  await js(`location.hash = '/w/${config.worldId}/p/the-last-crossing/scenes/sc_arrival'`);
  await until("document.body.innerText.includes('The boat returns at dusk.')");
  await window.webContents.reload();
  await until("document.body.innerText.includes('The boat returns at dusk.')");
  await shot("setup-created-scene");
  clearTimeout(timer);
  app.exit(0);
}
