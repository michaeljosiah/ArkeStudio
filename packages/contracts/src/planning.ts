import { compilationIsStale, designatedCompilation, type ReferenceKit } from "./reference.js";
import { referenceBudget, type BudgetCandidate, type BudgetResult } from "./reference-budget.js";
import { estimateMicroUsd, type ManifestModel } from "./manifest.js";
import type { Scene, Shot } from "./scene.js";
import type { Selections } from "./scene.js";
import type { Sheet, WorldMeta } from "./world.js";

/**
 * Dispatch planning (SPEC-012 §2.8–§2.11): prompts assembled from the world, mentions as the
 * one cast list, greedy order-preserving pass packing, and the seven named warnings. All pure
 * — the dialog renders the same plan the coordinator executes.
 */

// ---------------------------------------------------------------------------
// Mentions (R-9, D5): `@slug` is the source of the shot's cast
// ---------------------------------------------------------------------------

export function parseMentions(description: string): string[] {
  const out: string[] = [];
  for (const match of description.matchAll(/@([a-z0-9][a-z0-9-]*)/g)) {
    const slug = match[1]!;
    if (!out.includes(slug)) out.push(slug);
  }
  return out;
}

export interface ResolvedCast {
  /** In order of first appearance — the budget's third ranking key. */
  cast: Array<{ sheet: Sheet; retired: boolean }>;
  /** Mentions that resolve to nothing — reported, never silently dropped (§3.2). */
  unknown: string[];
}

export function resolveCast(description: string, sheets: Sheet[]): ResolvedCast {
  const byId = new Map(sheets.map((s) => [s.id, s]));
  const cast: ResolvedCast["cast"] = [];
  const unknown: string[] = [];
  for (const slug of parseMentions(description)) {
    const sheet = byId.get(slug);
    if (sheet) cast.push({ sheet, retired: sheet.retired === true });
    else unknown.push(slug);
  }
  return { cast, unknown };
}

// ---------------------------------------------------------------------------
// Prompt assembly (R-14, R-15, R-16, D6, D7)
// ---------------------------------------------------------------------------

/** The assembled form: cited sheets, the scene's location, the tone, the shot's direction. */
export function assemblePrompt(world: WorldMeta, sheets: Sheet[], scene: Scene, shot: Shot): string {
  const { cast } = resolveCast(shot.description, sheets);
  const parts: string[] = [];
  const style = [world.tone, world.genre].filter((s): s is string => typeof s === "string" && s.length > 0).join(", ");
  if (style) parts.push(style);
  const location = scene.inherits?.location !== undefined ? sheets.find((s) => s.id === scene.inherits!.location) : undefined;
  if (location) {
    const look = location.sections.find((s) => s.heading === "Look")?.body.split(/[.!?]/)[0]?.trim();
    parts.push(look ? `${location.name} — ${look}` : location.name);
  }
  if (scene.inherits?.timeOfDay) parts.push(scene.inherits.timeOfDay);
  // The description with mentions replaced by name + a clause of appearance.
  let description = shot.description;
  for (const { sheet } of cast) {
    const appearance = sheet.sections.find((s) => s.heading === "Appearance")?.body.split(/[.!?]/)[0]?.trim();
    description = description.replaceAll(`@${sheet.id}`, appearance ? `${sheet.name} (${appearance})` : sheet.name);
  }
  parts.push(description.trim());
  if (shot.camera) parts.push(shot.camera);
  if (shot.audio?.kind && shot.audio.kind !== "silence") {
    parts.push(shot.audio.line ? `${shot.audio.kind}: "${shot.audio.line}"` : shot.audio.kind);
  }
  return parts.filter((p) => p.length > 0).join(". ").replace(/\.\./g, ".");
}

/** What the dispatch will actually say: the override when present, else the assembled form. */
export function promptFor(world: WorldMeta, sheets: Sheet[], scene: Scene, shot: Shot): { text: string; overridden: boolean } {
  if (shot.promptOverride) return { text: shot.promptOverride.text, overridden: true };
  return { text: assemblePrompt(world, sheets, scene, shot), overridden: false };
}

