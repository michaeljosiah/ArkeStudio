import type { Job } from "@arke-studio/contracts";
import type { JobQueue } from "../src/queue/dispatcher.js";

/**
 * A stand-in for the coordinator's job queue, answering every lookup from one list. The coordinator
 * looks single jobs up with get, find and active rather than copying the whole history through
 * listJobs (issue 2792), so a stand-in with listJobs alone silently found nothing. Typed as the
 * queue it stands in for, so a test assigns it to the coordinator's member as that member is
 * declared (issue 2795); the methods it lacks are ones these tests never reach.
 */
export function fakeJobQueue<J extends Partial<Job>>(jobs: () => J[]): JobQueue {
  return {
    listJobs: () => jobs(),
    get: (id: string) => jobs().find(job => job.id === id),
    find: (match: (job: J) => unknown) => jobs().find(match),
    active: () => jobs().filter(job => job.status === "queued" || job.status === "submitting" || job.status === "running"),
  } as unknown as JobQueue;
}
