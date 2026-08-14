import type { ManifestModel, ResolvedArtDirection, SizeTier, WorldMeta } from "@arke-studio/contracts";
import { estimateMicroUsd, imageConstraintSuffix, imageOutputFor } from "@arke-studio/contracts";

/**
 * The world look as a picture, from the world look as words.
 *
 * The record has carried a `masterLook` path since SPEC-017 — history keeps one per version, the
 * reach counts it, the gate diffs it, the review names it — and nothing in the app could ever put
 * one there. It could only arrive by hand-editing the JSON, which made a documented feature of a
 * screen that explains how a master look travels into a fact about a text editor.
 *
 * No art-director rewrite here, unlike key art: the look is the description the author wrote and
 * every generation already receives, and asking a model to embellish it first would mean the
 * picture of the look and the look itself were written from different words. What the author may
 * do is say something else for one image — the words in the dialog are theirs, not a model's — and
 * the safety clause below is added to whatever they send.
 */

/** Where a candidate waits for a yes. One at a time: generating or uploading again replaces it. */
export const MASTER_LOOK_DIR = "incoming/master-look";
export const MASTER_LOOK_CANDIDATE = "candidate.png";

/** Where an image staged for the next generation waits. Also one at a time, for the same reason. */
export const MASTER_LOOK_REFERENCE_DIR = "incoming/master-look-ref";

/** Accepted master looks live beside the record that names them, one per look version. */
export const MASTER_LOOK_DIR_ACCEPTED = "art-direction";
export function masterLookFile(version: number, extension: string): string {
  return `${MASTER_LOOK_DIR_ACCEPTED}/look-v${version}${extension}`;
}

export function masterLookPrompt(direction: ResolvedArtDirection, override?: string | undefined): string {
  const words = override?.trim();
  return [
    words !== undefined && words !== "" ? words : direction.description,
    /*
     * The screen's own safety rule, made true in the request rather than only explained to the
     * reader: "a master look is carried for its treatment, never its subject — a face here can
     * arrive in other characters' work". This image is the one asset that rides along with
     * somebody else's portrait, so the one thing it must not contain is a person.
     */
    "A single reference frame establishing this look and nothing else — palette, light, material," +
      " atmosphere and surface. No people, no faces, no text, no logos, no captions, no grid or" +
      " montage.",
  ].join(" ");
}

/** The job, shaped like every other image job so the queue treats it like every other one. */
export function masterLookRequest(
  meta: WorldMeta,
  model: ManifestModel,
  direction: ResolvedArtDirection,
  options: {
    /** The author's words for this one image, or absent to send the look's own. */
    prompt?: string | undefined;
    /** World-relative images to send along, already filtered to what this model can take. */
    references?: readonly string[] | undefined;
    /** The chosen size, or absent for the provider's default. */
    tier?: SizeTier | undefined;
    /** The chosen shape. One the model does not offer is dropped, not sent. */
    aspect?: string | undefined;
  } = {},
) {
  const references = options.references ?? [];
  /*
   * A real output spec, where this job used to send none at all.
   *
   * Landscape by default because a master look is a plate — a palette, a light, a place — and
   * everything downstream lays it beside other landscape work. The estimate is computed from
   * these dimensions rather than the flat 1MP it used to assume, so the figure moves with the
   * two controls above it instead of contradicting them.
   */
  const output = imageOutputFor(model, {
    landscape: true,
    ...(options.tier !== undefined ? { tier: options.tier } : {}),
    ...(options.aspect !== undefined ? { aspect: options.aspect } : {}),
  });
  return {
    worldId: meta.worldId,
    target: { kind: "master-look", id: meta.worldId },
    capability: "image" as const,
    provider: model.provider,
    model: model.id,
    params: {
      prompt: `${masterLookPrompt(direction, options.prompt)}${imageConstraintSuffix(direction)}`,
      output,
      // Recorded as riding the world look at the version that asked for it, like any other
      // generation — this one happens to be a picture *of* that version.
      artDirection: { version: direction.version, source: "world", transport: "text" },
      ...(references.length > 0 ? { references: [...references] } : {}),
    },
    estimatedMicroUsd: estimateMicroUsd(model, {
      images: 1,
      megapixels: (output.width * output.height) / 1_000_000,
      referenceImages: references.length,
      ...(output.resolution !== undefined ? { resolution: output.resolution } : {}),
    }),
    landing: { dir: MASTER_LOOK_DIR, name: MASTER_LOOK_CANDIDATE },
  };
}
