import type { ManifestModel, ResolvedArtDirection, WorldMeta } from "@arke-studio/contracts";
import { estimateMicroUsd, imageConstraintSuffix, worldImagePrompt } from "@arke-studio/contracts";

/*
 * The prompt itself moved into contracts (design 64), because the art-direction page opens its
 * box with it and a second copy on the client would drift from this one. Re-exported here so
 * every caller and every test that already knew where to find it still does.
 */
export { worldImagePrompt };

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

/**
 * Whose words a key-art generation carries, in the order that outranks (design 64).
 *
 * Three sources, and the precedence is the whole rule: an author who opened the box and changed
 * it has decided what this picture is, so neither the art director nor the composition may write
 * over them; a director's prompt is a rewrite *of* the world's brief and so keeps the look's
 * description in front of it; and with neither, the composition stands as built.
 *
 * Extracted from the coordinator's switch because the precedence is the part worth asserting and
 * it was three string templates deep inside a case, where nothing could reach it.
 */
export function keyArtPrompt(input: {
  /** What `worldImageRequest` built, suffix already included — the floor. */
  composed: string;
  /** The look's own description, which a rewritten prompt is a rewrite of. */
  description: string;
  /** The standing constraint clause, which no branch may drop. */
  suffix: string;
  /** The author's words, when they wrote any. */
  authored?: string | undefined;
  /** The art director's, when the harness was ready and answered. */
  directed?: string | null;
}): string {
  if (input.authored !== undefined) return `${input.authored}${input.suffix}`;
  if (input.directed) return `${input.description}. ${input.directed}${input.suffix}`;
  return input.composed;
}

/**
 * Where the nth candidate of a set lands (design 65).
 *
 * Named by candidate, because four jobs that all land on one name are four charges and one file
 * — the exact shape of "generate looks does not work", which is why the character candidates
 * have been numbered since. A set of one keeps the historical `candidate.png` so a world made
 * before the count reads back byte-identical.
 */
export function worldImageCandidateName(index: number, count: number): string {
  return count === 1 ? WORLD_IMAGE_CANDIDATE : `candidate-${index + 1}.png`;
}

/** The job, shaped like every other image job so the queue treats it like every other one. */
export function worldImageRequest(
  meta: WorldMeta,
  model: ManifestModel,
  direction?: ResolvedArtDirection,
  /** Which of the set this is, and how many there are. One, unless the author asked for more. */
  slot: { index: number; count: number } = { index: 0, count: 1 },
) {
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
    landing: { dir: WORLD_IMAGE_DIR, name: worldImageCandidateName(slot.index, slot.count) },
  };
}
