import {
  worldChatTextRefusal, type ConversationActionCard, type RippleItem, type WorldChatContext, ulid,
  type WorldChatSubject,
} from "@arke-studio/contracts";
import type { GroupApprovalPort } from "../conversation-group-approval.js";
import type { AttachTarget } from "../../arke-bridge.js";
import { current, emitChange, send, subscribe, useStore } from "./core.js";
import type { WorldChatHold } from "./state.js";
import {
  type TakeReviewPrepared, takeReviewPreparedListeners, subscribeConversationActionDecision,
} from "./events.js";

/**
 * Open one conversation's workspace, or release the open one.
 *
 * Null closes it. The client holds one conversation at a time on purpose: a creator reads one at
 * a time, and keeping every transcript a session has visited would make the app cost more the
 * longer it stays open.
 */
export function openWorldChat(worldId: string, conversationId: string | null): void {
  send({ kind: "world-chat-open", worldId, conversationId });
}

export function createWorldChat(
  worldId: string,
  title: string,
  requestId: string,
  entryContext?: WorldChatContext,
): boolean {
  return send({ kind: "world-chat-create", worldId, title, requestId, ...(entryContext ? { entryContext } : {}) });
}

/** Say something in a conversation, and take a turn. */
export function sendWorldChat(
  worldId: string,
  conversationId: string,
  text: string,
  attachmentIds: string[] = [],
  subject?: WorldChatSubject,
  modelId?: string,
  /** A line that asks for a reply and nothing else (turn 128): no action the turn returns is staged. */
  replyOnly = false,
  /**
   * A line sent again after its answer was lost goes under its first request (PR 1232): the
   * coordinator takes one line per request, so the retry cannot buy a second turn.
   */
  requestId: string = crypto.randomUUID(),
  /** This turn's effort for whichever model answers, in the harness's own name (design turn 195). */
  variant?: string,
): string | null {
  if (worldChatTextRefusal(text) !== null) return null;
  const sent = send({
    kind: "world-chat-send",
    worldId,
    requestId,
    conversationId,
    text,
    attachmentIds,
    ...(modelId !== undefined ? { modelId } : {}),
    ...(variant !== undefined ? { variant } : {}),
    ...(subject !== undefined ? { subject } : {}),
    ...(replyOnly ? { replyOnly: true } : {}),
  });
  if (!sent) return null;
  // Held only while there is a thread on screen to watch move; with none there is nothing to wait on.
  const workspace = current.state?.worldChat;
  if (workspace?.conversationId === conversationId) {
    emitChange({
      ...current,
      worldChatHolds: {
        ...current.worldChatHolds,
        [conversationId]: { requestId, worldId, seq: workspace.seq, rejoins: current.rejoins },
      },
    });
  }
  return requestId;
}

/** Asks where a sent line stands, after a rejoin that may have lost its answer (PR 1232). */
export function askWorldChatSendStatus(worldId: string, conversationId: string, requestId: string): boolean {
  return send({ kind: "world-chat-send-status", worldId, requestId, conversationId: conversationId as never });
}

/** The line just sent into a conversation that the screen has not seen become a turn, if any. */
export function worldChatHold(conversationId: string | null | undefined): WorldChatHold | null {
  return conversationId ? current.worldChatHolds[conversationId] ?? null : null;
}

/** Decide exactly the card and conversation revision currently on screen. */
export function prepareConversationTakeReview(action: ConversationActionCard, takeId: string, shotId: string): Promise<string> {
  const state = current.state;
  const workspace = state?.worldChat;
  if (state?.world?.meta.worldId !== action.worldId || !workspace || workspace.conversationId !== action.conversationId) return Promise.reject(new Error("The conversation is no longer open."));
  const expectedConversationSeq = workspace.seq;
  const requestId = ulid();
  return new Promise((resolve, reject) => {
    const listener = (answer: TakeReviewPrepared) => {
      if (answer.requestId !== requestId || answer.worldId !== action.worldId || answer.conversationId !== action.conversationId) return;
      clearTimeout(timer); takeReviewPreparedListeners.delete(listener);
      if (answer.actionId) resolve(answer.actionId); else reject(new Error(answer.detail ?? "The review could not be prepared."));
    };
    const timer = setTimeout(() => { takeReviewPreparedListeners.delete(listener); reject(new Error("The preparation acknowledgement is unavailable.")); }, 30_000);
    takeReviewPreparedListeners.add(listener);
    if (!send({ kind: "conversation-take-review-prepare", worldId: action.worldId, conversationId: action.conversationId,
      sourceActionId: action.actionId, takeId, shotId, expectedConversationSeq, requestId })) {
      clearTimeout(timer); takeReviewPreparedListeners.delete(listener); reject(new Error("The review could not be sent."));
    }
  });
}

