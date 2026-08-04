import type { Job } from "@arke-studio/contracts";
import type { EnqueueInput } from "./dispatcher.js";

export interface EnqueueBatchOutcome {
  requestedCount: number;
  acceptedJobIds: Job["id"][];
  failures: Array<{ index: number; reason: string }>;
}

/** Attempt the whole user-requested batch; one failure never hides the jobs already journalled. */
export async function enqueueInputs(
  inputs: readonly EnqueueInput[],
  enqueue: (input: EnqueueInput) => Promise<Job>,
): Promise<EnqueueBatchOutcome> {
  const acceptedJobIds: Job["id"][] = [];
  const failures: Array<{ index: number; reason: string }> = [];
  for (const [index, input] of inputs.entries()) {
    try {
      acceptedJobIds.push((await enqueue(input)).id);
    } catch {
      failures.push({
        index,
        reason: "This item could not be added to Activity. Check provider settings and try again.",
      });
    }
  }
  return { requestedCount: inputs.length, acceptedJobIds, failures };
}
