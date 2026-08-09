import { compilationIsStale, designatedCompilation, mainPhotoFor, type ReferenceKit } from "./reference.js";
import type { ResolvedArtDirection } from "./art-direction.js";
import { referenceBudget, type BudgetCandidate, type BudgetResult } from "./reference-budget.js";
import {
  dispatchDuration,
  estimateMicroUsd,
  pricedDuration,
  sceneImageOutput,
  type ManifestModel,
  type SizeTier,
} from "./manifest.js";
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
// Prompt assembly (SPEC-012 R-14..R-16; SPEC-019 R-5..R-8, D5..D7)
// ---------------------------------------------------------------------------

/**
 * One statement, terminated once. Assembly used to join fragments with ". " until they looked
 * like sentences, which produced `dusk. Maren crosses` and the `..` cleanup that chased it
 * (SPEC-019 R-7). Terminating each part and giving blocks their own paragraph is what fixes
 * that; the parts themselves stay as authored.
 *
 * Deliberately NOT capitalised. Upper-casing the first letter of authored text turns
 * "iPhone-style handheld" into "IPhone-style handheld" — quietly corrupting a camera note to
 * make a fragment look like prose. Where the phrasing is ours, the capital is written in.
 */
function sentence(text: string): string {
  const trimmed = text.trim().replace(/[.\s]+$/, "");
  if (trimmed.length === 0) return "";
  return `${trimmed}.`;
}

/** The first clause of a named section, which is how a sheet's prose enters a prompt. */
function firstClause(sheet: Sheet, heading: string): string | null {
  const body = sheet.sections.find((s) => s.heading === heading)?.body;
  const clause = body?.split(/[.!?]/)[0]?.trim();
  return clause !== undefined && clause.length > 0 ? clause : null;
}

function styleFor(world: WorldMeta, artDirection?: string): string {
  return (
    artDirection ??
    [world.tone, world.genre].filter((s): s is string => typeof s === "string" && s.length > 0).join(", ")
  );
}

/**
 * The blocks of an assembled prompt (R-5). Kept separate rather than pre-joined so that the
 * dispatch dialog can show them, the tests can assert on one without matching the rest, and the
 * trailing constraints stay distinguishable from the beats they must not be interleaved with.
 */
export interface PromptBlocks {
  /** Art direction, cast, place, time and the event — what the clip is. */
  summary: string;
  /** What is true for the whole clip: location look, and prose for subjects carrying no image. */
  standing: string;
  /** The shot's own action. */
  body: string;
  /** This shot's camera and audio direction — part of the beat, in a pass. */
  direction: string;
  /**
   * Art direction restated as what must not drift. Stated once per clip and never per beat
   * (R-6): a four-shot pass repeating the world's look four times spends the model's attention
   * arguing with itself about which mention is authoritative.
   */
  persistent: string;
}

export interface AssembleInput {
  world: WorldMeta;
  sheets: Sheet[];
  scene: Scene;
  shot: Shot;
  artDirection?: string;
  /**
   * Sheets whose reference image this dispatch actually carries. Their prose appearance clause
   * is dropped, because the image is the stronger carrier and restating the description competes
   * with it (R-8, D7). Absent — a preview with no model chosen — every clause is kept, which is
   * the fullest form and never the wrong one.
   */
  carriedSheetIds?: ReadonlySet<string>;
}

