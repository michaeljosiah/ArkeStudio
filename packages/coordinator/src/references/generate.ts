import {
  characterImageEstimateIsUsable,
  characterImageOutput,
  estimateCharacterImageMicroUsd,
  headGate,
  lockedTiles,
  modelForCapability,
  nativeResolution,
  type AppSettings,
  type ManifestModel,
  type ModelManifest,
  type ReferenceAngle,
  type ReferenceKit,
  type ResolvedArtDirection,
  type SizeTier,
  type Sheet,
  type WorldMeta,
} from "@arke-studio/contracts";
import type { EnqueueInput } from "../queue/dispatcher.js";

/**
 * Tile-generation request assembly (SPEC-010 T-3, T-4, T-6): the establish flow, the
 * reference loop (anchor + locked tiles ride with every subsequent generation, R-6), and the
 * head-before-body gate (R-7). SPEC-012 owns shot prompts; this is the kit's own path.
 */

const ANGLE_PROMPT: Record<ReferenceAngle, string> = {
  "head-front": "head and shoulders, facing camera directly, neutral expression",
  "head-left-three-quarter": "head and shoulders, left three-quarter view, neutral expression",
  "head-right-three-quarter": "head and shoulders, right three-quarter view, neutral expression",
  "head-profile": "head and shoulders, full profile view, neutral expression",
  "body-full": "full body, standing, front view, arms relaxed",
  "body-back": "full body, standing, back view",
  detail: "costume and prop detail study",
  expression: "expression study",
};

/** The style line: the world's art direction unless the sheet overrides it (R-16, D12). */
export function styleLine(world: WorldMeta, kit: ReferenceKit | null): string {
  if (kit?.styleOverride) return kit.styleOverride;
  return [world.tone, world.genre]
    .filter((s): s is string => typeof s === "string" && s.length > 0)
    .join(", ");
}

