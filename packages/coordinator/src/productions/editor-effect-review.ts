import type { EffectReviewCommand, EffectReviewResult, EffectVersionRef } from "@arke-studio/contracts";
import type { WorldStore } from "../world/store.js";
import type { EditorEffectDependencies } from "./editor-effect-dependencies.js";
import { applyReviewedEffectVersion, discardEffectProposal, editEffectProposal, moveEffectProposalHistory,
  readEffectProposalVersion, reviewEffectProposal, retryEffectProposalDependencies, updateEffectProposal } from "./editor-effect-requests.js";

/** Only the authenticated editor dispatcher calls this boundary; model adapters cannot reach it. */
export async function handleEffectReview(store: WorldStore, command: EffectReviewCommand, dependencies: EditorEffectDependencies):
  Promise<{ result: EffectReviewResult; conversationId?: string }> {
  const base = { type: "editor-effect.proposal-result" as const, at: store.now(), worldId: command.worldId,
    productionId: command.productionId, requestId: command.requestId };
  const op = command.operation, input = { productionId: command.productionId, ref: op.ref, now: store.now(), actionId: command.requestId };
  try {
    if (store.worldId !== command.worldId) throw new Error("The owning world is no longer open");
    const source = await readEffectProposalVersion(store, { productionId: command.productionId, familyId: op.ref.familyId, versionId: op.ref.versionId });
    const conversationId = source?.family.conversationId;
    if (op.kind === "apply") {
      const receipt = await applyReviewedEffectVersion(store, { productionId: command.productionId, familyId: op.ref.familyId,
        versionId: op.ref.versionId, candidateHash: op.ref.candidateHash, reviewId: op.reviewId, requestId: command.requestId, now: input.now }, dependencies);
      return { result: { ...base, outcome: "applied", ref: op.ref, receipt }, conversationId };
    }
    if (op.kind === "review") {
      const grant = await reviewEffectProposal(store, input);
      return { result: { ...base, outcome: "reviewed", ref: op.ref, grant }, conversationId };
    }
    if (op.kind === "discard") {
      await discardEffectProposal(store, input);
      return { result: { ...base, outcome: "discarded", ref: op.ref }, conversationId };
    }
    const updated = op.kind === "edit" ? await editEffectProposal(store, { ...input, intent: op.intent, reviewId: op.reviewId }, dependencies)
      : op.kind === "history" ? await moveEffectProposalHistory(store, { ...input, direction: op.direction, reviewId: op.reviewId }, dependencies)
      : op.kind === "update" ? await updateEffectProposal(store, input, dependencies)
      : await retryEffectProposalDependencies(store, input, dependencies);
    const ref: EffectVersionRef = { familyId: updated.family.id, versionId: updated.version.id,
      candidateHash: updated.version.candidateHash, decisionRevision: updated.version.decisionRevision };
    const grant = updated.family.reviewGrants.find(value => value.versionId === ref.versionId && value.candidateHash === ref.candidateHash);
    return { result: { ...base, outcome: "updated", ref, ...(grant ? { grant } : {}) }, conversationId };
  } catch (error) {
    return { result: { ...base, outcome: "refused", ref: op.ref, reason: (error instanceof Error ? error.message : "Effects review failed").slice(0, 1000) } };
  }
}
