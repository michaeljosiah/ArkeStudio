import type {
  BibleEditRecord,
  CandidateGroup,
  CandidateTombstone,
  ConversationActionCard,
  ConversationActionBinding,
  ConversationActionPrepareIntent,
  ConversationActionRecord,
  ConversationActionStatus,
  ConversationId,
  WorldChangeCandidate,
  WorldChatAttachment,
  WorldChatEventEnvelope,
  WorldChatLoaded,
  WorldChatMessage,
  WorldChatProblem,
  WorldChatRun,
  WorldChatStatus,
  WorldChatSummary,
} from "@arke-studio/contracts";
import { conversationActionDigest, stableJson } from "../arke-actions/digest.js";

/**
 * The event log, folded into the workspace a screen renders (#70 §7.2).
 *
 * The fold is deliberately total and forgiving: it never throws. A conversation with a damaged
 * record still has to open, because the readable part of it is somebody's afternoon of thinking.
 * Anything it cannot honour becomes a named problem and the rest is kept.
 *
 * It is also pure. Recovery — appending the terminal event an interrupted run never wrote — is a
 * separate act performed by the caller, so that reading a conversation twice cannot change it.
 */

export interface FoldResult {
  view: WorldChatLoaded;
  problems: WorldChatProblem[];
  /** Live propositions withdrawn by conversation, kept so the same idea is not re-detected. */
  tombstones: CandidateTombstone[];
  /**
   * True when a run was left `running` with no terminal event — the process died mid-turn. The
   * view already shows it as interrupted; the caller is responsible for making that durable
   * before another run starts.
   */
  needsInterruptedRunRepair: boolean;
}

const MAX_MESSAGES = 50;

const ACTION_STATUS_TRANSITIONS: Record<ConversationActionStatus, readonly ConversationActionStatus[]> = {
  // Recovery may discover that the bound authority was decided through its original surface.
  pending: ["completed", "failed", "cancelled", "stale"],
  approved: ["awaiting-host", "queued", "running", "completed", "failed", "cancelled", "stale"],
  "awaiting-host": ["completed", "failed", "cancelled"],
  queued: ["running", "completed", "failed", "cancelled"],
  running: ["completed", "failed", "cancelled"],
  completed: [],
  failed: [],
  cancelled: [],
  denied: [],
  stale: [],
  superseded: [],
};

function bindingMatchesIntent(
  binding: ConversationActionBinding,
  intent: ConversationActionPrepareIntent,
): boolean {
  return binding.actionId === intent.actionId &&
    binding.conversationId === intent.conversationId &&
    binding.turnId === intent.turnId &&
    binding.worldId === intent.worldId &&
    binding.productionId === intent.productionId &&
    binding.actorId === intent.actorId &&
    binding.scope === intent.scope &&
    binding.actionKind === intent.actionKind &&
    binding.authorityKind === intent.authorityKind &&
    binding.cardFamily === intent.cardFamily &&
    binding.payloadDigest === intent.payloadDigest &&
    binding.createdAt === intent.createdAt &&
    stableJson(binding.targets) === stableJson(intent.targets) &&
    stableJson(binding.baseObservations) === stableJson(intent.baseObservations) &&
    stableJson(binding.dependencies) === stableJson(intent.dependencies);
}

