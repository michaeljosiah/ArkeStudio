import assert from "node:assert/strict";
import { it } from "node:test";
import { artifactTransferLimits, ArtifactTransferSettingsSchema, RecoveryAdvancedSettingsSchema, RecoveryControlSchema, ClientMessageSchema } from "../src/index.js";

it("keeps protective defaults and validates operator limits without granting arbitrary controls", () => {
  const defaults = RecoveryAdvancedSettingsSchema.parse({});
  assert.equal(defaults.checkStorageBeforeSubmission, true);
  assert.deepEqual(artifactTransferLimits(defaults.artifactTransfer), { maxFiles: 64, maxFileBytes: 1024 ** 3, maxTotalBytes: 4 * 1024 ** 3, timeoutMs: 30 * 60_000 });
  for (const value of [{ maxFiles: 257 }, { maxFileMiB: 2049 }, { maxTotalMiB: 8193 }, { timeoutMinutes: 0 }, { timeoutMinutes: 241 }, { maxFileMiB: 100, maxTotalMiB: 99 }]) {
    assert(!ArtifactTransferSettingsSchema.safeParse(value).success);
  }
  assert(!RecoveryAdvancedSettingsSchema.safeParse({ skipCredentialChecks: true }).success);
  const control = RecoveryControlSchema.parse({ version: 1, policyRevision: 1, mode: "automatic", targets: [], advanced: { artifactTransfer: { timeoutMinutes: -1 } } });
  assert.equal(control.advanced, undefined, "A malformed preference does not discard durable restart control");
  assert(!ClientMessageSchema.safeParse({ kind: "recovery-set-advanced", requestId: "01ARZ3NDEKTSV4RRFFQ69G5FAV", settings: { skipCredentialChecks: true } }).success);
});
