import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { cp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { totalmem } from "node:os";
import { build } from "esbuild";
import WebSocket from "ws";
import { OnboardingPlanSchema, newId } from "@arke-studio/contracts";
import { createProviderClients, SHIPPED_MANIFEST, comfyUiRecipeById } from "@arke-studio/providers";
import { Coordinator } from "../../../packages/coordinator/src/coordinator.ts";
import { FsWorldProvider } from "../../../packages/coordinator/src/world/provider.ts";
import { WorldStore } from "../../../packages/coordinator/src/world/store.ts";
import { AppSettingsFile } from "../../../packages/coordinator/src/app-settings.ts";
import { createNodeComfyUiEngine } from "../../../packages/coordinator/src/comfyui/node-engine.ts";
import { OllamaEngineService } from "../../../packages/coordinator/src/local-ai/ollama.ts";
import { addBenchReference, openBenchSession } from "../../../packages/coordinator/src/bench/service.ts";

// Opt-in native qualification, never part of npm test. The supplied engine must be idle and
// owned by the caller, who must stop it on a cutoff. No retries or changes to installed settings.
const [engineUrl, modelsDir, output, modelId = "comfyui-pika-h3-flex", image, duration = "5", aspect = "16:9"] = process.argv.slice(2);
assert(engineUrl && modelsDir && output, "Usage: node --import tsx apps/desktop/scripts/smoke-pika-h3-flex.mjs <idle-loopback-url> <models-dir> <new-evidence-dir> [recipe-id] [reference.png|-] [seconds] [aspect]");
assert.equal(new URL(engineUrl).hostname, "127.0.0.1");
const recipe = comfyUiRecipeById(modelId);
assert(recipe && modelId.startsWith("comfyui-pika-h3-flex"));
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const dir = resolve(output), appRoot = join(dir, "app"), worldDir = join(appRoot, "worlds", "the-undersong");
await mkdir(dir); // Refuse to reuse an earlier run or its world/journal.
await mkdir(dirname(worldDir), { recursive: true });
await cp(join(root, "fixtures/worlds/the-undersong"), worldDir, { recursive: true });
// Receipts remain file-identity checked by the production digest cache. Sharing verified
// receipts between these isolated worlds avoids rereading the same 60 GiB for each clip.
const receipts = join(dirname(dir), "pika-smoke-digests");
if (await stat(receipts).catch(() => null)) await cp(receipts, join(appRoot, ".index/comfyui-digests"), { recursive: true });
const clock = () => new Date().toISOString();
const store = await WorldStore.open(worldDir, { clock });
const worldId = store.worldId;
const model = SHIPPED_MANIFEST.models.find(row => row.id === modelId);
const opened = await openBenchSession(worldDir, clock, { fresh: true, defaultModel: { provider: "comfyui", model: modelId } });
assert(opened);
const reference = Boolean(recipe.referenceImages);
const params = { kind: "video", durationSec: Number(duration), resolution: model.limits.resolutions[0], aspect };
const brief = reference ? "@Image 1 is a toy robot that waves beside a red ball. Gentle camera movement, natural room sounds."
  : "A toy robot waves beside a red ball. Gentle camera movement, natural room sounds.";
try {
  await opened.store.append({ type: "composer-set", mode: "video", provider: "comfyui", model: modelId, params, brief }, { at: clock() });
  if (image && image !== "-") {
    const bytes = await readFile(resolve(image)), artifactId = newId("ar");
    await store.ownedWrite(async () => {
      await mkdir(join(worldDir, "artifacts"), { recursive: true });
      await writeFile(join(worldDir, "artifacts/pika.png"), bytes);
      await writeFile(join(worldDir, "artifacts/pika.png.json"), JSON.stringify({ id: artifactId, kind: "image", file: "pika.png",
        hash: `sha256:${createHash("sha256").update(bytes).digest("hex")}`, origin: { by: "user" }, links: [], created: clock() }));
    });
    const attached = await addBenchReference({ store: opened.store, session: await opened.store.fold() }, store.getBundle(), model,
      { source: { source: "artifact", artifactId }, requestId: "native-pika-reference", at: clock(), ...(!reference ? { lane: "keyframe" } : {}) });
    assert.notEqual(attached.outcome, "refused", JSON.stringify(attached));
  }
} finally { await store.close(); }
const settings = new AppSettingsFile(join(appRoot, "settings.json"));
await settings.setComfyUi({ engineUrl, enginePath: null, modelsDir: resolve(modelsDir) });
await settings.setOllama({ engineUrl: process.env.ARKE_PIKA_OLLAMA_URL ?? "http://127.0.0.1:11434", modelsDir: null });
await settings.setOnboarding(OnboardingPlanSchema.parse({ persona: "lightweight", step: "done", writing: "none" }));
const vramMb = Number(execFileSync("nvidia-smi", ["--query-gpu=memory.total", "--format=csv,noheader,nounits"], { encoding: "utf8", windowsHide: true }).trim().split("\n")[0]);
const probes = { vramMb, memMb: Math.floor(totalmem() / 1048576), diskFreeMb: null, platform: process.platform, accelerators: ["cuda"], vramMbByAccelerator: { cuda: vramMb } };
const engine = createNodeComfyUiEngine(appRoot), provider = new FsWorldProvider(appRoot);
const ollama = new OllamaEngineService({ appRoot, port: 11434 });
const clients = createProviderClients({ fetch: (url, init) => fetch(url, init), comfyui: engine.client,
  ollama: () => ollama.baseUrl(), ollamaCleanup: () => ollama.endpoint() });
const jobs = [];
const coordinator = new Coordinator({ provider, adapter: null, appRoot, appVersion: "pika-native-smoke", manifest: SHIPPED_MANIFEST,
  transportAuth: { token: randomBytes(32).toString("hex"), allowedOrigins: ["file://", "null"] },
  changeLogPath: join(appRoot, "logs/coordinator.jsonl"), dispatchClients: clients, validators: clients,
  comfyui: { service: engine.service }, setupExtraEntries: engine.weights, probeRuntime: async () => probes,
  ollama: { service: ollama },
  observeEvent: event => { if (event.type === "job.updated") jobs.push(event); } });
let child, control, watchdog, heartbeat;
let dispatchedAt;
try {
  console.log("[pika] starting real coordinator; verifying native dependencies before generation");
  heartbeat = setInterval(() => console.log(`[pika] verifying readiness: ${engine.service.engineStatus().state}`), 55000);
  const session = await coordinator.start();
  control = new WebSocket(`ws://127.0.0.1:${session.port}`, { headers: { Origin: "file://" } });
  await new Promise((resolve, reject) => { control.once("open", resolve); control.once("error", reject); });
  const hello = new Promise((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error("Authenticated smoke connection timed out")), 10000);
    control.once("message", () => { clearTimeout(deadline); resolve(); });
    control.once("close", () => { clearTimeout(deadline); reject(new Error("Authenticated smoke connection closed")); });
  });
  control.send(JSON.stringify({ kind: "hello", token: session.token })); await hello;
  control.send(JSON.stringify({ kind: "detect-runtimes" }));
  const until = async (test, ms) => { const end = Date.now() + ms; while (!test()) { if (Date.now() > end) throw new Error("Coordinator readiness timed out"); await new Promise(r => setTimeout(r, 500)); } };
  await until(() => coordinator.getState().app.comfyui?.recipes.find(row => row.recipeId === modelId)?.state === "ready", 20 * 60 * 1000);
  const status = coordinator.getState().app.comfyui;
  await cp(join(appRoot, ".index/comfyui-digests"), receipts, { recursive: true });
  await until(() => coordinator.getState().app.providers.some(row => row.id === "comfyui" && row.validation === "valid"), 60000);
  clearInterval(heartbeat);
  await writeFile(join(dir, "readiness.json"), JSON.stringify({ probes, status }, null, 2));
  await build({ entryPoints: [join(root, "apps/desktop/src/transport-auth.ts")], bundle: true, platform: "node", format: "cjs", outfile: join(dir, "auth.cjs") });
  await writeFile(join(dir, "main.cjs"), `(${electronMain.toString()})().catch(error => { console.error(error); require("electron").app.exit(1); });`);
  const require = createRequire(import.meta.url), env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  child = spawn(require("electron"), [join(dir, "main.cjs")], { windowsHide: true, env, stdio: ["ignore", "inherit", "inherit", "ipc"] });
  child.on("message", message => {
    if (message === "ready") child.send({ ...session, dir, worldId, sessionId: opened.session.id, modelName: model.displayName, modelId,
      preload: join(root, "apps/desktop/dist/preload.cjs"), page: join(root, "packages/client/dist/index.html") });
    if (message === "dispatch") {
      dispatchedAt = Date.now();
      watchdog = setTimeout(() => { console.error("[pika] 20-minute cutoff; stop the caller-owned engine; do not retry"); child.kill(); }, 20 * 60 * 1000);
    }
  });
  heartbeat = setInterval(() => {
    const state = coordinator.getState();
    const latest = state.app.jobs.filter(job => job.model === modelId).at(-1);
    console.log(`[pika] ${modelId}: ${latest?.status ?? "opening desktop"}; elapsed ${dispatchedAt ? Math.round((Date.now() - dispatchedAt) / 1000) : 0}s`);
    if (latest && ["failed", "cancelled", "interrupted"].includes(latest.status)) { console.error(JSON.stringify(latest)); child.kill(); }
  }, 55000);
  const code = await new Promise((res, rej) => { child.once("error", rej); child.once("exit", res); });
  assert.equal(code, 0, "sandboxed desktop generation/playback failed");
  const saved = await opened.store.fold();
  const take = saved.takes.at(-1);
  assert.equal(take?.status, "succeeded"); assert(take.media);
  assert.equal(take.request.model, modelId); assert.equal(take.request.recipeVersion, 1);
  await writeFile(join(dir, "result.json"), JSON.stringify({ modelId, elapsedSec: (Date.now() - dispatchedAt) / 1000, probes, take, jobs }, null, 2));
  console.log(`[pika] saved take and authenticated file-page playback passed: ${dir}`);
} finally {
  clearInterval(heartbeat); clearTimeout(watchdog);
  control?.close();
  if (child && child.exitCode === null) child.kill();
  await coordinator.stop(); await engine.service.dispose(); await ollama.dispose(); await provider.close();
}

