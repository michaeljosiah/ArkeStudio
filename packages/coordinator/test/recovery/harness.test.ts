import assert from "node:assert/strict";
import { it } from "node:test";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { emptyRecoveryTarget, RecoveryControlSchema, type RecoveryControl } from "@arke-studio/contracts";
import { assembleHarness } from "../../src/harness/v2-launch.js";
import { ChildSupervisor } from "../../src/supervisor.js";
import { FileRecoveryControlStore } from "../../src/recovery/control-file.js";
import { createStudioCoordinator } from "../../src/application/studio-host.js";
import { FsWorldProvider } from "../../src/world/provider.js";
import { makeTempRoot } from "../world/helpers.js";
import { until, untilAsync } from "../wait.js";

const child = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "child.mjs");
const key = createHash("sha256").update("managed-harness-v2").digest("hex");
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
async function fixture(options: { personal?: boolean; suggest?: boolean; circuit?: boolean; version?: string } = {}) {
  const { root } = await makeTempRoot(), provider = new FsWorldProvider(root);
  const store = new FileRecoveryControlStore(join(root, "operations", "recovery-control.json"));
  const control: RecoveryControl = { version: 1, policyRevision: 1, mode: options.suggest ? "suggest-only" : "automatic", targets: [] };
  if (options.circuit) control.targets.push({ ...emptyRecoveryTarget(key, "harness", Date.now()), circuitOpen: true });
  await store.save(control);
  const env = { PASSWORD: "synthetic-recovery-fixture", SERVICE_VERSION: options.version ?? "2.0.26", MODE: "healthy" };
  const wiring = await assembleHarness({ appRoot: root,
    v2: { ...(options.personal ? { configuredPath: process.execPath } : { bundledPath: process.execPath }),
      runCommand: async command => command === "where" || command === "which" ? { status: 1, stdout: "" } : { status: 0, stdout: "opencode v2.0.26" } },
    createSupervisor: (spec, deps) => new ChildSupervisor({ ...spec, command: process.execPath, args: [child], inheritEnv: false, env,
      readyTimeoutMs: 3000, probeIntervalMs: 30 }, { ...deps, listDescendants: async () => [] }) });
  assert(wiring.supervisor && wiring.adapter && wiring.recovery);
  const entered = deferred(); let reservations = 0;
  const coordinator = createStudioCoordinator({ provider, adapter: null, appRoot: root, storageHealth: null, recoveryHistory: null,
    harnessInfo: wiring.harnessInfo, harnessRecovery: { ...wiring.recovery, reserve: signal => { reservations++; entered.resolve(); return wiring.recovery!.reserve(signal); } },
    changeLogPath: join(root, "log.jsonl"), appVersion: "harness-recovery-test" });
  coordinator.superviseAs("harness", wiring.supervisor);
  return { coordinator, provider, wiring, worker: wiring.supervisor, env, entered, store, reservations: () => reservations,
    disk: async () => RecoveryControlSchema.parse(await store.load()),
    close: async () => { await coordinator.stop(); await provider.close(); } };
}

it("the production host recovers its managed writing server only after an admitted turn settles, without replay", { timeout: 40_000 }, async () => {
  const h = await fixture(), finish = deferred(); let sends = 0;
  h.wiring.adapter!.sendMessage = async () => { sends++; await finish.promise; return { sessionId: "captured-turn", correlationId: "original" }; };
  try {
    await h.coordinator.start(0); await until(() => h.worker.status === "healthy", "managed writing server ready", 15000);
    const pid = h.worker.pid!, epoch = h.worker.spawnEpoch;
    const turn = h.wiring.adapter!.sendMessage({ sessionId: "captured-turn", parts: [] }); process.kill(pid, "SIGKILL");
    await h.entered.promise;
    assert.equal(h.worker.pid, null); assert.equal(h.worker.spawnEpoch, epoch); assert.equal((await h.disk()).targets.length, 0);
    await assert.rejects(h.wiring.adapter!.sendMessage({ sessionId: "new-turn", parts: [] }), /recovering/);
    finish.resolve(); await turn;
    await untilAsync(async () => h.worker.status === "healthy" && h.worker.spawnEpoch === epoch + 1 && (await h.disk()).targets[0]?.intent === null, "verified writing replacement", 20000);
    assert.notEqual(h.worker.pid, pid); assert.equal(sends, 1); assert.equal(h.reservations(), 1);
    const target = (await h.disk()).targets[0]!; assert.equal(target.service, "harness"); assert.equal(target.attempts.length, 1);
    assert.throws(() => h.coordinator.superviseAs("harness", h.worker), /once before startup/);
  } finally { finish.resolve(); await h.close(); }
  assert.equal(h.worker.pid, null);
});

