import type { BenchReferenceToken } from "@arke-studio/contracts";

/**
 * Bringing a take's pictures back into a lane (⟲ restore).
 *
 * Restoring the words and the settings but not the images gave back a request that could not be
 * re-made: press ⟲ on a take built from a start frame and you got its prompt over whatever
 * happened to be in the lanes. The snapshot has carried the images all along; only the restore
 * had never read them.
 *
 * A plan rather than a loop of sends, so the decision — what to drop, what to bring back — can
 * be read and tested without a socket.
 */
export interface LaneRestorePlan {
  /** Tokens active now that the snapshot does not name. */
  remove: string[];
  /** Snapshot entries that are not active now. Re-adding a known source restores its old token. */
  add: BenchReferenceToken[];
}

/**
 * Set a lane to exactly what the snapshot names.
 *
 * Deliberately a difference and not a clear-then-add: a picture the take already had stays put
 * rather than being removed and re-added, which would churn the session log and make the lane
 * flicker for something that never changed.
 */
export function laneRestorePlan(
  wanted: readonly BenchReferenceToken[],
  current: readonly string[],
): LaneRestorePlan {
  const wantedTokens = new Set(wanted.map((entry) => entry.token));
  return {
    remove: current.filter((token) => !wantedTokens.has(token)),
    add: wanted.filter((entry) => !current.includes(entry.token)),
  };
}
