import { join } from "node:path";
import type { CandidateId, ConversationId, Proposal, ProposalId } from "@arke-studio/contracts";
import type { ProposalManager } from "../gate/proposals.js";
import { readChanges, type ChangeLine } from "../world/change-writer.js";
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
export interface Leftover {
  proposalId: string;
  /** The propositions it was made from, so recovery can settle them without its manifest. */
  candidateIds: readonly string[];
}

export function leftoversOf(events: ReadonlyArray<{ event: { type: string } }>): Leftover[] {
  const byId = new Map<string, Leftover>();
  for (const { event } of events) {
    if (event.type !== "wrapup.failed") continue;
    for (const one of (event as { leftovers?: readonly Leftover[] }).leftovers ?? []) {
      byId.set(one.proposalId, one);
    }
  }
  return [...byId.values()];
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
  // Read once for the whole pass: the world's account of what happened to a proposal, for the
  // leftovers whose own conversation never learned. See the sweep below.
  const journal = await readChanges(join(store.dir, "changes.jsonl"));

  for (const summary of summaries) {
    const log = new WorldChatStore(conversationDir(store.dir, summary.id));
    let { events } = await log.read();

    /*
     * Proposals a failed wrap-up could not take back, settled now.
     *
     * The attempt they belong to is over — it recorded that it failed, and said nothing was
     * created — so they are not proposals anybody chose to make: they are the remains of one that
     * refused itself. Left alone they sit on the approvals screen with a summary from a
     * conversation whose propositions are all still live, and accepting one writes part of
     * something nobody ever agreed to as a whole.
     *
     * Every one of them leaves here with something durable said about it, because the guard that
     * refuses the next wrap-up clears on exactly that. A leftover with no terminal state is a
     * conversation that can never be wrapped up again.
     */
    const leftovers = leftoversOf(events);
    if (leftovers.length > 0) {
      const settled = accountedProposalIdsOf(events);
      const returned: string[] = [];
      const reconciled: string[] = [];
      const stuck: string[] = [];

      for (const leftover of leftovers) {
        if (settled.has(leftover.proposalId)) continue;
        const reopen = {
          type: "conversation.reopened" as const,
          proposalId: leftover.proposalId as ProposalId,
          restoredCandidateIds: leftover.candidateIds as CandidateId[],
        };

        if (staged.some((p) => p.id === leftover.proposalId)) {
          /*
           * Removed first and recorded second — the opposite of what `sendBack` does, and on
           * purpose.
           *
           * Send-back's order is right for a person pressing the button: the propositions come
           * back to an open conversation, and a proposal still standing behind them is visible
           * and fixable. Here the log entry is also what stops the next wrap-up being refused, so
           * writing it first would clear the guard over a proposal still on the approvals screen.
           * Worse, the fold takes a reopen as that proposal's resolution and ignores a real
           * accept arriving after it — leaving the accepted change's propositions live, and
           * proposable a second time.
           */
          try {
            await gate.discard(leftover.proposalId);
          } catch {
            stuck.push(leftover.proposalId);
            continue;
          }
          await log.append(reopen, { at: now() });
          returned.push(leftover.proposalId);
          continue;
        }

        /*
         * Gone from the gate with nothing in the conversation to say why.
         *
         * Recording a resolution is best-effort by design — a proposal that has been accepted is
         * accepted, and failing that over bookkeeping would undo real work — so this is reachable
         * without any crash at all. The world's own change journal is the record that did not
         * depend on the conversation: a commit names the proposal it came from, and a discard
         * names the directory it removed.
         *
         * No line at all means it never landed. A commit writes its journal as part of itself, so
         * an accept that left no trace did not happen; what is left is a discard whose second
         * half failed, and the propositions are still the conversation's.
         */
        const outcome = outcomeInJournal(journal, leftover.proposalId);
        await log.append(
          outcome === null
            ? reopen
            : {
                type: "proposal.resolved",
                proposalId: leftover.proposalId as ProposalId,
                outcome,
                candidateIds: leftover.candidateIds as CandidateId[],
              },
          { at: now() },
        );
        reconciled.push(leftover.proposalId);
      }

      if (returned.length > 0 || reconciled.length > 0 || stuck.length > 0) {
        staged = await gate.listOpen();
        ({ events } = await log.read());
      }
      if (returned.length + reconciled.length > 0) {
        repaired.push({
          conversationId: summary.id,
          outcome: "cleaned",
          detail: `${returned.length + reconciled.length} proposals a failed wrap-up left behind were settled`,
        });
      }
      if (stuck.length > 0) {
        repaired.push({
          conversationId: summary.id,
          outcome: "left-for-review",
          detail: `${stuck.length} proposals from a failed wrap-up would not be removed and need a look`,
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

/**
 * What the world's change journal says became of one proposal, if it says anything.
 *
 * The journal is the record that does not depend on the conversation: accepting writes a commit
 * naming the proposal it came from, and discarding writes a line naming the directory it removed.
 * Read last-line-wins, which is only a tiebreak — a proposal is accepted or discarded once.
 */
function outcomeInJournal(
  journal: readonly ChangeLine[],
  proposalId: string,
): "accepted" | "discarded" | null {
  let outcome: "accepted" | "discarded" | null = null;
  for (const line of journal) {
    if (line["proposalId"] === proposalId) outcome = "accepted";
    else if (line.entity === `.proposals/${proposalId}` && line["discarded"] === true) {
      outcome = "discarded";
    }
  }
  return outcome;
}

/** A proposal is whole when it has at least one target and an origin naming what it came from. */
function everyProposalIsWhole(proposals: readonly Proposal[]): boolean {
  return proposals.every((p) => p.targets.length > 0 && (p.worldChatOrigins ?? []).length > 0);
}
