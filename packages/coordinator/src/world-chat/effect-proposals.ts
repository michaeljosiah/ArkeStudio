import { WorldChatEffectProposalActionSchema, type EffectProposalFamily, type EffectProposalVersion,
  type ConversationActionPrepareIntent } from "@arke-studio/contracts";
import type { WorldStore } from "../world/store.js";
import type { ConversationActionAuthorityAdapter, PreparedConversationActionAuthority } from "../arke-actions/lifecycle.js";
import { readEffectProposalFamilies, stageEffectProposals } from "../productions/editor-effect-requests.js";
import type { EditorEffectDependencies } from "../productions/editor-effect-dependencies.js";

const reviewRequired = "Use Review in timeline, then Apply reviewed version. Generic approval cannot apply effects or release protection.";

/** Native conversation lifecycle links the existing request authority; it owns no Apply path. */
export function effectProposalConversationAdapter(store: WorldStore, dependencies: EditorEffectDependencies | undefined,
  now: () => string): ConversationActionAuthorityAdapter {
  const find = async (actionId: string, productionId: string | undefined) => {
    if (!productionId) return null;
    for (const family of await readEffectProposalFamilies(store, productionId)) {
      const version = family.versions.find(value => value.actionId === actionId);
      if (version) return { family, version };
    }
    return null;
  };
  const projection = (intent: ConversationActionPrepareIntent, family: EffectProposalFamily, version: EffectProposalVersion): PreparedConversationActionAuthority => ({
    authority: { kind: "timeline", id: family.id }, authorityRevision: version.number, approvalBlockedReason: reviewRequired,
    shown: { title: version.summary.slice(0, 200), consequence: "Prepared effects arrangement. Current is unchanged.",
      affectedTargets: [...intent.targets], ripples: [], permissionReason: "authored-change",
      body: { family: "command", commands: [{ label: `Effects · Version ${version.number}`, detail: `${version.delta.length} changes · Review in timeline` }],
        expectedResult: "Review the exact arrangement, adjust it, then choose Apply reviewed version.", undoAvailable: true } },
  });
  return {
    actionKind: "world-chat-effect-proposal",
    prepare: async ({ intent, payload }) => {
      const action = WorldChatEffectProposalActionSchema.parse(payload);
      const existing = await find(intent.actionId, action.productionId);
      if (existing) return projection(intent, existing.family, existing.version);
      if (!dependencies) throw new Error("Effects proposal preparation is unavailable on this host");
      if (action.reviewed && (!action.proposal.family || action.proposal.family.id !== action.reviewed.familyId ||
        action.proposal.family.parentVersionId !== action.reviewed.versionId || action.proposal.family.candidateHash !== action.reviewed.candidateHash)) {
        throw new Error("Revise the exact effects version attached to the person's request");
      }
      const [staged] = await stageEffectProposals(store, { productionId: action.productionId, conversationId: intent.conversationId,
        actionId: intent.actionId, scope: action.scope, proposals: [action.proposal], now: now() }, dependencies);
      if (!staged) throw new Error("The effects proposal was not prepared");
      return projection(intent, staged.family, staged.version);
    },
    recoverPreparation: async intent => { const found = await find(intent.actionId, intent.productionId); return found ? projection(intent, found.family, found.version) : null; },
    // A lifecycle cleanup or grouped denial is not the person's dedicated Discard decision.
    abandonPreparation: async () => {},
    deny: async () => {},
    validate: async () => ({ ok: false, reason: "blocked", detail: reviewRequired }),
    execute: async () => ({ status: "failed", detail: reviewRequired }),
    reconcile: async action => {
      const found = await find(action.actionId, action.productionId);
      if (!found) return { status: "stale", detail: "The effects version is unavailable" };
      if (found.family.receipt) return { status: "completed", receipt: { kind: "editor-effects", id: found.family.id,
        summary: `Effects applied at revision ${found.family.receipt.resultRevision}.` } };
      if (found.family.status === "discarded") return { status: "cancelled", detail: "Effects arrangement discarded in the editor" };
      return null;
    },
  };
}
