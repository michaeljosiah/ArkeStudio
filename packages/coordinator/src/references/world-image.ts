import type { ManifestModel, WorldMeta } from "@arke-studio/contracts";
import { estimateMicroUsd } from "@arke-studio/contracts";

/**
 * The world's key image, from what the world already says about itself.
 *
 * The button promised this from the start — "title · logline · tone ride along · comes back as
 * a take" — and did nothing at all for months. There is no clever prompt here on purpose: the
 * logline is the author's sentence and it goes in as written. Adding adjectives of our own
 * would put the studio's taste in front of theirs.
 */

/** Where a generated candidate waits for a yes. One at a time: generating again replaces it. */
export const WORLD_IMAGE_DIR = "incoming/world-image";
export const WORLD_IMAGE_CANDIDATE = "candidate.png";
export const WORLD_IMAGE_FILE = "world-art.png";

export function worldImagePrompt(meta: WorldMeta): string {
  const parts = [
    `Key art for "${meta.name}"`,
    meta.logline?.trim(),
    meta.tone?.trim() ? `Tone: ${meta.tone.trim()}.` : undefined,
    meta.genre?.trim() ? `Genre: ${meta.genre.trim()}.` : undefined,
    // No people: a world image that leads with a face competes with the character sheets,
    // and the sheets are where a face is decided.
    "A single evocative establishing image of the place and its atmosphere. No text, no logos, no character portraits.",
  ];
  return parts.filter((p): p is string => typeof p === "string" && p.length > 0).join(" ");
}

/** The job, shaped like every other image job so the queue treats it like every other one. */
export function worldImageRequest(meta: WorldMeta, model: ManifestModel) {
  const estimatedMicroUsd = estimateMicroUsd(model, { images: 1, megapixels: 1 });
  return {
    worldId: meta.worldId,
    target: { kind: "world-image", id: meta.worldId },
    capability: "image" as const,
    provider: model.provider,
    model: model.id,
    params: { prompt: worldImagePrompt(meta), references: [] as string[] },
    estimatedMicroUsd,
    landing: { dir: WORLD_IMAGE_DIR, name: WORLD_IMAGE_CANDIDATE },
  };
}