async function electronMain() {
  const assert = require("node:assert/strict"), { join } = require("node:path"), { writeFile } = require("node:fs/promises");
  const { app, BrowserWindow, ipcMain } = require("electron");
  const { authenticatedMediaHeaders } = require("./auth.cjs");
  app.disableHardwareAcceleration(); app.setPath("userData", join(__dirname, "profile"));
  const configuration = new Promise(resolve => process.once("message", resolve)); process.send("ready");
  await app.whenReady(); const config = await configuration;
  ipcMain.handle("arke:remote-access", (_event, input) => {
    assert.equal(input.kind, "status");
    return { status: { enabled: false, running: false, startOnLogin: false, startupSupported: false,
      pairingDuration: 30, url: null, reason: "Remote access is disabled in this smoke host.", devices: [], pending: [] } };
  });
  ipcMain.on("arke:get-theme", event => { event.returnValue = { preference: "system", resolved: "light" }; });
  ipcMain.on("arke:startup-state-ready", event => event.sender.send("arke:startup-state", { status: "ready", port: config.port, token: config.token }));
  const window = new BrowserWindow({ show: false, width: 1440, height: 1000, webPreferences: { sandbox: true, contextIsolation: true,
    nodeIntegration: false, backgroundThrottling: false, preload: config.preload } });
  window.webContents.session.webRequest.onBeforeSendHeaders((details, callback) => callback({ requestHeaders: authenticatedMediaHeaders(details, config, window.webContents.id) }));
  const run = text => window.webContents.executeJavaScript(text);
  const capture = async name => {
    window.webContents.invalidate(); await new Promise(resolve => setTimeout(resolve, 500));
    await writeFile(join(config.dir, name), (await window.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG());
  };
  const until = async (text, ms = 60000) => { const end = Date.now() + ms; while (!(await run(text))) {
    if (Date.now() > end) {
      await capture("failure.png");
      throw new Error(`Desktop timed out: ${text}; ${(await run("document.body.innerText")).slice(-3000)}`);
    }
    await new Promise(r => setTimeout(r, 500));
  } };
  await window.loadFile(config.page, { hash: `/w/${config.worldId}/artifacts/bench/${config.sessionId}` });
  await until(`document.body.innerText.includes(${JSON.stringify(config.modelName)})`);
  assert.equal(await run("typeof process"), "undefined");
  const picker = await run(`(() => { const select = document.querySelector('select[aria-label="Model"]');
    return { value: select?.value, choices: Array.from(select?.options ?? []).filter(option => option.value.startsWith('comfyui/comfyui-pika-h3-flex')).map(option => ({ value: option.value, disabled: option.disabled })) }; })()`);
  assert.equal(picker.value, `comfyui/${config.modelId}`);
  assert.equal(picker.choices.length, 4); assert(picker.choices.every(choice => !choice.disabled));
  await writeFile(join(config.dir, "picker.json"), JSON.stringify(picker, null, 2));
  await capture("before.png");
  await until(`Array.from(document.querySelectorAll('button')).some(b => b.textContent.trim() === 'Generate' && !b.disabled)`);
  process.send("dispatch");
  await run("Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim() === 'Generate').click()");
  // The Bench's waiting animation is also a video; only the landed, authenticated media
  // stream proves this generation completed and the selected take can actually be played.
  await until("Array.from(document.querySelectorAll('video')).some(v => v.videoWidth > 0 && v.src.includes('/media/') && v.src.includes('.sessions'))", 20 * 60 * 1000);
  const media = await run(`(async () => { const video = Array.from(document.querySelectorAll('video')).find(v => v.videoWidth > 0 && v.src.includes('/media/') && v.src.includes('.sessions'));
    video.muted = true; await video.play(); await new Promise(r => setTimeout(r, 1500));
    return { width: video.videoWidth, height: video.videoHeight, duration: video.duration, currentTime: video.currentTime, error: video.error?.code }; })()`);
  assert(media.currentTime > 0); assert.equal(media.error, undefined);
  await writeFile(join(config.dir, "playback.json"), JSON.stringify(media, null, 2));
  await capture("after.png");
  window.destroy(); app.exit(0);
}
