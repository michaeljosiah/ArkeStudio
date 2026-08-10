import type { ConversationId, Proposal } from "@arke-studio/contracts";
import type { ProposalManager } from "../gate/proposals.js";
import type { WorldStore } from "../world/store.js";
import { discoverConversations } from "./discover.js";
import { sendBack } from "./resolution.js";
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
 * Proposals this conversation's own log says are settled — decided, or returned to it.
 *
 * The durable half of the answer, and the one that lags. Accepting or discarding removes the
 * proposal from the gate first and records it against the conversation after, so for as long as
 * that takes the gate says "gone" and the log has not caught up. Anything reading only the gate
 * in that gap sees a leftover that is neither staged nor accounted for, and reads it as settled.
 */
export function accountedProposalIdsOf(events: ReadonlyArray<{ event: { type: string } }>): Set<string> {
  const ids = new Set<string>();
  for (const { event } of events) {
    if (event.type === "proposal.resolved" || event.type === "conversation.reopened") {
      ids.add((event as unknown as { proposalId: string }).proposalId);
    }
  }
  return ids;
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
    let { events } = await log.read();

    /*
     * Proposals a failed wrap-up could not take back, sent back now.
     *
     * The attempt they belong to is over — it recorded that it failed, and said nothing was
     * created — so they are not proposals anybody chose to make: they are the remains of one that
     * refused itself. Left alone they sit on the approvals screen with a summary from a
     * conversation whose propositions are all still live, and accepting one writes part of
     * something nobody ever agreed to as a whole.
     *
     * Sent back rather than discarded, because discard means the person changed their mind and
     * keeps the proposition out of the conversation for good. Nobody changed their mind here: the
     * wrap-up refused itself, and the propositions have to still be there to be asked for again.
     * `sendBack` is that, and it already writes the log entry before removing the proposal — the
     * order that leaves something visible if the second half fails.
     *
     * What is left unaccounted for is not guessed at. A crash between the gate removing a
     * proposal and the conversation recording what became of it leaves no way to know which it
     * was, and the candidate ids that would say are in the manifest that went with it. Repairing
     * that on a guess writes to somebody's world, so it is named and left.
     */
    const recorded = leftoverProposalIdsOf(events);
    if (recorded.length > 0) {
      const sent: string[] = [];
      const stuck: string[] = [];
      for (const id of recorded) {
        const proposal = staged.find((p) => p.id === id);
        if (!proposal) continue;
        try {
          await sendBack(store, gate, proposal, now);
          sent.push(id);
        } catch {
          stuck.push(id);
        }
      }
      if (sent.length > 0 || stuck.length > 0) {
        staged = await gate.listOpen();
        ({ events } = await log.read());
      }
      const accounted = accountedProposalIdsOf(events);
      const unaccounted = recorded.filter(
        (id) => !accounted.has(id) && !staged.some((p) => p.id === id),
      );

      if (sent.length > 0) {
        repaired.push({
          conversationId: summary.id,
          outcome: "cleaned",
          detail: `${sent.length} proposals a failed wrap-up left behind went back to the conversation`,
        });
      }
      if (stuck.length > 0 || unaccounted.length > 0) {
        repaired.push({
          conversationId: summary.id,
          outcome: "left-for-review",
          detail: `${stuck.length + unaccounted.length} proposals from a failed wrap-up need a look`,
        });
      }
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
