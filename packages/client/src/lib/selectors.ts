import { useEffect } from "react";
import type { ProductionBundle, Sheet, WorldBundle } from "@arke-studio/contracts";
import { openWorld, useStore, useWorld } from "./store.js";
import type { TakeDecision } from "../domain/domain.js";

export type PendingEpisode = { id: string; title: string; order: number | null };

/**
 * Episodes staged in a proposal but not yet accepted (turn 92): a wrap-up writes one of these
 * before it is an episode on disk, so anything computing the next free order has to include it
 * too, or two paths can hand out the same order to two different episodes (issue 947).
 */
export function pendingEpisodes(
  world: WorldBundle | null,
  prodId: string | undefined,
  production: ProductionBundle | null,
): PendingEpisode[] {
  const stems = new Set(Object.values(production?.episodeFiles ?? {}));
  const prefix = `productions/${prodId}/episodes/`;
  return (world?.proposals ?? []).flatMap((sp) =>
    sp.proposal.targets.flatMap((t) => {
      // Prefix and suffix rather than a built pattern: a production id interpolated into a
      // regular expression is a pattern the caller did not write, and `\.` inside a template
      // literal is just a dot, so the escape that looked like it was there never was.
      if (!t.path.startsWith(prefix) || !t.path.endsWith(".json")) return [];
      const stem = t.path.slice(prefix.length, -".json".length);
      if (stem.length === 0 || stem.includes("/") || stems.has(stem)) return [];
      // The gate labels its review fields for reading — "Title", "Order" — so they are matched
      // case-insensitively rather than by the record's own key names.
      const fields = sp.review?.targets.flatMap((rt) => rt.fields) ?? [];
      const field = (name: string) => fields.find((f) => f.field.toLowerCase() === name)?.proposed;
      const title = field("title") ?? sp.proposal.summary;
      const order = Number(field("order") ?? Number.NaN);
      return [{ id: sp.proposal.id, title, order: Number.isFinite(order) ? order : null }];
    }),
  );
}

/** The next free episode order, counting both written episodes and ones staged but not yet accepted. */
export function nextEpisodeOrder(
  world: WorldBundle | null,
  prodId: string | undefined,
  production: ProductionBundle | null,
): number {
  const episodes = production?.episodes ?? [];
  return Math.max(0, ...episodes.map((e) => e.order), ...pendingEpisodes(world, prodId, production).map((e) => e.order ?? 0)) + 1;
}

/** Ask the coordinator for the routed world whenever the open one differs. */
export function useOpenWorldGuard(worldId: string | undefined): WorldBundle | null {
  const { connection } = useStore();
  const world = useWorld();
  useEffect(() => {
    if (!worldId || connection !== "open") return;
    if (world?.meta.worldId !== worldId) openWorld(worldId);
  }, [worldId, connection, world?.meta.worldId]);
  return world && world.meta.worldId === worldId ? world : null;
}

export function useSheet(worldId: string | undefined, sheetId: string | undefined): Sheet | null {
  const world = useOpenWorldGuard(worldId);
  return world?.sheets.find((s) => s.id === sheetId) ?? null;
}

export function useProduction(
  worldId: string | undefined,
  productionId: string | undefined,
): { world: WorldBundle | null; production: ProductionBundle | null } {
  const world = useOpenWorldGuard(worldId);
  return {
    world,
    production: world?.productions.find((p) => p.meta.id === productionId) ?? null,
  };
}

/** Latest review decision per take — later reviews.jsonl lines win (§2.3.6). */
export function takeDecisions(production: ProductionBundle): Record<string, TakeDecision> {
  const map: Record<string, TakeDecision> = {};
  for (const take of production.takes) map[take.id] = "pending";
  for (const review of production.reviews) {
    map[review.takeId] = review.decision === "accept" ? "accepted" : "rejected";
  }
  return map;
}

export function takesForShot(production: ProductionBundle, shotId: string) {
  return production.takes.filter(
    (take) =>
      take.boardSheetParent !== true &&
      !(take.kind === "clip" && take.segment === undefined && take.coversShots.length > 1) &&
      take.coversShots.includes(shotId),
  );
}

/** The take that owns the bytes for a selectable take; pass segments own only a time range. */
export function mediaTakeFor(
  production: Pick<ProductionBundle, "takes">,
  take: ProductionBundle["takes"][number],
): (ProductionBundle["takes"][number] & { media: string }) | null {
  const passTakeId = take.segment?.passTakeId;
  const mediaTake = passTakeId === undefined
    ? take
    : production.takes.find((candidate) => candidate.id === passTakeId);
  return mediaTake?.media === undefined
    ? null
    : mediaTake as ProductionBundle["takes"][number] & { media: string };
}

export function acceptedTakeId(production: ProductionBundle, shotId: string): string | null {
  const accepted = production.selections[shotId]?.acceptedTakeId ?? null;
  return accepted !== null && takesForShot(production, shotId).some((take) => take.id === accepted)
    ? accepted
    : null;
}

/** The day-one/established split the production dashboard renders (§8.2). */
export function isDayOne(production: ProductionBundle): boolean {
  /*
   * What makes a production started is anything the gate has written to it, which for an episodic
   * one is its season and its episodes long before it is ever a scene (turn 93). Counting scenes,
   * takes and chapters alone left a season with a question, an ending and three written episodes
   * still opening on "Nothing written yet" — offering to shape the thing that had just been
   * shaped, while the Season screen next door said 3 written.
   */
  return (
    production.scenes.length === 0 &&
    production.takes.length === 0 &&
    production.chapters.length === 0 &&
    production.episodes.length === 0 &&
    production.season?.question === undefined &&
    production.season?.ending === undefined
  );
}
