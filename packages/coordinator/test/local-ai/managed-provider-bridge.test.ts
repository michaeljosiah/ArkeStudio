import assert from "node:assert/strict";
import { copyFile, mkdir, readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { it } from "node:test";
import { ChildSupervisor, allocateLoopbackPort, isSupervisedProcessOrigin } from "../../src/supervisor.js";
import { OllamaEngineService } from "../../src/local-ai/ollama.js";
import { OLLAMA_VERSION } from "../../src/setup/catalogue.js";
import { ManagedStudioProviderBridge } from "../../src/studio-assistant/managed-provider-bridge.js";
import { tempDir } from "../tmp.js";
import { until } from "../wait.js";
import { nodeRuntimeContentPin } from "../fixtures/runtime-content.js";

const CHILD = join(import.meta.dirname, "../fixtures/managed-http-origin.mjs");
const managed = { engineUrl: null, modelsDir: null };
const body = JSON.stringify({ model: "fixture", messages: [{ role: "user", content: "private synthetic managed-provider text" }], stream: true });

for (const state of ["enabled", "config", "malformed"]) it(`refuses private routing when original provider locality is ${state}`, { timeout: 40_000 }, async () => {
  const root = await realpath(await tempDir("arke-provider-locality-refusal-")), marker = join(root, "requests.jsonl"); await mkdir(join(root, "ollama-runtime"));
  await copyFile(process.execPath, join(root, "ollama-runtime", "ollama.exe"));
  const service = new OllamaEngineService({ appRoot: root, port: await allocateLoopbackPort(), privateContentPin: await nodeRuntimeContentPin(),
    supervise: spec => new ChildSupervisor({ ...spec, args: [CHILD], readyTimeoutMs: 20_000,
      env: { ...spec.env, SERVICE_VERSION: OLLAMA_VERSION, SERVICE_CLOUD_STATUS: state, ORIGIN_MARKER: marker } }) });
  let bridge: ManagedStudioProviderBridge | undefined;
  try {
    await service.applySettings(managed); assert(service.captureManagedOrigin()?.current());
    bridge = new ManagedStudioProviderBridge(service, { model: "fixture", requestBody: body, ...(process.platform !== "win32" ? { verify: async () => true } : {}) });
    await assert.rejects(bridge.start(), /local-only inference/); assert.equal(bridge.approve(), false);
    await assert.rejects(readFile(marker), { code: "ENOENT" }); assert(await bridge.stop());
  } finally { await bridge?.stop(); await service.dispose(); }
});

it("a healthy managed protocol stand-in cannot open a private provider route with unqualified runtime files", { timeout: 40_000 }, async () => {
  const root = await realpath(await tempDir("arke-provider-content-refusal-")), marker = join(root, "requests.jsonl"); await mkdir(join(root, "ollama-runtime"));
  await copyFile(process.execPath, join(root, "ollama-runtime", "ollama.exe"));
  const service = new OllamaEngineService({ appRoot: root, port: await allocateLoopbackPort(),
    supervise: spec => new ChildSupervisor({ ...spec, args: [CHILD], readyTimeoutMs: 20_000, env: { ...spec.env, SERVICE_VERSION: OLLAMA_VERSION, ORIGIN_MARKER: marker } }) });
  let bridge: ManagedStudioProviderBridge | undefined;
  try {
    await service.applySettings(managed); assert(service.captureManagedOrigin()?.current());
    bridge = new ManagedStudioProviderBridge(service, { model: "fixture", requestBody: body });
    await assert.rejects(bridge.start(), /content could not be verified/); assert.equal(bridge.approve(), false);
    await assert.rejects(readFile(marker), { code: "ENOENT" }); assert(await bridge.stop());
  } finally { await bridge?.stop(); await service.dispose(); }
});

it("composes exact managed origin, one approved private provider request and retained cleanup across installation/override", { timeout: 120_000 }, async t => {
  const root = await realpath(await tempDir("arke-managed-provider-")), marker = join(root, "requests.jsonl");
  await mkdir(join(root, "ollama-runtime"));
  // A disposable Node image stands in for Ollama; this qualifies ownership/protocol, not model quality.
  await copyFile(process.execPath, join(root, "ollama-runtime", "ollama.exe"));
  const service = new OllamaEngineService({ appRoot: root, port: await allocateLoopbackPort(),
    privateContentPin: await nodeRuntimeContentPin(),
    fetch: async () => Response.json({ version: "explicit-personal-fixture" }),
    supervise: spec => new ChildSupervisor({ ...spec, args: [CHILD], readyTimeoutMs: 20_000,
      env: { ...spec.env, SERVICE_VERSION: OLLAMA_VERSION, ORIGIN_MARKER: marker } }),
  });
  let bridge: ManagedStudioProviderBridge | undefined, held: ManagedStudioProviderBridge | undefined, qualifying: ManagedStudioProviderBridge | undefined;
  let finishProof: ((ok: boolean) => void) | undefined, finishContent: (() => void) | undefined;
  let releaseInstall: (() => void) | undefined;
  const rows = async () => (await readFile(marker, "utf8")).trim().split("\n").map(line => JSON.parse(line) as { body: string; headers: Record<string, string> });
  try {
    assert.equal(service.captureManagedOrigin(), null);
    await service.applySettings(managed); const first = service.captureManagedOrigin(); assert(first); assert(first.current());
    assert(isSupervisedProcessOrigin(first.process)); assert.equal(first.process.executable, service.executable());
    if (process.platform !== "win32") t.diagnostic("Composition uses an injected proof on this platform; the default native port remains Windows-only.");
    bridge = new ManagedStudioProviderBridge(service, { model: "fixture", requestBody: body, timeoutMs: 30_000,
      ...(process.platform !== "win32" ? { verify: async () => true } : {}) });
    const route = await bridge.start(), headers = { authorization: `Bearer ${route.apiKey}`, "content-type": "application/json", "x-native-trace": "must-not-forward" };
    assert.match(route.identity, /^[a-f0-9]{64}$/);
    const before = await fetch(route.baseURL + "/chat/completions", { method: "POST", body, headers }); assert.equal(before.status, 409); await before.arrayBuffer();
    await assert.rejects(readFile(marker), { code: "ENOENT" });
    assert(bridge.approve());
    const response = await fetch(route.baseURL + "/chat/completions", { method: "POST", body, headers, signal: AbortSignal.timeout(40_000) });
    assert.equal(response.status, 200); assert.match(await response.text(), /fixture-complete/);
    const captured = await rows(); assert.equal(captured.length, 1); assert.equal(captured[0]?.body, body);
    assert.equal(captured[0]?.headers["x-native-trace"], undefined); assert.equal(captured[0]?.headers.authorization, undefined);
    assert(!JSON.stringify(captured).includes(route.apiKey));
    const repeat = await fetch(route.baseURL + "/chat/completions", { method: "POST", body, headers }); assert.equal(repeat.status, 409); await repeat.arrayBuffer();
    assert.equal(await bridge.stop(), true); assert(!bridge.busy()); assert(first.current());

    let entered = false, holdProof = false;
    held = new ManagedStudioProviderBridge(service, { model: "fixture", requestBody: body, shutdownMs: 20,
      verify: async () => { if (!holdProof) return true; entered = true; return new Promise<boolean>(resolve => { finishProof = resolve; }); } });
    const heldRoute = await held.start(); holdProof = true; assert(held.approve());
    const request = fetch(heldRoute.baseURL + "/chat/completions", { method: "POST", body, headers: { authorization: `Bearer ${heldRoute.apiKey}` } }).then(response => response.arrayBuffer(), () => null);
    await until(() => entered, "managed provider proof owns the connected socket");
    assert.equal(await held.stop(), false); await request; assert(held.busy()); assert.equal((await rows()).length, 1);
    finishProof!(true); await until(() => !held!.busy(), "retained managed bridge cleanup"); assert.equal(await held.stop(), true);
    assert.equal((await rows()).length, 1, "late proof cannot send another provider request");

    const qualify = service.qualifyManagedOrigin.bind(service); let checking = false;
    const content = new Promise<void>(resolve => { finishContent = resolve; });
    service.qualifyManagedOrigin = async signal => { checking = true; await content; return qualify(signal); };
    qualifying = new ManagedStudioProviderBridge(service, { model: "fixture", requestBody: body });
    const opening = assert.rejects(qualifying.start(), /content could not be verified/);
    await until(() => checking, "original content qualification is pending"); assert(qualifying.busy()); assert.equal(await qualifying.stop(), false);
    finishContent!(); await opening; assert(!qualifying.busy()); assert(await qualifying.stop());
    assert.equal((await rows()).length, 1, "a cancelled content qualification cannot prepare or dispatch another request");
    service.qualifyManagedOrigin = qualify;

    const installing = service.reserveInstallation(); assert(!first.current()); assert.equal(service.captureManagedOrigin(), null);
    assert.throws(() => new ManagedStudioProviderBridge(service, { model: "fixture", requestBody: body }));
    releaseInstall = await installing; releaseInstall(); releaseInstall = undefined;
    await service.refresh(); const next = service.captureManagedOrigin(); assert(next); assert(next.current());
    assert.notEqual(next.process.identity, first.process.identity); assert(!first.current());
    await service.applySettings({ ...managed, engineUrl: "http://127.0.0.1:11434" });
    assert.equal(service.status().source, "user-url"); assert(!next.current()); assert.equal(service.captureManagedOrigin(), null);
    assert.throws(() => new ManagedStudioProviderBridge(service, { model: "fixture", requestBody: body }));
    service.beginShutdown(); assert.equal(service.captureManagedOrigin(), null);
  } finally { finishContent?.(); finishProof?.(false); releaseInstall?.(); await qualifying?.stop(); await held?.stop(); await bridge?.stop(); await service.dispose(); }
});

it("does not acquire managed origin from a healthy explicitly selected existing Ollama install", async () => {
  const service = new OllamaEngineService({ appRoot: await tempDir("arke-personal-provider-"), port: 24102,
    fetch: async () => Response.json({ version: OLLAMA_VERSION }) });
  try {
    await service.applySettings({ ...managed, engineUrl: "http://127.0.0.1:11434" }); assert.equal(service.status().state, "ready");
    assert.equal(service.captureManagedOrigin(), null);
    assert.throws(() => new ManagedStudioProviderBridge(service, { model: "fixture", requestBody: body }));
  } finally { await service.dispose(); }
});
