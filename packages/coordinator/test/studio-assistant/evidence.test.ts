import assert from "node:assert/strict";
import { it } from "node:test";
import { StudioDiagnosticEvidenceSchema, StudioAssistantDecisionSchema, STUDIO_ASSISTANT_LIMITS, type RecoveryHistorySnapshot, type StorageHealthSnapshot } from "@arke-studio/contracts";
import { studioDiagnosticEvidence } from "../../src/studio-assistant/evidence.js";

const now = 600_000, digest = "a".repeat(64);
function history(): RecoveryHistorySnapshot {
  return { at: now, audit: "available", activeCount: 1, resolvedCount: 0, limited: false, preferences: { transientMuted: false, desktopOptIn: false },
    overflow: { coalescedObservations: 0, prunedSummaries: 0, lostDetail: false }, incidents: [{ id: digest, key: digest, kind: "storage-pressure", firstObservedAt: now, lastObservedAt: now,
      evidenceRevision: digest, phase: "needs-user", severity: "degraded", evidence: "fresh", facts: [{ name: "available-bytes", value: 1000, measuredAt: now }],
      everHeldWork: true, acknowledgedAt: null, severityTransition: 0,
      delivery: { lastAt: null, lastSeverity: null, lastPhase: null, lastCriticalTransition: null, snoozedUntil: null, snoozedSession: null } }] };
}
function storage(): StorageHealthSnapshot {
  return { at: now, writing: false, roots: [{ rootId: "PRIVATE_WORLD_PATH", role: "generated-media", source: "host-provided", state: "measured", limitations: ["quota-unavailable"], pressure: null, forecast: null,
    capacity: { volumeId: "PRIVATE_VOLUME_NAME", mappingRevision: "PRIVATE_ROOT_MAPPING", measuredAt: now, availableBytes: 1000, totalBytes: 10000 } }],
    admission: { state: "available", reservations: 0, uncertain: 0 } };
}
it("constructs a closed operational envelope without free text, paths, job parameters or provider identities", () => {
  const h = history(); Object.assign(h.incidents[0]!, { cause: "PRIVATE_RAW_LOG", title: "PRIVATE_WORLD_PROSE", token: "PRIVATE_CREDENTIAL" });
  const result = studioDiagnosticEvidence("storage", { history: h, storage: storage() }, now);
  const json = JSON.stringify(result); assert(!json.includes("PRIVATE_")); assert.equal(result.incidents[0]!.facts[0]!.value, 1000);
  assert.deepEqual(result.storage[0]!.limitations, ["quota-unavailable"]); assert.match(result.storage[0]!.capacity!.volumeId, /^[a-f0-9]{64}$/);
  const privateJob = { id: "PRIVATE_JOB_ID", capability: "image" as const, status: "running" as const, attempt: 1, providerJobId: "PRIVATE_ACCEPTED_ID", updatedAt: new Date(now).toISOString(),
    params: { prompt: "PRIVATE_WORLD_PROMPT" }, model: "PRIVATE_MODEL_FILE", error: "PRIVATE_ERROR_LOG" };
  const jobs = studioDiagnosticEvidence("jobs", { jobs: [privateJob] }, now);
  assert(!JSON.stringify(jobs).includes("PRIVATE_")); assert.equal(jobs.jobs[0]!.accepted, true); assert.equal(jobs.jobs[0]!.status, "running");
});
it("labels stale/future observations honestly and preserves their actual timestamp without granting fresh capacity", () => {
  const h = history(), s = storage(); h.incidents[0]!.facts[0]!.measuredAt = now - 60_001;
  assert.equal(studioDiagnosticEvidence("storage", { history: h, storage: s }, now).incidents[0]!.evidence, "stale");
  h.incidents[0]!.facts[0]!.measuredAt = now + 1; s.roots[0]!.capacity!.measuredAt = now + 1;
  const result = studioDiagnosticEvidence("storage", { history: h, storage: s }, now);
  assert.equal(result.incidents[0]!.evidence, "unavailable"); assert.equal(result.incidents[0]!.facts[0]!.value, null); assert.equal(result.incidents[0]!.facts[0]!.measuredAt, now + 1);
  assert.equal(result.storage[0]!.capacity, null); assert.equal(result.storage[0]!.state, "unavailable");
  const absent = studioDiagnosticEvidence("local-ai", {}, now); assert.equal(absent.audit.history, "unavailable"); assert.deepEqual(absent.jobs, []);
});
it("bounds the window and payload and keeps truncation explicit instead of asserting all work is healthy", () => {
  const s = storage(); s.roots = Array.from({ length: 128 }, (_, index) => ({ ...s.roots[0]!, rootId: `root-${index}` }));
  const result = studioDiagnosticEvidence("storage", { storage: s }, now);
  assert.equal(result.storage.length, 16); assert.equal(result.limited.storage, true); assert(Buffer.byteLength(JSON.stringify(result)) <= STUDIO_ASSISTANT_LIMITS.evidenceBytes);
  assert.equal(StudioDiagnosticEvidenceSchema.safeParse({ ...result, rawLog: "must never enter model context" }).success, false);
  for (const value of [{ kind: "diagnose", topic: "storage", prompt: "private transcript" }, { kind: "repair", path: "C:/private" }, { kind: "handoff", destination: "world", draft: "hello", send: true }]) {
    assert.equal(StudioAssistantDecisionSchema.safeParse(value).success, false);
  }
});
