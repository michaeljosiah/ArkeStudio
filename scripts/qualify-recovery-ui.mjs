import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { cp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { createStudioHost } from "../packages/coordinator/src/application/studio-host.ts";
import { FsWorldProvider } from "../packages/coordinator/src/world/provider.ts";
import { AppSettingsFile } from "../packages/coordinator/src/app-settings.ts";
import { AppStorageService } from "../packages/coordinator/src/storage/service.ts";
import { OllamaEngineService } from "../packages/coordinator/src/local-ai/ollama.ts";
import { createNodeComfyUiEngine } from "../packages/coordinator/src/comfyui/node-engine.ts";
import { nodeSetupDeps } from "../packages/coordinator/src/setup/node-deps.ts";
import { devCipher } from "../packages/coordinator/src/credentials/dev-cipher.ts";
import { createProviderClients, SHIPPED_MANIFEST } from "../packages/providers/src/index.ts";

// A real client/coordinator/settings/history journey with isolated data and controlled faults.
// Runtime HTTP answers and volume capacity are synthetic; this never installs or runs models.
const repo = resolve(dirname(fileURLToPath(import.meta.url)), ".."), root = resolve(process.argv[2] ?? "");
const rootChild = relative(join(repo, ".dev"), root);
assert(process.argv.length === 3 && rootChild && !rootChild.startsWith("..") && !isAbsolute(rootChild),
  "Usage: node --import tsx scripts/qualify-recovery-ui.mjs <new-directory-under-.dev>");
await mkdir(root); // Refuse to adopt an existing app or qualification directory.
await writeFile(join(root, ".recovery-ui-qualification.json"), '{"qualification":"recovery-ui","version":1}\n', { flag: "wx" });
await mkdir(join(root, "worlds"));
await cp(join(repo, "fixtures/worlds/the-undersong"), join(root, "worlds/the-undersong"), { recursive: true });
const clientRoot = join(repo, "packages/client/dist"), uiPort = 4415, coordinatorPort = 4416;
await stat(join(clientRoot, "index.html"));
let host, services, freeGiB = 100, healthy = true, stopping = false, cycle = 0;
const observations = [], required = new Set(["ollama-runtime", "comfyui-runtime"]);
const runtime = createServer((request, response) => {
  const path = new URL(request.url, "http://localhost").pathname;
  response.setHeader("Content-Type", "application/json"); response.setHeader("Connection", "close");
  if (!["/api/version", "/api/tags", "/api/ps", "/system_stats", "/object_info", "/queue"].includes(path)) {
    response.writeHead(404); response.end('{}'); return;
  }
  response.writeHead(healthy ? 200 : 503);
  response.end(JSON.stringify(path === "/api/version" ? { version: "qualification-fixture" }
    : path === "/system_stats" ? { system: { comfyui_version: "0.38.0" }, devices: [] }
    : path === "/queue" ? { queue_running: [], queue_pending: [] }
    : path === "/object_info" ? {} : { models: [] }));
});
await new Promise(resolve => runtime.listen(0, "127.0.0.1", resolve));
const runtimeUrl = `http://127.0.0.1:${runtime.address().port}`;
const settings = new AppSettingsFile(join(root, "settings.json"));
await settings.setComfyUi({ engineUrl: runtimeUrl }); await settings.setOllama({ engineUrl: runtimeUrl });
const report = async action => {
  const state = host?.coordinator.getState();
  const row = { action, cycle, at: new Date().toISOString(), localAiReady: state?.app.setup?.localAi?.ready,
    recoveryMode: state?.app.recoveryPolicy?.mode, advanced: state?.app.recoveryPolicy?.advanced,
    incidentCount: state?.app.recoveryHistory?.incidents.length, setupDownloadsBlocked: true };
  observations.push(row); await writeFile(join(root, "observations.json"), JSON.stringify(observations, null, 2));
  console.log(JSON.stringify(row));
};
async function start() {
  const provider = new FsWorldProvider(root), ollama = new OllamaEngineService({ appRoot: root, port: 4417 });
  const comfy = createNodeComfyUiEngine(root), deps = nodeSetupDeps();
  services = { ollama, comfy: comfy.service };
  const storage = new AppStorageService({ appRoot: root, native: { setRoots() {}, async stop() {},
    async probe(rootId) { return { state: "measured", source: "host-provided", limitations: [], capacity: {
      volumeId: "qualification-volume", mappingRevision: rootId, measuredAt: Date.now(), availableBytes: freeGiB * 1024 ** 3, totalBytes: 500 * 1024 ** 3 } }; } } });
  const clients = createProviderClients({ fetch: (url, init) => fetch(url, init), ollama: () => ollama.baseUrl(), ollamaCleanup: () => ollama.endpoint(), comfyui: comfy.client });
  host = createStudioHost({ provider, adapter: null, appRoot: root, appVersion: "recovery-ui-qualification", storageHealth: storage,
    cipher: devCipher(), changeLogPath: join(root, "logs/coordinator.jsonl"), manifest: SHIPPED_MANIFEST, validators: clients, dispatchClients: clients,
    comfyui: { service: comfy.service }, ollama: { service: ollama }, setupExtraEntries: comfy.weights,
    setup: { ...deps, ollama, externallyPresent: async id => required.has(id),
      fetchStream: async () => { throw new Error("Qualification never downloads runtime or model files."); },
      run: async () => { throw new Error("Qualification never executes installers or model commands."); } },
    transportAuth: { token: randomBytes(32).toString("hex"), allowedOrigins: [`http://127.0.0.1:${uiPort}`] },
    observeEvent: event => {
      if (event.type === "recovery.command-result") console.log(JSON.stringify({ action: "saved-command", operation: event.result.operation, status: event.result.status }));
    } });
  // StudioServer mints the capability. Only the private on-disk handoff carries it; assets never do.
  const session = await host.server.start(coordinatorPort); cycle++;
  await writeFile(join(root, "session.private.json"), JSON.stringify({ port: session.port, token: session.token, url: `http://127.0.0.1:${uiPort}/` }));
  await report("host-started");
}
const mime = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2" };
const ui = createServer(async (request, response) => {
  try {
    const path = decodeURIComponent(new URL(request.url, `http://127.0.0.1:${uiPort}`).pathname), file = resolve(clientRoot, path === "/" ? "index.html" : path.slice(1));
    const child = relative(clientRoot, file); assert(child && !child.startsWith("..") && !isAbsolute(child));
    response.setHeader("Content-Type", mime[extname(file)] ?? "application/octet-stream");
    response.setHeader("Cache-Control", "no-store"); response.end(await readFile(file));
  } catch { response.writeHead(404); response.end(); }
});
async function stop() {
  if (stopping) return; stopping = true;
  await host?.server.stop();
  await Promise.all([new Promise(resolve => ui.close(resolve)), new Promise(resolve => runtime.close(resolve))]);
  console.log(JSON.stringify({ action: "qualification-stopped", cycle }));
}
try {
  await new Promise((resolve, reject) => { ui.once("error", reject); ui.listen(uiPort, "127.0.0.1", resolve); });
  await start();
  console.log(JSON.stringify({ action: "browser-ready", url: `http://127.0.0.1:${uiPort}/`, root, syntheticRuntimeAndCapacity: true }));
  const input = createInterface({ input: process.stdin });
  for await (const line of input) {
    try {
      const command = JSON.parse(line);
      if (command.action === "stop") { input.close(); break; }
      if (command.action === "restart") { await host.server.stop(); await start(); }
      else if (command.action === "storage") {
        assert(Number.isInteger(command.freeGiB) && command.freeGiB >= 0 && command.freeGiB <= 100);
        freeGiB = command.freeGiB; await host.coordinator.wakeStorage();
      } else if (command.action === "health") {
        assert(typeof command.healthy === "boolean"); healthy = command.healthy;
        await Promise.all([services.comfy.checkNow(), services.ollama.refresh()]);
      } else assert.equal(command.action, "report");
      await report(command.action);
    } catch (error) { console.log(JSON.stringify({ action: "command-failed", error: String(error) })); }
  }
} finally { await stop(); }