/** The four blocks, before they are joined (R-5). */
export function assembleBlocks(input: AssembleInput): PromptBlocks {
  const { world, sheets, scene, shot } = input;
  const carried = input.carriedSheetIds ?? new Set<string>();
  const { cast } = resolveCast(shot.description, sheets);
  const style = styleFor(world, input.artDirection);
  const location =
    scene.inherits?.location !== undefined
      ? sheets.find((s) => s.id === scene.inherits!.location)
      : undefined;

  // 1 — summary: what the clip is, led by the art direction (R-6).
  const who = cast.map((c) => c.sheet.name);
  const whoClause =
    who.length === 0
      ? ""
      : who.length === 1
        ? who[0]!
        : `${who.slice(0, -1).join(", ")} and ${who[who.length - 1]!}`;
  const where = [location?.name, scene.inherits?.timeOfDay].filter((s): s is string => !!s).join(", ");
  const summary = [
    sentence(style),
    whoClause && where ? sentence(`${whoClause} at ${where}`) : sentence(whoClause || where),
    sentence(shot.title),
  ]
    .filter((s) => s.length > 0)
    .join(" ");

  // 2 — standing: true for the whole clip. A subject whose image travels contributes nothing
  // here; a sketch citation contributes its appearance once, rather than at every mention.
  const standingParts: string[] = [];
  if (location) {
    const look = firstClause(location, "Look");
    standingParts.push(sentence(look ? `${location.name} — ${look}` : location.name));
  }
  for (const { sheet } of cast) {
    if (carried.has(sheet.id)) continue;
    const appearance = firstClause(sheet, "Appearance");
    if (appearance) standingParts.push(sentence(`${sheet.name} — ${appearance}`));
  }
  const standing = standingParts.filter((s) => s.length > 0).join(" ");

  // 3 — body: the shot's direction, mentions resolved to names. The appearance clause is not
  // inlined here at all now: it is said once above, or carried as an image, never both.
  let description = shot.description;
  for (const { sheet } of cast) description = description.replaceAll(`@${sheet.id}`, sheet.name);
  const body = sentence(description);

  // 4 — direction: this shot's camera and audio. Per-beat, so in a pass it travels with the beat.
  const directionParts: string[] = [];
  if (shot.camera) directionParts.push(sentence(shot.camera));
  if (shot.audio?.kind && shot.audio.kind !== "silence") {
    directionParts.push(
      sentence(shot.audio.line ? `${shot.audio.kind}: "${shot.audio.line}"` : shot.audio.kind),
    );
  }
  const direction = directionParts.filter((s) => s.length > 0).join(" ");

  // 5 — persistent: what must not drift, once at the end (R-6).
  const persistent = style ? sentence(`Throughout: ${style}`) : "";

  return { summary, standing, body, direction, persistent };
}

/** The blocks joined, one paragraph each, empty ones omitted rather than emitted (R-7). */
export function joinBlocks(blocks: PromptBlocks): string {
  return [blocks.summary, blocks.standing, blocks.body, blocks.direction, blocks.persistent]
    .map((block) => block.trim())
    .filter((block) => block.length > 0)
    .join("\n\n");
}

/**
 * A whole-scene pass, composed as one clip rather than as several prompts stapled together
 * (R-5, R-6). The summary, the standing description and the persistent constraint are stated
 * once for the pass; each shot contributes only its beat. Joining per-shot prompts instead
 * restated the world's art direction twice per shot, which is what D6 exists to prevent.
 *
 * An overridden shot contributes its override verbatim as the beat: the override owns the
 * direction, and there are no blocks to take apart.
 */
export function assemblePassBlocks(input: {
  world: WorldMeta;
  sheets: Sheet[];
  scene: Scene;
  entries: ReadonlyArray<{ shot: Shot; prompt: { text: string; overridden: boolean } }>;
  artDirection?: string;
  carriedSheetIds?: ReadonlySet<string>;
}): { summary: string; standing: string; beats: Array<{ shot: Shot; text: string }>; persistent: string } {
  const blocksFor = (shot: Shot): PromptBlocks =>
    assembleBlocks({
      world: input.world,
      sheets: input.sheets,
      scene: input.scene,
      shot,
      ...(input.artDirection !== undefined ? { artDirection: input.artDirection } : {}),
      ...(input.carriedSheetIds !== undefined ? { carriedSheetIds: input.carriedSheetIds } : {}),
    });
  const first = input.entries[0];
  const lead = first ? blocksFor(first.shot) : null;
  // The standing description is the union across the pass, deduplicated: one location look, and
  // each uncarried subject named once however many beats they appear in.
  const standing: string[] = [];
  for (const entry of input.entries) {
    for (const line of blocksFor(entry.shot).standing.split(/(?<=\.)\s+/)) {
      const trimmed = line.trim();
      if (trimmed.length > 0 && !standing.includes(trimmed)) standing.push(trimmed);
    }
  }
  const beats = input.entries.map((entry) => {
    if (entry.prompt.overridden) return { shot: entry.shot, text: entry.prompt.text };
    const blocks = blocksFor(entry.shot);
    return {
      shot: entry.shot,
      text: [blocks.body, blocks.direction].filter((b) => b.length > 0).join(" "),
    };
  });
  return {
    summary: lead?.summary ?? "",
    standing: standing.join(" "),
    beats,
    persistent: lead?.persistent ?? "",
  };
}