export function foldConversation(
  id: ConversationId,
  createdAt: string,
  events: WorldChatEventEnvelope[],
  options: { messageLimit?: number; /** Log sequence to page back from, exclusive. */ before?: number } = {},
): FoldResult {
  const problems: WorldChatProblem[] = [];
  const limit = options.messageLimit ?? MAX_MESSAGES;

  let title = "Untitled conversation";
  let status: WorldChatStatus = "open";
  let notCarried: WorldChatLoaded["notCarried"] = [];
  let entryContext: WorldChatLoaded["entryContext"];
  let initiative: WorldChatLoaded["initiative"];
  let updatedAt = createdAt;
  let summary: string | undefined;
  let reopened = false;
  /** An intent with no outcome after it. Last one wins, as wrapup-recovery reads it too. */
  let wrapUpInFlight = false;
  /** A point being written right now — see save.intent-recorded. */
  let saveInFlight = false;

  const messages: WorldChatMessage[] = [];
  /** Landed Bible edits, by the studio message that reported them (master §4.5). */
  const bibleEdits = new Map<string, BibleEditRecord>();
  /** Tools each turn was refused, by the studio message written despite them (#506). */
  const refusals = new Map<string, readonly string[]>();
  /** Production filing rows, by the narration message they belong beneath. */
  const benchOutcomes = new Map<string, WorldChatLoaded["benchOutcomes"][string]>();
  /** Durable anchors only; the client joins each one to the live frame-run fold. */
  const frameRunOutcomes = new Map<string, WorldChatLoaded["frameRunOutcomes"][string]>();
  /** The log sequence each message arrived at, so paging can use a real cursor. */
  const messageSeq = new Map<string, number>();
  const messageIds = new Set<string>();
  const candidates = new Map<string, WorldChangeCandidate>();
  const mediaHandoffs: WorldChatLoaded["mediaHandoffs"] = {};
  const groups = new Map<string, CandidateGroup>();
  const attachments = new Map<string, WorldChatAttachment>();
  const tombstones = new Map<string, CandidateTombstone>();
  const actionIntents = new Map<string, ConversationActionPrepareIntent>();
  const failedActionIntents = new Set<string>();
  const actions = new Map<string, ConversationActionRecord>();
  const preparedBindings = new Map<string, ConversationActionBinding>();
  const runs = new Map<string, WorldChatRun>();
  const proposalIds = new Set<string>();
  const resolvedProposals = new Set<string>();
  let seq = 0;

  /** A snapshot may only move a proposition forward one revision at a time. */
  function applyCandidate(next: WorldChangeCandidate, atSeq: number): void {
    const prior = candidates.get(next.id);
    if (prior && next.revision !== prior.revision + 1) {
      problems.push({
        kind: "interior-corruption",
        detail: `A proposition jumped from revision ${prior.revision} to ${next.revision}, so an event is missing or was applied twice.`,
        atSeq,
      });
      // The newer snapshot is still the better guess at current state; refusing it would leave
      // the panel showing something the conversation has already moved past.
    }
    candidates.set(next.id, next);
  }

  function applyActionIntent(intent: ConversationActionPrepareIntent, atSeq: number): void {
    const prior = actionIntents.get(intent.actionId);
    if (prior && stableJson(prior) !== stableJson(intent)) {
      problems.push({
        kind: "interior-corruption",
        detail: `Action ${intent.actionId} has two different preparation intents.`,
        atSeq,
      });
      return;
    }
    if (intent.conversationId !== id) {
      problems.push({
        kind: "interior-corruption",
        detail: `Action ${intent.actionId} names a different conversation.`,
        atSeq,
      });
      return;
    }
    actionIntents.set(intent.actionId, intent);
  }

  function applyActionStatus(
    actionId: string,
    expectedStatus: ConversationActionStatus,
    nextStatus: ConversationActionStatus,
    atSeq: number,
    detail?: string,
    receipt?: ConversationActionRecord["receipt"],
  ): void {
    const action = actions.get(actionId);
    if (!action) return;
    if (action.status !== expectedStatus) {
      problems.push({
        kind: "interior-corruption",
        detail: `Action ${actionId} expected ${expectedStatus} but was ${action.status}.`,
        atSeq,
      });
      return;
    }
    if (!ACTION_STATUS_TRANSITIONS[expectedStatus].includes(nextStatus)) {
      problems.push({
        kind: "interior-corruption",
        detail: `Action ${actionId} cannot move from ${expectedStatus} to ${nextStatus}.`,
        atSeq,
      });
      return;
    }
    actions.set(actionId, {
      ...action,
      status: nextStatus,
      ...(detail ? { statusDetail: detail } : {}),
      ...(receipt ? { receipt } : {}),
    });
  }

  for (const envelope of events) {
    seq = envelope.seq;
    updatedAt = envelope.at;
    const e = envelope.event;
    switch (e.type) {
      case "conversation.created":
        title = e.title;
        entryContext = e.entryContext;
        break;
      case "conversation.metadata-updated":
        if (e.title !== undefined) title = e.title;
        if (e.entryContext !== undefined) entryContext = e.entryContext;
        if (e.initiative !== undefined) initiative = e.initiative;
        break;
      case "conversation.archived":
        status = "archived";
        break;
      case "conversation.unarchived":
        status = "open";
        break;
      case "conversation.reopened":
        status = "open";
        reopened = true;
        for (const candidateId of e.restoredCandidateIds) {
          const c = candidates.get(candidateId);
          if (c) candidates.set(candidateId, { ...c, status: "live" });
        }
        resolvedProposals.add(e.proposalId);
        // Sent back is a proposal that no longer exists, so it is no longer one this conversation
        // is waiting on. Without this the id stays in the set that blocks deletion, and a
        // conversation whose proposals were all returned to it could never be deleted.
        proposalIds.delete(e.proposalId);
        break;
      case "turn.started":
        /*
         * Saying something in a conversation is what makes it open (#70 §6.5).
         *
         * Accept all closes: every point it carried was written, and "closed · everything decided"
         * is a true and useful thing for the list to say. What it must not mean is that the thread
         * is over. It used to: the composer went dead and offered "send one back to carry on" —
         * advice that cannot be taken, because a wrap-up that wrote everything leaves no proposal
         * to send back. Somebody four documents deep in a conversation had to abandon it and
         * re-attach everything to a new one.
         *
         * Closed only. Archiving is a filing decision the person made on purpose, and it is
         * undone by restoring rather than by talking over it.
         */
        if (status === "closed") status = "open";
        addMessage(e.message, envelope.seq);
        runs.set(e.run.id, e.run);
        break;
      case "run.retry-started":
        runs.set(e.run.id, e.run);
        break;
      case "run.session-created": {
        const run = runs.get(e.runId);
        if (run) runs.set(e.runId, { ...run, harnessSessionId: e.harnessSessionId });
        break;
      }
      case "run.finished":
        runs.set(e.run.id, e.run);
        break;
      case "turn.completed":
        addMessage(e.message, envelope.seq);
        runs.set(e.run.id, e.run);
        // Keyed by the reply that made it, so the card renders beside the sentence describing it.
        if (e.bibleEdit) bibleEdits.set(e.message.id, e.bibleEdit);
        // Same keying, and for the same reason: a refusal has to sit beside the sentence it
        // contradicts, not somewhere the reader has to go and look for it.
        if (e.refusedTools && e.refusedTools.length > 0) refusals.set(e.message.id, e.refusedTools);
        for (const c of e.candidates) applyCandidate(c, envelope.seq);
        for (const g of e.groups) groups.set(g.id, g);
        for (const t of e.tombstones) {
          tombstones.set(t.structuralKey, t);
          const c = candidates.get(t.candidateId);
          if (c) candidates.set(t.candidateId, { ...c, status: "withdrawn" });
        }
        for (const intent of e.actionPrepareIntents ?? []) {
          if (intent.turnId !== e.message.turnId) {
            problems.push({
              kind: "interior-corruption",
              detail: `Action ${intent.actionId} names a different turn from the reply that prepared it.`,
              atSeq: envelope.seq,
            });
            continue;
          }
          applyActionIntent(intent, envelope.seq);
        }
        break;
      case "bench.outcome-recorded":
        addMessage(e.message, envelope.seq);
        benchOutcomes.set(e.message.id, e.report);
        break;
      case "frame-run.outcome-recorded":
        addMessage(e.message, envelope.seq);
        frameRunOutcomes.set(e.message.id, e.report);
        break;
      case "candidate.status-changed": {
        const c = candidates.get(e.candidateId);
        if (!c) break;
        candidates.set(e.candidateId, { ...c, status: e.status });
        /*
         * A point saved on its own records its proposal here and nowhere else.
         *
         * Wrap-up announces its proposals in `wrapup.completed`; a save has no such event, so
         * without this the conversation reports no open proposals for one it is holding — which
         * means nothing blocks deleting it, and deleting it takes away the only place a proposal
         * carrying a question could ever be sent back to.
         */
        if (e.status === "proposed" && e.proposalId && !resolvedProposals.has(e.proposalId)) {
          proposalIds.add(e.proposalId);
        }
        break;
      }
      case "media.handoff-created":
        mediaHandoffs[e.candidateId] = {
          candidateRevision: e.candidateRevision,
          sessionId: e.sessionId,
          medium: e.medium,
        };
        break;
      case "attachment.created":
        attachments.set(e.attachment.id, e.attachment);
        break;
      case "attachment.linked": {
        const a = attachments.get(e.attachmentId);
        if (a && !a.linkedMessageIds.includes(e.messageId)) {
          attachments.set(a.id, { ...a, linkedMessageIds: [...a.linkedMessageIds, e.messageId] });
        }
        break;
      }
      case "attachment.unlinked": {
        const a = attachments.get(e.attachmentId);
        if (a) {
          attachments.set(a.id, {
            ...a,
            linkedMessageIds: a.linkedMessageIds.filter((m) => m !== e.messageId),
          });
        }
        break;
      }
      case "attachment.promoted": {
        const a = attachments.get(e.attachmentId);
        if (a) attachments.set(a.id, { ...a, promotedArtifactId: e.artifactId });
        break;
      }
      case "wrapup.intent-recorded":
        // Recorded but not applied: an intent is not an outcome, and a wrap-up that never
        // completed must not leave the conversation looking closed. It does hold deletion open,
        // though — proposals may be halfway to existing.
        wrapUpInFlight = true;
        break;
      case "wrapup.completed":
        status = "closed";
        // Not the ones already resolved: Accept all writes as it goes and records each acceptance
        // as it happens, so completion arrives after them and would otherwise re-add proposals
        // that have already landed — reported as waiting, and blocking deletion for good.
        for (const p of e.proposalIds) if (!resolvedProposals.has(p)) proposalIds.add(p);
        notCarried = e.notCarried;
        wrapUpInFlight = false;
        break;
      case "save.intent-recorded":
        saveInFlight = true;
        break;
      case "save.settled":
        saveInFlight = false;
        for (const p of e.proposalIds) if (!resolvedProposals.has(p)) proposalIds.add(p);
        break;
      case "wrapup.failed":
        wrapUpInFlight = false;
        /*
         * A failure that could not take back everything it staged still holds deletion open.
         *
         * The intent closes here, so nothing else in this fold would say the conversation is
         * waiting on anything — and it would offer Delete over a proposal that is still on the
         * approvals screen. Deleting then puts it beyond reach of every repair there is: startup
         * recovery walks the conversations that exist, send-back needs somewhere to restore the
         * propositions to, and both are gone with the directory.
         *
         * Cleared the same way any other unresolved proposal is: by something saying what became
         * of it.
         */
        for (const one of e.leftovers ?? []) proposalIds.add(one.proposalId);
        break;
      case "proposal.resolved": {
        // A proposal resolves once; a repeated reconciliation on startup is a no-op.
        if (resolvedProposals.has(e.proposalId)) break;
        resolvedProposals.add(e.proposalId);
        // Sent back is the one that returns a proposition to the conversation; discarded
        // deliberately does not, which is what makes discard safe to offer beside it.
        const resolved =
          e.outcome === "accepted" ? "accepted" : e.outcome === "discarded" ? "discarded" : "live";
        for (const candidateId of e.candidateIds) {
          const c = candidates.get(candidateId);
          if (c) candidates.set(candidateId, { ...c, status: resolved });
        }
        proposalIds.delete(e.proposalId);
        break;
      }
      case "summary.updated":
        summary = e.text;
        break;
      case "deletion.intent-recorded":
        break;
      case "action.prepare-intent":
        applyActionIntent(e.intent, envelope.seq);
        break;
      case "action.prepared": {
        const preparedBefore = preparedBindings.get(e.binding.actionId);
        if (preparedBefore) {
          if (stableJson(preparedBefore) !== stableJson(e.binding)) {
            problems.push({
              kind: "interior-corruption",
              detail: `Action ${e.binding.actionId} was prepared twice with different immutable content.`,
              atSeq: envelope.seq,
            });
          }
          break;
        }
        if (conversationActionDigest(e.binding.shown) !== e.binding.previewDigest) {
          problems.push({
            kind: "interior-corruption",
            detail: `Action ${e.binding.actionId} does not match its shown preview digest.`,
            atSeq: envelope.seq,
          });
          break;
        }
        const intent = actionIntents.get(e.binding.actionId);
        if (!intent) {
          problems.push({
            kind: "interior-corruption",
            detail: `Action ${e.binding.actionId} was prepared without a durable intent.`,
            atSeq: envelope.seq,
          });
          break;
        }
        if (!bindingMatchesIntent(e.binding, intent)) {
          problems.push({
            kind: "interior-corruption",
            detail: `Action ${e.binding.actionId} does not match its durable preparation intent.`,
            atSeq: envelope.seq,
          });
          break;
        }
        preparedBindings.set(e.binding.actionId, e.binding);
        actions.set(e.binding.actionId, { ...e.binding });
        failedActionIntents.delete(e.binding.actionId);
        break;
      }
      case "action.prepare-failed":
        if (!actions.has(e.actionId)) failedActionIntents.add(e.actionId);
        break;
      case "action.decision-recorded": {
        const action = actions.get(e.actionId);
        if (!action || action.decision) break;
        if (e.decision.expectedConversationSeq !== envelope.seq - 1) {
          problems.push({
            kind: "interior-corruption",
            detail: `Action ${e.actionId} was decided against sequence ${e.decision.expectedConversationSeq}, not ${envelope.seq - 1}.`,
            atSeq: envelope.seq,
          });
          break;
        }
        if (action.status !== e.decision.expectedStatus) {
          problems.push({
            kind: "interior-corruption",
            detail: `Action ${e.actionId} was decided from ${action.status}, not ${e.decision.expectedStatus}.`,
            atSeq: envelope.seq,
          });
          break;
        }
        if (e.decision.decision === "approve" && action.status !== "pending") {
          problems.push({
            kind: "interior-corruption",
            detail: `Stale action ${e.actionId} cannot be approved; it must be prepared again.`,
            atSeq: envelope.seq,
          });
          break;
        }
        actions.set(e.actionId, {
          ...action,
          decision: e.decision,
          status: e.decision.decision === "approve" ? "approved" : "denied",
        });
        break;
      }
      case "action.status-changed":
        applyActionStatus(
          e.actionId,
          e.expectedStatus,
          e.status,
          envelope.seq,
          e.detail,
          e.receipt,
        );
        break;
      case "action.superseded": {
        const action = actions.get(e.actionId);
        if (!action || (action.status !== "pending" && action.status !== "stale")) break;
        actions.set(e.actionId, {
          ...action,
          status: "superseded",
          supersededBy: e.supersededBy,
          ...(e.detail ? { statusDetail: e.detail } : {}),
        });
        break;
      }
      case "action.undo-linked": {
        const action = actions.get(e.actionId);
        if (action && !action.undo) actions.set(e.actionId, { ...action, undo: e.undo });
        break;
      }
    }
  }

  function addMessage(message: WorldChatMessage, atSeq: number): void {
    if (messageIds.has(message.id)) {
      problems.push({
        kind: "interior-corruption",
        detail: "The same message id appears twice, so the log has been replayed or duplicated.",
      });
      return;
    }
    messageIds.add(message.id);
    messageSeq.set(message.id, atSeq);
    messages.push(message);
  }

  // A run still marked running has no terminal event: the process died mid-turn. The view says
  // interrupted immediately so nothing renders a spinner that will never stop, and the caller
  // makes it durable.
  let needsInterruptedRunRepair = false;
  for (const [runId, run] of runs) {
    if (run.status === "running") {
      needsInterruptedRunRepair = true;
      runs.set(runId, { ...run, status: "interrupted", safeDetail: "the app closed mid-turn" });
    }
  }

  // `before` is a log sequence, not a position: messages are append-only, so a sequence stays
  // meaningful even as the conversation grows underneath a client that is paging back.
  const windowed =
    options.before === undefined
      ? messages
      : messages.filter((m) => (messageSeq.get(m.id) ?? 0) < options.before!);
  const shown = windowed.slice(Math.max(0, windowed.length - limit));

  // Intent order is transcript order. Authority preparation may finish out of order, but that
  // must not move cards away from the turn position at which they were proposed.
  const actionCards = projectActionCards(
    [...actionIntents.keys()].flatMap((actionId) => {
      const action = actions.get(actionId);
      return action ? [action] : [];
    }),
  );
  const unresolvedActionIntent = [...actionIntents.keys()].some(
    (actionId) => !actions.has(actionId) && !failedActionIntents.has(actionId),
  );
  const actionInFlight = actionCards.some((action) =>
    ["pending", "approved", "awaiting-host", "queued", "running"].includes(action.status),
  );

  const view: WorldChatLoaded = {
    id,
    title,
    status,
    createdAt,
    updatedAt,
    ...(entryContext ? { entryContext } : {}),
    ...(initiative ? { initiative } : {}),
    seq,
    ...(reopened ? { reopened: true } : {}),
    messages: shown,
    // Only for the messages still in the window: a card whose message has paged out of the
    // transcript has nothing to render beside, and the bible's own history is the durable record.
    bibleEdits: Object.fromEntries(
      shown.flatMap((m) => {
        const edit = bibleEdits.get(m.id);
        return edit ? [[m.id, edit] as const] : [];
      }),
    ),
    refusals: Object.fromEntries(
      shown.flatMap((m) => {
        const refused = refusals.get(m.id);
        return refused ? [[m.id, [...refused]] as const] : [];
      }),
    ),
    benchOutcomes: Object.fromEntries(
      shown.flatMap((message) => {
        const report = benchOutcomes.get(message.id);
        return report ? [[message.id, report] as const] : [];
      }),
    ),
    frameRunOutcomes: Object.fromEntries(
      shown.flatMap((message) => {
        const report = frameRunOutcomes.get(message.id);
        return report ? [[message.id, report] as const] : [];
      }),
    ),
    hasMore: shown.length < windowed.length,
    candidates: [...candidates.values()],
    actions: actionCards,
    mediaHandoffs,
    groups: [...groups.values()],
    attachments: [...attachments.values()],
    activeRun: [...runs.values()].find((r) => r.status === "interrupted" || r.status === "running") ?? null,
    // The newest run only, and only when it failed: an older failure that a later turn already
    // answered is history, not a thing to keep apologising for.
    lastFailedRun: lastRunIfFailed([...runs.values()], shown),
    ...(summary ? { summary } : {}),
    proposalIds: [...proposalIds],
    notCarried,
    // Computed here because this is the only place all three inputs exist at once, and because
    // one answer is the point: the row that offers Delete and the command that refuses it must
    // not be able to disagree.
    deletionBlock: needsInterruptedRunRepair
      ? "active-run"
      : wrapUpInFlight || saveInFlight
        ? "wrap-up-in-flight"
        : proposalIds.size > 0
          ? "unresolved-proposals"
          : unresolvedActionIntent || actionInFlight
            ? "pending-actions"
          : null,
    problems,
  };
  return { view, problems, tombstones: [...tombstones.values()], needsInterruptedRunRepair };
}