function sheetDescription(sheet: Sheet): string {
  const essence = sheet.sections.find((s) => s.heading === "Essence" || s.heading === "Look")?.body ?? "";
  const appearance = sheet.sections.find((s) => s.heading === "Appearance")?.body ?? "";
  return [essence, appearance]
    .filter((s) => s.trim().length > 0)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

export interface TileRequest {
  input: EnqueueInput;
  angle: ReferenceAngle;
  estimatedMicroUsd: number;
}

/** One tile dispatch: prompt from the sheet, references from the locked set (R-6, D1). */
export function tileRequest(
  world: WorldMeta,
  sheet: Sheet,
  kit: ReferenceKit | null,
  model: ManifestModel,
  angle: ReferenceAngle,
): TileRequest {
  const references: string[] = [];
  if (kit) {
    // The anchor first, then other locked tiles, up to the model's budget (R-6, R-15).
    const locked = lockedTiles(kit);
    const anchor = kit.anchor !== undefined ? locked.find((t) => t.file === kit.anchor) : undefined;
    const rest = locked.filter((t) => t !== anchor);
    for (const tile of [anchor, ...rest]) {
      if (!tile?.file) continue;
      if (references.length >= model.accepts.referenceImages) break;
      references.push(`references/${sheet.id}/${tile.file}`);
    }
  }
  const estimated = pricedCharacterImage(model, "reference-tile", references.length);
  return {
    angle,
    estimatedMicroUsd: estimated,
    input: {
      worldId: world.worldId,
      target: { kind: "reference-tile", id: `${sheet.id}/${angle}` },
      capability: "image",
      provider: model.provider,
      model: model.id,
      params: {
        prompt: `${styleLine(world, kit)}. ${sheet.name} — ${sheetDescription(sheet)}. ${ANGLE_PROMPT[angle]}, character reference sheet tile.`,
        references,
        output: characterImageOutput(model, "reference-tile"),
      },
      estimatedMicroUsd: estimated,
      // Named by angle. Without a name every job lands the provider's own "image-1.png" into
      // the same directory, so a turnaround of six angles arrives as one file that each job
      // overwrote in turn.
      landing: { dir: `references/${sheet.id}/incoming`, name: `${angle}.png` },
    },
  };
}

/** The establish flow (R-5): N candidates from text and style alone — no references exist yet. */
export function establishRequests(
  world: WorldMeta,
  sheet: Sheet,
  kit: ReferenceKit | null,
  model: ManifestModel,
  count: number,
  direction?: ResolvedArtDirection,
): TileRequest[] {
  const estimated = pricedCharacterImage(model, "reference-tile");
  const style = kit?.styleOverride ?? direction?.description ?? styleLine(world, kit);
  return Array.from({ length: count }, (_, i) => ({
    angle: "head-front" as const,
    estimatedMicroUsd: estimated,
    input: {
      worldId: world.worldId,
      target: { kind: "establish-candidate", id: `${sheet.id}/${i + 1}` },
      capability: "image",
      provider: model.provider,
      model: model.id,
      params: {
        prompt: `${style}. ${sheet.name} — ${sheetDescription(sheet)}. ${ANGLE_PROMPT["head-front"]}, character reference, candidate ${i + 1} of ${count}, distinct interpretation.`,
        references: [],
        output: characterImageOutput(model, "reference-tile"),
        ...(direction ? { provenance: generationProvenance(world, direction, sheet) } : {}),
        ...(direction
          ? {
              artDirection: {
                version: direction.version,
                source: kit?.styleOverride ? "sheet" : "world",
                transport: "text",
              },
            }
          : {}),
      },
      estimatedMicroUsd: estimated,
      // Named by candidate. Four candidates asked for, four jobs dispatched, four charges on
      // the account — and one file, because they all landed as "image-1.png" on top of each
      // other. That is what "generate looks does not work" looked like.
      landing: { dir: `references/${sheet.id}/candidates`, name: `candidate-${i + 1}.png` },
    },
  }));
}

export interface CharacterGenerationRequest {
  input: EnqueueInput;
  estimatedMicroUsd: number;
}

function pricedCharacterImage(
  model: ManifestModel,
  workflow: "main-photo" | "character-sheet" | "character-look" | "reference-tile",
  referenceImages = 0,
  tier?: SizeTier,
): number {
  const estimate = estimateCharacterImageMicroUsd(model, workflow, 1, referenceImages, tier);
  if (!characterImageEstimateIsUsable(model, estimate)) {
    throw new Error(`${model.displayName} could not be priced for the selected output size`);
  }
  return estimate;
}

function generationProvenance(
  world: WorldMeta,
  direction: ResolvedArtDirection,
  sheet: Sheet,
  anchorFile?: string,
) {
  return {
    canonRevision: world.canonRevision,
    sheets: { [sheet.id]: sheet.version },
    artDirectionVersion: direction.version,
    ...(anchorFile ? { anchorFile } : {}),
  };
}

export function mainPhotoRequests(
  world: WorldMeta,
  direction: ResolvedArtDirection,
  sheet: Sheet,
  kit: ReferenceKit | null,
  model: ManifestModel,
  input: {
    prompt: string;
    count: number;
    identityReferences: string[];
    generationKey: string;
    tier?: SizeTier;
  },
): CharacterGenerationRequest[] {
  const budget = referenceBudgetFor(model);
  if (input.identityReferences.length > 0 && budget === 0) {
    throw new Error(`${model.displayName} cannot receive identity reference images`);
  }
  const style = kit?.styleOverride ?? direction.description;
  const identityReferences = input.identityReferences.slice(0, budget);
  const tier = tierFor(model, input.tier);
  const estimatedMicroUsd = pricedCharacterImage(model, "main-photo", identityReferences.length, tier);
  // N previews are N jobs, not one job asking for N images, and that is the choice rather than
  // an oversight (#138). Every fal route takes num_images up to 4, so one request would work —
  // but a failure would then take all four candidates with it, a retry would re-spend on the
  // three that arrived, and the queue would show one row for four charges. Per-image pricing is
  // identical either way, so the only thing the fan-out costs is request count.
  return Array.from({ length: input.count }, (_, index) => ({
    estimatedMicroUsd,
    input: {
      worldId: world.worldId,
      target: { kind: "main-photo-candidate", id: `${sheet.id}/${input.generationKey}/${index + 1}` },
      capability: "image",
      provider: model.provider,
      model: model.id,
      params: {
        prompt: `${style}. ${sheet.name} — ${sheetDescription(sheet)}. ${input.prompt}. Head-and-shoulders identity portrait, face and physical identity clear, restrained neutral expression, no text or montage.`,
        references: identityReferences,
        referenceRoles: identityReferences.map((file) => ({ file, role: "identity" })),
        output: characterImageOutput(model, "main-photo", tier),
        artDirection: {
          version: direction.version,
          source: kit?.styleOverride ? "sheet" : "world",
          transport: "text",
        },
        provenance: generationProvenance(world, direction, sheet),
      },
      estimatedMicroUsd,
      landing: {
        dir: `references/${sheet.id}/candidates`,
        name: `main-photo-${input.generationKey}-${index + 1}.png`,
      },
    },
  }));
}

export function characterSheetRequest(
  world: WorldMeta,
  direction: ResolvedArtDirection,
  sheet: Sheet,
  kit: ReferenceKit,
  model: ManifestModel,
  generationKey: string,
  styleOverride?: string,
  requestedTier?: SizeTier,
): CharacterGenerationRequest {
  if (referenceBudgetFor(model) === 0) {
    throw new Error(`${model.displayName} cannot receive the accepted main photo`);
  }
  const photo = kit.mainPhoto?.file ?? kit.anchor;
  if (!photo) throw new Error("character sheet generation needs an accepted main photo");
  const style = styleOverride ?? kit.styleOverride ?? direction.description;
  const identityReferences = referenceBudgetFor(model) > 0 ? [`references/${sheet.id}/${photo}`] : [];
  const tier = tierFor(model, requestedTier);
  const estimatedMicroUsd = pricedCharacterImage(model, "character-sheet", identityReferences.length, tier);
  return {
    estimatedMicroUsd,
    input: {
      worldId: world.worldId,
      target: { kind: "character-sheet", id: `${sheet.id}/${generationKey}` },
      capability: "image",
      provider: model.provider,
      model: model.id,
      params: {
        characterName: sheet.name,
        prompt: `${style}. ${sheet.name} — ${sheetDescription(sheet)}. One composite character sheet on a clean neutral field: front, three-quarter, profile and back turnaround; expression studies; costume and prop details; clear relative proportions. Preserve the supplied identity exactly.`,
        references: identityReferences,
        referenceRoles: identityReferences.map((file) => ({ file, role: "identity" })),
        output: characterImageOutput(model, "character-sheet", tier),
        artDirection: {
          version: direction.version,
          source: styleOverride ? "generation" : kit.styleOverride ? "sheet" : "world",
          transport: "text",
          identityTransport: identityReferences.length > 0 ? "image" : "text",
        },
        provenance: generationProvenance(world, direction, sheet, photo),
      },
      estimatedMicroUsd,
      landing: {
        dir: `references/${sheet.id}/incoming`,
        name: `character-sheet-${generationKey}.png`,
      },
    },
  };
}

export function characterLookRequests(
  world: WorldMeta,
  direction: ResolvedArtDirection,
  sheet: Sheet,
  kit: ReferenceKit,
  model: ManifestModel,
  input: {
    kind: "costume" | "pose-expression" | "condition-age";
    mode: "stay-close" | "push-it";
    prompt: string;
    count: number;
    tier?: SizeTier;
    generationKey: string;
  },
): CharacterGenerationRequest[] {
  if (referenceBudgetFor(model) === 0) {
    throw new Error(`${model.displayName} cannot receive the accepted main photo`);
  }
  const photo = kit.mainPhoto?.file ?? kit.anchor;
  if (!photo) throw new Error("looks need an accepted main photo");
  const style = kit.styleOverride ?? direction.description;
  const identityReferences = referenceBudgetFor(model) > 0 ? [`references/${sheet.id}/${photo}`] : [];
  const tier = tierFor(model, input.tier);
  const estimatedMicroUsd = pricedCharacterImage(model, "character-look", identityReferences.length, tier);
  return Array.from({ length: input.count }, (_, index) => ({
    estimatedMicroUsd,
    input: {
      worldId: world.worldId,
      target: { kind: "character-look", id: `${sheet.id}/${input.generationKey}/${index + 1}` },
      capability: "image",
      provider: model.provider,
      model: model.id,
      params: {
        prompt: `${style}. ${sheet.name} — ${sheetDescription(sheet)}. ${input.prompt}. ${input.mode === "stay-close" ? "Stay close to the accepted identity and proportions." : "Push the styling while preserving the accepted identity."} Optional ${input.kind.replace("-", " ")} exploration; do not redefine identity.`,
        references: identityReferences,
        referenceRoles: identityReferences.map((file) => ({ file, role: "identity" })),
        output: characterImageOutput(model, "character-look", tier),
        lookKind: input.kind,
        lookPrompt: input.prompt,
        artDirection: {
          version: direction.version,
          source: kit.styleOverride ? "sheet" : "world",
          transport: "text",
          identityTransport: identityReferences.length > 0 ? "image" : "text",
        },
        provenance: generationProvenance(world, direction, sheet, photo),
      },
      estimatedMicroUsd,
      landing: {
        dir: `references/${sheet.id}/looks/incoming`,
        name: `look-${input.generationKey}-${index + 1}.png`,
      },
    },
  }));
}

/**
 * The missing tiles of a group, gated (R-7, D5): body work refuses until the head turnaround
 * is fully locked, naming what is outstanding.
 */
export function missingTileAngles(
  kit: ReferenceKit | null,
  group: "head" | "body",
): { ok: true; angles: ReferenceAngle[] } | { ok: false; reason: string } {
  const tiles = kit?.tiles ?? [];
  const groupAngles: ReferenceAngle[] =
    group === "head"
      ? ["head-front", "head-left-three-quarter", "head-right-three-quarter", "head-profile"]
      : ["body-full", "body-back"];
  if (group === "body") {
    const gate = headGate(kit ?? { sheetId: "x", tiles: [], compilations: [] });
    if (!gate.ready) {
      return {
        ok: false,
        reason: `body generation needs the full head turnaround locked first — outstanding: ${gate.outstanding.join(", ")}`,
      };
    }
  }
  if (group === "head" && (kit === null || kit.anchor === undefined)) {
    return {
      ok: false,
      reason: "establish a look first — the anchor is the reference everything else carries",
    };
  }
  const present = new Set(
    tiles
      .filter(
        (t) =>
          t.status === "locked" ||
          t.status === "generated" ||
          t.status === "pending" ||
          t.status === "rendering",
      )
      .map((t) => t.angle),
  );
  return { ok: true, angles: groupAngles.filter((a) => !present.has(a)) };
}

/**
 * The image model for one piece of kit work. A requested id overrides the routed default for
 * this generation and nothing else; it is refused rather than quietly ignored when it is not an
 * image model or has been switched off in Providers, because falling back silently would spend
 * money on a model the user did not choose.
 */
export function imageModelFor(
  settings: AppSettings | null,
  manifest: ModelManifest,
  requestedId?: string,
): ManifestModel | null {
  if (requestedId !== undefined) {
    const requested = manifest.models.find((m) => m.id === requestedId && m.capability === "image");
    if (!requested) return null;
    if (settings?.models.disabled.includes(requestedId)) return null;
    return requested;
  }
  return modelForCapability(manifest, settings?.routing, "image");
}

/**
 * What a model will actually carry. An unverified model was enabled from a provider's catalogue
 * on the strength of a published price alone, so it runs at the floor: no reference images, and
 * no size tier, leaving the provider its own default. Understating this costs a dropped
 * reference; overstating it costs a dispatch that dies after the estimate was accepted.
 */
export function referenceBudgetFor(model: ManifestModel): number {
  return model.unverified === true ? 0 : model.accepts.referenceImages;
}

/** The chosen tier, unless this model cannot reach it — then the model's own first size. */
export function tierFor(model: ManifestModel, requested?: SizeTier): SizeTier | undefined {
  if (model.unverified === true) return undefined;
  return requested !== undefined && nativeResolution(model, requested) !== undefined ? requested : undefined;
}
