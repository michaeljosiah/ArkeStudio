import assert from "node:assert/strict";
import { it } from "node:test";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { VoxaClient, VoxaCancelledError, VoxaRecoveryHeldError, SidecarHealthSchema } from "@arke-studio/voice";
import { emptyRecoveryTarget, RecoveryControlSchema, type RecoveryControl } from "@arke-studio/contracts";
import { createStudioCoordinator } from "../../src/application/studio-host.js";
import { FileRecoveryControlStore } from "../../src/recovery/control-file.js";
import { FsWorldProvider } from "../../src/world/provider.js";
import { ChildSupervisor } from "../../src/supervisor.js";
import { makeTempRoot } from "../world/helpers.js";
import { until, untilAsync } from "../wait.js";

const child = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "voice-child.mjs"), key = createHash("sha256").update("managed-voxa").digest("hex");
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
async function fixture(options: { personal?: boolean; suggest?: boolean; circuit?: boolean; holdBody?: boolean; protocol?: string; readyTimeoutMs?: number } = {}) {
  const { root } = await makeTempRoot(), provider = new FsWorldProvider(root), store = new FileRecoveryControlStore(join(root, "operations", "recovery-control.json"));
  const control: RecoveryControl = { version: 1, policyRevision: 1, mode: options.suggest ? "suggest-only" : "automatic", targets: [] };
  if (options.circuit) control.targets.push({ ...emptyRecoveryTarget(key, "voice", Date.now()), circuitOpen: true });
  await store.save(control);
  const env = { MODE: "healthy", IGNORE_STOP: "0", PROTOCOL_VERSION: options.protocol ?? "1" };
  const worker = new ChildSupervisor({ id: "voxa-fixture", command: process.execPath, args: [child], inheritEnv: false, env,
    healthPath: "/health", readyTimeoutMs: options.readyTimeoutMs ?? 10_000, probeIntervalMs: 30, validateHealth: async response => {
      const result = SidecarHealthSchema.safeParse(await response.json());
      return result.success && result.data.architecture === process.arch && result.data.engines.includes("kokoro") && result.data.engines.includes("whisper")
        ? true : { ok: false, reason: "incompatible voice protocol" };
    } }, { listDescendants: async () => [] });
  let requests = 0, released = 0, source = options.personal ? "configured" : "bundled";
  const body = deferred(), entered = deferred();
  const client = new VoxaClient(async (url, init) => {
    const response = await fetch(url, init);
    if (url.endsWith("/tts")) {
      requests++;
      if (options.holdBody && requests === 1) {
        const bytes = await response.arrayBuffer(); entered.resolve();
        return { status: response.status, arrayBuffer: async () => { await body.promise; return bytes; } } as Response;
      }
    }
    return response;
  }, () => `http://127.0.0.1:${worker.port ?? 0}`);
  // Match desktop request cancellation; recovery still drains the client's completion fence.
  worker.on("status", event => { if (event.status !== "healthy") client.cancelPending(); });
  const coordinator = createStudioCoordinator({ provider, adapter: null, appRoot: root, storageHealth: null, recoveryHistory: null, appVersion: "voice-recovery-test", changeLogPath: join(root, "log.jsonl"),
    voice: { sidecar: client, localPresets: [], cloudSources: [], dispose: () => client.dispose(), recovery: {
      ownership: () => source === "bundled" ? "managed" : "external", componentDigest: () => "b".repeat(64),
      reserve: async signal => { const release = await client.reserveRuntime(signal); return () => { released++; release(); }; },
    } } });
  coordinator.superviseAs("voice", worker);
  return { coordinator, worker, client, env, entered, body, requests: () => requests, released: () => released, selectPersonal: () => { source = "configured"; },
    disk: async () => RecoveryControlSchema.parse(await store.load()), close: async () => { body.resolve(); await coordinator.stop(); client.dispose(); await provider.close(); } };
}

