import { productionShape, productionFrameRate, sceneCommandBatchCandidate,
  type Production, type ProductionCardPreview, type WorldBundle, type WorldChatPreparedAction } from "@arke-studio/contracts";
import { sceneActionCommands } from "./action-sequencing.js";
import { sceneCommandFrom } from "../productions/scene-commands.js";

/** Renderable records come from the same frozen candidate the authority will execute. */
export function productionCardPreview(world: WorldBundle, payload: WorldChatPreparedAction): ProductionCardPreview | undefined {
  if (payload.kind === "world-chat-production-create") {
    const plan = payload.plan;
    return metadataPreview(world, plan.production, plan.series.operation === "none" ? null : plan.series.record.title,
      plan.initialSeason ? "Season" : null, plan.initialContent?.episodes.length ?? plan.initialSeason?.defaults?.episodeCount ?? 0);
  }
  if (payload.kind === "world-chat-production-metadata") {
    const current = world.productions.find(p => p.meta.id === payload.action.productionId);
    if (!current) throw new Error("The production preview is unavailable.");
    const changes = payload.action.changes;
    const meta = { ...current.meta, ...changes, ...(changes.productionKind !== undefined ? { kind: changes.productionKind ?? undefined } : {}) };
    const series = changes.seriesId === undefined ? world.series.find(s => s.seasons.includes(meta.id)) : world.series.find(s => s.id === changes.seriesId);
    return metadataPreview(world, meta, series?.title ?? null, current.season ? "Season" : null, current.episodes.length);
  }
  if (payload.kind === "world-chat-production-scene-command") {
    const before = payload.scenePlan?.before ?? world.productions.find(p => p.meta.id === payload.action.productionId)?.scenes.find(s => s.id === payload.action.sceneId);
    if (!before) throw new Error("The scene preview is unavailable.");
    const after = payload.scenePlan?.after ?? sceneCommandBatchCandidate(world, payload.action.productionId, before,
      sceneActionCommands(payload.action).map(sceneCommandFrom));
    return { kind: "scene", before, after };
  }
  return undefined;
}

function metadataPreview(world: WorldBundle, meta: Production, series: string | null, season: string | null, episodes: number): ProductionCardPreview {
  const shape = productionShape(meta);
  return { kind: "production", title: meta.title, medium: shape.medium, productionKind: shape.kind,
    aspect: meta.aspect ?? "16:9", frameRate: productionFrameRate(meta), series, season, episodes,
    style: meta.styleOverride ?? world.artDirection?.description ?? null, model: meta.models?.llm ?? null };
}
