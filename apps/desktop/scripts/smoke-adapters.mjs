import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { FrameSchema } from "../../../packages/contracts/src/index.ts";
import { Coordinator } from "../../../packages/coordinator/src/coordinator.ts";
import { FsWorldProvider } from "../../../packages/coordinator/src/world/provider.ts";

// Real authenticated coordinator and built sandboxed file page, disposable settings only.
const root = fileURLToPath(new URL("../../../", import.meta.url));
const require = createRequire(import.meta.url);
const dir = await mkdtemp(join(tmpdir(), "arke-adapters-smoke-"));
const forbidden = async () => { throw new Error("This smoke must not generate"); };
const adapter = { id: "claude", capabilities: () => new Set(), init: async () => {}, readiness: () => ({ ready: true }),
  streamEvents: () => ({ async *[Symbol.asyncIterator]() {} }), createSession: forbidden, sendMessage: forbidden,
  dispatchAsync: forbidden, dispose: async () => {} };
const coordinator = new Coordinator({ provider: new FsWorldProvider(dir), adapter, appRoot: dir, appVersion: "smoke",
  changeLogPath: join(dir, "logs", "changes.jsonl"),
  transportAuth: { token: randomBytes(32).toString("hex"), allowedOrigins: ["file://", "null"] } });
try {
  const { port, token } = await coordinator.start();
  assert.ok(coordinator.getState().app.adapters, "The coordinator snapshot carries adapter authority");
  FrameSchema.parse({ kind: "snapshot", seq: 1, state: coordinator.getState() });
  await writeFile(join(dir, "main.cjs"), `(${electronMain.toString()})().catch(error => { console.error(error); require("electron").app.exit(1); });`);
  const child = spawn(require("electron"), [join(dir, "main.cjs")], { windowsHide: true, stdio: ["ignore", "inherit", "inherit"],
    env: { ...process.env, ARKE_ADAPTER_SMOKE: JSON.stringify({ port, token, dir,
      preload: join(root, "apps", "desktop", "dist", "preload.cjs"), page: join(root, "packages", "client", "dist", "index.html") }) } });
  assert.equal(await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); }), 0);
  const history = (await readFile(join(dir, "adapters", "decisions.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
  assert.ok(history.some(row => row.adultContent.enabled && row.adultContent.acknowledgedAt));
  assert.equal(history.at(-1).adultContent.enabled, false);
  console.log(`Adapter controls smoke passed; disposable profile and screenshots: ${dir}`);
} finally { await coordinator.stop(); }

async function electronMain() {
  const { app, BrowserWindow, ipcMain } = require("electron");
  const assert = require("node:assert/strict");
  const { writeFile } = require("node:fs/promises");
  const { join } = require("node:path");
  const config = JSON.parse(process.env.ARKE_ADAPTER_SMOKE);
  delete process.env.ARKE_ADAPTER_SMOKE;
  app.disableHardwareAcceleration();
  app.setPath("userData", join(config.dir, "profile"));
  const timeout = setTimeout(() => { console.error("Adapter controls smoke timed out"); app.exit(1); }, 90_000);
  await app.whenReady();
  ipcMain.on("arke:get-theme", event => { event.returnValue = { preference: "system", resolved: "light" }; });
  ipcMain.on("arke:startup-state-ready", event => { event.sender.send("arke:startup-state", { status: "ready", port: config.port, token: config.token }); });
  const window = new BrowserWindow({ show: false, width: 1200, height: 900,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, preload: config.preload } });
  window.webContents.on("console-message", (_event, level, message) => { if (level >= 2) console.error("renderer:", String(message).replace(/[a-f0-9]{64}/g, "[redacted]")); });
  const js = source => window.webContents.executeJavaScript(source);
  const until = async condition => {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) { if (await js(condition)) return; await new Promise(resolve => setTimeout(resolve, 100)); }
    await writeFile(join(config.dir, "failure.png"), (await window.webContents.capturePage()).toPNG());
    throw new Error(`Timed out: ${condition}\n${await js("document.body.innerText")}`);
  };
  const shot = async name => {
    await js("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
    await writeFile(join(config.dir, name + ".png"), (await window.webContents.capturePage()).toPNG());
  };
  await window.loadFile(config.page, { hash: "/settings/adapters" });
  await until("[...document.querySelectorAll('button')].some(b => b.textContent.includes('Enable adult content') && !b.disabled)");
  assert.equal(await js("document.querySelectorAll('article.fy-fact').length"), 0);
  await shot("off");
  await js("[...document.querySelectorAll('button')].find(b => b.textContent.includes('Enable adult content')).click()");
  await until("document.querySelector('[aria-labelledby=adult-content-title]') !== null");
  assert.ok(await js("(() => { const panel = document.querySelector('[aria-labelledby=adult-content-title]'); const box = panel.getBoundingClientRect(); return panel.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)); })()"), "acknowledgement is above the settings sheet");
  assert.equal(await js("document.querySelectorAll('[role=dialog] input[type=checkbox]').length"), 3);
  const enable = "[...document.querySelectorAll('[role=dialog] button')].find(b => b.textContent.trim() === 'Enable adult content')";
  assert.equal(await js(enable + ".disabled"), true);
  await js("[...document.querySelectorAll('[role=dialog] input[type=checkbox]')].slice(0,2).forEach(box => box.click())");
  assert.equal(await js(enable + ".disabled"), true);
  await js("document.querySelectorAll('[role=dialog] input[type=checkbox]')[2].click()");
  assert.equal(await js(enable + ".disabled"), false);
  await shot("acknowledgement");
  await js(enable + ".click()");
  await until("document.querySelectorAll('article.fy-fact').length === 14");
  assert.equal(await js("document.querySelector('[data-screen=settings-adapters]').scrollWidth <= document.querySelector('[data-screen=settings-adapters]').clientWidth + 2"), true, "catalogue fits the settings pane");
  assert.ok(await js("document.querySelector('article.fy-fact').getBoundingClientRect().width > 300"), "rows use the pane width");
  assert.ok(await js("document.body.innerText.includes('No compliance agent is connected')"));
  assert.equal(await js("[...document.querySelectorAll('article.fy-fact button')].filter(b => b.textContent === 'Install').every(b => b.disabled)"), true);
  await shot("catalogue");
  window.webContents.reload();
  await until("document.querySelectorAll('article.fy-fact').length === 14");
  await js("[...document.querySelectorAll('button')].find(b => b.textContent.includes('Turn off adult content')).click()");
  await until("document.querySelectorAll('article.fy-fact').length === 0");
  window.webContents.reload();
  await until("[...document.querySelectorAll('button')].some(b => b.textContent.includes('Enable adult content') && !b.disabled)");
  assert.equal(await js("document.querySelectorAll('article.fy-fact').length"), 0);
  clearTimeout(timeout);
  window.destroy();
  app.exit(0);
}
