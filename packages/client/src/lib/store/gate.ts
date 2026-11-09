import { ulid } from "@arke-studio/contracts";
import { send, useStoreSelector } from "./core.js";
import type { GateNotice } from "./state.js";
import { gateRequests } from "./events.js";

// ---- the accept gate (SPEC-004) -------------------------------------------

/** Save only dirtyHeadings; sections may be the full form or that subset. Omitted prose stays. */
export function stageSheetEdit(
  worldId: string,
  path: string,
  summary: string,
  sections: Array<{ heading: string; body: string }>,
  dirtyHeadings: string[],
  /** Characters only: the new `role`, or "" to clear it. Omit to leave it untouched. */
  role?: string,
): string | null {
  const requestId = ulid();
  return send({
    kind: "stage-sheet-edit",
    worldId,
    requestId,
    path,
    summary,
    sections,
    dirtyHeadings,
    ...(role !== undefined ? { role } : {}),
  })
    ? requestId
    : null;
}

/** Restore the outgoing version carried by a successful sheet edit result (SPEC-040 R-24). */
export function restoreSheetVersion(worldId: string, path: string, version: number): string | null {
  const requestId = ulid();
  return send({ kind: "restore-sheet-version", worldId, requestId, path, version }) ? requestId : null;
}

export function stageArtDirectionChange(
  worldId: string,
  description: string,
  masterLook?: string | null,
): void {
  send({
    kind: "stage-art-direction-change",
    worldId,
    description,
    ...(masterLook !== undefined ? { masterLook } : {}),
  });
}

/**
 * The human's own action (the assign-voice rule): applies at once, versioned, never staged.
 * Returns whether the command was actually sent — a disconnected studio must not read as a
 * change made, or the caller navigates away over a lost edit.
 */
export function setArtDirection(worldId: string, description: string, masterLook?: string | null): string | null {
  const requestId = ulid();
  return send({
    kind: "set-art-direction",
    worldId,
    requestId,
    description,
    ...(masterLook !== undefined ? { masterLook } : {}),
  }) ? requestId : null;
}

/** True when the accept went out; false when the transport is down. */
export function acceptProposal(
  worldId: string,
  proposalId: string,
  confirmRipples?: string,
  expectedDraftRevision?: number,
  /** Echoed on a refusal, so the screen that pressed knows the answer is its own (PR 1232). */
  requestId?: string,
): boolean {
  if (requestId !== undefined) gateRequests.add(requestId);
  return send({
    kind: "proposal-accept",
    worldId,
    proposalId,
    ...(requestId !== undefined ? { requestId } : {}),
    ...(confirmRipples !== undefined ? { confirmRipples } : {}),
    ...(expectedDraftRevision !== undefined ? { expectedDraftRevision } : {}),
  });
}

export function discardProposal(worldId: string, proposalId: string): void {
  send({ kind: "proposal-discard", worldId, proposalId });
}

export function rebaseProposal(worldId: string, proposalId: string): void {
  send({ kind: "proposal-rebase", worldId, proposalId });
}

export function resolveProposalConflict(
  worldId: string,
  proposalId: string,
  path: string,
  field: string,
  choice: "mine" | "theirs",
): void {
  send({ kind: "proposal-resolve-conflict", worldId, proposalId, path, field, choice });
}

export function markProposalSeen(worldId: string, proposalId: string): void {
  send({ kind: "proposal-mark-seen", worldId, proposalId });
}

export function resolveProposalChoice(
  worldId: string,
  proposalId: string,
  choiceId: string,
  optionId: string,
  expectedDraftRevision: number,
): void {
  send({
    kind: "proposal-resolve-choice",
    worldId,
    requestId: crypto.randomUUID(),
    proposalId,
    choiceId,
    optionId,
    expectedDraftRevision,
  });
}

/**
 * Keep part of a staged passage revision (turn 128): the span as the screen drew it, and the edits
 * kept by index; the gate composes the passage. Fenced to the draft revision shown, as a field
 * edit is. False when nothing was sent, so the screen does not wait for an answer that cannot come.
 */
export function updateProposalPassage(
  worldId: string,
  proposalId: string,
  path: string,
  span: { before: string; after: string },
  kept: readonly number[],
  expectedDraftRevision: number,
  /** The keep's own id: sent again after a rejoin, the gate makes the same edit once (PR 1232). */
  requestId: string = crypto.randomUUID(),
): boolean {
  gateRequests.add(requestId);
  return send({
    kind: "proposal-update-passage",
    worldId,
    requestId,
    proposalId,
    path,
    before: span.before,
    after: span.after,
    kept: [...kept],
    expectedDraftRevision,
  });
}

export function useGateNotices(): Record<string, GateNotice> {
  return useStoreSelector(store => store.gateNotices);
}
