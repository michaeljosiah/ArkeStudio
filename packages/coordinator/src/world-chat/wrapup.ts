import { resolve } from "node:path";
import {
  type CandidateId,
  type ConversationId,
  type Proposal,
  type ProposalOpenChoice,
  type WorldChangeCandidate,
} from "@arke-studio/contracts";
import { LookAlreadyProposedError, type ProposalManager } from "../gate/proposals.js";
import type { WorldStore } from "../world/store.js";
import { foldConversation } from "./fold.js";
import { lookHasMoved } from "./look.js";
import {
  canonIdsNeeded,
  materialiseCandidate,
  MaterialiseError,
  planIdentities,
  type Materialised,
} from "./materialise.js";
import { evaluateReadiness, type NotCarried } from "./readiness.js";
import { conversationDir, WorldChatStore } from "./store.js";
import { accountedProposalIdsOf, leftoversOf, openIntentOf } from "./wrapup-recovery.js";

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
    readonly reason:
      | "stale"
      | "nothing-to-carry"
      | "materialise"
      | "too-many"
      | "in-flight"
      | "look-already-proposed"
      | "leftovers",
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

/**
 * The conversations being wrapped up by this process, right now.
 *
 * The durable check below cannot see these. An intent is only appended after the pre-flight has
 * passed, so two frames arriving together both read a log with no open intent, both agree there
 * is nothing in the way, and both go on to stage a set of proposals for the same propositions.
 * The transport starts a handler per frame without waiting for the one before it — the same shape
 * as the append race this change fixes a layer down.
 *
 * A Set is enough because the question and the claim are one synchronous step: nothing is awaited
 * between them, so no second call can arrive in between. The durable check remains the one that
 * matters across a restart, where this is empty and the log is all there is.
 */
const inFlight = new Set<string>();

export async function wrapUp(input: WrapUpInput): Promise<WrapUpResult> {
  // Built through the shared helper rather than spelled out here, so this store reaches the same
  // per-directory writer as every other one on this conversation (see `writerFor`).
  const dir = conversationDir(input.store.dir, input.conversationId);
  const claim = resolve(dir);
  if (inFlight.has(claim)) {
    throw new WrapUpError(
      "in-flight",
      "This conversation is already being turned into proposals. Wait for that to finish.",
    );
  }
  inFlight.add(claim);
  try {
    return await wrapUpOnce(dir, input);
  } finally {
    inFlight.delete(claim);
  }
}

