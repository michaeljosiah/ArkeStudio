import type { ManifestModel, ResolvedArtDirection, WorldMeta } from "@arke-studio/contracts";
import { estimateMicroUsd, imageConstraintSuffix } from "@arke-studio/contracts";

/**
 * The world's key image, from what the world already says about itself.
 *
 * The button promised this from the start — "title · logline · tone ride along · comes back as
 * a take" — and did nothing at all for months. There is no clever prompt here on purpose: the
 * logline is the author's sentence and it goes in as written. Adding adjectives of our own
 * would put the studio's taste in front of theirs.
 */

/** Where a candidate waits for a yes. One at a time: generating or uploading again replaces it. */
export const WORLD_IMAGE_DIR = "incoming/world-image";
export const WORLD_IMAGE_CANDIDATE = "candidate.png";
/**
 * The accepted key art, without its extension.
 *
 * `world-art.png` remains what a generated one is called, and what worlds made before uploads
 * existed still hold. An uploaded image keeps the format its bytes carry instead, so the name
 * is a stem and the bundle carries the path — nothing may assume the extension any more.
 */
export const WORLD_IMAGE_STEM = "world-art";
export const KEY_ART_EXTENSIONS = [".png", ".jpg", ".jpeg", ".webp"] as const;

export function worldImagePrompt(meta: WorldMeta, direction?: ResolvedArtDirection): string {
  const parts = [
    `Key art for "${meta.name}"`,
    direction?.description,
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
export function worldImageRequest(meta: WorldMeta, model: ManifestModel, direction?: ResolvedArtDirection) {
  const estimatedMicroUsd = estimateMicroUsd(model, { images: 1, megapixels: 1, referenceImages: 0 });
  return {
    worldId: meta.worldId,
    target: { kind: "world-image", id: meta.worldId },
    capability: "image" as const,
    provider: model.provider,
    model: model.id,
    // No references: a world has no reference kit. Sending an empty list would be a field the
    // provider has to know to ignore, and OpenAI does not — it answers unknown fields with 400.
    params: {
      prompt: `${worldImagePrompt(meta, direction)}${imageConstraintSuffix(direction)}`,
      ...(direction
        ? {
            artDirection: {
              version: direction.version,
              source: "world",
              transport: "text",
            },
          }
        : {}),
    },
    estimatedMicroUsd,
    landing: { dir: WORLD_IMAGE_DIR, name: WORLD_IMAGE_CANDIDATE },
  };
}
