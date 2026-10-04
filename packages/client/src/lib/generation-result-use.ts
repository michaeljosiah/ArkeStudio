import type { ConversationActionCard, WorldBundle } from "@arke-studio/contracts";

type Result = NonNullable<NonNullable<ConversationActionCard["receipt"]>["generation"]>["results"][number];

/** Use is a human request in the owning conversation; existing authorities still prepare/decide it. */
export function generationResultUses(action: ConversationActionCard, result: Result, world: WorldBundle): { label: string; request: string }[] {
  if (world.meta.worldId !== action.worldId || result.status !== "completed" || !result.mediaPath ||
      action.shown.body.family !== "generation" || !["approved", "queued", "running", "completed", "failed", "cancelled"].includes(action.status)) return [];
  const production = world.productions.find(p => p.meta.id === action.productionId);
  const origin = `completed result ${result.id} from generation action ${action.actionId}`;
  if (action.actionKind === "world-chat-bench-generation") return result.medium === "audio" && production
    ? [{ label: "Audio cue", request: `Prepare the existing filing and audio cue placement actions for the ${origin} in production ${production.meta.id}. Read its owning Bench session ${action.authority.id} and the current timeline, keep the source's role, and show the placement for review.` }]
    : [{ label: "File result", request: `Prepare the existing filing action for the ${origin} in Bench session ${action.authority.id}. Read the current take and its subject, and show the filing destination for review.` }];
  if (!production) return [];
  const performance = production.performances.find(p => p.id === result.id);
  if (performance) return [{ label: "Dialogue performance", request: `Review the ${origin} for shot ${performance.target.shotId} in production ${production.meta.id}. Read its current performance review and selection. Prepare the existing dialogue placement action when its human review is complete.` }];
  const take = production.takes.find(t => t.id === result.id);
  if (take?.kind === "voice") return [{ label: "Dialogue cue", request: `Prepare an audio cue placement for voice take ${take.id}, the ${origin}, in production ${production.meta.id}. Read the current timeline and source duration, keep its dialogue role, and show the placement for review.` }];
  if (result.medium === "audio" && result.description === "Scene rehearsal") return [{ label: "Dialogue timing plan", request: `Use the ${origin} to prepare a dialogue timing plan in production ${production.meta.id}. Read the owning scene rehearsal and current performances, and show proposed changes for review.` }];
  return [];
}
