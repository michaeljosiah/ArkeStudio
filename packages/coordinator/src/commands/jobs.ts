import type { JobQueue } from "../queue/dispatcher.js";
import type { CommandModule } from "./router.js";

/** The job queue: cancelling, retrying a finalization, deleting, deciding a held job, resuming. No world. */
export function jobCommands(deps: { jobQueue: () => JobQueue | null }) {
  return {
    "cancel-job": { scope: "none", async handle(msg) { await deps.jobQueue()?.cancel(msg.jobId); } },
    "retry-job-finalization": { scope: "none", async handle(msg) { await deps.jobQueue()?.retryFinalization(msg.jobId); } },
    "delete-job": { scope: "none", async handle(msg) { await deps.jobQueue()?.delete(msg.jobId); } },
    "resolve-held-job": { scope: "none", async handle(msg) { await deps.jobQueue()?.resolveHeld(msg.jobId, msg.decision); } },
    // The message IS the explicit confirmation resuming a paused provider (SPEC-009 D7).
    "queue-resume": { scope: "none", handle(msg) { deps.jobQueue()?.resume(msg.provider); } },
  } satisfies CommandModule;
}
