import { useEffect } from "react";
import type { ProductionBundle, Sheet, WorldBundle } from "@arke-studio/contracts";
import { openWorld, useStore, useWorld } from "./store.js";
import type { TakeDecision } from "../domain/domain.js";

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
  return production.takes.filter((t) => t.boardSheetParent !== true && t.coversShots.includes(shotId));
}

export function acceptedTakeId(production: ProductionBundle, shotId: string): string | null {
  return production.selections[shotId]?.acceptedTakeId ?? null;
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
