import {
  estimateMicroUsd,
  headGate,
  lockedTiles,
  type AppSettings,
  type ManifestModel,
  type ModelManifest,
  type ReferenceAngle,
  type ReferenceKit,
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
  return [world.tone, world.genre].filter((s): s is string => typeof s === "string" && s.length > 0).join(", ");
}

function sheetDescription(sheet: Sheet): string {
  const essence = sheet.sections.find((s) => s.heading === "Essence" || s.heading === "Look")?.body ?? "";
  const appearance = sheet.sections.find((s) => s.heading === "Appearance")?.body ?? "";
  return [essence, appearance].filter((s) => s.trim().length > 0).join(" ").replace(/\s+/g, " ").trim();
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
  const estimated = estimateMicroUsd(model, { images: 1 });
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
      },
      estimatedMicroUsd: estimated,
      landing: { dir: `references/${sheet.id}/incoming` },
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
): TileRequest[] {
  const estimated = estimateMicroUsd(model, { images: 1 });
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
        prompt: `${styleLine(world, kit)}. ${sheet.name} — ${sheetDescription(sheet)}. ${ANGLE_PROMPT["head-front"]}, character reference, candidate ${i + 1} of ${count}, distinct interpretation.`,
        references: [],
      },
      estimatedMicroUsd: estimated,
      landing: { dir: `references/${sheet.id}/candidates` },
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
    return { ok: false, reason: "establish a look first — the anchor is the reference everything else carries" };
  }
  const present = new Set(
    tiles.filter((t) => t.status === "locked" || t.status === "generated" || t.status === "pending" || t.status === "rendering").map((t) => t.angle),
  );
  return { ok: true, angles: groupAngles.filter((a) => !present.has(a)) };
}

/** The routed image model for kit work: routing default, else the manifest's first image model. */
export function imageModelFor(settings: AppSettings | null, manifest: ModelManifest): ManifestModel | null {
  const routed = settings?.routing["image"];
  if (routed !== undefined) {
    const model = manifest.models.find((m) => m.id === routed);
    if (model) return model;
  }
  return manifest.models.find((m) => m.capability === "image") ?? null;
}
