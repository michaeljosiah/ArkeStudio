import type { Job } from "@arke-studio/contracts";
import type { EnqueueInput } from "./dispatcher.js";

export interface EnqueueBatchOutcome {
  requestedCount: number;
  acceptedJobIds: Job["id"][];
  failures: Array<{ index: number; reason: string }>;
}

/**
 * Attempt the whole user-requested batch; one failure never hides the jobs already journalled.
 *
 * `halted` is asked before each input: a request that ended while its batch was still being
 * journalled — a read whose first piece was refused, or one the person stopped — journals
 * nothing more, because every job journalled after that is pumped at once and can reach a
 * provider before the caller gets the ids to cancel it. The count is then of what was put to
 * the queue, which is all the request will ever hold.
 */
export async function enqueueInputs(
  inputs: readonly EnqueueInput[],
  enqueue: (input: EnqueueInput) => Promise<Job>,
  halted?: () => boolean,
): Promise<EnqueueBatchOutcome> {
  const acceptedJobIds: Job["id"][] = [];
  const failures: Array<{ index: number; reason: string }> = [];
  for (const [index, input] of inputs.entries()) {
    if (halted?.()) return { requestedCount: index, acceptedJobIds, failures };
    try {
      acceptedJobIds.push((await enqueue(input)).id);
    } catch (error) {
      failures.push({
        index,
        reason:
          error instanceof Error && error.message.trim().length > 0
            ? error.message
            : "This item could not be added to Activity. Check provider settings and try again.",
      });
    }
  }
  return { requestedCount: inputs.length, acceptedJobIds, failures };
}