export function decideConversationAction(
  worldId: string,
  conversationId: string,
  actionId: string,
  expectedConversationSeq: number,
  expectedStatus: "pending" | "stale",
  decision: "approve" | "deny",
  group?: { turnId: string; requestId: string },
): string | null {
  const requestId = group?.requestId ?? ulid();
  return send({
    kind: "conversation-action-decide",
    worldId,
    conversationId,
    actionId,
    expectedConversationSeq,
    expectedStatus,
    decision,
    requestId,
    ...(group ? { groupApprovalTurnId: group.turnId } : {}),
  }) ? requestId : null;
}

/** A group uses the current conversation sequence after each completed member. */
export function conversationGroupApprovalPort(conversationId: string): GroupApprovalPort {
  return {
    read: () => {
      const state = current.state;
      const workspace = state?.worldChat;
      return state?.world && workspace?.conversationId === conversationId
        ? { worldId: state.world.meta.worldId, conversationId, seq: workspace.seq, actions: workspace.actions }
        : null;
    },
    decide: (action, seq, requestId) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => { unsubscribe(); reject(new Error("The decision acknowledgement is unavailable.")); }, 30_000);
      const unsubscribe = subscribeConversationActionDecision(answer => {
        if (answer.requestId !== requestId || answer.actionId !== action.actionId) return;
        clearTimeout(timer); unsubscribe(); resolve(answer);
      });
      if (!decideConversationAction(action.worldId, action.conversationId, action.actionId, seq, "pending", "approve", { turnId: action.turnId, requestId })) {
        clearTimeout(timer); unsubscribe(); reject(new Error("The decision could not be sent."));
      }
    }),
    changed: signal => new Promise((resolve, reject) => {
      if (signal.aborted) { reject(new Error("Stopped")); return; }
      const cleanup = () => { clearTimeout(timer); unsubscribe(); signal.removeEventListener("abort", abort); };
      const abort = () => { cleanup(); reject(new Error("Stopped")); };
      const timer = setTimeout(() => { cleanup(); reject(new Error("No current action state.")); }, 30_000);
      const unsubscribe = subscribe(() => { cleanup(); resolve(); });
      signal.addEventListener("abort", abort, { once: true });
    }),
  };
}

/** Accept or reject one of Arke's editor requests (SPEC-039 R-29): the only boundary that lands or discards it. */
export function decideEditorRequest(worldId: string, productionId: string, requestId: string, decision: "accept" | "reject"): void {
  send({ kind: "editor-request-decide", worldId, productionId, requestId, decision });
}

/** Stop the turn in flight. */
export function cancelWorldChat(worldId: string, conversationId: string): void {
  send({ kind: "world-chat-cancel", worldId, conversationId });
}

/**
 * Run a failed turn again. No second message: they already said it once, and retyping it to
 * recover from our timeout would be the app charging them for its own failure.
 */
export function retryWorldChatTurn(worldId: string, conversationId: string, turnId: string): void {
  send({ kind: "world-chat-retry-turn", worldId, requestId: crypto.randomUUID(), conversationId, turnId });
}

/**
 * Write one point into the world, from the rail it is shown on.
 *
 * Returns the attempt's id, or null when nothing was transmitted — the rail waits on the answer
 * to this, and a command that never left has no answer coming.
 *
 * `expectedRevision` is the revision the rail is showing. A point corrected by talking since is
 * refused rather than written as it was.
 */
