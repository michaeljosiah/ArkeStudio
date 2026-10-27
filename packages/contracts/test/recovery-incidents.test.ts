import assert from "node:assert/strict";
import { it } from "node:test";
import { RECOVERY_HISTORY_LIMITS, RecoveryHistorySchema, RecoveryObservationSchema, emptyRecoveryHistory, observeRecoveryIncident, observeRecoveryIncidents,
  recoveryFindingFacts, recoveryIncidentSummary, recoveryNoticeDecision, recordRecoveryNotice, type Finding, type RecoveryObservation } from "../src/index.js";

const key = "a".repeat(64), revision = "b".repeat(64), session = "f".repeat(64), now = 2_000_000;
const id = (value: number) => value.toString(16).padStart(64, "0");
const observation = (patch: Partial<RecoveryObservation> = {}): RecoveryObservation => ({ key, kind: "storage-pressure", evidenceRevision: revision,
  observedAt: now, severity: "advisory", phase: "needs-user", evidence: "fresh", facts: [{ name: "available-bytes", value: 2 * 1024 ** 3, measuredAt: now }], ...patch });

it("deduplicates a persistent resource and links recurrence without granting repair authority", () => {
  const empty = emptyRecoveryHistory(), first = observeRecoveryIncident(empty, observation(), id(1), now);
  const repeated = observeRecoveryIncident(first, observation({ observedAt: now + 1 }), id(2), now + 1);
  assert.equal(empty.incidents.length, 0); assert.equal(first.incidents.length, 1);
  assert.equal(repeated.incidents.length, 1); assert.equal(repeated.incidents[0]!.id, id(1));
  const cleared = observeRecoveryIncident(repeated, observation({ observedAt: now + 2, phase: "recovered", resolution: "verified-capacity" }), id(3), now + 2);
  const recurrence = observeRecoveryIncident(cleared, observation({ observedAt: now + 3 }), id(4), now + 3);
  assert.equal(recurrence.incidents.length, 2); assert.equal(recurrence.incidents[1]!.previousId, id(1));
  assert(!JSON.stringify(recurrence).includes("attempts")); assert(!JSON.stringify(recurrence).includes("approval"));
});

it("announces an available preview review without persisting its target or granting deletion", () => {
  const facts = [{ name: "available-bytes" as const, value: 4 * 1024 ** 3, measuredAt: now },
    { name: "reviewable-previews" as const, value: 1, measuredAt: now }];
  const history = observeRecoveryIncident(emptyRecoveryHistory(), observation({ phase: "action-available", facts }), id(1), now);
  const incident = history.incidents[0]!;
  assert.match(recoveryIncidentSummary(incident).detail, /review is available in Diagnostics/);
  assert.match(recoveryIncidentSummary(incident).detail, /needs your approval/);
  assert(!JSON.stringify(history).includes("scope")); assert(!JSON.stringify(history).includes("planId"));
  assert.match(recoveryIncidentSummary({ ...incident, evidence: "stale" }).detail, /Refresh Diagnostics/);
  assert.doesNotMatch(recoveryIncidentSummary({ ...incident, phase: "needs-user" }).detail, /review is available/);
  recordRecoveryNotice(incident, now);
  assert.equal(recoveryNoticeDecision(incident, incident, history, now + 1000, session), null);
});

it("refuses missing verification, clock reversal and future measurements without inventing recovery", () => {
  const first = observeRecoveryIncident(emptyRecoveryHistory(), observation(), id(1), now);
  assert(!RecoveryObservationSchema.safeParse(observation({ phase: "recovered" })).success);
  assert(!RecoveryObservationSchema.safeParse(observation({ phase: "recovered", resolution: "verified-capacity", evidence: "stale" })).success);
  assert.deepEqual(observeRecoveryIncident(first, observation({ observedAt: now + 1 }), id(2), now - 1), first);
  assert.deepEqual(observeRecoveryIncident(first, observation({ observedAt: now + 1 }), id(2), now), first);
  assert.deepEqual(observeRecoveryIncident(first, observation({ facts: [{ name: "available-bytes", value: 100, measuredAt: now + 1 }] }), id(2), now), first);
  const missing = observeRecoveryIncidents(first, [], now + 1);
  assert.equal(missing.incidents[0]!.phase, "needs-user");
});

