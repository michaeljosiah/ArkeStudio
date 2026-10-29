import type { JobSummary } from "./job-summary.js";
import type { SetupStatus } from "./setup.js";

/** Counts only current owner-reported holds. No prose matching, file paths, or inference
 * from a historic failed check. Counts confer no retry, deletion or dispatch authority. */
export function storageWaitingWork(jobs: readonly JobSummary[], setup: SetupStatus | null | undefined, now: number) {
  let unsubmitted = 0, completed = 0, unverified = 0;
  const seen = new Set<string>();
  for (const job of jobs) {
    const wait = job.storageWait;
    if (seen.has(job.id) || job.deletedAt || !wait || Date.parse(wait.observedAt) > now || !Number.isFinite(Date.parse(wait.observedAt))) continue;
    const submission = wait.phase === "submission" && job.status === "queued";
    const result = wait.phase === "result" && (job.status === "running" || job.status === "submitting");
    if (!submission && !result) continue;
    seen.add(job.id);
    if (submission) unsubmitted++; else completed++;
    if (wait.reason === "unavailable") unverified++;
  }
  const downloads = new Set((setup?.components ?? []).filter(component => component.state === "blocked" && component.blockedBy === "disk").map(component => component.id)).size;
  return { unsubmitted, completed, downloads, unverified, total: unsubmitted + completed + downloads };
}
