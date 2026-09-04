import type { WorldBundle, WorldChatContext, WorldChatSubject } from "@arke-studio/contracts";

/** Resolve a conversation's semantic entry point against the world it claims to describe. */
export function worldChatContextExists(bundle: WorldBundle, context: WorldChatContext): boolean {
  switch (context.kind) {
    case "world":
      return true;
    case "canon-question":
      return context.candidateEntryIds.every((id) => bundle.canon.some((entry) => entry.id === id));
    case "canon-entry":
      return bundle.canon.some((entry) => entry.id === context.entryId);
    case "sheet":
      return bundle.sheets.some((sheet) => sheet.id === context.sheetId && sheet.type === context.sheetKind);
    case "attachment":
      // A new conversation cannot already own a private attachment. Existing conversations resolve
      // this arm against their folded attachment list because the world bundle cannot see it.
      return false;
    case "production":
      return bundle.productions.some((production) => production.meta.id === context.productionId);
    case "episode":
      return bundle.productions.some((production) =>
        production.meta.id === context.productionId &&
        production.episodes.some((episode) => episode.id === context.episodeId));
    case "scene":
      return bundle.productions.some((production) =>
        production.meta.id === context.productionId &&
        production.scenes.some((scene) => scene.id === context.sceneId));
  }
}

/** A renderer selection is context only after its id resolves in that conversation's production. */
export function worldChatSubjectExists(
  bundle: WorldBundle,
  context: WorldChatContext,
  subject: WorldChatSubject,
): boolean {
  const productionId = context.kind === "production" || context.kind === "episode" || context.kind === "scene"
    ? context.productionId
    : null;
  if (productionId === null) return false;
  const state = bundle.productions.find((production) => production.meta.id === productionId)?.timeline;
  if (state?.status !== "ready") return false;
  return subject.kind === "timeline-track"
    ? state.timeline.tracks.some((track) => track.id === subject.trackId)
    : state.timeline.tracks.some((track) => track.clips.some((clip) => clip.id === subject.clipId));
}
