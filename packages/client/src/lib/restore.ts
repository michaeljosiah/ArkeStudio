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
/**
 * A source as the wire accepts it — the discriminant and its id, and nothing else.
 *
 * The stored token's source carries a content `hash` besides, and the frame's pick schema is
 * `.strict()`: handing it the stored shape unchanged fails validation, and a rejected frame is
 * dropped in silence — no event, no error, the lane simply never fills. TypeScript does not
 * catch it either, because excess-property checks apply to object literals and not to a value
 * passed through a variable. Narrowing here, inside the tested unit, is what stops the call
 * site from having to remember.
 */
export type WirePick =
  | { source: "artifact"; artifactId: string }
  | { source: "take"; takeId: string }
  | { source: "world-file"; path: string };

export interface LaneRestorePlan {
  /** Tokens active now that the snapshot does not name. */
  remove: string[];
  /** Sources to re-add. Re-adding a source the registry knows restores its old token. */
  add: Array<{ token: string; pick: WirePick }>;
}

function toPick(source: BenchReferenceToken["source"]): WirePick {
  switch (source.source) {
    case "artifact":
      return { source: "artifact", artifactId: source.artifactId };
    case "take":
      return { source: "take", takeId: source.takeId };
    case "world-file":
      return { source: "world-file", path: source.path };
  }
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
    add: wanted
      .filter((entry) => !current.includes(entry.token))
      .map((entry) => ({ token: entry.token, pick: toPick(entry.source) })),
  };
}
