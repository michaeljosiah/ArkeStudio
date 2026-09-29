import assert from "node:assert/strict";
import { cp, mkdtemp, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { ROSTER, agentForPurpose } from "../../../packages/contracts/src/index.ts";
import { Coordinator } from "../../../packages/coordinator/src/coordinator.ts";
import { FsWorldProvider } from "../../../packages/coordinator/src/world/provider.ts";

// The real transport, coordinator, settings and production gate behind a sandboxed file page.
// Discovery is scripted, so these UI assertions never depend on a subscription or paid turn.
const root = fileURLToPath(new URL("../../../", import.meta.url));
const require = createRequire(import.meta.url);
const dir = await mkdtemp(join(tmpdir(), "arke-harness-models-"));
const worldId = "01J8F3K2QW9VZX4N7M0RTYB6HC";
await cp(join(root, "fixtures", "worlds", "the-undersong"), join(dir, "worlds", "the-undersong"), { recursive: true });
let ready = false;
const models = [
  { provider: "anthropic", id: "claude-sonnet-live", displayName: "Sonnet live", inputModalities: ["text", "image"], isDefault: true },
  { provider: "anthropic", id: "claude-opus-live[1m]", displayName: "Opus live", inputModalities: ["text", "image"] },
  { provider: "anthropic", id: "claude-fable-live[1m]", displayName: "Fable live" },
];
const adapter = {
  id: "claude", capabilities: () => new Set(["events", "models"]),
  init: async () => { ready = true; },
  readiness: () => ({ ready, ...(ready ? {} : { reason: "not initialized" }) }),
  listModels: async () => {
    // Optional fixture latency exercises controls while a real asynchronous catalog is loading.
    if (process.env.ARKE_SMOKE_CATALOG_DELAY_MS) {
      await new Promise(resolve => setTimeout(resolve, Number(process.env.ARKE_SMOKE_CATALOG_DELAY_MS)));
    }
    return models;
  },
  streamEvents: () => ({ async *[Symbol.asyncIterator]() { yield* []; } }),
  createSession: async () => { throw new Error("The controls smoke must not generate"); },
  sendMessage: async () => { throw new Error("The controls smoke must not generate"); },
  dispatchAsync: async () => { throw new Error("The controls smoke must not generate"); },
  dispose: async () => { ready = false; },
};
const provider = new FsWorldProvider(dir);
const coordinator = new Coordinator({
  provider, adapter, appRoot: dir, appVersion: "smoke",
  changeLogPath: join(dir, "logs", "changes.jsonl"),
  harnessInfo: { generation: "claude", source: "configured", version: "smoke", beta: false },
  authoring: { roster: ROSTER, agentForPurpose },
  detectHarnesses: async () => [
    { id: "claude", label: "Claude Code", installed: true, version: "smoke", source: "configured", blocked: null, bundled: false },
    { id: "codex", label: "Codex", installed: true, version: "0.154.0", source: "configured", blocked: null, bundled: false },
  ],
  transportAuth: { token: randomBytes(32).toString("hex"), allowedOrigins: ["file://", "null"] },
});
try {
  const { port, token } = await coordinator.start();
  await writeFile(join(dir, "main.cjs"), `(${electronMain.toString()})().catch(error => { console.error(error); require("electron").app.exit(1); });`);
  const child = spawn(require("electron"), [join(dir, "main.cjs")], {
    windowsHide: true, stdio: ["ignore", "inherit", "inherit"],
    env: { ...process.env, ARKE_SMOKE_CONFIG: JSON.stringify({ port, token, worldId, dir,
      catalogDelayMs: Number(process.env.ARKE_SMOKE_CATALOG_DELAY_MS ?? 0),
      preload: join(root, "apps", "desktop", "dist", "preload.cjs"),
      page: join(root, "packages", "client", "dist", "index.html"),
    }) },
  });
  assert.equal(await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); }), 0);
  const settings = JSON.parse(await readFile(join(dir, "settings.json"), "utf8"));
  assert.equal(settings.agents["world-builder"].model, "anthropic/claude-sonnet-live");
  assert.equal(settings.agents["stage-designer"].model, "anthropic/claude-opus-live[1m]");
  assert.equal(settings.harness.engine, "codex");
  const production = provider.openStore()?.getBundle().productions.find(p => p.meta.id === "saltlight");
  assert.equal(production?.meta.models?.llm, "anthropic/claude-fable-live[1m]");
  console.log(`Harness controls smoke passed; screenshots and disposable world: ${dir}`);
} finally {
  await coordinator.stop();
}