export function saveWorldChatPoint(
  worldId: string,
  conversationId: string,
  candidateId: string,
  expectedRevision: number,
  /** What the rail was showing for this point's atomic group, if it has one. */
  groupMembers: ReadonlyArray<{ candidateId: string; revision: number }> = [],
): string | null {
  const requestId = crypto.randomUUID();
  const sent = send({
    kind: "world-chat-save-point",
    worldId,
    requestId,
    conversationId,
    candidateId,
    expectedCandidateRevision: expectedRevision,
    ...(groupMembers.length > 0 ? { expectedGroupRevisions: [...groupMembers] } : {}),
  });
  // A decision replaces the last refusal rather than standing beside it — the reason on screen has
  // to belong to the press just made, and a stale one over a point that then wrote is a lie.
  if (sent && current.worldChatWrapUpRefusals[conversationId] !== undefined) {
    const cleared = { ...current.worldChatWrapUpRefusals };
    delete cleared[conversationId];
    emitChange({ ...current, worldChatWrapUpRefusals: cleared });
  }
  if (sent && current.worldChatRipples[conversationId] !== undefined) {
    const cleared = { ...current.worldChatRipples };
    delete cleared[conversationId];
    emitChange({ ...current, worldChatRipples: cleared });
  }
  return sent ? requestId : null;
}

/** Drop one point. It is not written, and it stops being offered. */
export function rejectWorldChatPoint(
  worldId: string,
  conversationId: string,
  candidateId: string,
  expectedRevision: number,
  /** As for a save: rejecting a grouped point drops its siblings, so it names them too. */
  groupMembers: ReadonlyArray<{ candidateId: string; revision: number }> = [],
): boolean {
  const sent = send({
    kind: "world-chat-reject-point",
    worldId,
    requestId: crypto.randomUUID(),
    conversationId,
    candidateId,
    expectedCandidateRevision: expectedRevision,
    ...(groupMembers.length > 0 ? { expectedGroupRevisions: [...groupMembers] } : {}),
  });
  // As for a save: a decision that went out replaces the last refusal rather than standing under
  // it, or the rail keeps explaining a failure beneath a point that has just been dealt with.
  if (sent && current.worldChatWrapUpRefusals[conversationId] !== undefined) {
    const cleared = { ...current.worldChatWrapUpRefusals };
    delete cleared[conversationId];
    emitChange({ ...current, worldChatWrapUpRefusals: cleared });
  }
  if (sent && current.worldChatRipples[conversationId] !== undefined) {
    const cleared = { ...current.worldChatRipples };
    delete cleared[conversationId];
    emitChange({ ...current, worldChatRipples: cleared });
  }
  return sent;
}

/** Prepare or reopen a reviewed Bench session. This command never dispatches generation. */
export function openWorldChatMedia(
  worldId: string,
  conversationId: string,
  candidateId: string,
  expectedRevision: number,
): string | null {
  const requestId = ulid();
  return send({
    kind: "world-chat-open-media",
    worldId,
    requestId,
    conversationId,
    candidateId,
    expectedCandidateRevision: expectedRevision,
  })
    ? requestId
    : null;
}

/**
 * Turn the conversation into proposals and close it.
 *
 * Returns the id of the attempt, or null when the command did not go out at all. The screen waits
 * on the answer to this: a command that was never transmitted has nothing to wait for, and an
 * answer that names a different attempt belongs to another window.
 */
export function wrapUpWorldChat(
  worldId: string,
  conversationId: string,
  expectedConversationSeq: number,
): string | null {
  const requestId = crypto.randomUUID();
  const sent = send({
    kind: "world-chat-wrap-up",
    worldId,
    requestId,
    conversationId,
    expectedConversationSeq,
  });
  // A fresh attempt clears the last refusal rather than standing beside it, but only once one has
  // actually gone: a press that transmitted nothing has no answer coming to replace it, and
  // taking the old reason away would leave the screen saying nothing about either.
  if (sent && current.worldChatWrapUpRefusals[conversationId] !== undefined) {
    const cleared = { ...current.worldChatWrapUpRefusals };
    delete cleared[conversationId];
    emitChange({ ...current, worldChatWrapUpRefusals: cleared });
  }
  if (sent && current.worldChatRipples[conversationId] !== undefined) {
    const cleared = { ...current.worldChatRipples };
    delete cleared[conversationId];
    emitChange({ ...current, worldChatRipples: cleared });
  }
  return sent ? requestId : null;
}