function projectActionCards(records: readonly ConversationActionRecord[]): ConversationActionCard[] {
  const byId = new Map(records.map((action) => [action.actionId, action]));
  return records.map((action) => {
    const blocking = action.dependencies
      .map((dependency) => byId.get(dependency))
      .find((dependency) => dependency?.status !== "completed");
    const blockedReason = action.approvalBlockedReason ?? (blocking
      ? dependencyBlockReason(blocking)
      : action.dependencies.some((dependency) => !byId.has(dependency))
        ? "A required action is no longer available."
        : undefined);
    const availableDecisions = action.status === "pending"
      ? blockedReason
        ? (["deny"] as const)
        : (["approve", "deny"] as const)
      : action.status === "stale"
        ? (["deny"] as const)
        : ([] as const);
    return {
      ...action,
      availableDecisions: [...availableDecisions],
      ...(blockedReason ? { blockedReason } : {}),
    };
  });
}

function dependencyBlockReason(dependency: ConversationActionRecord): string {
  switch (dependency.status) {
    case "failed":
      return `Required action ${dependency.actionId} failed.`;
    case "cancelled":
      return `Required action ${dependency.actionId} was cancelled.`;
    case "denied":
      return `Required action ${dependency.actionId} was denied.`;
    case "stale":
      return `Required action ${dependency.actionId} became stale.`;
    case "superseded":
      return `Required action ${dependency.actionId} was superseded.`;
    default:
      return `Waiting for ${dependency.actionId} to complete.`;
  }
}

