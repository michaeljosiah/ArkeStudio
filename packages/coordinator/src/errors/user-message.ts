import { describeError } from "@arke-studio/contracts";
import { CommitPlanError, CommitStaleError } from "../world/commit.js";

/**
 * What a caught error becomes when it reaches a screen (see `error-copy.ts`'s module doc for the
 * house rule this implements). `CommitStaleError`
 * and `CommitPlanError` carry `.message` strings written for `commit.test.ts`, not for a person —
 * "commit refused: base moved for references/tunde/kit.json — staleness is detected, never
 * merged" told nobody what to do. They are special-cased here, ahead of `describeError`'s generic
 * fallback, because both live in `world/commit.ts` and only the coordinator throws them.
 */
export function describeCoordinatorError(err: unknown): string {
  if (err instanceof CommitStaleError) {
    // One sentence covers every stale path (R-46's shape: a count and one cause) — naming the
    // file would not help the author do anything differently.
    return "Something changed while this was saving — try again.";
  }
  if (err instanceof CommitPlanError) return describeCommitPlanError(err);
  return describeError(err);
}

/**
 * `CommitPlanError` messages are a closed, enumerable set (`commit.ts`, `world/store.ts`) — most
 * are internal invariants that should never reach a real user (a caller writing `world.json`
 * directly, binary content on a versioned track) and fall back to the generic line; the rest name
 * a real condition and get their own sentence. Matched by pattern because every message carries
 * an interpolated path first.
 */
function describeCommitPlanError(err: CommitPlanError): string {
  const message = err.message;
  for (const [pattern, copy] of COMMIT_PLAN_COPY) {
    if (pattern.test(message)) return copy;
  }
  // Unmatched messages in this class are the ones already written plainly at the throw site
  // ("a world needs a name", "the world look is already derived") — trusted as-is.
  return message;
}

const COMMIT_PLAN_COPY: ReadonlyArray<readonly [RegExp, string]> = [
  // A conflict names a history file that already holds bytes outside this commit's allowed set —
  // rollback leaves it exactly as it was, so retrying deterministically fails the same way. A
  // move, in contrast, is the staging-window race closing on someone else's write and clears on
  // its own the moment that write is done — retrying is the actual remedy there.
  [/history snapshot conflicts with/, "A saved version of this file doesn't match what Arke Studio expected — trying again won't fix it."],
  [/history snapshot moved while .* was staged/, "Something changed while this was saving — try again."],
  [/cannot be restored/, "That earlier version can't be restored."],
  [/^world\.json missing/, "This folder isn't a world Arke Studio recognizes."],
  [
    /^world has external edits awaiting reconciliation$/,
    "This world has changes made outside Arke Studio waiting to be reviewed — resolve them before saving again.",
  ],
  [/^no history snapshot at /, "That earlier version can't be found."],
  [/last committed version is unavailable$/, "An earlier version of this file can't be found."],
  [/^restore is not defined for/, "That can't be restored to an earlier version."],
  [/ does not exist$/, "That file can't be found anymore."],
  // Internal invariants: a caller bypassing the committer's own rules. Should never reach a
  // real user, so no sentence names the rule — the generic line covers it.
  [/; the committer owns it$/, "Something went wrong while saving. Try again."],
  [/ requires content$/, "Something went wrong while saving. Try again."],
  [/binary content cannot bypass versioned records$/, "Something went wrong while saving. Try again."],
  [/a committed base is only valid for an outside edit$/, "Something went wrong while saving. Try again."],
];