it("a managed voice crash settles its admitted request without replay and verifies one replacement", { timeout: 100_000 }, async () => {
  const h = await fixture({ holdBody: true, readyTimeoutMs: 30_000 });
  try {
    await h.coordinator.start(0); await until(() => h.worker.status === "healthy", "voice fixture ready", 40000); const pid = h.worker.pid!;
    const pending = assert.rejects(h.client.synthesize({ voiceId: "fixture", text: "captured request" }), VoxaCancelledError); await h.entered.promise;
    process.kill(pid, "SIGKILL"); await pending;
    await untilAsync(async () => {
      assert.notEqual(h.worker.status, "failed", `voice replacement failed: ${h.worker.reason}`);
      return h.worker.status === "healthy" && h.worker.pid !== pid && (await h.disk()).targets[0]?.intent === null;
    }, "verified voice replacement", 40000);
    assert.equal(h.requests(), 1); assert.equal(h.released(), 1); assert.equal((await h.disk()).targets[0]!.service, "voice");
    assert.equal((await h.disk()).targets[0]!.attempts.length, 1); h.body.resolve();
    assert((await h.client.synthesize({ voiceId: "fixture", text: "explicit new request" })).byteLength > 44); assert.equal(h.requests(), 2);
  } finally { await h.close(); }
  assert.equal(h.worker.pid, null);
});

it("Suggest only and explicit personal voice selection cannot reset or bypass automatic policy", { timeout: 40_000 }, async () => {
  for (const options of [{ suggest: true }, { personal: true, circuit: true }]) {
    const h = await fixture(options);
    try {
      await h.coordinator.start(0); await until(() => h.worker.status === "healthy", "selected voice fixture ready", 15000);
      process.kill(h.worker.pid!, "SIGKILL"); await until(() => h.worker.status === "failed", "voice recovery refused", 15000);
      assert.equal(h.released(), 0); assert.equal(h.worker.pid, null);
      if (options.personal) { assert.match(h.worker.reason!, /outside Arke/); assert.equal((await h.disk()).targets[0]!.circuitOpen, true); assert.equal((await h.disk()).targets[0]!.attempts.length, 0); }
      else { assert.match(h.worker.reason!, /Suggest only/); assert.equal((await h.disk()).targets.length, 0); }
    } finally { await h.close(); }
  }
});

it("voice reconfiguration confirms the old process and settles its retained reservation before personal startup", { timeout: 120_000 }, async () => {
  const h = await fixture({ readyTimeoutMs: 30_000 }); type StopSeam = { forceStop(child: unknown): Promise<void> };
  const seam = h.worker as unknown as StopSeam, stop = seam.forceStop.bind(h.worker);
  try {
    await h.coordinator.start(0); await until(() => h.worker.status === "healthy", "voice fixture ready", 40_000);
    // An incompatible response proves the replacement initialized its signal handler before
    // validation fails. A three-second never-ready clock could kill a starved Linux child
    // before that handler existed, so it never exercised retained cleanup at all.
    seam.forceStop = async () => {}; h.env.PROTOCOL_VERSION = "2"; h.env.IGNORE_STOP = "1"; process.kill(h.worker.pid!, "SIGKILL");
    await untilAsync(async () => (await h.disk()).targets[0]?.intent?.phase === "unknown", "retained unverified voice process", 50_000);
    const retainedPid = h.worker.pid!; assert.ok(retainedPid); assert.equal(h.released(), 0);
    await assert.rejects(h.client.synthesize({ voiceId: "fixture", text: "must remain held" }), VoxaRecoveryHeldError);
    h.selectPersonal(); h.client.cancelPending();
    const launch = { command: process.execPath, args: [child], env: { ...h.env, MODE: "healthy", PROTOCOL_VERSION: "1", IGNORE_STOP: "0" }, inheritEnv: false };
    await assert.rejects(h.worker.reconfigure(launch), /not confirmed/); assert.equal(h.worker.pid, retainedPid); assert.equal(h.released(), 0); process.kill(retainedPid, 0);
    seam.forceStop = stop; await h.worker.reconfigure(launch);
    assert.equal(h.worker.status, "healthy"); assert.notEqual(h.worker.pid, retainedPid); assert.equal(h.released(), 1);
    assert.equal((await h.disk()).targets[0]!.intent, null); assert.equal((await h.disk()).targets[0]!.attempts.length, 1);
  } finally { seam.forceStop = stop; await h.close(); }
});

it("voice startup requires a compatible running protocol without spending crash-recovery attempts", { timeout: 25_000 }, async () => {
  const h = await fixture({ protocol: "2" });
  try {
    await h.coordinator.start(0); await until(() => h.worker.status === "failed", "incompatible voice protocol refused", 15000);
    assert.match(h.worker.reason!, /incompatible voice protocol/); assert.equal((await h.disk()).targets.length, 0); assert.equal(h.released(), 0);
  } finally { await h.close(); }
  assert.equal(h.worker.pid, null);
});
