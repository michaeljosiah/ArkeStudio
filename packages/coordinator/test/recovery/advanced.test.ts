import assert from "node:assert/strict";
import { it } from "node:test";
import { RecoveryAdvancedSettingsSchema, type RecoveryControl } from "@arke-studio/contracts";
import { RecoveryControlService } from "../../src/recovery/control.js";
import { recoveryCommand } from "../../src/recovery/commands.js";

it("persists advanced preferences across restart without clearing stop or retry holds", async () => {
  let disk: RecoveryControl = { version: 1, policyRevision: 1, mode: "automatic", targets: [] };
  const store = { load: async () => structuredClone(disk), save: async (next: RecoveryControl) => { disk = structuredClone(next); } };
  const control = new RecoveryControlService({ store }); await control.open();
  const target = { key: "a".repeat(64), service: "ollama" as const };
  await control.markCircuitOpen(target); await control.setStoppedByUser(target, true);
  const settings = RecoveryAdvancedSettingsSchema.parse({ checkStorageBeforeSubmission: false, artifactTransfer: { maxFiles: 100, timeoutMinutes: 90 } });
  const result = await recoveryCommand({ kind: "recovery-set-advanced", requestId: "01ARZ3NDEKTSV4RRFFQ69G5FAV", settings }, { control });
  assert.equal(result.status, "saved"); assert.deepEqual(control.advancedSettings(), settings); await control.stop();
  const restarted = new RecoveryControlService({ store }); await restarted.open();
  assert.deepEqual(restarted.advancedSettings(), settings); assert.equal(restarted.policySnapshot().targets[0]!.circuitOpen, true);
  assert.equal(restarted.policySnapshot().targets[0]!.stoppedByUser, true); await restarted.stop();
});
it("does not apply unconfirmed relaxed preferences after a failed control write", async () => {
  const control = new RecoveryControlService({ store: { load: async () => ({ version: 1, policyRevision: 1, mode: "automatic", targets: [] }), save: async () => { throw new Error("unconfirmed"); } } });
  await control.open();
  const settings = RecoveryAdvancedSettingsSchema.parse({ checkStorageBeforeSubmission: false });
  assert.equal(await control.setAdvanced(settings), false); assert.equal(control.advancedSettings().checkStorageBeforeSubmission, true);
  assert.equal(control.policySnapshot().audit, "unavailable"); await control.stop();
});