/** Cited sheets that advanced past the override's recorded versions (R-16, D7). */
export function overrideStaleAgainst(shot: Shot, sheets: Sheet[]): Array<{ sheetId: string; from: number; to: number }> {
  if (!shot.promptOverride) return [];
  const out: Array<{ sheetId: string; from: number; to: number }> = [];
  for (const [sheetId, pinned] of Object.entries(shot.promptOverride.sheetVersions)) {
    const sheet = sheets.find((s) => s.id === sheetId);
    if (sheet && sheet.version > (pinned as number)) out.push({ sheetId, from: pinned as number, to: sheet.version });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Pass packing (R-18, R-19, D9, D10, D11)
// ---------------------------------------------------------------------------

export interface ShotPlanEntry {
  shotId: string;
  number: number;
  startSec: number;
  endSec: number;
}

export interface Pass {
  index: number;
  durationSec: number;
  /** Explicit boundaries computed BEFORE dispatch — SPEC-013 segments from these, never guesses. */
  plan: ShotPlanEntry[];
}

export type PackResult =
  | { ok: true; passes: Pass[]; totalSec: number }
  | { ok: false; oversizeShot: { shotId: string; number: number; durationSec: number; capSec: number } };

const DEFAULT_SHOT_SEC = 4;

/** Greedy, order-preserving; a shot is never split (D9). Oversize disables whole-scene (D10). */
export function packScene(shots: Shot[], capSec: number): PackResult {
  const passes: Pass[] = [];
  let current: ShotPlanEntry[] = [];
  let cursor = 0;
  let total = 0;
  const close = () => {
    if (current.length === 0) return;
    passes.push({ index: passes.length + 1, durationSec: cursor, plan: current });
    current = [];
    cursor = 0;
  };
  for (const shot of shots) {
    const duration = shot.durationSec ?? DEFAULT_SHOT_SEC;
    if (duration > capSec) {
      return { ok: false, oversizeShot: { shotId: shot.id, number: shot.number, durationSec: duration, capSec } };
    }
    if (cursor + duration > capSec) close();
    current.push({ shotId: shot.id, number: shot.number, startSec: cursor, endSec: cursor + duration });
    cursor += duration;
    total += duration;
  }
  close();
  return { ok: true, passes, totalSec: total };
}

// ---------------------------------------------------------------------------
// Reference attachment (moved judgement from SPEC-010): one resolver, every path
// ---------------------------------------------------------------------------

export interface AttachmentDecision {
  sheetId: string;
  file: string | null;
  mode: "designated" | "sketch-citation";
  staleGap: string | null;
}

export function attachmentFor(kit: ReferenceKit | null, sheet: Sheet): AttachmentDecision {
  const designated = kit ? designatedCompilation(kit) : null;
  if (!kit || !designated) {
    return { sheetId: sheet.id, file: null, mode: "sketch-citation", staleGap: null };
  }
  const stale = compilationIsStale(kit, designated, sheet.version);
  return {
    sheetId: sheet.id,
    file: `references/${sheet.id}/${designated.file}`,
    mode: "designated",
    staleGap: stale ? `model sheet is v${designated.sheetVersion}; ${sheet.name} is at v${sheet.version}` : null,
  };
}

// ---------------------------------------------------------------------------
// The dispatch dialog (R-17, R-20, D12): seven warnings, every one named
// ---------------------------------------------------------------------------

export interface DispatchWarnings {
  shotsWithoutFrame: Array<{ shotId: string; number: number }>;
  sketchCitations: string[];
  droppedReferences: BudgetResult["dropped"];
  staleModelSheets: string[];
  retiredCitations: string[];
  unknownMentions: string[];
  overriddenStale: Array<{ shotId: string; number: number; against: Array<{ sheetId: string; from: number; to: number }> }>;
}

export interface ScenePlanInput {
  world: WorldMeta;
  sheets: Sheet[];
  kits: ReferenceKit[];
  scene: Scene;
  selections: Selections;
  model: ManifestModel;
  resolution?: string;
}

export interface ShotDispatchPlan {
  shot: Shot;
  prompt: { text: string; overridden: boolean };
  references: AttachmentDecision[];
  budget: BudgetResult;
  estimatedMicroUsd: number;
}

export interface ScenePlan {
  mode: "per-shot" | "whole-scene";
  shots: ShotDispatchPlan[];
  pack: PackResult;
  totalEstimatedMicroUsd: number;
  warnings: DispatchWarnings;
}

function sceneCast(scene: Scene, sheets: Sheet[]): { resolved: ResolvedCast; perShot: Map<string, ResolvedCast> } {
  const perShot = new Map<string, ResolvedCast>();
  const seen = new Map<string, { sheet: Sheet; retired: boolean }>();
  const unknown = new Set<string>();
  for (const shot of scene.shots) {
    const resolved = resolveCast(shot.description, sheets);
    perShot.set(shot.id, resolved);
    for (const entry of resolved.cast) if (!seen.has(entry.sheet.id)) seen.set(entry.sheet.id, entry);
    for (const u of resolved.unknown) unknown.add(u);
  }
  return { resolved: { cast: [...seen.values()], unknown: [...unknown] }, perShot };
}

function budgetFor(cast: ResolvedCast["cast"], kits: ReferenceKit[], scene: Scene, sheets: Sheet[], model: ManifestModel) {
  const withLocation: Array<{ sheet: Sheet; retired: boolean }> = [...cast];
  const locationId = scene.inherits?.location;
  if (locationId !== undefined && !withLocation.some((c) => c.sheet.id === locationId)) {
    const location = sheets.find((s) => s.id === locationId);
    if (location) withLocation.push({ sheet: location, retired: location.retired === true });
  }
  const candidates: BudgetCandidate[] = withLocation.map((entry, i) => ({
    sheetId: entry.sheet.id,
    kind: entry.sheet.type,
    ...(entry.sheet.billing !== undefined ? { billing: entry.sheet.billing } : {}),
    appearanceOrder: i,
    hasReference: attachmentFor(kits.find((k) => k.sheetId === entry.sheet.id) ?? null, entry.sheet).file !== null,
  }));
  return referenceBudget(candidates, model);
}

/** The whole plan, computed before a dollar moves (R-17, R-20). Nothing here blocks (D12). */
export function planScene(input: ScenePlanInput, mode: "per-shot" | "whole-scene"): ScenePlan {
  const { world, sheets, kits, scene, selections, model } = input;
  const { resolved, perShot } = sceneCast(scene, sheets);
  const capSec = model.limits.maxDurationSec ?? Number.POSITIVE_INFINITY;
  const pack = packScene(scene.shots, capSec);

  const shots: ShotDispatchPlan[] = scene.shots.map((shot) => {
    const cast = perShot.get(shot.id)!;
    const budget = budgetFor(cast.cast, kits, scene, sheets, model);
    const references = budget.carried.map((c) =>
      attachmentFor(kits.find((k) => k.sheetId === c.sheetId) ?? null, sheets.find((s) => s.id === c.sheetId)!),
    );
    const duration = shot.durationSec ?? DEFAULT_SHOT_SEC;
    const estimate =
      model.capability === "video"
        ? estimateMicroUsd(model, { durationSec: duration, ...(input.resolution !== undefined ? { resolution: input.resolution } : {}) })
        : estimateMicroUsd(model, { images: 1, ...(input.resolution !== undefined ? { resolution: input.resolution } : {}) });
    return { shot, prompt: promptFor(world, sheets, scene, shot), references, budget, estimatedMicroUsd: estimate };
  });

  const perShotTotal = shots.reduce((a, s) => a + s.estimatedMicroUsd, 0);
  const wholeSceneTotal =
    pack.ok && model.capability === "video"
      ? pack.passes.reduce(
          (a, p) =>
            a +
            estimateMicroUsd(model, {
              durationSec: p.durationSec,
              ...(input.resolution !== undefined ? { resolution: input.resolution } : {}),
            }),
          0,
        )
      : perShotTotal;

  const sceneBudget = budgetFor(resolved.cast, kits, scene, sheets, model);
  const warnings: DispatchWarnings = {
    shotsWithoutFrame: scene.shots
      .filter((s) => !(selections[s.id]?.startFrameTakeId ?? null))
      .map((s) => ({ shotId: s.id, number: s.number })),
    sketchCitations: resolved.cast.filter((c) => c.sheet.status === "sketch").map((c) => c.sheet.name),
    droppedReferences: sceneBudget.dropped,
    staleModelSheets: resolved.cast
      .map((c) => attachmentFor(kits.find((k) => k.sheetId === c.sheet.id) ?? null, c.sheet).staleGap)
      .filter((g): g is string => g !== null),
    retiredCitations: resolved.cast.filter((c) => c.retired).map((c) => c.sheet.name),
    unknownMentions: resolved.unknown,
    overriddenStale: scene.shots
      .map((s) => ({ shotId: s.id, number: s.number, against: overrideStaleAgainst(s, sheets) }))
      .filter((s) => s.against.length > 0),
  };

  return {
    mode,
    shots,
    pack,
    totalEstimatedMicroUsd: mode === "whole-scene" ? wholeSceneTotal : perShotTotal,
    warnings,
  };
}
