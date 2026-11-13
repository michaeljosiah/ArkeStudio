import { orderedShots, type ConversationActionCard, type ProductionBundle, type WorldChatContext } from "@arke-studio/contracts";

export type StudioFocus = { view: "production" | "scene" | "shot" | "board" | "stage" | "cut" | "understanding" | "proposal";
  sceneId?: string; shotId?: string; actionId?: string };

export function studioEntry(context: WorldChatContext): StudioFocus {
  if (context.kind === "scene") return { view: "scene", sceneId: context.sceneId };
  if (context.kind === "cut") return { view: "cut" };
  return { view: "production" };
}

/** Canvas targeting is presentation only; it never changes the conversation's authority context. */
export function studioActionFocus(action: ConversationActionCard, production: ProductionBundle | undefined, fallback: StudioFocus): StudioFocus {
  const preview = action.shown.productionPreview;
  const shotId = action.targets.find(t => t.kind === "shot")?.id;
  const sceneId = preview?.kind === "scene" ? preview.after.id : action.targets.find(t => t.kind === "scene")?.id ??
    production?.scenes.find(s => orderedShots(s).some(shot => shot.id === shotId))?.id ?? fallback.sceneId;
  const view = preview?.kind === "timeline" || preview?.kind === "export" || /timeline|cut-export|audio-cue|audio-edit/.test(action.actionKind) ? "cut"
    : /stage/.test(action.actionKind) ? "stage" : /board/.test(action.actionKind) ? "board" : shotId ? "shot" : sceneId ? "scene" : "production";
  return { view, sceneId, shotId, actionId: action.actionId };
}
