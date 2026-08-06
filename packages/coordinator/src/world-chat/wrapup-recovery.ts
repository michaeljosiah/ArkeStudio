import type { ConversationId, Proposal } from "@arke-studio/contracts";
import type { ProposalManager } from "../gate/proposals.js";
import type { WorldStore } from "../world/store.js";
import { discoverConversations } from "./discover.js";
import { conversationDir, WorldChatStore } from "./store.js";

/**
 * Finishing a wrap-up the last process died in the middle of (#70 §11.3).
 *
 * Wrap-up spans several files: the conversation log, a Canon allocation, and one proposal
 * directory per change. There is no way to make that one atomic write, and pretending otherwise
 * would be the more dangerous design — so it is a saga, and this is the part that resolves it.
 *
 * The rule that keeps it honest is that one requestId resolves to at most one set of proposals
 * and one terminal outcome. A crash may burn Canon ids; it may never produce two sets of
 * proposals for one intent, and it may never leave a conversation that is neither open nor
 * closed.
 *
 * What it does not do is guess. Where the evidence is ambiguous — proposals exist but do not
 * match the intent — it records a problem and leaves the conversation open, because a wrong
 * automatic repair here writes to somebody's world.
 */

export interface WrapUpRepair {
  conversationId: ConversationId;
  outcome: "completed" | "failed" | "left-for-review";
  detail: string;
}

export interface RecoveryOutcome {
  repaired: WrapUpRepair[];
}

interface OpenIntent {
  requestId: string;
  expectedConversationSeq: number;
}

/** The intent that has no matching completion or failure, if there is one. */
function openIntentOf(events: ReadonlyArray<{ event: { type: string } }>): OpenIntent | null {
  let open: OpenIntent | null = null;
  for (const { event } of events) {
    if (event.type === "wrapup.intent-recorded") {
      const e = event as unknown as OpenIntent;
      open = { requestId: e.requestId, expectedConversationSeq: e.expectedConversationSeq };
    } else if (event.type === "wrapup.completed" || event.type === "wrapup.failed") {
      open = null;
    }
  }
  return open;
}

/**
 * Reconcile every conversation whose wrap-up did not finish.
 *
 * Runs at startup, when no wrap-up can be in flight, so an unresolved intent belongs to a process
 * that is gone.
 */
export async function recoverWrapUps(
  store: WorldStore,
  gate: ProposalManager,
  now: () => string,
): Promise<RecoveryOutcome> {
  const { summaries } = await discoverConversations(store.dir);
  const repaired: WrapUpRepair[] = [];
  const staged = await gate.listOpen();

  for (const summary of summaries) {
    const log = new WorldChatStore(conversationDir(store.dir, summary.id));
    const { events } = await log.read();
    const intent = openIntentOf(events);
    if (!intent) continue;

    const mine = staged.filter((p) =>
      (p.worldChatOrigins ?? []).some((o) => o.requestId === intent.requestId),
    );

    if (mine.length === 0) {
      // Nothing was created under this intent. The ids reserved for it are burned — Canon ids
      // are never reused — but nothing is inconsistent, and the conversation can be wrapped up
      // again whenever the user chooses.
      await log.append(
        {
          type: "wrapup.failed",
          requestId: intent.requestId,
          safeDetail: "the app closed before any proposal was created",
        },
        { at: now() },
      );
      repaired.push({
        conversationId: summary.id,
        outcome: "failed",
        detail: "nothing had been created, so the conversation stays open",
      });
      continue;
    }

    if (!everyProposalIsWhole(mine)) {
      // Ambiguous: proposals exist under this request but do not look complete. Repairing this
      // automatically means writing to the world on a guess, so it is left for a person.
      repaired.push({
        conversationId: summary.id,
        outcome: "left-for-review",
        detail: `${mine.length} proposals from an unfinished wrap-up need a look`,
      });
      continue;
    }

    // Every planned proposal is there and whole: finish the wrap-up rather than make the user
    // do it again over work that already exists.
    await log.append(
      {
        type: "wrapup.completed",
        requestId: intent.requestId,
        proposalIds: mine.map((p) => p.id),
        notCarried: [],
        mediaIdeaIds: [],
      },
      { at: now() },
    );
    repaired.push({
      conversationId: summary.id,
      outcome: "completed",
      detail: `${mine.length} proposals were already durable, so the conversation is closed`,
    });
  }

  return { repaired };
}

/** A proposal is whole when it has at least one target and an origin naming what it came from. */
function everyProposalIsWhole(proposals: readonly Proposal[]): boolean {
  return proposals.every((p) => p.targets.length > 0 && (p.worldChatOrigins ?? []).length > 0);
}
