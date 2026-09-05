import { orderedShots, type WorldBundle, type WorldChatContext, type WorldChatSubject } from "@arke-studio/contracts";

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
  const production = bundle.productions.find((candidate) => candidate.meta.id === productionId);
  if (production === undefined) return false;
  if (subject.kind === "timeline-track" || subject.kind === "timeline-clip") {
    const state = production.timeline;
    if (state?.status !== "ready") return false;
    return subject.kind === "timeline-track"
      ? state.timeline.tracks.some((track) => track.id === subject.trackId)
      : state.timeline.tracks.some((track) => track.clips.some((clip) => clip.id === subject.clipId));
  }
  if (subject.kind === "take") return production.takes.some((take) => take.id === subject.takeId);
  const scene = production.scenes.find((candidate) => candidate.id === subject.sceneId);
  if (scene === undefined || (context.kind === "scene" && context.sceneId !== scene.id)) return false;
  if (subject.kind === "scene") return true;
  const hasShot = (shotId: string | null) => shotId === null || orderedShots(scene).some((shot) => shot.id === shotId);
  if (subject.kind === "shot") return hasShot(subject.shotId);
  if (subject.kind === "board") return subject.memberShotIds.every(hasShot);
  return (subject.fromShotId !== null || subject.toShotId !== null) &&
    hasShot(subject.fromShotId) && hasShot(subject.toShotId);
}
