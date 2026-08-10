import type {
  CandidateGroup,
  CandidateTombstone,
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
  let updatedAt = createdAt;
  let summary: string | undefined;
  let reopened = false;
  /** An intent with no outcome after it. Last one wins, as wrapup-recovery reads it too. */
  let wrapUpInFlight = false;
  /** A point being written right now — see save.intent-recorded. */
  let saveInFlight = false;

  const messages: WorldChatMessage[] = [];
  /** The log sequence each message arrived at, so paging can use a real cursor. */
  const messageSeq = new Map<string, number>();
  const messageIds = new Set<string>();
  const candidates = new Map<string, WorldChangeCandidate>();
  const groups = new Map<string, CandidateGroup>();
  const attachments = new Map<string, WorldChatAttachment>();
  const tombstones = new Map<string, CandidateTombstone>();
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
        for (const c of e.candidates) applyCandidate(c, envelope.seq);
        for (const g of e.groups) groups.set(g.id, g);
        for (const t of e.tombstones) {
          tombstones.set(t.structuralKey, t);
          const c = candidates.get(t.candidateId);
          if (c) candidates.set(t.candidateId, { ...c, status: "withdrawn" });
        }
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

  const view: WorldChatLoaded = {
    id,
    title,
    status,
    createdAt,
    updatedAt,
    ...(entryContext ? { entryContext } : {}),
    seq,
    ...(reopened ? { reopened: true } : {}),
    messages: shown,
    hasMore: shown.length < windowed.length,
    candidates: [...candidates.values()],
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
          : null,
    problems,
  };
  return { view, problems, tombstones: [...tombstones.values()], needsInterruptedRunRepair };
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
    ...(view.reopened ? { reopened: true } : {}),
    notCarried: view.notCarried,
    ...(view.deletionBlock ? { deletionBlock: view.deletionBlock } : {}),
  };
}
