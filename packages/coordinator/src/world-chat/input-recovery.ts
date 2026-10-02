import { unresolvedWorldChatInputs, type WorldChatStoredEvent } from "@arke-studio/contracts";
import { foldWorldChatInputs } from "./input-fold.js";
import { inputCommandDigest } from "./input-journal.js";
import { ConversationSequenceError, type WorldChatStore } from "./store.js";

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
  for (;;) {
    const { events, problems } = await log.read();
    // A repaired torn tail is already flushed. Interior damage needs a person: appending after a
    // line nothing can read could repeat its sequence and obscure what it recorded.
    const folded = foldWorldChatInputs(events);
    if (problems.some(one => one.kind !== "torn-tail") || folded.problems.length) return changed;
    const pending = unresolvedWorldChatInputs(folded.queue);
    const lost = pending.find(row => (row.status === "offering" || row.status === "accepted") && row.attempt);
    let next: { event: WorldChatStoredEvent; requestId?: string } | null = null;
    if (lost?.attempt) {
      next = {
        event: { type: "input.delivery-unknown", messageId: lost.input.messageId, attempt: lost.attempt,
          commandDigest: inputCommandDigest({ kind: "restart", messageId: lost.input.messageId, attempt: lost.attempt }),
          queueRevision: folded.queue.revision + 1 },
        requestId: `world-chat-input:recovery:${lost.input.messageId}:${lost.attempt.inputId}`,
      };
    } else if (pending.length > 0 && folded.queue.pauseReason === null) {
      next = { event: { type: "input-queue.paused", reason: "restart", queueRevision: folded.queue.revision + 1,
        commandDigest: inputCommandDigest({ kind: "pause", reason: "restart" }) } };
    }
    if (!next) return changed;
    try {
      // Against the sequence just read: the revision above was computed from it, and a terminal
      // event landing in between would otherwise leave this one non-consecutive.
      const appended = await log.append(next.event, { at: now(), ...(next.requestId ? { requestId: next.requestId } : {}),
        expectedSeq: events.reduce((max, envelope) => Math.max(max, envelope.seq), 0) });
      // An earlier pass's record under the same id changes nothing the fold has not seen.
      if (appended.deduplicated) return changed;
      changed = true;
    } catch (error) {
      if (!(error instanceof ConversationSequenceError)) throw error;
    }
  }
}
