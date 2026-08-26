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
/**
 * Where the master look's staged reference used to live, on its own.
 *
 * Kept only so a world that has one staged right now does not lose it across the upgrade: the
 * scan reads this path into the `master-look` key, and nothing writes here any more.
 */
export const LEGACY_MASTER_LOOK_REFERENCE_DIR = "incoming/master-look-ref";

/** Where any surface's staged reference lives now (design 67). One directory, one image. */
export function stagedReferenceDir(key: string): string {
  return `incoming/staged-refs/${key}`;
}

/**
 * The staged reference for one surface, if this model can carry another image (design 67).
 *
 * `already` is what the surface is sending regardless — a character's identity anchor, a
 * location's establishing view. Those win: a main photo generated without the face it exists to
 * preserve is not the picture anybody asked for, whereas a staged reference that does not fit is
 * a preference that could not be honoured. The dialog says which was dropped rather than leaving
 * the difference to be discovered in the result.
 *
 * Sending it to a model that declares no reference slots would not be refused by the provider —
 * it would be quietly dropped, and the estimate would have charged for it.
 */
export function stagedFor(
  bundle: { stagedReferences: Record<string, string> },
  key: string,
  model: { accepts: { referenceImages: number }; unverified?: boolean },
  already: readonly string[] = [],
): string[] {
  const staged = bundle.stagedReferences[key];
  if (staged === undefined) return [...already];
  const budget = model.unverified === true ? 0 : model.accepts.referenceImages;
  return already.length < budget ? [...already, staged] : [...already];
}

/** Accepted master looks live beside the record that names them, one per look version. */
export const MASTER_LOOK_DIR_ACCEPTED = "art-direction";
export function masterLookFile(version: number, extension: string): string {
  return `${MASTER_LOOK_DIR_ACCEPTED}/look-v${version}${extension}`;
}

export function masterLookPrompt(
  direction: Pick<ResolvedArtDirection, "description">,
  override?: string | undefined,
): string {
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
    /** Which of the set this is, and how many there are (design 65). One, unless asked otherwise. */
    slot?: { index: number; count: number } | undefined;
  } = {},
) {
  const references = options.references ?? [];
  const slot = options.slot ?? { index: 0, count: 1 };
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
    landing: { dir: MASTER_LOOK_DIR, name: masterLookCandidateName(slot.index, slot.count) },
  };
}

/**
 * Where the nth candidate of a set lands (design 65). A set of one keeps the historical
 * `candidate.png`, so a world that generated one before the count reads back unchanged.
 */
export function masterLookCandidateName(index: number, count: number): string {
  return count === 1 ? MASTER_LOOK_CANDIDATE : `candidate-${index + 1}.png`;
}

// ---------------------------------------------------------------------------
// The founding look preview (SPEC-031 §1.10)
// ---------------------------------------------------------------------------

/** Where a genesis look preview waits in the sandbox (R-53). One at a time, like a candidate. */
export const LOOK_PREVIEW_DIR = "previews";
export const LOOK_PREVIEW_NAME = "look-preview.png";
/** The durable metadata beside it: the exact look text the image was generated from (R-53). */
export const LOOK_PREVIEW_META = "look-preview.json";

/**
 * The job for one picture of the look, before any world exists (R-50). Scoped to the
 * conversation (R-55) and landing in its sandbox; the prompt is the look's own words
 * unrewritten, with the subject-exclusion clause still appended (R-52) — this image may be
 * promoted to the master look at Begin, and a face in it would arrive in every character
 * the build makes.
 */
export function lookPreviewRequest(genesisId: string, look: string, model: ManifestModel) {
  const output = imageOutputFor(model, { landscape: true });
  return {
    worldId: genesisId,
    target: { kind: "look-preview", id: genesisId },
    capability: "image" as const,
    provider: model.provider,
    model: model.id,
    params: {
      prompt: `${masterLookPrompt({ description: look })}${imageConstraintSuffix(undefined)}`,
      /** What R-54's carry test reads against the founded look. */
      lookText: look,
      output,
    },
    estimatedMicroUsd: estimateMicroUsd(model, {
      images: 1,
      megapixels: (output.width * output.height) / 1_000_000,
      ...(output.resolution !== undefined ? { resolution: output.resolution } : {}),
    }),
    landing: { dir: LOOK_PREVIEW_DIR, name: LOOK_PREVIEW_NAME },
  };
}
