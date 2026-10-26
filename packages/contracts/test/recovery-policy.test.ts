import assert from "node:assert/strict";
import { it } from "node:test";
import { RecoveryControlSchema, RecoveryRestartContextSchema, decideRecoveryRestart, emptyRecoveryTarget, recentRecoveryAttempts } from "../src/recovery-policy.js";

const now = 2_000_000, key = "a".repeat(64);
const context = { ownership: "managed" as const, idle: true, exitConfirmed: true, generation: 2, componentDigest: "b".repeat(64) };
it("refuses every automatic restart without declared ownership, idle work and confirmed cleanup", () => {
  const target = emptyRecoveryTarget(key, "comfyui", now);
  for (const [patch, reason] of [[{ ownership: "external" }, "external"], [{ idle: false }, "busy"], [{ exitConfirmed: false }, "cleanup-unconfirmed"]] as const) {
    assert.deepEqual(decideRecoveryRestart({ target, context: { ...context, ...patch }, mode: "automatic", automatic: true, now }), { allowed: false, reason });
  }
  assert.deepEqual(decideRecoveryRestart({ target, context, mode: "suggest-only", automatic: true, now }), { allowed: false, reason: "suggest-only" });
  target.stoppedByUser = true;
  assert.deepEqual(decideRecoveryRestart({ target, context, mode: "automatic", automatic: true, now }), { allowed: false, reason: "user-stopped" });
});
it("keeps rolling attempts and open circuits independent of consecutive-failure reset", () => {
  const target = emptyRecoveryTarget(key, "ollama", now);
  target.attempts = [now - 100, now - 50, now]; target.consecutiveFailures = 0;
  assert.deepEqual(decideRecoveryRestart({ target, context, mode: "automatic", automatic: true, now }), { allowed: false, reason: "circuit-open" });
  target.attempts = []; target.circuitOpen = true;
  assert.deepEqual(decideRecoveryRestart({ target, context, mode: "automatic", automatic: true, now: now + 900_000 }), { allowed: false, reason: "circuit-open" });
  assert.deepEqual(decideRecoveryRestart({ target, context, mode: "suggest-only", automatic: false, now }), { allowed: true, delayMs: 0 });
});
it("keeps future attempts and refuses mutation on wall-clock reversal", () => {
  const target = emptyRecoveryTarget(key, "voice", now); target.attempts = [now];
  assert.deepEqual(recentRecoveryAttempts(target, now - 1), [now]);
  assert.deepEqual(decideRecoveryRestart({ target, context, mode: "automatic", automatic: true, now: now - 1 }), { allowed: false, reason: "clock-reversed" });
});
it("refuses arbitrary commands, paths, unknown policy versions and duplicate resources", () => {
  const target = emptyRecoveryTarget(key, "harness", now);
  const value = { version: 1, policyRevision: 1, mode: "automatic", targets: [target] };
  assert(RecoveryControlSchema.safeParse(value).success);
  for (const invalid of [{ ...value, policyRevision: 2 }, { ...value, targets: [target, target] }, { ...value, command: "pip install anything" },
    { ...value, targets: [{ ...target, key: "C:\\private\\runtime" }] }]) assert(!RecoveryControlSchema.safeParse(invalid).success);
  assert(!RecoveryRestartContextSchema.safeParse({ ...context, path: "/private/runtime" }).success);
});
