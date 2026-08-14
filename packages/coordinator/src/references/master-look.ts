import type { ManifestModel, ResolvedArtDirection, WorldMeta } from "@arke-studio/contracts";
import { estimateMicroUsd, imageConstraintSuffix } from "@arke-studio/contracts";

/**
 * The world look as a picture, from the world look as words.
 *
 * The record has carried a `masterLook` path since SPEC-017 — history keeps one per version, the
 * reach counts it, the gate diffs it, the review names it — and nothing in the app could ever put
 * one there. It could only arrive by hand-editing the JSON, which made a documented feature of a
 * screen that explains how a master look travels into a fact about a text editor.
 *
 * There is no second prompt here on purpose. The look is the description the author wrote and
 * every generation already receives; asking a model to embellish it first would mean the picture
 * of the look and the look itself were written from different words.
 */

/** Where a candidate waits for a yes. One at a time: generating or uploading again replaces it. */
export const MASTER_LOOK_DIR = "incoming/master-look";
export const MASTER_LOOK_CANDIDATE = "candidate.png";

/** Accepted master looks live beside the record that names them, one per look version. */
export const MASTER_LOOK_DIR_ACCEPTED = "art-direction";
export function masterLookFile(version: number, extension: string): string {
  return `${MASTER_LOOK_DIR_ACCEPTED}/look-v${version}${extension}`;
}

export function masterLookPrompt(direction: ResolvedArtDirection): string {
  return [
    direction.description,
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
export function masterLookRequest(meta: WorldMeta, model: ManifestModel, direction: ResolvedArtDirection) {
  return {
    worldId: meta.worldId,
    target: { kind: "master-look", id: meta.worldId },
    capability: "image" as const,
    provider: model.provider,
    model: model.id,
    params: {
      prompt: `${masterLookPrompt(direction)}${imageConstraintSuffix(direction)}`,
      // Recorded as riding the world look at the version that asked for it, like any other
      // generation — this one happens to be a picture *of* that version.
      artDirection: { version: direction.version, source: "world", transport: "text" },
    },
    estimatedMicroUsd: estimateMicroUsd(model, { images: 1, megapixels: 1, referenceImages: 0 }),
    landing: { dir: MASTER_LOOK_DIR, name: MASTER_LOOK_CANDIDATE },
  };
}
