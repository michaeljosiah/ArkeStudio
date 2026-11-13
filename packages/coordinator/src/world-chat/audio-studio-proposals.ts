import { WorldChatAudioStudioProposalActionSchema, type AudioStudioProposal, type ConversationActionPrepareIntent } from "@arke-studio/contracts";
import type { WorldStore } from "../world/store.js";
import type { FfmpegRunner } from "../takes/export.js";
import type { ConversationActionAuthorityAdapter, PreparedConversationActionAuthority } from "../arke-actions/lifecycle.js";
import { findAudioStudioProposal, stageAudioStudioProposal } from "../productions/audio-studio.js";

const reviewRequired = "Open Audio Studio to compare Current and Suggested, then Keep Current or Apply Suggested.";

/** Chat stages a command batch; only the editor's exact-version decision can apply it. */
export function audioStudioProposalConversationAdapter(store: WorldStore, options: { ffmpeg?: FfmpegRunner } = {},
  changed?: (productionId: string, chapterId: string) => Promise<void>): ConversationActionAuthorityAdapter {
  // A chapter's record or an episode's mix (issue 1882): an episode's card no longer reads stale.
  const find = async (actionId: string, productionId?: string) => productionId === undefined ? null : findAudioStudioProposal(store, productionId, actionId);
  const projection = (intent: ConversationActionPrepareIntent, family: AudioStudioProposal): PreparedConversationActionAuthority => {
    const version = family.versions.find(entry => entry.actionId === intent.actionId)!;
    return { authority: { kind: "voice", id: family.id }, authorityRevision: version.number, approvalBlockedReason: reviewRequired,
      shown: { title: version.summary, consequence: "Audio Studio suggestion prepared. Current is unchanged.", affectedTargets: [...intent.targets],
        ripples: [], permissionReason: "authored-change", body: { family: "command",
          commands: [{ label: `Audio Studio · Version ${version.number}`, detail: `${version.commands.length} changes · Review in Audio Studio` }],
          expectedResult: reviewRequired, undoAvailable: true } } };
  };
  return {
    actionKind: "world-chat-audio-studio-proposal",
    prepare: async ({ intent, payload }) => {
      const action = WorldChatAudioStudioProposalActionSchema.parse(payload);
      const family = await stageAudioStudioProposal(store, action.productionId, action.chapterId, intent.actionId, action.proposal, options);
      await changed?.(action.productionId, action.chapterId);
      return projection(intent, family);
    },
    recoverPreparation: async intent => { const family = await find(intent.actionId, intent.productionId); return family ? projection(intent, family) : null; },
    abandonPreparation: async () => {}, deny: async () => {},
    validate: async () => ({ ok: false, reason: "blocked", detail: reviewRequired }),
    execute: async () => ({ status: "failed", detail: reviewRequired }),
    reconcile: async action => {
      const family = await find(action.actionId, action.productionId);
      if (!family) return { status: "stale", detail: "This Audio Studio proposal is unavailable" };
      if (family.status === "kept") return { status: "cancelled", detail: "Kept Current in Audio Studio" };
      if (family.status === "applied") return { status: "completed", receipt: { kind: "audio-studio", id: family.id, summary: `Audio arrangement applied at revision ${family.resultRevision}.` } };
      if (family.versions.at(-1)?.actionId !== action.actionId) return { status: "stale", detail: "A newer version is ready for review in Audio Studio" };
      return null;
    },
  };
}
