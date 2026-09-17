import { unresolvedWorldChatInputs } from "@arke-studio/contracts";
import { foldWorldChatInputs } from "./input-fold.js";
import { inputCommandDigest } from "./input-journal.js";
import type { WorldChatStore } from "./store.js";

/** Called only during owned-world startup, before admitting any new work. Never calls an engine. */
export async function recoverWorldChatInputs(log: WorldChatStore, now: () => string): Promise<boolean> {
  let changed = false;
  const read = async () => {
    const { events, problems } = await log.read();
    const folded = foldWorldChatInputs(events);
    // A repaired torn tail is already flushed. Interior damage still needs human repair;
    // appending after an unreadable sequence can duplicate its identity and obscure evidence.
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
