import type { ConversationActionCard, Job, LedgerEntry, WorldBundle } from "@arke-studio/contracts";
import { takeMediaView } from "./take-presentation.js";
import { orderedShots } from "@arke-studio/contracts";

type Result = NonNullable<NonNullable<ConversationActionCard["receipt"]>["generation"]>["results"][number] & {
  shotIds: string[]; segment?: { inSec: number; outSec: number; passTakeId: string };
};

/** Live presentation is a fold of the queue and immutable landed records, never a card counter. */
export function generationCardView(action: ConversationActionCard, world: WorldBundle, jobs: readonly Job[], ledger: readonly LedgerEntry[] = []) {
  if (world.meta.worldId !== action.worldId) return { jobs: [], results: [] as Result[], authorized: 0, completed: 0, failed: 0, cancelled: 0, actualMicroUsd: null };
  const keys = new Set(action.generationWork?.jobKeys ?? []);
  const owned = jobs.filter(job => world.meta.worldId === action.worldId && job.worldId === action.worldId && keys.has(job.idempotencyKey));
  const completed = owned.filter(job => job.status === "succeeded" && (!job.finalization || job.finalization.status === "complete"));
  const production = world.meta.worldId === action.worldId ? world.productions.find(p => p.meta.id === action.productionId) : undefined;
  const results = owned.flatMap<Result>(job => {
    if (!completed.includes(job)) return [];
    const takes = production?.takes.filter(t => t.jobId === job.id && !t.boardSheetParent && (t.coversShots.length || t.kind === "voice")) ?? [];
    const productionResults = takes.flatMap(take => {
      const view = production && takeMediaView(production, take);
      const shot = production?.scenes.flatMap(scene => orderedShots(scene)).find(shot => take.coversShots.includes(shot.id));
      return view ? [{ id: take.id, medium: take.kind === "voice" ? "audio" as const : view.isVideo ? "video" as const : "image" as const,
        status: "completed" as const, description: `${shot ? `Shot ${shot.number}` : take.kind} · ${take.model}`, mediaPath: view.sourcePath, posterPath: view.posterPath,
        shotIds: take.kind === "voice" ? [] : take.coversShots, segment: take.segment }] : [];
    });
    if (productionResults.length) return productionResults;
    const take = world.meta.worldId === action.worldId ? world.referenceTakes.find(t => t.jobId === job.id) : undefined;
    const owner = take?.reference?.sheetId ?? take?.prop?.propId;
    if (take?.media && owner) return [{ id: take.id, medium: "image" as const, status: "completed" as const,
      description: `${take.kind} · ${owner}`, mediaPath: `references/${owner}/takes/${take.id}/${take.media}`, posterPath: undefined,
      shotIds: [] as string[], segment: undefined }];
    const receipt = action.receipt?.generation?.results.find(result => result.status === "completed" && result.id === job.target.id);
    return receipt?.mediaPath ? [{ ...receipt, posterPath: receipt.posterPath, shotIds: [] as string[], segment: undefined }] : [];
  });
  const costs = owned.map(job => job.providerCostMicroUsd ?? ledger.find(entry => entry.jobId === job.id && entry.worldId === action.worldId)?.actualMicroUsd ?? null);
  // Terminal receipts retain playable results even after Activity hides the corresponding jobs.
  for (const result of [...action.generationWork?.results ?? [], ...action.receipt?.generation?.results ?? []]) {
    if (results.some(value => value.id === result.id)) continue;
    const take = production?.takes.find(t => t.id === result.id);
    results.push({ ...result, shotIds: take?.kind === "voice" ? [] : take?.coversShots ?? [], segment: take?.segment });
  }
  return { jobs: owned, results, authorized: action.generationWork?.jobKeys.length ?? action.receipt?.generation?.authorized ?? 0,
    completed: completed.length, failed: owned.filter(job => job.status === "failed" || job.finalization?.status === "failed").length,
    cancelled: owned.filter(job => job.status === "cancelled").length,
    actualMicroUsd: costs.length && costs.every(cost => cost !== null) ? costs.reduce<number>((sum, cost) => sum + cost!, 0) : action.receipt?.generation?.actualMicroUsd ?? null };
}
