import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { build } from "esbuild";
import { Coordinator } from "../../../packages/coordinator/src/coordinator.ts";
import { FsWorldProvider } from "../../../packages/coordinator/src/world/provider.ts";
import { CredentialStore } from "../../../packages/coordinator/src/credentials/store.ts";
import { devCipher } from "../../../packages/coordinator/src/credentials/dev-cipher.ts";
import { SecretRegistry } from "../../../packages/coordinator/src/redact.ts";
import { FakeProvider, pngBytes } from "../../../packages/coordinator/test/queue/fake-provider.ts";

// Exercise a real renderer crash, built sandboxed preload, authenticated coordinator and its
// durable queue. Only the native button choice is supplied by the harness; no paid work runs.
const root = fileURLToPath(new URL("../../../", import.meta.url));
const require = createRequire(import.meta.url);
const dir = await mkdtemp(join(tmpdir(), "arke-renderer-recovery-"));
const inside = relative(tmpdir(), dir);
if (inside.startsWith("..") || isAbsolute(inside)) throw new Error("Smoke directory escaped tmpdir");
const provider = new FsWorldProvider(dir), remote = new FakeProvider(), cipher = devCipher();
remote.pollState = "running";
remote.artifacts = [{ name: "picture.png", contentType: "image/png", data: pngBytes() }];
const coordinator = new Coordinator({ provider, adapter: null, appRoot: dir, appVersion: "renderer-recovery-smoke",
  cipher, credentialsFileName: "smoke-credentials.dat", dispatchClients: { fal: remote },
  changeLogPath: join(dir, "changes.jsonl"), transportAuth: { token: randomBytes(32).toString("hex"), allowedOrigins: ["file://", "null"] } });
