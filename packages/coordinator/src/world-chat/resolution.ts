import { join } from "node:path";
import type { CandidateId, ConversationId, Proposal, ProposalId } from "@arke-studio/contracts";
import type { ProposalManager } from "../gate/proposals.js";
import type { WorldStore } from "../world/store.js";
import { conversationDir, WorldChatStore } from "./store.js";

/**
 * What happens to a conversation when its proposals are decided (#70 §6.5, R-34a).
 *
 * Three outcomes, and the difference between two of them is the whole reason both are offered.
 *
 * **Accepted** is history. The proposition became world state and is immutable; a later change to
 * the same fact is a new proposition in a new conversation.
 *
 * **Discarded** is the user saying they have changed their mind. It stays discarded. It does not
 * come back to the conversation, because coming back is what would make discard feel unsafe —
 * somebody who discards wants it gone, not returned to the panel to be discarded again.
 *
 * **Sent back** is the user saying the conversation was not finished. The propositions return to
 * live, the conversation reopens, and the discussion carries on from where it was. This is what
 * makes discard safe to offer beside it: there is a way to say "not like this" that is not "no".
 */

export class ResolutionError extends Error {
  constructor(
    readonly reason: "not-world-chat" | "conversation-gone",
    message: string,
  ) {
    super(message);
    this.name = "ResolutionError";
  }
}

/** The conversation a proposal came from, or null if it did not come from one. */
export function originOf(proposal: Proposal): {
  conversationId: ConversationId;
  candidateIds: CandidateId[];
} | null {
  const origins = proposal.worldChatOrigins ?? [];
  if (origins.length === 0) return null;
  return {
    conversationId: origins[0]!.conversationId as ConversationId,
    candidateIds: origins.map((o) => o.candidateId as CandidateId),
  };
}

async function logFor(store: WorldStore, conversationId: ConversationId): Promise<WorldChatStore | null> {
  const log = new WorldChatStore(join(conversationDir(store.dir, conversationId)));
  return (await log.readMeta()) ? log : null;
}

/**
 * Record that a proposal was accepted or discarded, against the conversation it came from.
 *
 * Best-effort by design: a proposal that has been accepted is accepted, and failing the accept
 * because its conversation was deleted would undo real work over bookkeeping. The conversation is
 * the account of what happened, not the authority for what did.
 */
export async function recordResolution(
  store: WorldStore,
  proposal: Proposal,
  outcome: "accepted" | "discarded",
  now: () => string,
): Promise<void> {
  const origin = originOf(proposal);
  if (!origin) return;
  const log = await logFor(store, origin.conversationId);
  if (!log) return;

  await log
    .append(
      {
        type: "proposal.resolved",
        proposalId: proposal.id as ProposalId,
        outcome,
        candidateIds: origin.candidateIds,
      },
      { at: now() },
    )
    .catch(() => {
      /* the world has already changed; the conversation's account of it is not worth failing on */
    });
}

/**
 * Send a proposal back to the conversation it came from (R-34a).
 *
 * The proposal is removed and its propositions return to live. Unlike discard, this is reversible
 * by simply carrying on: nothing has been decided, and the conversation is open again.
 *
 * Refuses when the conversation is gone. Returning propositions to a conversation that no longer
 * exists would silently discard them while appearing to preserve them, which is the worst of both
 * behaviours.
 */
export async function sendBack(
  store: WorldStore,
  gate: ProposalManager,
  proposal: Proposal,
  now: () => string,
): Promise<ConversationId> {
  const origin = originOf(proposal);
  if (!origin) {
    throw new ResolutionError(
      "not-world-chat",
      "This proposal did not come from a conversation, so there is nowhere to send it back to.",
    );
  }
  const log = await logFor(store, origin.conversationId);
  if (!log) {
    throw new ResolutionError(
      "conversation-gone",
      "The conversation this came from has been deleted, so it cannot be sent back. Discard it instead.",
    );
  }

  // The conversation is reopened first. If the discard fails after this, the propositions are
  // live in an open conversation and the proposal is still staged — visible and fixable. The
  // other order would leave propositions that belong to a proposal nobody can find.
  await log.append(
    {
      type: "conversation.reopened",
      proposalId: proposal.id as ProposalId,
      restoredCandidateIds: origin.candidateIds,
    },
    { at: now() },
  );
  await gate.discard(proposal.id);
  return origin.conversationId;
}
