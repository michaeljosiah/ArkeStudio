import assert from "node:assert/strict";
import { it } from "node:test";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { RecoveryControl } from "@arke-studio/contracts";
import { RecoveryControlService } from "../../src/recovery/control.js";
import { SupervisorRecovery } from "../../src/recovery/supervisor.js";
import { ChildSupervisor, type SupervisorRecoveryPort } from "../../src/supervisor.js";
import { LocalGpu } from "../../src/local-ai/gpu.js";
import { until } from "../wait.js";

const CHILD = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "child.mjs");
const identity = { key: "a".repeat(64), service: "ollama" as const }, digest = "b".repeat(64);
function control(options: { mode?: "automatic" | "suggest-only"; now?: () => number } = {}) {
  let disk: RecoveryControl = { version: 1, policyRevision: 1, mode: options.mode ?? "automatic", targets: [] };
  const store = { load: async () => structuredClone(disk), save: async (value: RecoveryControl) => { disk = structuredClone(value); } };
  return { service: new RecoveryControlService({ store, now: options.now }), store };
}
const specimen = (patch: Partial<ConstructorParameters<typeof ChildSupervisor>[0]> = {}) => new ChildSupervisor({ id: "recovery-native", command: process.execPath, args: [CHILD],
  readyTimeoutMs: 10_000, probeIntervalMs: 50, ...patch });
const policy = (service: RecoveryControlService, options: { acquire?: (signal: AbortSignal) => Promise<() => void>; current?: () => boolean; ownership?: () => "managed" | "external"; now?: () => number } = {}) =>
  new SupervisorRecovery({ control: service, identity, componentDigest: () => digest, current: options.current ?? (() => true), ownership: options.ownership ?? (() => "managed"),
    acquire: options.acquire ?? (async () => () => {}), now: options.now });

it("a real child exit waits behind admitted GPU work, then restarts and verifies readiness once", { timeout: 40_000 }, async () => {
  const h = control(), gpu = new LocalGpu(async () => {}, ["Ollama", "Ming"]), abort = new AbortController();
  const creative = await gpu.acquire("Ming", abort.signal);
  const port = policy(h.service, { acquire: signal => gpu.acquire("Ollama", signal) }), supervisor = specimen(); supervisor.setRecoveryPort(port);
  try {
    await supervisor.start(); assert.equal(supervisor.status, "healthy"); const previous = supervisor.pid!;
    process.kill(previous, "SIGKILL");
    await until(() => gpu.isBusy("Ollama"), "restart waiting behind creative work", 30_000);
    assert.equal(supervisor.pid, null); assert.equal(supervisor.status, "unhealthy"); assert.equal(h.service.snapshot().control.targets.length, 0);
    creative();
    await until(() => supervisor.pid !== null && supervisor.pid !== previous && supervisor.status === "healthy" && h.service.snapshot().control.targets[0]?.intent === null, "verified owned restart", 30_000);
    assert.equal(h.service.snapshot().control.targets[0]!.attempts.length, 1);
    assert.equal(gpu.isBusy("Ollama"), false, "verified startup released the inference lane");
  } finally { creative(); await supervisor.stopAndConfirm(); await port.ownerStopped(); await h.service.stop(); gpu.stop(); }
});

it("startup exits serialize through all allowed attempts rather than losing the next exit", { timeout: 40_000 }, async () => {
  let now = Date.now(), acquisitions = 0, releases = 0;
  const h = control({ now: () => now });
  const port = policy(h.service, { now: () => now, acquire: async () => { acquisitions++; return () => { releases++; }; } });
  const accelerated: SupervisorRecoveryPort = { allowStart: signal => port.allowStart(signal), recover: work => port.recover({ ...work, sleep: async ms => { now += ms; } }),
    mayStopForFailedHealth: () => port.mayStopForFailedHealth(), budgetExhausted: () => port.budgetExhausted(), ownerStopped: () => port.ownerStopped() };
  const supervisor = specimen({ env: { MODE: "exit-immediately" } }); supervisor.setRecoveryPort(accelerated);
  try {
    await supervisor.start();
    await until(() => supervisor.status === "failed" && h.service.snapshot().control.targets[0]?.circuitOpen === true, "bounded startup circuit", 30_000);
    assert.equal(h.service.snapshot().control.targets[0]!.attempts.length, 3);
    assert.equal(h.service.snapshot().control.targets[0]!.intent, null);
    assert.equal(acquisitions, 3); assert.equal(releases, 3); assert.equal(supervisor.spawnEpoch, 4);
    await supervisor.stopAndConfirm(); await h.service.stop();
    const restored = new RecoveryControlService({ store: h.store, now: () => now }); await restored.open();
    assert.equal((await policy(restored).allowStart(new AbortController().signal)).ok, false, "new supervisor/app instances cannot evade exhaustion"); await restored.stop();
  } finally { await supervisor.stopAndConfirm(); await port.ownerStopped(); await h.service.stop(); }
});

