import { resolve } from "node:path";
import {
  type CandidateId,
  type ConversationId,
  type Proposal,
  type ProposalOpenChoice,
  type WorldBundle,
  type WorldChangeCandidate,
} from "@arke-studio/contracts";
import { LookAlreadyProposedError, type ProposalManager } from "../gate/proposals.js";
import type { WorldStore } from "../world/store.js";
import { foldConversation } from "./fold.js";
import { canonIdsNeeded, materialiseCandidate, MaterialiseError, planIdentities } from "./materialise.js";
import { evaluateReadiness, explainNotCarried, type NotCarried } from "./readiness.js";
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
    readonly reason:
      | "stale"
      | "nothing-to-carry"
      | "materialise"
      | "too-many"
      | "in-flight"
      | "look-already-proposed",
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

/**
 * Reserve, build and stage one set of propositions — all of them or none.
 *
 * Shared by wrap-up, which carries everything a conversation settled, and by saving one point
 * from the rail. They differ in what they select and in whether the conversation closes
 * afterwards; the part in the middle — allocate identities, materialise, stage, and undo the lot
 * if any of it refuses — is the same work and must not exist twice.
 *
 * `onFailure` is how the caller records the attempt in its own vocabulary. Wrap-up writes
 * `wrapup.failed` to close the intent it opened; a save has no intent to close and writes nothing.
 */
