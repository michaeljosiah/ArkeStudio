import { type ProductionBundle } from "@arke-studio/contracts";
import { isVideoMedia, posterNameFor } from "./poster.js";
import { mediaTakeFor } from "./selectors.js";

/** A take's playable bytes and poster, resolved through a segment's backing pass when needed. */
export function takeMediaView(
  production: Pick<ProductionBundle, "meta" | "takes">,
  take: ProductionBundle["takes"][number],
): { sourcePath: string; posterPath: string; isVideo: boolean } | null {
  const mediaTake = mediaTakeFor(production, take);
  if (mediaTake === null) return null;
  const root = `productions/${production.meta.id}/takes/${mediaTake.id}`;
  return {
    sourcePath: `${root}/${mediaTake.media}`,
    posterPath: `${root}/${posterNameFor(mediaTake.media)}`,
    isVideo: isVideoMedia(mediaTake.media),
  };
}

/** A take's poster image, on the shared convention (lib/poster.ts). */
export function takeMediaPath(
  production: Pick<ProductionBundle, "meta" | "takes">,
  take: ProductionBundle["takes"][number],
): string | null {
  return takeMediaView(production, take)?.posterPath ?? null;
}

export function decisionTone(decision: string | undefined): "ok" | "warn" | "sketch" {
  if (decision === "accepted") return "ok";
  if (decision === "rejected") return "sketch";
  return "warn";
}