const until = async condition => {
  const deadline = Date.now() + 30_000;
  while (!condition()) { if (Date.now() > deadline) throw new Error("Recovery smoke timed out"); await new Promise(resolve => setTimeout(resolve, 50)); }
};
try {
  await cp(join(root, "fixtures/worlds/the-undersong"), join(dir, "worlds/the-undersong"), { recursive: true });
  const worldId = JSON.parse(await readFile(join(dir, "worlds/the-undersong/world.json"), "utf8")).worldId;
  await new CredentialStore(join(dir, "smoke-credentials.dat"), cipher, new SecretRegistry()).set("fal", "fixture-key");
  const session = await coordinator.start(0);
  await coordinator.openWorld(worldId);
  const job = await coordinator.enqueueJob({ worldId, provider: "fal", model: "fixture-image", capability: "image",
    target: { kind: "shot", id: "shot_fixture" }, params: {}, estimatedMicroUsd: 0, landing: { dir: "incoming" } });
  await until(() => coordinator.getState().app.jobs.some(row => row.id === job.id && row.status === "running"));
  await build({ entryPoints: [join(root, "apps/desktop/src/renderer-recovery.ts")], bundle: true,
    platform: "node", format: "cjs", outfile: join(dir, "recovery.cjs") });
  await writeFile(join(dir, "index.html"), '<!doctype html><title>Renderer recovery smoke</title>Recovery fixture');
  await writeFile(join(dir, "main.cjs"), `(${electronMain.toString()})(${JSON.stringify(join(root, "apps/desktop/dist/preload.cjs"))}).catch(error => { console.error(error); require("electron").app.exit(1); });`);
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(require("electron"), [join(dir, "main.cjs")], { env, windowsHide: true, stdio: ["ignore", "inherit", "inherit", "ipc"] });
  let completed = false;
  child.on("message", message => {
    if (message === "ready") child.send({ ...session, worldId, jobId: job.id });
    if (message === "crashed") for (const accepted of remote.remote.values()) accepted.state = "succeeded";
    if (message === "complete") completed = true;
  });
  assert.equal(await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); }), 0);
  assert(completed);
  assert.equal(remote.submitCount, 1, "reloading cannot submit the accepted job again");
  assert.equal(remote.cancelCount, 0, "a renderer crash cannot cancel accepted provider work");
  assert.equal(provider.openStore()?.worldId, worldId);
  assert.equal(coordinator.getState().app.jobs.find(row => row.id === job.id)?.status, "succeeded");
  console.log("[smoke] real renderer crash/reload, authenticated reconnect, same open world, accepted job completion and one provider submission passed");
} finally {
  await coordinator.stop(); await provider.close();
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

async function electronMain(preload) {
  const { app, BrowserWindow, ipcMain } = require("electron");
  const { join } = require("node:path");
  const assert = require("node:assert/strict");
  const { installRendererRecovery } = require("./recovery.cjs");
  app.disableHardwareAcceleration(); app.setPath("userData", join(__dirname, "profile"));
  const timeout = setTimeout(() => { console.error("Electron recovery smoke timed out"); app.exit(1); }, 45000);
  const sessionReady = new Promise(resolve => process.once("message", resolve));
  process.send("ready");
  await app.whenReady();
  const session = await sessionReady;
  ipcMain.on("arke:startup-state-ready", event => event.sender.send("arke:startup-state", { status: "ready", port: session.port, token: session.token }));
  ipcMain.on("arke:get-theme", event => { event.returnValue = { preference: "system", resolved: "light" }; });
  const window = new BrowserWindow({ show: false, webPreferences: { preload, sandbox: true, contextIsolation: true, nodeIntegration: false } });
  let prompts = 0, receipt = null, choose;
  installRendererRecovery(window, { canRecover: () => true, report: () => assert.fail("recovery failed"),
    prompt: options => { prompts++; assert.deepEqual(options.buttons, ["Not now", "Reload window"]); return new Promise(resolve => { choose = resolve; }); } });
  window.webContents.on("render-process-gone", (_event, details) => { receipt = details; process.send("crashed"); });
  const connect = () => window.webContents.executeJavaScript(`new Promise(resolve => {
    window.arke.subscribe(raw => { const frame = JSON.parse(raw); if (frame.kind === "snapshot") { window.recoveryState = frame.state; resolve(frame.state); } }, status => {
      if (status === "open") window.arke.send(JSON.stringify({kind:"hello"}));
    });
  })`);
  await window.loadFile(join(__dirname, "index.html"));
  const before = await connect();
  assert.equal(before.world.meta.worldId, session.worldId);
  assert.equal(before.app.jobs.find(row => row.id === session.jobId).status, "running");
  assert.equal(await window.webContents.executeJavaScript("typeof process"), "undefined");
  const gone = new Promise(resolve => window.webContents.once("render-process-gone", resolve));
  window.webContents.forcefullyCrashRenderer(); await gone;
  assert(receipt.reason !== "clean-exit"); assert.equal(prompts, 1);
  choose(0); await Promise.resolve();
  window.emit("focus"); assert.equal(prompts, 1, "dismissal focus must not reopen the prompt");
  window.emit("blur"); window.emit("focus"); assert.equal(prompts, 2);
  const loaded = new Promise(resolve => window.webContents.once("did-finish-load", resolve));
  choose(1); await loaded;
  let after = await connect();
  const deadline = Date.now() + 20000;
  while (after.app.jobs.find(row => row.id === session.jobId)?.status !== "succeeded") {
    assert(Date.now() < deadline, "accepted job did not finish");
    await new Promise(resolve => setTimeout(resolve, 100));
    after = await window.webContents.executeJavaScript(`window.arke.send(JSON.stringify({kind:"hello"})); window.recoveryState`);
  }
  assert.equal(after.world.meta.worldId, session.worldId);
  window.emit("blur"); window.emit("focus"); assert.equal(prompts, 2);
  console.log("[smoke] crash receipt retained; native choice seam, sandbox and authenticated preload survived the renderer replacement");
  process.send("complete"); window.destroy(); clearTimeout(timeout); app.exit(0);
}