/**
 * Delete a conversation permanently (R-50).
 *
 * The coordinator rechecks whether anything still depends on it and refuses if so, which is why
 * this returns nothing to wait on: the row it came from is redrawn either way, still carrying the
 * reason if there is one.
 */
export function deleteWorldChat(worldId: string, conversationId: string): void {
  send({ kind: "world-chat-delete", worldId, requestId: crypto.randomUUID(), conversationId });
}

/** Ask the host's picker for documents to hand to this conversation, privately. */
export function worldChatAttachFiles(worldId: string, conversationId: string): void {
  send({ kind: "world-chat-attach-files", worldId, conversationId });
}

/** Explicitly file one private conversation attachment into the world's artifact shelf. */
export function promoteWorldChatAttachment(worldId: string, conversationId: string, attachmentId: string): void {
  send({
    kind: "world-chat-promote-attachment",
    worldId,
    conversationId,
    attachmentId,
    requestId: crypto.randomUUID(),
  });
}

/**
 * Where a dropped or pasted file goes: this conversation, not the world.
 *
 * Handed to the host rather than sent from here, because resolving a File to a path is the one
 * thing the renderer must not do — see attachHostFiles.
 */
export function worldChatAttachTarget(worldId: string, conversationId: string): AttachTarget {
  return { kind: "world-chat-attach", worldId, conversationId };
}

/** What this conversation would not take, so the composer can say so on a chip. */
export function useWorldChatRefusals(
  conversationId: string | undefined,
): Array<{ name: string; reason: string }> {
  const refusals = useStore().worldChatRefusals;
  return conversationId ? (refusals[conversationId] ?? []) : [];
}

/** Why the last wrap-up did not happen, and which attempt it answers. */
export function useWorldChatWrapUpRefusal(
  conversationId: string | undefined,
): { requestId: string; detail: string } | null {
  const refusals = useStore().worldChatWrapUpRefusals;
  return conversationId ? (refusals[conversationId] ?? null) : null;
}

export function useWorldChatRipples(
  conversationId: string | undefined,
): { requestId: string; items: RippleItem[] } | null {
  const notices = useStore().worldChatRipples;
  return conversationId ? (notices[conversationId] ?? null) : null;
}

export function dismissWorldChatRipples(conversationId: string): void {
  if (current.worldChatRipples[conversationId] === undefined) return;
  const next = { ...current.worldChatRipples };
  delete next[conversationId];
  emitChange({ ...current, worldChatRipples: next });
}

/**
 * What the studio is doing this second, or null when it is not doing anything.
 *
 * `since` discards a label left over from the previous turn. Progress is transient and keyed by
 * conversation, so without it the last word of one turn — usually "Writing" — is what the next
 * turn shows for its first couple of seconds, describing work that finished a minute ago.
 */
export function useWorldChatProgress(
  conversationId: string | undefined,
  since: string | null,
): string | null {
  const progress = useStore().worldChatProgress;
  const entry = conversationId ? progress[conversationId] : undefined;
  if (!entry) return null;
  if (since !== null && entry.at < since) return null;
  return entry.label;
}

/** Shelve a conversation. Reversible, and loses nothing. */
/** The mode changes initiative, never acceptance authority (SPEC-023 R-21). */
export function setWorldChatInitiative(
  worldId: string,
  conversationId: string,
  initiative: "assist" | "collaborate" | "develop",
): void {
  send({ kind: "world-chat-set-initiative", worldId, conversationId, initiative });
}

export function archiveWorldChat(worldId: string, conversationId: string): void {
  send({ kind: "world-chat-archive", worldId, conversationId });
}

/** Take it back off the shelf. */
export function unarchiveWorldChat(worldId: string, conversationId: string): void {
  send({ kind: "world-chat-unarchive", worldId, conversationId });
}

/** Return a proposal to the conversation it came from, and reopen it. */
export function sendProposalBack(worldId: string, proposalId: string): void {
  send({ kind: "proposal-send-back", worldId, proposalId });
}
