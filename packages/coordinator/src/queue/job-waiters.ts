import type { Job } from "@arke-studio/contracts";

/**
 * Jobs a caller awaits to their end — an audiobook run's parts, a heard block's (SPEC-047 R-16,
 * R-45). The queue reports a job's end once, to whoever is listening then, and the caller only
 * starts waiting after enqueue returns: a job that ends in between is held until someone waits,
 * so that race can never lose an answer.
 *
 * Hearing a block once never answered (2026-10-03): its jobs ended unheard because only a run's
 * part was settled here, and the press sat on `reading…` with the file landed and paid for. So a
 * registered waiter is answered whatever the job was asked for; `hold` decides only which jobs
 * are kept for a waiter still to come, since a job nobody will wait for must not be kept forever.
 */
export class JobWaiters {
  private readonly waiting = new Map<string, (job: Job) => void>();
  private readonly ended = new Map<string, Job>();

  wait(jobId: string): Promise<Job> {
    const done = this.ended.get(jobId);
    if (done !== undefined) {
      this.ended.delete(jobId);
      return Promise.resolve(done);
    }
    return new Promise((resolve) => this.waiting.set(jobId, resolve));
  }

  /** A job reached its end: its waiter is answered, or the job held for one when `hold`. */
  settle(job: Job, hold: boolean): void {
    const waiter = this.waiting.get(job.id);
    if (waiter !== undefined) {
      this.waiting.delete(job.id);
      waiter(job);
    } else if (hold) {
      this.ended.set(job.id, job);
    }
  }
}
