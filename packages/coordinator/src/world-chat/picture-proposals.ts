import { WorldChatPictureProposalActionSchema, type PictureProposalFamily, type PictureProposalVersion,
  type ConversationActionPrepareIntent } from "@arke-studio/contracts";
import type { WorldStore } from "../world/store.js";
import type { ConversationActionAuthorityAdapter, PreparedConversationActionAuthority } from "../arke-actions/lifecycle.js";
import type { EditorEffectDependencies } from "../productions/editor-effect-dependencies.js";
import { readPictureFamilies, stagePictureProposal } from "../productions/editor-picture-requests.js";

export function pictureProposalConversationAdapter(store: WorldStore, dependencies: EditorEffectDependencies | undefined): ConversationActionAuthorityAdapter {
  const blocked = "Choose Review in timeline, then Apply reviewed version. Generic approval cannot apply picture appearance or release protection.";
  const find = async (actionId: string, productionId?: string) => {
    if (productionId) for (const family of await readPictureFamilies(store, productionId)) {
      const version = family.versions.find(value => value.actionId === actionId); if (version) return { family, version };
    }
    return null;
  };
  const projection = (intent: ConversationActionPrepareIntent, family: PictureProposalFamily, version: PictureProposalVersion): PreparedConversationActionAuthority => ({
    authority: { kind: "timeline", id: family.id }, authorityRevision: version.number, approvalBlockedReason: blocked,
    shown: { title: version.summary.slice(0, 200), consequence: "Prepared picture appearance. Current is unchanged.", affectedTargets: [...intent.targets], ripples: [], permissionReason: "authored-change",
      body: { family: "command", commands: [{ label: `Picture appearance · Version ${version.number}`, detail: "Clip appearance · Review in timeline" }], expectedResult: "Review, adjust and Apply the exact version.", undoAvailable: true } },
  });
  return { actionKind: "world-chat-picture-proposal",
    prepare: async ({ intent, payload }) => { const action = WorldChatPictureProposalActionSchema.parse(payload);
      if (!dependencies) throw new Error("Picture proposal preparation is unavailable");
      const { family, version } = await stagePictureProposal(store, { productionId: action.productionId, conversationId: intent.conversationId, actionId: intent.actionId, proposal: action.proposal }, dependencies);
      return projection(intent, family, version); },
    recoverPreparation: async intent => { const found = await find(intent.actionId, intent.productionId); return found ? projection(intent, found.family, found.version) : null; },
    abandonPreparation: async () => {}, deny: async () => {}, validate: async () => ({ ok: false, reason: "blocked", detail: blocked }), execute: async () => ({ status: "failed", detail: blocked }),
    reconcile: async action => { const found = await find(action.actionId, action.productionId);
      if (!found) return { status: "stale", detail: "The picture appearance version is unavailable" };
      if (found.family.receipt) return { status: "completed", receipt: { kind: "editor-pictures", id: found.family.id, summary: `Picture appearance applied at revision ${found.family.receipt.resultRevision}.` } };
      if (found.family.status === "discarded") return { status: "cancelled", detail: "Picture appearance proposal discarded" };
      return null; },
  };
}