it("Suggest only and personal writing executables never receive automatic replacement or a reset circuit", { timeout: 40_000 }, async () => {
  for (const options of [{ suggest: true }, { personal: true, circuit: true }]) {
    const h = await fixture(options);
    try {
      await h.coordinator.start(0); await until(() => h.worker.status === "healthy", "selected writing server ready", 15000);
      process.kill(h.worker.pid!, "SIGKILL"); await until(() => h.worker.status === "failed", "automatic writing recovery refused", 15000);
      assert.equal(h.worker.spawnEpoch, 1); assert.equal(h.reservations(), 0); assert.equal(h.worker.pid, null);
      const targets = (await h.disk()).targets;
      if (options.personal) { assert.equal(targets[0]!.circuitOpen, true); assert.equal(targets[0]!.attempts.length, 0); assert.match(h.worker.reason!, /outside Arke/); }
      else { assert.equal(targets.length, 0); assert.match(h.worker.reason!, /Suggest only/); }
    } finally { await h.close(); }
  }
});

it("shutdown cancels writing recovery waiting behind a turn before generic supervisor cleanup drains", { timeout: 40_000 }, async () => {
  const h = await fixture(), finish = deferred();
  let starts = 0; h.worker.on("status", event => { if (event.status === "starting") starts++; });
  h.wiring.adapter!.sendMessage = async () => { await finish.promise; return { sessionId: "captured-turn", correlationId: "original" }; };
  let turn: Promise<unknown> | undefined, timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await h.coordinator.start(0); await until(() => h.worker.status === "healthy", "writing server ready", 15000);
    turn = h.wiring.adapter!.sendMessage({ sessionId: "captured-turn", parts: [] }); process.kill(h.worker.pid!, "SIGKILL"); await h.entered.promise;
    await Promise.race([h.coordinator.stop(), new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error("writing recovery wait held native shutdown")), 15000); })]);
    assert.equal(h.worker.pid, null); assert.equal(starts, 1); assert.equal((await h.disk()).targets.length, 0);
  } finally { if (timeout) clearTimeout(timeout); finish.resolve(); await turn; await h.close(); }
});

it("a writing replacement that never verifies keeps its fence until a failed native stop is retried and confirmed", { timeout: 40_000 }, async () => {
  const h = await fixture(); let originalStop: (() => Promise<void>) | undefined;
  type StopSeam = { forceStop(child: unknown): Promise<void> }; const seam = h.worker as unknown as StopSeam, originalForce = seam.forceStop.bind(h.worker);
  try {
    await h.coordinator.start(0); await until(() => h.worker.status === "healthy", "writing server ready", 15000);
    seam.forceStop = async () => {}; h.env.MODE = "never-healthy"; process.kill(h.worker.pid!, "SIGKILL");
    await untilAsync(async () => (await h.disk()).targets[0]?.intent?.phase === "unknown", "retained writing replacement", 15000);
    assert.ok(h.worker.pid); seam.forceStop = originalForce; originalStop = h.worker.stopAndConfirm.bind(h.worker);
    h.worker.stopAndConfirm = async () => { throw new Error("unconfirmed writing process exit"); };
    await assert.rejects(h.coordinator.stop(), /Local runtime cleanup did not confirm exit/);
    await assert.rejects(h.wiring.recovery!.reserve(new AbortController().signal), /already reserved/);
    h.worker.stopAndConfirm = originalStop; await h.coordinator.stop(); assert.equal(h.worker.pid, null);
    const release = await h.wiring.recovery!.reserve(new AbortController().signal); release();
    const target = (await h.disk()).targets[0]!; assert.equal(target.intent, null); assert.equal(target.attempts.length, 1);
  } finally { seam.forceStop = originalForce; if (originalStop) h.worker.stopAndConfirm = originalStop; await h.close(); }
});

it("running writing-server protocol validation refuses an unsupported process despite pinned discovery metadata", { timeout: 25_000 }, async () => {
  const h = await fixture({ version: "2.0.25" });
  try {
    await h.coordinator.start(0); await until(() => h.worker.status === "failed", "unsupported server refused", 15000);
    assert.match(h.worker.reason!, /supported server protocol/); assert.equal(h.worker.spawnEpoch, 1); assert.equal(h.reservations(), 0);
    assert.equal((await h.disk()).targets.length, 0);
  } finally { await h.close(); }
  assert.equal(h.worker.pid, null);
});