/** The assembled form: cited sheets, the scene's location, the tone, the shot's direction. */
export function assemblePrompt(
  world: WorldMeta,
  sheets: Sheet[],
  scene: Scene,
  shot: Shot,
  artDirection?: string,
  carriedSheetIds?: ReadonlySet<string>,
): string {
  return joinBlocks(
    assembleBlocks({
      world,
      sheets,
      scene,
      shot,
      ...(artDirection !== undefined ? { artDirection } : {}),
      ...(carriedSheetIds !== undefined ? { carriedSheetIds } : {}),
    }),
  );
}

/**
 * The overridable body: the override when present, else the assembled form.
 *
 * This is the *body* only. The binding preamble and the derived negatives are composed at
 * dispatch and sit outside it (SPEC-019 R-3, R-13, D3) — an override is what a user writes for a
 * hard shot, and a hard shot is the one with the most cast in it and still a video dispatch.
 */
export function promptFor(
  world: WorldMeta,
  sheets: Sheet[],
  scene: Scene,
  shot: Shot,
  artDirection?: string,
  carriedSheetIds?: ReadonlySet<string>,
): { text: string; overridden: boolean } {
  if (shot.promptOverride) return { text: shot.promptOverride.text, overridden: true };
  return {
    text: assemblePrompt(world, sheets, scene, shot, artDirection, carriedSheetIds),
    overridden: false,
  };
}

