import assert from "node:assert/strict";
import { it } from "node:test";
import { emptyRecoveryHistory, type RecoveryControl, type RecoveryHistory } from "@arke-studio/contracts";
import { recoveryCommand } from "../../src/recovery/commands.js";
import { RecoveryControlService } from "../../src/recovery/control.js";
import { RecoveryHistoryService } from "../../src/recovery/history.js";

const requestId = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
it("waits for policy persistence, preserves retry holds and exposes no intent capability", async () => {
  let disk: RecoveryControl = { version: 1, policyRevision: 1, mode: "automatic", targets: [] }, finish!: () => void, entered!: () => void;
  const waiting = new Promise<void>(resolve => { entered = resolve; }), saved = new Promise<void>(resolve => { finish = resolve; });
  const control = new RecoveryControlService({ store: { load: async () => disk, save: async value => { entered(); await saved; disk = structuredClone(value); } } });
  await control.open(); let received = false;
  const pending = recoveryCommand({ kind: "recovery-set-mode", requestId, mode: "suggest-only" }, { control }).then(result => { received = true; return result; });
  await waiting; assert(!received); assert.equal(control.policySnapshot().mode, "automatic"); finish();
  assert.equal((await pending).status, "saved"); assert.equal(disk.mode, "suggest-only");
  const identity = { key: "a".repeat(64), service: "comfyui" as const };
  await control.markCircuitOpen(identity); await control.setStoppedByUser(identity, true);
  await recoveryCommand({ kind: "recovery-set-mode", requestId, mode: "automatic" }, { control });
  assert.deepEqual(control.policySnapshot().targets, [{ ...identity, stoppedByUser: true, circuitOpen: true, pendingOutcome: false }]);
  assert(!JSON.stringify(control.policySnapshot()).includes("componentDigest")); await control.stop();
});

it("persists presentation changes independently and refuses unavailable or inapplicable commands", async () => {
  let disk = emptyRecoveryHistory();
  const history = new RecoveryHistoryService({ store: { load: async () => structuredClone(disk), save: async value => { disk = structuredClone(value); } } });
  await history.open();
  const observedAt = Date.now(), incidentKey = "a".repeat(64);
  history.observe([{ key: incidentKey, kind: "storage-pressure", evidenceRevision: "b".repeat(64), observedAt, severity: "advisory", evidence: "fresh", phase: "needs-user", facts: [] }]);
  const incident = history.snapshot().incidents[0]!;
  assert.equal((await recoveryCommand({ kind: "recovery-history-control", requestId, command: { action: "acknowledge", incidentId: incident.id } }, { history })).status, "saved");
  assert.equal((await recoveryCommand({ kind: "recovery-history-control", requestId, command: { action: "snooze-session", incidentId: incident.id } }, { history })).status, "saved");
  assert.equal(history.snapshot().incidents[0]!.phase, "needs-user"); assert.equal(history.snapshot().activeCount, 1);
  assert.equal((await recoveryCommand({ kind: "recovery-set-preferences", requestId, preferences: { desktopOptIn: true, transientMuted: true } }, { history })).status, "saved");
  assert.deepEqual(disk.preferences, { desktopOptIn: true, transientMuted: true });
  assert.equal((await recoveryCommand({ kind: "recovery-history-control", requestId, command: { action: "acknowledge", incidentId: "c".repeat(64) } }, { history })).reason, "not-applicable");
  await history.stop();
  assert.equal((await recoveryCommand({ kind: "recovery-set-mode", requestId, mode: "automatic" }, {})).reason, "unavailable");
  let writes = 0;
  const failed = new RecoveryHistoryService({ store: { load: async () => emptyRecoveryHistory(), save: async (_value: RecoveryHistory) => { writes++; throw Object.assign(new Error("secret path"), { code: "ENOSPC" }); } } });
  await failed.open(); const result = await recoveryCommand({ kind: "recovery-set-preferences", requestId, preferences: { desktopOptIn: true } }, { history: failed });
  assert.equal(result.status, "refused"); assert.equal(result.reason, "unavailable"); assert(!JSON.stringify(result).includes("secret"));
  await recoveryCommand({ kind: "recovery-history-control", requestId, command: { action: "clear-resolved" } }, { history: failed });
  assert.equal(writes, 1); await failed.stop();
});
