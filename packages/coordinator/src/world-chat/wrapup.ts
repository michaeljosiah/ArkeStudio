import {
  type CandidateId,
  type ConversationId,
  type Proposal,
  type ProposalOpenChoice,
  type WorldChangeCandidate,
} from "@arke-studio/contracts";
import type { ProposalManager } from "../gate/proposals.js";
import type { WorldStore } from "../world/store.js";
import { foldConversation } from "./fold.js";
import { canonIdsNeeded, materialiseCandidate, MaterialiseError, planIdentities } from "./materialise.js";
import { evaluateReadiness, type NotCarried } from "./readiness.js";
import { conversationDir, WorldChatStore } from "./store.js";
import { openIntentOf } from "./wrapup-recovery.js";

/**
 * Turning a conversation into proposals, once (#70 §11.3).
 *
 * One action does the whole thing: decide what carries, reserve the identities, write the files,
 * stage every proposal, and close the conversation. There is deliberately no preview — an earlier
 * draft had one, and it computed exactly this result without writing, showed it in a sheet, and
 * then a second command replayed it. That sheet stood in front of the approvals screen and said
 * less than it did.
 *
 * The conversation closes at the end and not before. Either every planned proposal is durable and
 * it is closed, or nothing was created and it stays open (R-42a). There is no half-closed state
 * to explain to somebody, and no wrap-up that half-happened.
 *
 * This is a recoverable saga rather than a claim of cross-file atomicity. A crash may burn Canon
 * ids — they are reserved before the files exist — but one requestId resolves to at most one set
 * of proposals and one terminal outcome, so a retry never quietly allocates a second set.
 */

export interface WrapUpResult {
  proposalIds: string[];
  /** Unresolved propositions that became open Canon threads. */
  threadProposalIds: string[];
  /** Named, never merely counted (R-13, R-27d). */
  notCarried: NotCarried[];
  /** Retained against their target; never proposals (R-37a). */
  mediaIdeaIds: CandidateId[];
  /** Choices the coordinator could not make; each names the proposal carrying it (R-34c). */
  openChoices: Array<ProposalOpenChoice & { proposalId: string }>;
}

export class WrapUpError extends Error {
  constructor(
    readonly reason: "stale" | "nothing-to-carry" | "materialise" | "too-many" | "in-flight",
    message: string,
  ) {
    super(message);
    this.name = "WrapUpError";
  }
}

/** One wrap-up may not produce more proposals than a person can reasonably review (§19). */
const MAX_PROPOSALS = 40;

/**
 * The question a Canon create carries when the coordinator genuinely cannot decide (§6.2).
 *
 * In practice this is the only such question: a create that looks like an existing entry may be a
 * duplicate, an amendment, or a real second thing, and only the person who said it knows which.
 * It travels with its own proposal so every other proposal stays acceptable.
 */
function openChoiceFor(candidate: WorldChangeCandidate): ProposalOpenChoice | null {
  if (candidate.classification !== "canon.create") return null;
  const duplicates = candidate.checks.likelyDuplicates;
  if (duplicates.length === 0) return null;
  const named = duplicates
    .map((ref) => (ref.kind === "canon" ? ref.entryId : ref.kind === "sheet" ? ref.sheetId : "the world"))
    .slice(0, 3);
  return {
    choiceId: `duplicate-or-amend:${candidate.id}`,
    kind: "duplicate-or-amend",
    question: `This looks close to ${named.join(", ")}. Is it a new rule, or a change to one of those?`,
    options: [
      { optionId: "create", label: "It is new — keep it separate" },
      ...named.map((id) => ({ optionId: `amend:${id}`, label: `It changes ${id}` })),
    ],
  };
}

export interface WrapUpInput {
  store: WorldStore;
  gate: ProposalManager;
  conversationId: ConversationId;
  requestId: string;
  expectedConversationSeq: number;
  now: () => string;
}

