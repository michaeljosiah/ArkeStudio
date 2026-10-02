import { unresolvedWorldChatInputs } from "@arke-studio/contracts";
import { foldWorldChatInputs } from "./input-fold.js";
import { inputCommandDigest } from "./input-journal.js";
import type { WorldChatStore } from "./store.js";

/**
 * Startup's half of SPEC-045 R-13 and R-19. Called only during owned-world recovery, before any
 * new work is admitted, and never calls an engine.
 *
 * An offer recorded with no outcome may or may not have reached the model, so it becomes
 * uncertain rather than being sent again. Anything still waiting is paused: the author submitted
 * it while working, not so that opening the world tomorrow would quietly start model calls.
 * Returns true when this pass wrote anything.
 */
export async function recoverWorldChatInputs(log: WorldChatStore, now: () => string): Promise<boolean> {
  let changed = false;
  const read = async () => {
    const { events, problems } = await log.read();
    const folded = foldWorldChatInputs(events);
    // A repaired torn tail is already flushed. Interior damage needs a person: appending after a
    // line nothing can read could repeat its sequence and obscure what it recorded.
    return problems.some(one => one.kind !== "torn-tail") || folded.problems.length ? null : folded;
  };
  let folded = await read();
  if (!folded) return false;
  for (const row of unresolvedWorldChatInputs(folded.queue)) {
    if ((row.status !== "offering" && row.status !== "accepted") || !row.attempt) continue;
    const command = { kind: "restart", messageId: row.input.messageId, attempt: row.attempt };
    await log.append({ type: "input.delivery-unknown", messageId: row.input.messageId, attempt: row.attempt,
      commandDigest: inputCommandDigest(command), queueRevision: folded.queue.revision + 1 },
    { at: now(), requestId: `world-chat-input:recovery:${row.input.messageId}:${row.attempt.inputId}` });
    changed = true;
    folded = await read();
    if (!folded) return changed;
  }
  if (unresolvedWorldChatInputs(folded.queue).length > 0 && folded.queue.pauseReason === null) {
    await log.append({ type: "input-queue.paused", reason: "restart", queueRevision: folded.queue.revision + 1,
      commandDigest: inputCommandDigest({ kind: "pause", reason: "restart" }) }, { at: now() });
    changed = true;
  }
  return changed;
}