it("persists the advisory budget, honors mute/snooze, and allows one critical notice per transition", () => {
  let history = observeRecoveryIncident(emptyRecoveryHistory(), observation(), id(1), now), incident = history.incidents[0]!;
  assert.equal(recoveryNoticeDecision(incident, undefined, history, now, session), "first-actionable"); recordRecoveryNotice(incident, now);
  assert.equal(recoveryNoticeDecision(incident, incident, history, now + 1, session), null);
  assert.equal(recoveryNoticeDecision(incident, incident, history, now + 86400_000, session), "advisory-reminder");
  incident.delivery.snoozedSession = session;
  assert.equal(recoveryNoticeDecision(incident, incident, history, now + 86400_000, session), null);
  const previous = incident;
  history = observeRecoveryIncident(history, observation({ severity: "blocking", observedAt: now + 1 }), id(2), now + 1); incident = history.incidents[0]!;
  assert.equal(recoveryNoticeDecision(incident, previous, history, now + 1, session), "severity-escalated"); recordRecoveryNotice(incident, now + 1);
  assert.equal(recoveryNoticeDecision(incident, incident, history, now + 2, session), null);
  history.preferences.transientMuted = true;
  incident.delivery.lastCriticalTransition = null;
  assert.equal(recoveryNoticeDecision(incident, previous, history, now + 2, session), null);
});

it("reports failed recovery and verified availability separately from a creative job's outcome", () => {
  let history = observeRecoveryIncident(emptyRecoveryHistory(), observation({ phase: "recovering", facts: [{ name: "held-jobs", value: 2, measuredAt: now }] }), id(1), now);
  const recovering = history.incidents[0]!;
  history = observeRecoveryIncident(history, observation({ phase: "needs-user", observedAt: now + 1 }), id(2), now + 1);
  let incident = history.incidents[0]!; recordRecoveryNotice(incident, now);
  assert.equal(recoveryNoticeDecision(incident, recovering, history, now + 1, session), "recovery-failed");
  const failed = incident;
  history = observeRecoveryIncident(history, observation({ phase: "recovered", resolution: "verified-capacity", observedAt: now + 2 }), id(3), now + 2);
  incident = history.incidents[0]!;
  assert.equal(recoveryNoticeDecision(incident, failed, history, now + 2, session), "recovered"); recordRecoveryNotice(incident, now + 2);
  assert.equal(recoveryNoticeDecision(incident, incident, history, now + 3, session), null);
});

it("caps active history and wire-safe summaries without evicting active faults", () => {
  const observations = Array.from({ length: 1001 }, (_, index) => ({ id: id(index + 1), observation: observation({ key: id(index + 1) }) }));
  const history = observeRecoveryIncidents(emptyRecoveryHistory(), observations, now);
  assert.equal(history.incidents.length, 1000); assert.equal(history.overflow.coalescedObservations, 1); assert(history.overflow.lostDetail);
  assert(Buffer.byteLength(JSON.stringify(RecoveryHistorySchema.parse(history))) < RECOVERY_HISTORY_LIMITS.maxBytes);
  assert.equal(history.incidents[0]!.id, id(1));
});

it("expires resolved summaries after thirty days while retaining current active incidents", () => {
  const first = observeRecoveryIncident(emptyRecoveryHistory(), observation(), id(1), now);
  const resolved = observeRecoveryIncident(first, observation({ phase: "recovered", resolution: "verified-capacity" }), id(2), now);
  const later = now + RECOVERY_HISTORY_LIMITS.retentionMs + 1;
  const next = observeRecoveryIncident(resolved, observation({ key: id(99), observedAt: later, facts: [] }), id(3), later);
  assert.equal(next.incidents.length, 1); assert.equal(next.incidents[0]!.id, id(3)); assert.equal(next.overflow.prunedSummaries, 1);
});

it("stores enumerated numeric facts instead of subsystem text, paths, prompts and log content", () => {
  const finding = { facts: [
    { name: "available-bytes", value: 42, source: "app.storageHealth.roots", measuredAt: new Date(now).toISOString() },
    { name: "source", value: "C:/private/world-name", source: "raw worker output", measuredAt: new Date(now).toISOString() },
    { name: "available-bytes", value: "secret", source: "secret source", measuredAt: new Date(now).toISOString() },
    { name: "prompt", value: "world prose", source: "content", measuredAt: new Date(now).toISOString() },
  ] } as Finding;
  assert.deepEqual(recoveryFindingFacts(finding), [{ name: "available-bytes", value: 42, measuredAt: now }]);
  assert(!RecoveryObservationSchema.safeParse({ ...observation(), cause: "raw log" }).success);
  const history = observeRecoveryIncident(emptyRecoveryHistory(), observation(), id(1), now);
  assert(!RecoveryHistorySchema.safeParse({ ...history, shell: "run a repair" }).success);
});