/** Cited sheets that advanced past the override's recorded versions (R-16, D7). */
export function overrideStaleAgainst(
  shot: Shot,
  sheets: Sheet[],
): Array<{ sheetId: string; from: number; to: number }> {
  if (!shot.promptOverride) return [];
  const out: Array<{ sheetId: string; from: number; to: number }> = [];
  for (const [sheetId, pinned] of Object.entries(shot.promptOverride.sheetVersions)) {
    const sheet = sheets.find((s) => s.id === sheetId);
    if (sheet && sheet.version > (pinned as number))
      out.push({ sheetId, from: pinned as number, to: sheet.version });
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
      return {
        ok: false,
        oversizeShot: { shotId: shot.id, number: shot.number, durationSec: duration, capSec },
      };
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
  mode: "designated" | "main-photo" | "scoped-look" | "sketch-citation";
  role: "primary" | "secondary";
  staleGap: string | null;
}

// ---------------------------------------------------------------------------
// Reference binding (SPEC-019 R-1..R-4, D1, D2)
// ---------------------------------------------------------------------------

/**
 * A carried asset, numbered. The index is the position the asset occupies in the transmitted
 * array, and the preamble is generated from these same records — one structure, so the stated
 * order and the sent order cannot drift (R-2, D2). Two representations of one ordering will
 * disagree eventually, and the disagreement presents as the model confusing two characters.
 */
export interface BoundReference {
  /** 1-based, matching the transmitted array's order. */
  index: number;
  sheetId: string;
  /** Display name of the subject, so the prompt binds to a name rather than a slug. */
  subject: string;
  file: string;
  kind: "image";
  /** What this asset is a reference *for*, from its attachment mode (R-4). */
  rolePhrase: string;
  /** For a second reference on a subject already bound: the index that first bound it. */
  sameSubjectAs: number | null;
}

/**
 * What an asset is a reference for, in words (R-4). A model sheet, a main photo and a scoped
 * look are three different claims, and the vendor guidance asks specifically that the part of an
 * asset being referenced is named rather than left to be inferred.
 */
function rolePhraseFor(sheet: Sheet, decision: AttachmentDecision): string {
  if (sheet.type === "location") return "location reference — environment and composition";
  if (sheet.type === "faction") return "faction reference — insignia, dress and materials";
  if (decision.role === "secondary") return "additional reference for the same subject";
  switch (decision.mode) {
    case "scoped-look":
      return "subject reference — appearance as they look in this production";
    case "main-photo":
      return "subject reference — appearance identity, from the main photo";
    default:
      return "subject reference — appearance identity";
  }
}

/**
 * Number the assets that will actually travel, in the order they will travel. Decisions with no
 * file never took a slot and never get an index — the prompt must not cite an image that is not
 * in the request.
 */
export function bindReferences(
  decisions: readonly AttachmentDecision[],
  sheets: readonly Sheet[],
): BoundReference[] {
  const bound: BoundReference[] = [];
  for (const decision of decisions) {
    if (decision.file === null) continue;
    const sheet = sheets.find((s) => s.id === decision.sheetId);
    if (sheet === undefined) continue;
    const first = bound.find((b) => b.sheetId === decision.sheetId);
    bound.push({
      index: bound.length + 1,
      sheetId: decision.sheetId,
      subject: sheet.name,
      file: decision.file,
      kind: "image",
      rolePhrase: rolePhraseFor(sheet, decision),
      sameSubjectAs: first ? first.index : null,
    });
  }
  return bound;
}

/** The files to transmit, in the order the preamble numbers them (R-2). */
export function boundFiles(bound: readonly BoundReference[]): string[] {
  return bound.map((reference) => reference.file);
}

/**
 * The preamble: every carried asset named, numbered and given a role (R-1). Composed at dispatch
 * and never part of the overridable body (R-3, D3).
 */
export function bindingPreamble(bound: readonly BoundReference[]): string | null {
  if (bound.length === 0) return null;
  const lines = bound.map((reference) => {
    const label = `Image ${reference.index}: ${reference.subject}`;
    return reference.sameSubjectAs !== null
      ? `${label} — ${reference.rolePhrase}, same subject as image ${reference.sameSubjectAs}.`
      : `${label} — ${reference.rolePhrase}.`;
  });
  return [
    "Reference assets, by upload order:",
    ...lines,
    "Keep each subject consistent with its own reference images throughout; do not blend subjects or repeat one as another.",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Derived negatives (SPEC-019 R-9..R-13, D8..D10)
// ---------------------------------------------------------------------------

export interface AudioDesign {
  /** The cut composes a score track, so the model must not lay music under every clip (R-11). */
  scoreTrack: boolean;
}

export interface NegativeInput {
  capability: string;
  shot?: Shot;
  audioDesign?: AudioDesign;
}

/**
 * The negatives, derived from the production rather than authored per shot (R-9, D10). A
 * per-shot negative is a per-shot thing to forget, and the failure stays silent until an export
 * has titles burned into the picture.
 */
export function derivedNegatives(input: NegativeInput): string | null {
  if (input.capability !== "video") return null;
  // Always. A take is immutable, so burned-in text is damage with no version of the take without
  // it; no surface asks for subtitles and the cut renders its own titles (R-10, D8).
  const parts = ["No subtitles."];
  if (input.shot?.audio?.kind === "silence") {
    parts.push("No audio.");
  } else if (input.audioDesign?.scoreTrack === true) {
    // Score only. Environmental and action sound belong to the shot and replacing them would
    // mean sourcing foley for every clip (R-11, D9).
    parts.push("No background music — environmental and action sound only.");
  }
  return parts.join(" ");
}

// ---------------------------------------------------------------------------
// Final composition: what the planner composes, the planner keeps (D3)
// ---------------------------------------------------------------------------

export interface PromptParts {
  /** Machine-composed, outside the override (R-3). */
  preamble: string | null;
  /** The override when present, else the assembled blocks (SPEC-012 R-15). */
  body: string;
  /** Machine-composed, appended after the body, outside the override (R-13). */
  negatives: string | null;
}

/**
 * The text that actually goes over the wire. The override owns the direction; the preamble
 * describes the payload and the negatives describe the delivery, and neither is authored intent.
 */
export function composePrompt(parts: PromptParts): string {
  return [parts.preamble, parts.body, parts.negatives]
    .map((part) => part?.trim() ?? "")
    .filter((part) => part.length > 0)
    .join("\n\n");
}

export function attachmentFor(
  kit: ReferenceKit | null,
  sheet: Sheet,
  role: "primary" | "secondary" = "primary",
  scope?: { productionId?: string; sceneId?: string },
): AttachmentDecision {
  const scopedLook = kit?.looks?.find((look) => {
    if (!look.attachedTo || !scope?.productionId) return false;
    if (look.attachedTo.productionId !== scope.productionId) return false;
    return look.attachedTo.kind === "production" || look.attachedTo.sceneId === scope.sceneId;
  });
  if (role === "primary" && scopedLook) {
    return {
      sheetId: sheet.id,
      file: `references/${sheet.id}/${scopedLook.file}`,
      mode: "scoped-look",
      role,
      staleGap: null,
    };
  }
  const designated = kit ? designatedCompilation(kit) : null;
  const photo = kit ? mainPhotoFor(kit) : null;
  if (role === "secondary") {
    return photo && designated
      ? {
          sheetId: sheet.id,
          file: `references/${sheet.id}/${photo.file}`,
          mode: "main-photo",
          role,
          staleGap: null,
        }
      : { sheetId: sheet.id, file: null, mode: "sketch-citation", role, staleGap: null };
  }
  if (!kit || !designated) {
    return photo
      ? {
          sheetId: sheet.id,
          file: `references/${sheet.id}/${photo.file}`,
          mode: "main-photo",
          role,
          staleGap: null,
        }
      : { sheetId: sheet.id, file: null, mode: "sketch-citation", role, staleGap: null };
  }
  const stale = compilationIsStale(kit, designated, sheet.version);
  return {
    sheetId: sheet.id,
    file: `references/${sheet.id}/${designated.file}`,
    mode: "designated",
    role,
    staleGap: stale
      ? `model sheet is v${designated.sheetVersion}; ${sheet.name} is at v${sheet.version}`
      : null,
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
  overriddenStale: Array<{
    shotId: string;
    number: number;
    against: Array<{ sheetId: string; from: number; to: number }>;
  }>;
  /**
   * Shots longer than the longest clip this model can be asked for. Named rather than clamped:
   * a 22s shot quietly dispatched as a 15s clip is paid-for footage that cannot cover it.
   */
  overlongShots: Array<{ shotId: string; number: number; durationSec: number; longestSec: number }>;
}

export interface ScenePlanInput {
  world: WorldMeta;
  sheets: Sheet[];
  kits: ReferenceKit[];
  scene: Scene;
  selections: Selections;
  model: ManifestModel;
  resolution?: string;
  /** Stills: the chosen size tier, which becomes real output dimensions at dispatch. */
  tier?: SizeTier;
  productionId?: string;
  artDirection?: ResolvedArtDirection;
  /**
   * The production's audio design, which is where the score negative comes from (R-11). Absent
   * means no score track is known, and only the subtitle negative is emitted.
   */
  audioDesign?: AudioDesign;
}

export interface ShotDispatchPlan {
  shot: Shot;
  prompt: { text: string; overridden: boolean };
  references: AttachmentDecision[];
  /** The carried assets, numbered in transmission order (R-2). */
  bound: BoundReference[];
  /** Preamble, overridable body and negatives, kept apart so only the body is editable (R-3, R-13). */
  parts: PromptParts;
  budget: BudgetResult;
  estimatedMicroUsd: number;
}

export interface ScenePlan {
  mode: "per-shot" | "whole-scene";
  shots: ShotDispatchPlan[];
  passReferences: Array<{
    passIndex: number;
    references: AttachmentDecision[];
    budget: BudgetResult;
    /** The pass's carried assets, numbered in transmission order (R-2). */
    bound: BoundReference[];
    /** The clip's derived negatives, computed here so the dialog and the dispatch agree (R-9). */
    negatives: string | null;
  }>;
  pack: PackResult;
  /**
   * The size these estimates were computed at, carried so the jobs composed from this plan run
   * at it too. Without it the plan priced 1080p and the dispatch quietly took the provider's
   * default — the estimate and the request disagreeing about the same job.
   */
  resolution?: string;
  /** Stills: the tier those estimates assumed, for the output spec the jobs carry. */
  tier?: SizeTier;
  totalEstimatedMicroUsd: number;
  warnings: DispatchWarnings;
}

function sceneCast(
  scene: Scene,
  sheets: Sheet[],
): { resolved: ResolvedCast; perShot: Map<string, ResolvedCast> } {
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

function budgetFor(
  cast: ResolvedCast["cast"],
  kits: ReferenceKit[],
  scene: Scene,
  sheets: Sheet[],
  model: ManifestModel,
  productionId?: string,
) {
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
    hasReference:
      attachmentFor(kits.find((k) => k.sheetId === entry.sheet.id) ?? null, entry.sheet, "primary", {
        ...(productionId ? { productionId } : {}),
        sceneId: scene.id,
      }).file !== null,
    hasSecondaryReference:
      entry.sheet.type === "character" &&
      attachmentFor(kits.find((k) => k.sheetId === entry.sheet.id) ?? null, entry.sheet, "secondary").file !==
        null,
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
    const budget = budgetFor(cast.cast, kits, scene, sheets, model, input.productionId);
    const references = budget.carried.map((c) =>
      attachmentFor(
        kits.find((k) => k.sheetId === c.sheetId) ?? null,
        sheets.find((s) => s.id === c.sheetId)!,
        c.referenceRole,
        { ...(input.productionId ? { productionId: input.productionId } : {}), sceneId: scene.id },
      ),
    );
    // The length that will actually be asked for. A route takes one of a fixed few lengths, so
    // a 6.5s shot becomes a 7s dispatch — and the estimate has to be the 7, or the figure shown
    // and the figure billed are for two different requests. A shot longer than anything the
    // route offers keeps its own seconds here and is refused by name in the warnings.
    const duration = pricedDuration(model, shot.durationSec ?? DEFAULT_SHOT_SEC);
    const estimate =
      model.capability === "video"
        ? estimateMicroUsd(model, {
            durationSec: duration,
            ...(input.resolution !== undefined ? { resolution: input.resolution } : {}),
          })
        : (() => {
            // Priced from the frame that will actually be asked for. Without the megapixels a
            // per-megapixel model came out at zero, which is not an estimate.
            const output = sceneImageOutput(model, input.tier);
            return estimateMicroUsd(model, {
              images: 1,
              referenceImages: references.filter((reference) => reference.file !== null).length,
              megapixels: (output.width * output.height) / 1_000_000,
              ...(output.resolution !== undefined ? { resolution: output.resolution } : {}),
            });
          })();
    // Bound first, because what travels decides what the prose still has to say: a subject whose
    // image is carried loses its appearance clause (R-8), and only carried assets get numbered.
    const bound = bindReferences(references, sheets);
    const prompt = promptFor(
      world,
      sheets,
      scene,
      shot,
      input.artDirection?.description,
      new Set(bound.map((reference) => reference.sheetId)),
    );
    const parts: PromptParts = {
      preamble: bindingPreamble(bound),
      body: prompt.text,
      negatives: derivedNegatives({
        capability: model.capability,
        shot,
        ...(input.audioDesign !== undefined ? { audioDesign: input.audioDesign } : {}),
      }),
    };
    return {
      shot,
      prompt,
      references,
      bound,
      parts,
      budget,
      estimatedMicroUsd: estimate,
    };
  });

  const perShotTotal = shots.reduce((a, s) => a + s.estimatedMicroUsd, 0);
  const passReferences = pack.ok
    ? pack.passes.map((pass) => {
        const seen = new Map<string, ResolvedCast["cast"][number]>();
        for (const entry of pass.plan) {
          for (const cast of perShot.get(entry.shotId)?.cast ?? []) {
            if (!seen.has(cast.sheet.id)) seen.set(cast.sheet.id, cast);
          }
        }
        const budget = budgetFor([...seen.values()], kits, scene, sheets, model, input.productionId);
        const references = budget.carried.map((candidate) =>
          attachmentFor(
            kits.find((kit) => kit.sheetId === candidate.sheetId) ?? null,
            sheets.find((sheet) => sheet.id === candidate.sheetId)!,
            candidate.referenceRole,
            { ...(input.productionId ? { productionId: input.productionId } : {}), sceneId: scene.id },
          ),
        );
        return {
          passIndex: pass.index,
          references,
          budget,
          bound: bindReferences(references, sheets),
          // A pass is one clip, so its negatives are the clip's: no per-shot silence, because
          // several shots' audio directions share the same output.
          negatives: derivedNegatives({
            capability: model.capability,
            ...(input.audioDesign !== undefined ? { audioDesign: input.audioDesign } : {}),
          }),
        };
      })
    : [];
  const wholeSceneTotal =
    pack.ok && model.capability === "video"
      ? pack.passes.reduce(
          (a, p) =>
            a +
            estimateMicroUsd(model, {
              durationSec: pricedDuration(model, p.durationSec),
              ...(input.resolution !== undefined ? { resolution: input.resolution } : {}),
            }),
          0,
        )
      : perShotTotal;

  const sceneBudget = budgetFor(resolved.cast, kits, scene, sheets, model, input.productionId);
  const droppedReferences =
    mode === "whole-scene"
      ? passReferences
          .flatMap((pass) => pass.budget.dropped)
          .filter(
            (candidate, index, all) =>
              all.findIndex(
                (other) =>
                  other.sheetId === candidate.sheetId && other.referenceRole === candidate.referenceRole,
              ) === index,
          )
      : sceneBudget.dropped;
  const overlongShots = scene.shots
    .map((shot) => ({ shot, choice: dispatchDuration(model, shot.durationSec ?? DEFAULT_SHOT_SEC) }))
    .filter((entry): entry is { shot: Shot; choice: { kind: "over-cap"; longest: number } } =>
      entry.choice.kind === "over-cap",
    )
    .map((entry) => ({
      shotId: entry.shot.id,
      number: entry.shot.number,
      durationSec: entry.shot.durationSec ?? DEFAULT_SHOT_SEC,
      longestSec: entry.choice.longest,
    }));
  const warnings: DispatchWarnings = {
    // Only where a frame would actually travel. Warning that a shot has no accepted frame, on a
    // model that cannot take one, tells the user to go and fix something that would change
    // nothing about the dispatch (#154). It returns of its own accord the day a model declares
    // it takes a start frame and the dispatch carries it.
    shotsWithoutFrame: model.accepts.startFrame
      ? scene.shots
          .filter((s) => !(selections[s.id]?.startFrameTakeId ?? null))
          .map((s) => ({ shotId: s.id, number: s.number }))
      : [],
    sketchCitations: resolved.cast.filter((c) => c.sheet.status === "sketch").map((c) => c.sheet.name),
    droppedReferences,
    staleModelSheets: resolved.cast
      .map((c) => attachmentFor(kits.find((k) => k.sheetId === c.sheet.id) ?? null, c.sheet).staleGap)
      .filter((g): g is string => g !== null),
    retiredCitations: resolved.cast.filter((c) => c.retired).map((c) => c.sheet.name),
    unknownMentions: resolved.unknown,
    overlongShots,
    overriddenStale: scene.shots
      .map((s) => ({ shotId: s.id, number: s.number, against: overrideStaleAgainst(s, sheets) }))
      .filter((s) => s.against.length > 0),
  };

  return {
    mode,
    shots,
    passReferences,
    pack,
    ...(input.resolution !== undefined ? { resolution: input.resolution } : {}),
    ...(input.tier !== undefined ? { tier: input.tier } : {}),
    totalEstimatedMicroUsd: mode === "whole-scene" ? wholeSceneTotal : perShotTotal,
    warnings,
  };
}