/**
 * The newest run, when it failed and left the conversation without an answer.
 *
 * Cancelling is excluded: the person pressed stop, so they know why there is no reply, and being
 * told about it would be the app explaining their own decision back to them. Everything else --
 * timeout, failure, an exhausted budget -- is the app owing an explanation.
 *
 * Also excluded once a later studio message exists for the same turn, which is what a retry
 * produces: the failure is then answered history rather than the state of the conversation.
 */
function lastRunIfFailed(runs: WorldChatRun[], messages: WorldChatMessage[]): WorldChatRun | null {
  const newest = runs.reduce<WorldChatRun | null>(
    (best, run) => (best === null || run.startedAt >= best.startedAt ? run : best),
    null,
  );
  if (newest === null) return null;
  if (newest.status === "running" || newest.status === "completed" || newest.status === "cancelled") return null;
  if (newest.status === "interrupted") return null; // already carried by activeRun, with its own repair
  const answered = messages.some((m) => m.turnId === newest.turnId && m.role === "studio");
  return answered ? null : newest;
}

/** The row the world snapshot carries: enough to choose a conversation, and no history. */
export function summarise(view: WorldChatLoaded): WorldChatSummary {
  return {
    id: view.id,
    title: view.title,
    status: view.status,
    updatedAt: view.updatedAt,
    ...(view.entryContext ? { entryContext: view.entryContext } : {}),
    pointCount: view.candidates.filter((c) => c.status === "live").length,
    openProposalCount: view.proposalIds.length,
    pendingActionCount: view.actions.filter((action) =>
      ["pending", "approved", "awaiting-host", "queued", "running"].includes(action.status),
    ).length,
    ...(view.reopened ? { reopened: true } : {}),
    notCarried: view.notCarried,
    ...(view.deletionBlock ? { deletionBlock: view.deletionBlock } : {}),
  };
}