it("shutdown during the durable backoff never starts a replacement", { timeout: 40_000 }, async () => {
  const h = control(), port = policy(h.service), supervisor = specimen(); supervisor.setRecoveryPort(port);
  try {
    await supervisor.start(); process.kill(supervisor.pid!, "SIGKILL");
    await until(() => h.service.snapshot().control.targets[0]?.intent?.phase === "intended", "saved restart intent", 30_000);
    const epoch = supervisor.spawnEpoch;
    await supervisor.stopAndConfirm(); await port.ownerStopped();
    assert.equal(supervisor.pid, null); assert.equal(supervisor.spawnEpoch, epoch + 1, "only stop advanced the generation");
    assert.equal(h.service.snapshot().control.targets[0]!.intent, null);
  } finally { await supervisor.stopAndConfirm(); await port.ownerStopped(); await h.service.stop(); }
});

it("rechecks the component after port allocation before spawning a replacement", { timeout: 40_000 }, async () => {
  const h = control(); let currentDigest = digest;
  const port = new SupervisorRecovery({ control: h.service, identity, componentDigest: () => currentDigest,
    current: () => true, ownership: () => "managed", acquire: async () => () => {} });
  const supervisor = specimen(); supervisor.setRecoveryPort(port);
  supervisor.on("status", event => {
    if (event.status === "starting" && supervisor.spawnEpoch === 2) currentDigest = "c".repeat(64);
  });
  try {
    await supervisor.start(); process.kill(supervisor.pid!, "SIGKILL");
    await until(() => supervisor.reason?.includes("target or policy changed") === true && h.service.snapshot().control.targets[0]?.intent === null,
      "replacement refused after its target changed", 30_000);
    assert.equal(supervisor.pid, null); assert.equal(supervisor.spawnEpoch, 2);
    assert.equal(h.service.snapshot().control.targets[0]!.attempts.length, 1);
  } finally { await supervisor.stopAndConfirm(); await port.ownerStopped(); await h.service.stop(); }
});

it("Suggest only and external ownership refuse restart before acquiring a GPU reservation", { timeout: 40_000 }, async () => {
  for (const kind of ["suggest-only", "external"] as const) {
    let acquisitions = 0;
    const h = control({ mode: kind === "suggest-only" ? kind : "automatic" });
    const port = policy(h.service, { ownership: () => kind === "external" ? "external" : "managed", acquire: async () => { acquisitions++; return () => {}; } });
    const supervisor = specimen(); supervisor.setRecoveryPort(port);
    try {
      await supervisor.start(); process.kill(supervisor.pid!, "SIGKILL");
      await until(() => supervisor.status === "failed", "explicit recovery refusal", 30_000);
      assert.match(supervisor.reason!, kind === "external" ? /outside Arke/ : /Suggest only/);
      assert.equal(acquisitions, 0); assert.equal(supervisor.spawnEpoch, 1); assert.equal(h.service.snapshot().control.targets.length, 0);
    } finally { await supervisor.stopAndConfirm(); await port.ownerStopped(); await h.service.stop(); }
  }
});

it("failed health retains a still-running worker instead of treating it as safe to kill", { timeout: 40_000 }, async () => {
  const h = control(), port = policy(h.service), supervisor = specimen({ env: { HEALTHY_REQUESTS: "1" }, healthIntervalMs: 20, healthFailureThreshold: 1 }); supervisor.setRecoveryPort(port);
  try {
    await supervisor.start(); const pid = supervisor.pid!;
    await until(() => supervisor.reason?.includes("retained") === true, "retained unhealthy process", 30_000);
    assert.equal(supervisor.pid, pid); assert.equal(supervisor.spawnEpoch, 1); process.kill(pid, 0);
    assert.equal(h.service.snapshot().control.targets.length, 0);
  } finally { await supervisor.stopAndConfirm(); await port.ownerStopped(); await h.service.stop(); }
});

it("retains an unresolved cleanup's GPU lease until the lifecycle owner confirms stop", async () => {
  let now = 2_000_000, released = 0, acquired = 0, held = "";
  const h = control({ now: () => now }), port = policy(h.service, { now: () => now, acquire: async () => { acquired++; return () => { released++; }; } });
  await h.service.open();
  const work: Parameters<SupervisorRecoveryPort["recover"]>[0] = { generation: 1, signal: new AbortController().signal, current: () => true, exitConfirmed: () => true,
    sleep: async ms => { now += ms; }, held: reason => { held = reason; }, restart: async canSpawn => { assert(canSpawn()); return "unknown"; } };
  await port.recover(work); assert.equal(released, 0); assert.equal(h.service.snapshot().control.targets[0]!.intent!.phase, "unknown");
  await port.recover(work); assert.equal(acquired, 1); assert.match(held, /cleanup/);
  await port.ownerStopped(); assert.equal(released, 1); assert.equal(h.service.snapshot().control.targets[0]!.intent, null);
  await port.ownerStopped(); assert.equal(released, 1); await h.service.stop();
});