async function wrapUpOnce(dir: string, input: WrapUpInput): Promise<WrapUpResult> {
  const log = new WorldChatStore(dir);
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

  /**
   * Nothing an earlier attempt left standing (R-42a).
   *
   * A failed wrap-up takes its own staging back, and a discard that will not go leaves a proposal
   * behind for propositions that are all still live. Going again from here would stage a second
   * proposal for each of them, and the approvals screen would hold two accounts of one
   * conversation with no way to tell which was meant.
   *
   * Not the permanent wedge the open-intent refusal would be: these are visible on the approvals
   * screen and can be decided there, and the next start sends them back without being asked.
   *
   * Held until the conversation's own log says what became of them, and not merely until the gate
   * stops listing them. Deciding a proposal removes it and records that against the conversation
   * afterwards, so in between the gate says gone while the log still shows every candidate live —
   * and a wrap-up that trusted the gate alone would slip through exactly there and propose again
   * what had just been accepted. Still staged counts too: send-back writes its log entry first and
   * removes the proposal second, so the two disagree in that direction as well.
   *
   * The gate is only asked when the log says there is something to ask about — a wrap-up on a
   * conversation that never failed reads no proposal directories at all.
   */
  const recordedLeftovers = leftoversOf(events).map((one) => one.proposalId);
  if (recordedLeftovers.length > 0) {
    const accounted = accountedProposalIdsOf(events);
    const open = await input.gate.listOpen();
    const outstanding = recordedLeftovers.filter(
      (id) => !accounted.has(id) || open.some((p) => p.id === id),
    );
    if (outstanding.length > 0) {
      throw new WrapUpError(
        "leftovers",
        "An earlier attempt on this conversation left proposals behind that could not be taken back. Send those back or decide them on the approvals screen, then wrap this up.",
      );
    }
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
  const built: Materialised[] = [];
  let nextCanon = 0;
  try {
    for (const candidate of carried) {
      built.push(
        materialiseCandidate(candidate, identities, bundle, at, () => identities.canonIds[nextCanon++]!),
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

  /*
   * Everything this wrap-up stages, or nothing (R-42a).
   *
   * Staging can refuse for reasons only the gate knows — the world look singleton is one, and it
   * is a refusal raised between two of these calls when another conversation gets there first.
   * Whatever the reason, a wrap-up that stops half way must not leave proposals on the approvals
   * screen with no account of themselves, and must not leave its intent open: the in-flight guard
   * would then refuse every later wrap-up on this conversation until the studio restarted, which
   * turns one lost race into a feature that stays broken.
   *
   * So the cleanup is here, around the whole loop, rather than at any one refusal inside it.
   */
  try {
    for (const item of built) {
      const choice = openChoiceFor(item.candidate);
      const proposal = await input.gate.stage({
        /*
         * A world-look change is an art-direction proposal wherever it came from.
         *
         * The kind is not a label: the gate computes an art-direction proposal's ripple from it —
         * which reference kits see the new look, which productions inherit it, which accepted
         * takes stay pinned to the old one. Staged as "worldbuilding" it would arrive at the
         * approvals screen as a file change with none of that said, which is the wrong thing to
         * be quiet about: this is the one proposal whose consequences reach work already made.
         */
        kind: item.candidate.classification === "art-direction.change" ? "art-direction" : "worldbuilding",
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
      // Recorded before anything else can fail, so the rollback below knows about it.
      proposals.push(proposal);

      /*
       * The look was materialised from a bundle read before any of this, and staging captures its
       * base now — so a look accepted in between would be replaced by a record computed against
       * the one before it, and nothing downstream would call that stale: the proposal's base is
       * the new file. Readiness cannot close that window on its own, because there are awaited
       * writes and an id allocation between it and here.
       */
      if (item.candidate.classification === "art-direction.change") {
        // Against the words as well as the version — a derived look is v1 however often the
        // world's tone is edited underneath it (see look.ts).
        if (lookHasMoved(item.candidate.checks, input.store.getBundle().artDirection)) {
          throw new WrapUpError(
            "stale",
            "The world look changed while this was being written, so nothing was. Open the conversation again and ask for the look you want from where it is now.",
          );
        }
      }

      if (choice) openChoices.push({ ...choice, proposalId: proposal.id });
      if (item.candidate.classification === "canon.thread") threadProposalIds.push(proposal.id);
    }
  } catch (err) {
    /*
     * What would not go is named, not swallowed.
     *
     * The intent closes below whatever happens here, because leaving it open would refuse every
     * later wrap-up on this conversation as in-flight until the studio restarted. That closure is
     * also what puts a failed discard beyond the reach of startup recovery, which reconciles by
     * open intent and would never look again — so an undiscarded proposal would sit on the
     * approvals screen for propositions that are all still live, with nothing anywhere recording
     * that it is there.
     *
     * So the ids travel with the terminal event. The next start sweeps them, the next wrap-up on
     * this conversation refuses while they remain, and the refusal below stops claiming that
     * nothing was created when something was.
     */
    const wouldNotGo: Array<{ proposalId: string; candidateIds: CandidateId[] }> = [];
    for (const [index, staged] of proposals.entries()) {
      await input.gate
        .discard(staged.id)
        .catch(() =>
          wouldNotGo.push({ proposalId: staged.id, candidateIds: [built[index]!.candidate.id] }),
        );
    }
    /*
     * A discard that threw is not proof the proposal is still there.
     *
     * It removes the directory and then writes the world's change journal, so a failure in the
     * second half leaves nothing on the approvals screen and nothing to send back — while the id
     * recorded below would name a proposal that does not exist, and the guard above would refuse
     * every later wrap-up on its account for good. So the gate is asked what actually remains.
     *
     * If that question cannot be answered either, every one of them is recorded. Naming a
     * proposal that has gone costs a startup sweep, which reconciles it against the world's own
     * journal; missing one that is still there costs a proposal nothing accounts for.
     */
    const stillOpen = wouldNotGo.length > 0 ? await input.gate.listOpen().catch(() => null) : [];
    const leftBehind =
      stillOpen === null
        ? wouldNotGo
        : wouldNotGo.filter((one) => stillOpen.some((p) => p.id === one.proposalId));
    const cause =
      err instanceof WrapUpError
        ? err
        : err instanceof LookAlreadyProposedError
          ? new WrapUpError(
              "look-already-proposed",
              "A change to the world look is already waiting to be decided. Decide that one, then wrap this up.",
            )
          : new WrapUpError("materialise", "One of these changes could not be staged, so none were.");
    // What is said and what is recorded differ on purpose. The person is told the thing they can
    // act on — there are proposals on the screen that should not be there — while the log keeps
    // why the wrap-up stopped in the first place, which is the only thing that explains them.
    const refusal =
      leftBehind.length > 0
        ? new WrapUpError(
            "leftovers",
            "This could not be finished, and what it had already created could not be taken back. Those proposals are on the approvals screen; send them back or decide them before trying again.",
          )
        : cause;
    await log.append(
      {
        type: "wrapup.failed",
        requestId: input.requestId,
        safeDetail:
          leftBehind.length > 0 ? `${cause.reason}; ${leftBehind.length} left staged` : cause.reason,
        ...(leftBehind.length > 0 ? { leftovers: leftBehind } : {}),
      },
      { at: input.now() },
    );
    throw refusal;
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