async function buildAndStage(input: {
  log: WorldChatStore;
  store: WorldStore;
  gate: ProposalManager;
  conversationId: ConversationId;
  requestId: string;
  carried: readonly WorldChangeCandidate[];
  bundle: WorldBundle;
  at: string;
  now: () => string;
  onFailure: (reason: WrapUpError["reason"]) => Promise<void>;
}): Promise<{
  built: ReturnType<typeof materialiseCandidate>[];
  proposals: Proposal[];
  openChoices: WrapUpResult["openChoices"];
  threadProposalIds: string[];
}> {
  const { log, gate, carried, bundle, at } = input;

  const needed = canonIdsNeeded(carried);
  const reserved =
    needed > 0 ? await input.store.allocateCanonIds(needed, `world-chat:${input.conversationId}`) : [];
  const identities = planIdentities(carried, reserved, bundle);

  // Everything is built and validated before a single proposal directory exists, so a malformed
  // candidate fails without leaving one behind (§11.2).
  const built = [];
  let nextCanon = 0;
  try {
    for (const candidate of carried) {
      built.push(materialiseCandidate(candidate, identities, bundle, at, () => identities.canonIds[nextCanon++]!));
    }
  } catch (err) {
    await input.onFailure("materialise");
    throw new WrapUpError(
      "materialise",
      err instanceof MaterialiseError
        ? "One of these changes could not be written, so nothing was."
        : "This could not be written, so nothing was.",
    );
  }

  const proposals: Proposal[] = [];
  const openChoices: WrapUpResult["openChoices"] = [];
  const threadProposalIds: string[] = [];

  /*
   * Everything staged, or nothing (R-42a).
   *
   * Staging can refuse for reasons only the gate knows — the world-look singleton is one, and it
   * refuses between two of these calls when another conversation gets there first. Whatever the
   * reason, stopping half way must not leave proposals on the approvals screen with no account of
   * themselves, so the cleanup is around the whole loop rather than at any one refusal inside it.
   */
  try {
    for (const item of built) {
      const choice = openChoiceFor(item.candidate);
      const proposal = await gate.stage({
        /*
         * A world-look change is an art-direction proposal wherever it came from.
         *
         * The kind is not a label: the gate computes an art-direction proposal's ripple from it —
         * which reference kits see the new look, which productions inherit it, which accepted
         * takes stay pinned to the old one.
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
       * the one before it, and nothing downstream would call that stale.
       */
      if (item.candidate.classification === "art-direction.change") {
        const basedOn = item.candidate.checks.basedOnArtDirectionVersion;
        const now = input.store.getBundle().artDirection.version;
        if (basedOn !== undefined && basedOn !== now) {
          throw new WrapUpError(
            "stale",
            "The world look changed while this was being written, so nothing was. Ask for the look you want from where it is now.",
          );
        }
      }

      if (choice) openChoices.push({ ...choice, proposalId: proposal.id });
      if (item.candidate.classification === "canon.thread") threadProposalIds.push(proposal.id);
    }
  } catch (err) {
    for (const staged of proposals) {
      await gate.discard(staged.id).catch(() => {
        /* recovery reconciles what will not go now; the refusal below is the answer either way */
      });
    }
    const refusal =
      err instanceof WrapUpError
        ? err
        : err instanceof LookAlreadyProposedError
          ? new WrapUpError(
              "look-already-proposed",
              "A change to the world look is already waiting to be decided. Decide that one first.",
            )
          : new WrapUpError("materialise", "One of these changes could not be staged, so none were.");
    await input.onFailure(refusal.reason);
    throw refusal;
  }

  /**
   * Each proposition that carried is now proposed, and says which proposal it became (§6.5).
   *
   * Without this the panel would still show them as live, because it renders live ones and
   * nothing else had moved them. It also gives send-back the link it needs to put them back.
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

  return { built, proposals, openChoices, threadProposalIds };
}

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

  const { proposals, openChoices, threadProposalIds } = await buildAndStage({
    log,
    store: input.store,
    gate: input.gate,
    conversationId: input.conversationId,
    requestId: input.requestId,
    carried,
    bundle,
    at,
    now: input.now,
    // The intent opened above has to be closed however this ends, or the in-flight guard refuses
    // every later wrap-up on this conversation until the studio is restarted.
    onFailure: async (reason) => {
      await log.append(
        { type: "wrapup.failed", requestId: input.requestId, safeDetail: reason },
        { at: input.now() },
      );
    },
  });

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

export interface SavePointInput {
  store: WorldStore;
  gate: ProposalManager;
  conversationId: ConversationId;
  requestId: string;
  candidateId: string;
  /** The revision the rail was showing. A point corrected since is refused, not written as it was. */
  expectedCandidateRevision: number;
  now: () => string;
}

export interface SavePointResult {
  /** Every proposal this wrote — more than one when the point belongs to an atomic group. */
  proposalIds: string[];
  /** The propositions it carried, so the caller can say what it wrote. */
  candidateIds: CandidateId[];
}

/**
 * Write one point into the world, from the rail it is shown on (#70, revised).
 *
 * The same machinery as a wrap-up over a set of one, and deliberately so: readiness decides what
 * may be written, the identities are reserved, the files are built and validated before anything
 * exists, and the whole set is undone if any of it refuses. What is different is the shape of the
 * decision around it — this writes as soon as it is asked to, and the conversation stays open.
 *
 * No intent is recorded, unlike wrap-up. An intent exists so recovery can reconcile a crash that
 * left a set of proposals half made; a save stages at most a group, and a crash between staging
 * and accepting leaves exactly what a proposal waiting on the approvals screen already is — a
 * state a person can finish by hand. Recording an intent that nothing would resolve would instead
 * leave the conversation refusing every later save as in-flight.
 *
 * An atomic group comes with it. Membership is a property of the references between propositions,
 * not a preference, so a point that only makes sense beside two others carries those two: writing
 * one of a group would leave the world holding half of something that was never true separately.
 */
export async function savePoint(input: SavePointInput): Promise<SavePointResult> {
  const dir = conversationDir(input.store.dir, input.conversationId);
  const claim = resolve(dir);
  if (inFlight.has(claim)) {
    throw new WrapUpError("in-flight", "This conversation is already writing something. Wait for that to finish.");
  }
  inFlight.add(claim);
  try {
    const log = new WorldChatStore(dir);
    const meta = await log.readMeta();
    if (!meta) throw new WrapUpError("stale", "That conversation is no longer here.");

    const { events } = await log.read();
    const view = foldConversation(meta.id, meta.createdAt, events).view;

    const point = view.candidates.find((c) => c.id === input.candidateId);
    if (!point || point.status !== "live") {
      throw new WrapUpError("stale", "That point is no longer in this conversation.");
    }
    /*
     * The revision the rail was showing, not merely the one that exists.
     *
     * A point is corrected by talking, and a correction arrives as a new revision of the same
     * proposition. Writing whatever is current would write the correction the person has not read
     * yet — the same mistake as wrap-up ignoring the conversation's sequence, one point down.
     */
    if (point.revision !== input.expectedCandidateRevision) {
      throw new WrapUpError("stale", "That point changed since you saw it. Look again and save it from there.");
    }

    const group = point.groupId
      ? view.groups.find((g) => g.id === point.groupId && g.status === "live")
      : undefined;
    const wanted = new Set<string>(
      group ? group.members.map((m) => m.candidateId as string) : [input.candidateId],
    );
    const selected = view.candidates.filter((c) => wanted.has(c.id));

    const bundle = input.store.getBundle();
    const { carried, notCarried } = evaluateReadiness(selected, bundle);
    if (carried.length === 0) {
      const why = notCarried.find((n) => n.candidateId === input.candidateId);
      throw new WrapUpError(
        "nothing-to-carry",
        why ? `This cannot be written yet: ${explainNotCarried(why.reason)}.` : "This cannot be written yet.",
      );
    }
    /*
     * A group lands whole or not at all, so one member held back holds the group back. Writing the
     * rest would be the app deciding that the missing piece did not matter, which is exactly the
     * judgement atomicity exists to keep away from it.
     */
    if (group && carried.length !== selected.length) {
      const blocked = notCarried[0];
      throw new WrapUpError(
        "nothing-to-carry",
        blocked
          ? `These land together, and one of them cannot be written yet: ${explainNotCarried(blocked.reason)}.`
          : "These land together, and one of them cannot be written yet.",
      );
    }

    const at = input.now();
    const { proposals } = await buildAndStage({
      log,
      store: input.store,
      gate: input.gate,
      conversationId: input.conversationId,
      requestId: input.requestId,
      carried,
      bundle,
      at,
      now: input.now,
      // Nothing to record: no intent was opened, and the refusal itself is the whole answer.
      onFailure: async () => {},
    });

    return {
      proposalIds: proposals.map((p) => p.id),
      candidateIds: carried.map((c) => c.id),
    };
  } finally {
    inFlight.delete(claim);
  }
}
