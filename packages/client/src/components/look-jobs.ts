import { useEffect, useState } from "react";
import { pictureRefusal, type Job } from "@arke-studio/contracts";
import { subscribeQueueResults } from "../lib/store.js";

/**
 * Where a look picture asked of the queue stands (design turn 193, SPEC-047 R-113, R-118): making
 * while its job is queued or running, failed with the reason in plain words once the job ends
 * without a picture. A failed job never leaves a spinner (2026-10-04: a close view the safety
 * system refused stayed `Making close view…` for good).
 */
export type LookJobState = { state: "making" } | { state: "failed"; reason: string; /** False where the picture was made and paid for and only its filing failed: Activity retries that at no charge, so no second paid request is offered. */ retry: boolean };

const ACTIVE = new Set<Job["status"]>(["queued", "submitting", "running"]);

/** One job's state for a row, or null once it succeeded (its picture is the row's). */
export function lookJobState(job: Job | undefined): LookJobState | null {
  if (job === undefined) return null;
  if (job.status === "succeeded") return job.finalization?.status === "failed" ? { state: "failed", reason: "made, not filed · see Activity", retry: false } : null;
  if (ACTIVE.has(job.status)) return { state: "making" };
  // A cancel after submission may still be completed or charged by the provider: Activity settles it, not a second request.
  if (job.status === "cancelled") return job.cancellationUncertain === true ? { state: "failed", reason: "stopped · see Activity", retry: false } : { state: "failed", reason: "stopped", retry: true };
  // A provider outcome Arke did not see may have been charged: Activity settles it, not a new request.
  if (job.status === "needs-reconciliation") return { state: "failed", reason: "held · see Activity", retry: false };
  return { state: "failed", reason: pictureRefusal(job.error), retry: true };
}

/** The look jobs whose params match, newest first (job ids sort by when they were made). */
export function lookJobs(jobs: readonly Job[], match: (params: Record<string, unknown>) => boolean): Job[] {
  return jobs.filter((job) => job.target.kind === "character-look" && match(job.params)).sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
}

/** Pictures of one request the coordinator would not queue: how many, and why. */
export interface QueueRefusal {
  reason: string;
  /** How many of the request's pictures were not queued; the rest have jobs of their own. */
  count: number;
  /**
   * Nothing of it was queued. A request refused before its pictures were assembled is answered
   * as one failure whatever it asked for, so the asker counts every picture it asked for.
   */
  whole: boolean;
}

/**
 * Requests the coordinator would not queue in whole or in part, by request id, with the reason
 * (`The look to make a close view of is gone`): answered once, as `queue.enqueue-result`, and held
 * here so the row or slot that asked can say it. A partial answer counts the pictures that have no
 * job, which would otherwise wait as `making` for good (codex on PR 1559).
 */
export function useQueueRefusals(): Record<string, QueueRefusal> {
  const [refused, setRefused] = useState<Record<string, QueueRefusal>>({});
  useEffect(
    () =>
      subscribeQueueResults((result) => {
        if (result.command !== "generate-character-looks") return;
        const count = Math.max(result.failures.length, result.requestedCount - result.acceptedJobIds.length);
        if (count <= 0) return;
        const reason = (result.failures[0]?.reason ?? "").replace(/\s*Nothing was queued\.?\s*$/, "").replace(/\.$/, "").trim();
        setRefused((held) => ({ ...held, [result.requestId]: { reason: reason === "" ? "not queued" : reason, count, whole: result.acceptedJobIds.length === 0 } }));
      }),
    [],
  );
  return refused;
}
