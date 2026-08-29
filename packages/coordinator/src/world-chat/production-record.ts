import type { ProductionBundle, WorldBundle } from "@arke-studio/contracts";
import { orderedShots, productionShape } from "@arke-studio/contracts";

/**
 * One production, read whole (round 3, 2026-08-22).
 *
 * Found by driving: an episode thread asked for its season and got nothing back — the query
 * surface served canon and sheets and nothing production-shaped, so the model was briefed on
 * the season's numbers and blind to its direction, and said so out loud. This is the read both
 * query surfaces serve now: the story, the whole season including the direction the wrap-up
 * wrote, the episodes with their promises and memberships, and the scene index.
 *
 * Context, not evidence: production records carry no observation a citation could be verified
 * against (evidence.ts refuses them by design), so nothing here mints quotable text — it is
 * the thing the thread is about, handed over instead of narrated.
 */
export function productionRecord(bundle: WorldBundle, productionId: string): Record<string, unknown> | null {
  const production: ProductionBundle | undefined = bundle.productions.find((p) => p.meta.id === productionId);
  if (!production) return null;
  const shape = productionShape(production.meta);
  return {
    id: production.meta.id,
    title: production.meta.title,
    medium: shape.medium,
    kind: shape.kind,
    ...(production.meta.aspect !== undefined ? { aspect: production.meta.aspect } : {}),
    story: production.story,
    season: production.season,
    episodes: production.episodes.map((e) => ({
      id: e.id,
      order: e.order,
      title: e.title,
      ...(e.promise !== undefined ? { promise: e.promise } : {}),
      scenes: e.scenes,
    })),
    scenes: production.scenes.map((s) => ({
      id: s.id,
      number: s.number,
      title: s.title,
      ...(s.synopsis !== undefined ? { synopsis: s.synopsis } : {}),
      shots: orderedShots(s).length,
    })),
  };
}
