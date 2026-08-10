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
  outcome: "completed" | "failed" | "left-for-review" | "cleaned";
  detail: string;
}

export interface RecoveryOutcome {
  repaired: WrapUpRepair[];
}

export interface OpenIntent {
  requestId: string;
  expectedConversationSeq: number;
}

/**
 * The intent that has no matching completion or failure, if there is one.
 *
 * Exported because wrap-up itself has to ask the same question before starting another: at
 * startup an open intent belongs to a process that is gone, but during a session it belongs to a
 * wrap-up still running, or to one that died part-way and left proposals nothing has accounted
 * for. Two readings of "unfinished" would eventually disagree, and the one that matters here is
 * whether a second set of proposals is about to be staged for the same propositions.
 */
export function openIntentOf(events: ReadonlyArray<{ event: { type: string } }>): OpenIntent | null {
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
 * Proposals a failed wrap-up staged and could not take back, in the order they were recorded.
 *
 * Exported for the same reason as `openIntentOf`: wrap-up has to ask this before starting another
 * one. A failed attempt closes its own intent — deliberately, or the in-flight guard would refuse
 * every later wrap-up on the conversation until the studio restarted — so this is the only thing
 * that remembers a proposal was left standing, and both the retry and the startup sweep read it.
 *
 * Every failure in the log, not only the last: two attempts can each leave something, and the
 * second one's event says nothing about the first one's.
 */
export function leftoverProposalIdsOf(events: ReadonlyArray<{ event: { type: string } }>): string[] {
  const ids = new Set<string>();
  for (const { event } of events) {
    if (event.type !== "wrapup.failed") continue;
    for (const id of (event as { leftoverProposalIds?: readonly string[] }).leftoverProposalIds ?? []) {
      ids.add(id);
    }
  }
  return [...ids];
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
  // Re-read whenever the sweep below removes something, so the intent reconciliation that follows
  // is never deciding against proposals this pass has already taken away.
  let staged = await gate.listOpen();

  for (const summary of summaries) {
    const log = new WorldChatStore(conversationDir(store.dir, summary.id));
    const { events } = await log.read();

    /*
     * Proposals a failed wrap-up could not take back, taken back now.
     *
     * The attempt they belong to is over — it recorded that it failed, and said nothing was
     * created — so they are not proposals anybody chose to make: they are the remains of one that
     * refused itself. Left alone they sit on the approvals screen with a summary from a
     * conversation whose propositions are all still live, and accepting one writes half of
     * something nobody ever agreed to as a whole.
     *
     * Nothing is appended when this succeeds. The `wrapup.failed` event stays exactly as written,
     * which is what makes the sweep idempotent: it runs again next start, finds them gone, and
     * does nothing. One that still will not go is reported and tried again next time.
     */
    const recorded = leftoverProposalIdsOf(events);
    const stillStaged = recorded.filter((id) => staged.some((p) => p.id === id));
    if (stillStaged.length > 0) {
      const stuck: string[] = [];
      for (const id of stillStaged) {
        await gate.discard(id).catch(() => stuck.push(id));
      }
      staged = await gate.listOpen();
      repaired.push(
        stuck.length > 0
          ? {
              conversationId: summary.id,
              outcome: "left-for-review",
              detail: `${stuck.length} proposals from a failed wrap-up could not be removed and need a look`,
            }
          : {
              conversationId: summary.id,
              outcome: "cleaned",
              detail: `${stillStaged.length} proposals a failed wrap-up left behind were removed`,
            },
      );
    }

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
