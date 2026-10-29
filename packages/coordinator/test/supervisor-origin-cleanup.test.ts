import assert from "node:assert/strict";
import { join } from "node:path";
import { it } from "node:test";
import { ChildSupervisor, isSupervisedProcessCleanupConfirmed } from "../src/supervisor.js";

const child = join(import.meta.dirname, "fixtures/child.mjs");
it("native cleanup proof belongs to the captured process generation and requires confirmed stop", { timeout: 45_000 }, async () => {
  const supervisor = new ChildSupervisor({ id: "origin-cleanup", command: process.execPath, args: [child], readyTimeoutMs: 15_000 });
  try {
    await supervisor.start(); const original = supervisor.captureProcessOrigin(); assert(original);
    assert(!isSupervisedProcessCleanupConfirmed(original)); assert(!isSupervisedProcessCleanupConfirmed({ ...original }));
    await supervisor.stop(); assert(!original.current()); assert(!isSupervisedProcessCleanupConfirmed(original), "ordinary Stop is not confirmation");
    await supervisor.stopAndConfirm(); assert(isSupervisedProcessCleanupConfirmed(original));
    await supervisor.start(); const replacement = supervisor.captureProcessOrigin(); assert(replacement); assert.notEqual(replacement.identity, original.identity);
    assert(isSupervisedProcessCleanupConfirmed(original)); assert(!isSupervisedProcessCleanupConfirmed(replacement), "a new owner cannot inherit prior cleanup");
    await supervisor.stopAndConfirm(); assert(isSupervisedProcessCleanupConfirmed(replacement));
  } finally { await supervisor.stopAndConfirm(); }
});
it("failed native cleanup cannot confirm an original process until its successful cleanup retry", { timeout: 45_000 }, async () => {
  let refuse = true;
  const supervisor = new ChildSupervisor({ id: "origin-held-cleanup", command: process.execPath, args: [child], env: { MODE: "ignore-stop" }, readyTimeoutMs: 15_000 });
  // Refuse the complete forced-stop owner, including the captured-handle fallback. A failed
  // tree kill alone is recoverable and must not stand in for failure of every native route.
  const owner = supervisor as unknown as { forceStop(child: unknown): Promise<void> }, forceStop = owner.forceStop.bind(supervisor);
  owner.forceStop = async child => { if (!refuse) await forceStop(child); };
  try {
    await supervisor.start(); const origin = supervisor.captureProcessOrigin(); assert(origin);
    await assert.rejects(supervisor.stopAndConfirm(), /has not confirmed process exit/);
    assert(!origin.current()); assert(!isSupervisedProcessCleanupConfirmed(origin));
    refuse = false; await supervisor.stopAndConfirm(); assert(isSupervisedProcessCleanupConfirmed(origin));
  } finally { refuse = false; await supervisor.stopAndConfirm(); }
});