async function electronMain() {
  const { app, BrowserWindow, ipcMain } = require("electron");
  const assert = require("node:assert/strict");
  const { writeFile, readFile } = require("node:fs/promises");
  const { join } = require("node:path");
  const config = JSON.parse(process.env.ARKE_SMOKE_CONFIG);
  delete process.env.ARKE_SMOKE_CONFIG;
  app.disableHardwareAcceleration();
  app.setPath("userData", join(config.dir, "profile"));
  const timer = setTimeout(() => { console.error("Harness controls smoke timed out"); app.exit(1); }, 120_000);
  await app.whenReady();
  ipcMain.on("arke:get-theme", event => { event.returnValue = { preference: "system", resolved: "light" }; });
  ipcMain.on("arke:startup-state-ready", event => {
    event.sender.send("arke:startup-state", { status: "ready", port: config.port, token: config.token });
  });
  const window = new BrowserWindow({ show: false, width: 1440, height: 1050,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, preload: config.preload } });
  window.webContents.on("console-message", (_event, level, message) => {
    if (level >= 2) console.error("renderer:", String(message).replace(/[a-f0-9]{64}/g, "[redacted]"));
  });
  const js = async source => {
    try { return await window.webContents.executeJavaScript(source); }
    catch (error) { throw new Error(`Renderer command failed: ${source}`, { cause: error }); }
  };
  const until = async condition => {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (await js(condition)) return;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    const controls = await js(`({
      selects: [...document.querySelectorAll('select')].map(element => ({ label: element.getAttribute('aria-label'),
        value: element.value, disabled: element.disabled, optionDisabled: element.selectedOptions[0]?.disabled })),
      buttons: [...document.querySelectorAll('button')].map(element => ({ label: element.textContent.trim(), disabled: element.disabled })),
      statuses: [...document.querySelectorAll('[role=status]')].map(element => element.textContent),
    })`);
    throw new Error(`Timed out: ${condition}\nControls: ${JSON.stringify(controls)}\n${await js("document.body.innerText")}`);
  };
  const choose = async (label, value) => {
    // An option retained during refresh exists but cannot be chosen. Check and act in the same
    // renderer turn so a loading snapshot cannot slip between readiness and the interaction.
    await until(`(() => {
      const element = document.querySelector(${JSON.stringify(`select[aria-label="${label}"]`)});
      const option = [...(element?.options ?? [])].find(option => option.value === ${JSON.stringify(value)});
      if (!element || element.disabled || !option || option.disabled) return false;
      element.value = ${JSON.stringify(value)};
      element.dispatchEvent(new Event('change', {bubbles:true}));
      return true;
    })()`);
  };
  const click = async label => {
    await until(`(() => {
      const button = [...document.querySelectorAll('button')].find(button => button.textContent.trim() === ${JSON.stringify(label)});
      if (!button || button.disabled) return false;
      button.click();
      return true;
    })()`);
  };
  const shot = async name => {
    await js("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
    await writeFile(join(config.dir, `${name}.png`), (await window.webContents.capturePage()).toPNG());
  };
  await window.loadFile(config.page, { hash: "/settings/harness" });
  await until("document.body.innerText.includes('Advanced · which model')");
  await js("[...document.querySelectorAll('button')].find(b => b.textContent.includes('Advanced · which model')).click()");
  await until("document.body.innerText.includes('3 models from Claude Code')");
  await choose("Model for world-builder", "anthropic/claude-sonnet-live");
  await choose("Model for stage-designer", "anthropic/claude-opus-live[1m]");
  const settingsPath = join(config.dir, "settings.json");
  let persisted;
  for (let n = 0; n < 100; n++) {
    persisted = JSON.parse(await readFile(settingsPath, "utf8").catch(() => "{}"));
    if (persisted.agents?.["stage-designer"]?.model === "anthropic/claude-opus-live[1m]") break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.equal(persisted.agents["world-builder"].model, "anthropic/claude-sonnet-live");
  assert.equal(persisted.agents["stage-designer"].model, "anthropic/claude-opus-live[1m]");
  await shot("harness-agents");
  await until("[...document.querySelectorAll('[role=tab]')].some(b => b.textContent.includes('Codex'))");
  await js("[...document.querySelectorAll('[role=tab]')].find(b => b.textContent.includes('Codex')).click()");
  await until("[...document.querySelectorAll('button')].some(b => b.textContent.trim() === 'Use this')");
  await js("[...document.querySelectorAll('button')].filter(b => b.textContent.trim() === 'Use this').at(-1).click()");
  await until("[...document.querySelectorAll('[role=tab]')].some(b => b.textContent.includes('Codex') && b.textContent.includes('next restart'))");
  assert.ok(await js("document.body.innerText.includes('models from Claude Code')"), "pending restart preserves active catalog");
  await shot("harness-pending-restart");
  await js(`location.hash = '/w/${config.worldId}/p/saltlight/story'`);
  await until("document.querySelector('select[aria-label=\"Language model\"]') !== null");
  if (config.catalogDelayMs) {
    await js("window.arke.send(JSON.stringify({kind:'list-harness-models'}))");
    await until("document.body.innerText.includes('Loading models from Claude Code')");
  }
  await choose("Language model", "anthropic/claude-fable-live[1m]");
  if (config.catalogDelayMs) {
    await js("window.arke.send(JSON.stringify({kind:'list-harness-models'}))");
    await until("[...document.querySelectorAll('button')].some(button => button.textContent.trim() === 'Remember for this production' && button.disabled)");
  }
  await click("Remember for this production");
  await until("document.body.innerText.includes('Clear production default')");
  await shot("production-model");
  await window.webContents.reload();
  await until("document.querySelector('select[aria-label=\"Language model\"]')?.value === 'anthropic/claude-sonnet-live'");
  assert.ok(await js("document.body.innerText.includes('CHAT AGENT')"), "agent retains precedence over remembered production model");
  clearTimeout(timer);
  app.exit(0);
}