export async function wrapUp(input: WrapUpInput): Promise<WrapUpResult> {
  // Built through the shared helper rather than spelled out here, so this store reaches the same
  // per-directory writer as every other one on this conversation (see `writerFor`).
  const log = new WorldChatStore(conversationDir(input.store.dir, input.conversationId));
  const meta = await log.readMeta();
  if (!meta) throw new WrapUpError("stale", "That conversation is no longer here.");

  const { events } = await log.read();
  // Refused outright rather than silently re-planned: what is written must be what the person
  // was last shown in the panel, not whatever arrived while they were deciding.
  //
  // Against the last sequence number, because that is the number the panel was given: the fold
  // reports the seq it last read, not how many lines it read to get there. Comparing the count
  // instead held only while the numbers ran 1..N unbroken, so a log that had ever been written
  // by two writers at once could never be wrapped up again — the count stayed permanently ahead
  // of the sequence, and every attempt came back stale with nothing to act on.
  //
  // The number is a sound revision token because an append takes the highest sequence in the file
  // and adds one, so the last one always moves when anything is written — including on a log an
  // older race left with a repeat in the middle, which is the case this has to keep working.
  const lastSeq = events.length > 0 ? events[events.length - 1]!.seq : 0;
  if (lastSeq !== input.expectedConversationSeq) {
    throw new WrapUpError(
      "stale",
      "This conversation moved on while you were looking at it. Open it again and wrap up from there.",
    );
  }

  /**
   * One intent at a time (R-42a).
   *
   * An intent with no outcome after it means a wrap-up is still running, or one died after
   * staging some of its proposals and never recorded how it ended. Starting a second would stage
   * a second set for the same propositions, because their `candidate.status-changed` events are
   * only appended once every proposal is durable — until then they still read as live and would
   * be carried again.
   *
   * The refusal, rather than resuming here: recovery reconciles an open intent against the
   * proposals actually on disk, and it will not guess when they do not match. Doing that inside a
   * button press would be repair by accident.
   */
  if (openIntentOf(events)) {
    throw new WrapUpError(
      "in-flight",
      "This conversation is already being turned into proposals. If that did not finish, restart the studio and it will be resolved before anything else is written.",
    );
  }

  const view = foldConversation(meta.id, meta.createdAt, events).view;
  const bundle = input.store.getBundle();
  const { carried, mediaIdeas, notCarried } = evaluateReadiness(view.candidates, bundle);

  if (carried.length === 0) {
    throw new WrapUpError(
      "nothing-to-carry",
      "Nothing in this conversation is settled enough to propose yet.",
    );
  }
  if (carried.length > MAX_PROPOSALS) {
    throw new WrapUpError(
      "too-many",
      `${carried.length} changes is more than one review can hold. Wrap up a narrower conversation.`,
    );
  }

  const at = input.now();

  // Step 1: the intent is durable before anything is reserved or written, so a crash leaves a
  // record of what was being attempted rather than an unexplained set of burned ids.
  await log.append(
    {
      type: "wrapup.intent-recorded",
      requestId: input.requestId,
      expectedConversationSeq: input.expectedConversationSeq,
      plannedProposalIds: [],
    },
    { at },
  );

  const needed = canonIdsNeeded(carried);
  const reserved = needed > 0 ? await input.store.allocateCanonIds(needed, `world-chat:${input.conversationId}`) : [];
  const identities = planIdentities(carried, reserved, bundle);

  // Step 4: everything is built and validated before a single proposal directory exists, so a
  // malformed candidate fails wrap-up without leaving one behind (§11.2).
  const built = [];
  let nextCanon = 0;
  try {
    for (const candidate of carried) {
      built.push(
        materialiseCandidate(candidate, identities, bundle, at.slice(0, 10), () => identities.canonIds[nextCanon++]!),
      );
    }
  } catch (err) {
    await log.append(
      {
        type: "wrapup.failed",
        requestId: input.requestId,
        safeDetail: err instanceof MaterialiseError ? err.detail.slice(0, 300) : "a change could not be written",
      },
      { at: input.now() },
    );
    throw new WrapUpError("materialise", "One of these changes could not be written, so nothing was.");
  }

  const proposals: Proposal[] = [];
  const openChoices: WrapUpResult["openChoices"] = [];
  const threadProposalIds: string[] = [];

  for (const item of built) {
    const choice = openChoiceFor(item.candidate);
    const proposal = await input.gate.stage({
      kind: "worldbuilding",
      summary: item.candidate.title,
      source: `world-chat:${input.conversationId}`,
      targets: item.targets,
      preReservedCanonIds: item.reservedCanonIds,
      worldChatOrigins: [
        {
          requestId: input.requestId,
          conversationId: input.conversationId,
          candidateId: item.candidate.id,
          candidateRevision: item.candidate.revision,
          ...(item.candidate.groupId ? { groupId: item.candidate.groupId } : {}),
          targetPaths: item.targets.map((t) => t.path),
          fields: item.fields,
        },
      ],
      ...(choice ? { openChoices: [choice] } : {}),
    });
    proposals.push(proposal);
    if (choice) openChoices.push({ ...choice, proposalId: proposal.id });
    if (item.candidate.classification === "canon.thread") threadProposalIds.push(proposal.id);
  }

  /**
   * Each proposition that carried is now proposed, and says which proposal it became (§6.5).
   *
   * Without this a closed conversation would still show its propositions as live, because the
   * panel renders live ones and nothing else had moved them. It also gives send-back the link it
   * needs to put them back.
   */
  for (const [index, item] of built.entries()) {
    await log.append(
      {
        type: "candidate.status-changed",
        candidateId: item.candidate.id,
        revision: item.candidate.revision,
        status: "proposed",
        proposalId: proposals[index]!.id,
      },
      { at: input.now() },
    );
  }

  // Step 6: the conversation closes here, once every proposal is durable — and not one step
  // earlier.
  await log.append(
    {
      type: "wrapup.completed",
      requestId: input.requestId,
      proposalIds: proposals.map((p) => p.id),
      // The summary travels with the reason: the approvals screen names what did not carry, and
      // a bare id would make that impossible after the conversation is closed.
      notCarried: notCarried.map((n) => ({
        candidateId: n.candidateId as CandidateId,
        summary: n.summary,
        reason: n.reason,
      })),
      mediaIdeaIds: mediaIdeas.map((c) => c.id),
    },
    { at: input.now() },
  );

  return {
    proposalIds: proposals.map((p) => p.id),
    threadProposalIds,
    notCarried,
    mediaIdeaIds: mediaIdeas.map((c) => c.id),
    openChoices,
  };
}
