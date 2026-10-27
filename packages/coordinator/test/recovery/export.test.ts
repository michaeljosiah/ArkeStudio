import assert from "node:assert/strict";
import { it } from "node:test";
import { emptyRecoveryHistory, observeRecoveryIncidents, IDLE_UPDATE_STATE, type ClientState, type RecoveryHistory, type RecoveryPolicySnapshot } from "@arke-studio/contracts";
import { buildDiagnosticsBundle } from "../../src/diagnostics.js";
import { SecretRegistry } from "../../src/redact.js";

const now = 2_000_000;
const state = { app: { version: "test", health: { coordinator: { status: "healthy" }, harness: { status: "healthy" }, voice: { status: "healthy" } }, providers: [], routing: { defaults: {}, faults: [] }, spend: null,
  runtime: null, voiceRuntime: null, drift: [], manifest: null, jobs: [], ledger: [], ledgerUnavailable: false, update: IDLE_UPDATE_STATE }, worlds: [], world: null } as unknown as ClientState;

it("exports the entire bounded incident history and enumerated policy through the existing diagnostics boundary", async () => {
  const history = observeRecoveryIncidents(emptyRecoveryHistory(), Array.from({ length: 1000 }, (_, index) => ({ id: (index + 1).toString(16).padStart(64, "0"), observation: {
    key: (index + 1).toString(16).padStart(64, "0"), kind: "storage-pressure" as const, evidenceRevision: "b".repeat(64), observedAt: now, phase: "needs-user" as const,
    evidence: "fresh" as const, severity: "advisory" as const, facts: [{ name: "available-bytes" as const, value: 42, measuredAt: now }],
  } })), now);
  history.incidents[0]!.delivery.snoozedSession = "c".repeat(64);
  const sentinel = "NEVER_EXPORT_RECOVERY_PROSE", secret = "sk-recovery-export-secret", absolute = "/Users/recovery-export-private/model.bin";
  Object.assign(history, { futureText: sentinel, nativeTargets: [absolute] });
  Object.assign(history.incidents[0]!, { worldTitle: sentinel, rawLog: secret, localPath: absolute });
  Object.assign(history.incidents[0]!.facts[0]!, { path: absolute, explanation: sentinel });
  const policy: RecoveryPolicySnapshot = { audit: "available", accepting: true, mode: "suggest-only", targets: [{ key: "d".repeat(64), service: "comfyui", stoppedByUser: true, circuitOpen: true, pendingOutcome: true }] };
  Object.assign(policy.targets[0]!, { intentId: "e".repeat(64), componentDigest: "f".repeat(64), rawLog: sentinel, localPath: absolute });
  const registry = new SecretRegistry(); registry.register(secret);
  const bundle = await buildDiagnosticsBundle(state, null, registry, null, { history, audit: { audit: "unavailable", reason: "disk-full" }, policy });
  const recovery = bundle.recovery as { history: { audit: string; reason: string; incidents: Array<{ resourceId: string; notification: Record<string, unknown> }> }; policy: { targets: Record<string, unknown>[] } };
  assert.equal(recovery.history.incidents.length, 1000); assert.equal(recovery.history.audit, "unavailable"); assert.equal(recovery.history.reason, "disk-full");
  assert.equal(recovery.history.incidents[0]!.resourceId, history.incidents[0]!.key); assert(!("snoozedSession" in recovery.history.incidents[0]!.notification));
  assert.deepEqual(recovery.policy.targets, [{ resourceId: "d".repeat(64), service: "comfyui", stoppedByUser: true, circuitOpen: true, pendingOutcome: true }]);
  const text = JSON.stringify(bundle); for (const excluded of [sentinel, secret, absolute, "c".repeat(64), "e".repeat(64), "f".repeat(64)]) assert(!text.includes(excluded));
  const poisoned = structuredClone(history) as RecoveryHistory; poisoned.incidents[0]!.evidenceRevision = `${secret} ${absolute}`;
  const scrubbed = JSON.stringify(await buildDiagnosticsBundle(state, null, registry, null, { history: poisoned, audit: { audit: "available" }, policy: null }));
  assert(!scrubbed.includes(secret)); assert(!scrubbed.includes("recovery-export-private")); assert(scrubbed.includes("[redacted]"));
});

it("exports only closed latest outcome facts and never their control identity or injected fields", async () => {
  const receipt = { action: "restart-managed-runtime" as const, automatic: true, authorizedAt: now, settledAt: now + 10, outcome: "unknown" as const };
  Object.assign(receipt, { intentId: "PRIVATE_INTENT", componentDigest: "PRIVATE_DIGEST", rawLog: "PRIVATE_WORKER_OUTPUT", path: "/private/runtime" });
  const policy: RecoveryPolicySnapshot = { audit: "available", accepting: true, mode: "automatic", targets: [{ key: "d".repeat(64), service: "ollama", stoppedByUser: false, circuitOpen: false, pendingOutcome: true, lastOutcome: receipt }] };
  const bundle = await buildDiagnosticsBundle(state, null, new SecretRegistry(), null, { history: null, audit: null, policy });
  const exported = bundle.recovery as { policy: { targets: { lastOutcome: unknown }[] } };
  assert.deepEqual(exported.policy.targets[0]!.lastOutcome, { action: "restart-managed-runtime", automatic: true, authorizedAt: now, settledAt: now + 10, outcome: "unknown" });
  assert(!JSON.stringify(bundle).includes("PRIVATE_")); assert(!JSON.stringify(bundle).includes("/private/runtime"));
  Object.assign(receipt, { outcome: "PRIVATE_FORGED_OUTCOME" });
  const refused = JSON.stringify(await buildDiagnosticsBundle(state, null, new SecretRegistry(), null, { history: null, audit: null, policy }));
  assert(!refused.includes("PRIVATE_FORGED")); assert(refused.includes('"unavailable":true'));
});

it("exports bounded chronological action summaries without future fields or executable identifiers", async () => {
  const history = emptyRecoveryHistory();
  history.actions = Array.from({ length: 1000 }, (_, index) => ({ id: (index + 1).toString(16).padStart(64, "0"), resourceId: "a".repeat(64),
    action: "cleanup-local-preset-previews", automatic: false, authorizedAt: null, outcomeAt: now, outcome: "cancelled", evidence: "owner-receipt",
    cleanup: { removedFiles: 1, logicalBytes: 60, availableBefore: null, availableAfter: null, reclaimedBytes: null } }));
  Object.assign(history.actions[0]!, { planId: "PRIVATE_PLAN", intentId: "PRIVATE_INTENT", path: "/private/cache.wav", prompt: "PRIVATE_PROSE" });
  Object.assign(history.actions[0]!.cleanup!, { path: "/private/cleanup.wav" });
  const bundle = await buildDiagnosticsBundle(state, null, new SecretRegistry(), null, { history, audit: { audit: "available" }, policy: null });
  const exported = bundle.recovery as { history: { actionsAvailable: boolean; actions: unknown[] } };
  assert.equal(exported.history.actionsAvailable, true); assert.equal(exported.history.actions.length, 1000);
  const text = JSON.stringify(exported); assert(!text.includes("PRIVATE_")); assert(!text.includes("/private/"));
  history.actions[0]!.id = "PRIVATE_FORGED_ID";
  const invalid = JSON.stringify(await buildDiagnosticsBundle(state, null, new SecretRegistry(), null, { history, audit: { audit: "available" }, policy: null }));
  assert(!invalid.includes("PRIVATE_FORGED")); assert(invalid.includes('"unavailable":true'));
});
