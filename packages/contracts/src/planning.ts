import {
  compilationIsStale,
  designatedCompilation,
  mainPhotoFor,
  type Compilation,
  type ReferenceKit,
} from "./reference.js";
import { DEFAULT_AUDIO_POLICY, type AudioPolicy, type ResolvedArtDirection } from "./art-direction.js";
import {
  payloadVerdict,
  referenceBudget,
  type BudgetCandidate,
  type BudgetResult,
  type PayloadVerdict,
} from "./reference-budget.js";
import {
  dispatchDuration,
  estimateMicroUsd,
  pricedDuration,
  sceneImageOutput,
  type ManifestModel,
  type SizeTier,
} from "./manifest.js";
import { chooseReferenceSteering, type ReferenceSteering } from "./storyboard.js";
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
  /**
   * The room, in the location's own authored words (SPEC-019; #246). Empty unless the scene
   * inherits a location whose Look is nonblank and the dispatch is video: a still does not need
   * to be told where the camera could stand, and stills stay byte-identical to what they were.
   */
  spatial: string;
  /**
   * Where the camera stands and what it faces, taken verbatim from the shot. Empty unless the
   * spatial block is present and the shot authored a camera value — an anchor is never parsed
   * out of ordinary camera vocabulary, because inferring a fixture is how "closer to the fridge"
   * moves the fridge.
   */
  cameraAnchor: string;
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
  /**
   * What the planned model does. The spatial and camera-anchor blocks are video-only: they exist
   * to place a camera in a room over time, which is not a question a still asks. Absent — a
   * preview with no model chosen — they are omitted, which is the prior behaviour exactly.
   */
  capability?: string;
}

/**
 * The room as the location authored it, or null (#246).
 *
 * Deliberately not clever: the complete Look body, whitespace collapsed so that Markdown line
 * wrapping in a sheet cannot change what a provider receives. Nothing is extracted, inferred or
 * asked of an agent — a fixture list nobody wrote is a fixture list nobody can be held to, and
 * the failure mode this block exists to fix is precisely a model inventing geometry.
 */
export function spatialLayoutFor(scene: Scene, sheets: readonly Sheet[]): string | null {
  const locationId = scene.inherits?.location;
  const location = locationId !== undefined ? sheets.find((sheet) => sheet.id === locationId) : undefined;
  if (location?.type !== "location") return null;

  const look = location.sections.find((section) => section.heading === "Look")?.body.trim();
  if (look === undefined || look.length === 0) return null;

  return `SPATIAL LAYOUT\n${location.name} — ${look.replace(/\s+/g, " ")}`;
}

/** The blocks, before they are joined (R-5). */
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

  // The room's own words, video only. When it is present it replaces the location's first Look
  // clause below rather than joining it — saying the same room twice, once abridged, invites the
  // model to arbitrate between two descriptions of one place.
  const spatial = input.capability === "video" ? (spatialLayoutFor(scene, sheets) ?? "") : "";

  // 2 — standing: true for the whole clip. A subject whose image travels contributes nothing
  // here; a sketch citation contributes its appearance once, rather than at every mention.
  const standingParts: string[] = [];
  if (location && spatial.length === 0) {
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

  // 4 — the camera's own block, when there is a room to place it in. Verbatim: whatever the shot
  // authored is what the anchor says, so a generic "MCU · slow push-in" stays generic rather than
  // being dressed up as a placement nobody wrote.
  const authoredCamera = shot.camera?.trim() ?? "";
  const cameraAnchor =
    spatial.length > 0 && authoredCamera.length > 0 ? `CAMERA ANCHOR\n${authoredCamera}` : "";

  // 5 — direction: this shot's camera and audio. Per-beat, so in a pass it travels with the beat.
  // The camera is spoken once: if it has been raised into its own anchor block, it does not also
  // trail the description.
  const directionParts: string[] = [];
  if (shot.camera && cameraAnchor.length === 0) directionParts.push(sentence(shot.camera));
  if (shot.audio?.kind && shot.audio.kind !== "silence") {
    directionParts.push(
      sentence(shot.audio.line ? `${shot.audio.kind}: "${shot.audio.line}"` : shot.audio.kind),
    );
  }
  const direction = directionParts.filter((s) => s.length > 0).join(" ");

  // 6 — persistent: what must not drift, once at the end (R-6).
  const persistent = style ? sentence(`Throughout: ${style}`) : "";

  return { summary, standing, spatial, cameraAnchor, body, direction, persistent };
}

/** The blocks joined, one paragraph each, empty ones omitted rather than emitted (R-7). */
export function joinBlocks(blocks: PromptBlocks): string {
  return [
    blocks.summary,
    blocks.standing,
    blocks.spatial,
    blocks.cameraAnchor,
    blocks.body,
    blocks.direction,
    blocks.persistent,
  ]
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
  capability?: string;
}): {
  summary: string;
  standing: string;
  spatial: string;
  beats: Array<{ shot: Shot; text: string }>;
  persistent: string;
} {
  const blocksFor = (shot: Shot): PromptBlocks =>
    assembleBlocks({
      world: input.world,
      sheets: input.sheets,
      scene: input.scene,
      shot,
      ...(input.artDirection !== undefined ? { artDirection: input.artDirection } : {}),
      ...(input.carriedSheetIds !== undefined ? { carriedSheetIds: input.carriedSheetIds } : {}),
      ...(input.capability !== undefined ? { capability: input.capability } : {}),
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
    // The room is stated once for the pass; the camera is stated per beat, because that is what
    // changes between them.
    const beatBody = [blocks.body, blocks.direction].filter((b) => b.length > 0).join(" ");
    return {
      shot: entry.shot,
      text: blocks.cameraAnchor.length > 0 ? `${blocks.cameraAnchor}\n${beatBody}` : beatBody,
    };
  });
  return {
    summary: lead?.summary ?? "",
    standing: standing.join(" "),
    // Derived from the scene, so a pass keeps its room even when every beat in it is overridden —
    // the same reason the standing block survives an overridden beat today.
    spatial: input.scene.inherits?.location !== undefined ? (lead?.spatial ?? spatialFromScene()) : "",
    beats,
    persistent: lead?.persistent ?? "",
  };

  function spatialFromScene(): string {
    return input.capability === "video" ? (spatialLayoutFor(input.scene, input.sheets) ?? "") : "";
  }
}

/** The assembled form: cited sheets, the scene's location, the tone, the shot's direction. */
export function assemblePrompt(
  world: WorldMeta,
  sheets: Sheet[],
  scene: Scene,
  shot: Shot,
  artDirection?: string,
  carriedSheetIds?: ReadonlySet<string>,
  capability?: string,
): string {
  return joinBlocks(
    assembleBlocks({
      world,
      sheets,
      scene,
      shot,
      ...(artDirection !== undefined ? { artDirection } : {}),
      ...(carriedSheetIds !== undefined ? { carriedSheetIds } : {}),
      ...(capability !== undefined ? { capability } : {}),
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
  capability?: string,
): { text: string; overridden: boolean } {
  // An override owns every word of its body, including whatever it says about the room and the
  // camera. Nothing generated is merged into it (D10's reasoning, one layer up).
  if (shot.promptOverride) return { text: shot.promptOverride.text, overridden: true };
  return {
    text: assemblePrompt(world, sheets, scene, shot, artDirection, carriedSheetIds, capability),
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
  /**
   * For a location sheet: the panel names top to bottom, read off the compilation actually
   * being sent rather than the kit's current views (#243). One image arrives carrying several
   * angles, and a model given no map treats the stack as a collage to blend.
   */
  panels?: readonly string[];
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
/**
 * The panel map for a location sheet (#243): which angle is where in the stacked image. Named
 * top and bottom because those are the two positions a model can locate without counting, and
 * the count is what a long stack gets wrong.
 */
export function panelMapPhrase(names: readonly string[]): string {
  const parts = names.map((name, index) => {
    const position =
      index === 0
        ? "panel 1 (top)"
        : index === names.length - 1
          ? `panel ${index + 1} (bottom)`
          : `panel ${index + 1}`;
    return `${position}, ${name}`;
  });
  return `location sheet: ${parts.join("; ")}`;
}

function rolePhraseFor(sheet: Sheet, decision: AttachmentDecision): string {
  if (sheet.type === "location") {
    // The map replaces the generic phrase rather than joining it: a sheet *is* the environment
    // reference, and saying so twice buys nothing the panel names do not already say.
    if (decision.panels && decision.panels.length > 0) return panelMapPhrase(decision.panels);
    return "location reference — environment and composition";
  }
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
  /**
   * The shots one clip covers, for a whole-scene pass. Silence is a property of the output, so a
   * pass is silent only when every shot in it is: one spoken beat among four makes the clip a
   * clip with audio. Absent falls back to `shot`, which is the single-shot case.
   */
  shots?: readonly Shot[];
  audioDesign?: AudioDesign;
  /**
   * The merged world-then-production policy (#244). Absent — a preview assembled before either
   * was resolved — behaves exactly as it did before this existed, which is the only safe reading
   * of "nobody told me": state no constraint rather than invent one.
   */
  constraints?: ReturnType<typeof standingConstraints>;
  /**
   * Raw byte size of each attachable reference file, measured by the caller (SPEC-019 R-43).
   *
   * Planning stays pure — it cannot stat a file — so the sizes are supplied. Absent means the
   * payload cannot be checked here, and the check falls back to the transport, which is the
   * situation R-43 exists to end rather than one it can fix on its own.
   */
  referenceBytes?: Record<string, number>;
  /** The transport's inline ceiling in bytes, when the caller knows it. */
  payloadCeilingBytes?: number;
}

/**
 * The negatives, derived from the production rather than authored per shot (R-9, D10). A
 * per-shot negative is a per-shot thing to forget, and the failure stays silent until an export
 * has titles burned into the picture.
 */
/**
 * The standing constraints a dispatch carries, world first and then production (#244, turn 59).
 *
 * One function, because the production screen shows this and dispatch sends it. Two ways of
 * computing the same merge is how a screen comes to promise something the request does not say —
 * and the whole value of writing a policy down is that it is the same policy everywhere.
 *
 * A production may only strengthen: `musicPolicy` can say `environmental-only` and nothing else,
 * so the merge is a floor rather than a choice. Failure modes are concatenated, world first,
 * because the world's are the ones every production is entitled to assume.
 */
export function standingConstraints(
  direction: { audio?: AudioPolicy; failureModes?: readonly string[] } | null | undefined,
  production?: { musicPolicy?: "environmental-only"; failureModes?: readonly string[] } | null,
): { music: AudioPolicy["music"]; subtitles: "never"; failureModes: string[] } {
  const worldMusic = direction?.audio?.music ?? DEFAULT_AUDIO_POLICY.music;
  return {
    music: production?.musicPolicy === "environmental-only" ? "environmental-only" : worldMusic,
    subtitles: "never",
    failureModes: [...(direction?.failureModes ?? []), ...(production?.failureModes ?? [])],
  };
}

export function derivedNegatives(input: NegativeInput): string | null {
  if (input.capability !== "video") return null;
  // Always. A take is immutable, so burned-in text is damage with no version of the take without
  // it; no surface asks for subtitles and the cut renders its own titles (R-10, D8).
  const parts = ["No subtitles."];
  // Silence has to be said. Omitting the audio direction asks for a clip with no stated
  // soundtrack, which is a clip whose soundtrack the model chooses.
  const covered = input.shots ?? (input.shot ? [input.shot] : []);
  const silent = covered.length > 0 && covered.every((s) => s.audio?.kind === "silence");
  if (silent) {
    parts.push("No audio.");
  } else if (input.audioDesign?.scoreTrack === true || input.constraints?.music === "environmental-only") {
    // Score only. Environmental and action sound belong to the shot and replacing them would
    // mean sourcing foley for every clip (R-11, D9).
    //
    // Now reachable two ways (#244): a cut that composes its own score has always implied it, and
    // a world or production may now say it standing, before any cut exists. The condition is an
    // or rather than a replacement — a policy that stopped applying the moment somebody added a
    // score track would be a policy that switches itself off exactly when it matters most.
    parts.push("No background music — environmental and action sound only.");
  }
  // Standing failure modes last, after the audio direction: they are the world's accumulated
  // "this keeps going wrong", and a model reading in order should meet the specific request, then
  // what must not happen to it.
  for (const mode of input.constraints?.failureModes ?? []) parts.push(mode);
  return parts.join(" ");
}

// ---------------------------------------------------------------------------
// Final composition: what the planner composes, the planner keeps (D3)
// ---------------------------------------------------------------------------

export interface PromptParts {
  /**
   * The shape of the clip being asked for, stated first (see `passStructure`). Only a whole-scene
   * pass has one; a single shot's length and frame are the request's own parameters and there are
   * no boundaries inside it to describe.
   */
  structure?: string | null;
  /** Machine-composed, outside the override (R-3). */
  preamble: string | null;
  /** The override when present, else the assembled blocks (SPEC-012 R-15). */
  body: string;
  /** Machine-composed, appended after the body, outside the override (R-13). */
  negatives: string | null;
}

/**
 * The text that actually goes over the wire. The override owns the direction; the structure
 * states the shape of the clip, the preamble describes the payload and the negatives describe the
 * delivery, and none of those three is authored intent.
 */
export function composePrompt(parts: PromptParts): string {
  return [parts.structure ?? null, parts.preamble, parts.body, parts.negatives]
    .map((part) => part?.trim() ?? "")
    .filter((part) => part.length > 0)
    .join("\n\n");
}

/**
 * The pass's shape, said in the prompt rather than left to the parameters.
 *
 * A pass is one clip that we then cut at `shotPlan`'s boundaries (R-19, D11). Those boundaries
 * are only sound if the model divides the clip where we are going to: a request that carries
 * "14 seconds" as a parameter and says nothing in the prompt is a request to compose 14 seconds
 * however it likes, and the cuts then land on whatever it happened to do.
 *
 * The seconds are the seconds actually asked for, not the seconds planned — a pass snapped up to
 * the route's next length is longer than its shots, and the last one absorbs the difference
 * (`coverPlan`), so that is the clip being described.
 */
export function passStructure(input: {
  shotCount: number;
  askedSec: number;
  aspect?: string | undefined;
}): string | null {
  if (input.shotCount < 2) return null;
  const frame = input.aspect ? `, ${input.aspect}` : "";
  return `One continuous clip: ${input.askedSec}s${frame}, ${input.shotCount} shots. Cut between shots only at the boundaries given below, in that order.`;
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
  const panels = locationSheetPanels(kit, designated);
  return {
    sheetId: sheet.id,
    file: `references/${sheet.id}/${designated.file}`,
    mode: "designated",
    role,
    staleGap: stale
      ? `model sheet is v${designated.sheetVersion}; ${sheet.name} is at v${sheet.version}`
      : null,
    ...(panels ? { panels } : {}),
  };
}

/**
 * The panel names of a location sheet, in the order they were composed into it. Read off the
 * compilation's own tile list and not the kit's current views, so the map describes the image
 * being sent even if the views have moved on since (#243).
 */
function locationSheetPanels(kit: ReferenceKit, designated: Compilation): string[] | null {
  if (designated.format !== "location-sheet") return null;
  const views = kit.locationViews ?? [];
  const names = designated.tiles.map((file) => views.find((view) => view.file === file)?.name);
  // A tile with no view behind it means the map would misname a panel, which is worse than no
  // map at all — the model would trust it and bind the wrong angle.
  return names.every((name): name is string => name !== undefined) ? names : null;
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
  /**
   * Cast owned by a *different* production (SPEC-020 R-6).
   *
   * The mention resolved — scope is not consulted at resolution time, deliberately (R-5, D3), so
   * a description that names another production's one-off still finds the sheet and still
   * dispatches. This is where the user finds out, which is the moment money moves, and it is
   * named rather than blocked for the same reason a retired citation is: it may well be what
   * they meant.
   */
  foreignGuests: Array<{ name: string; owner: string }>;
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
  /**
   * The scene was drafted under one model family's guidance and is being dispatched to another
   * (SPEC-019 R-21, D26). Null when they agree, when the scene records no skill, or when there
   * is nothing to compare.
   *
   * Recording the skill on the draft is not enough on its own: SPEC-008 R-21 lets any dispatch
   * override the routed model, so a scene written for one family reaches another without the
   * drafting rule ever being broken. This is where that shows up.
   */
  skillFamilyMismatch: { draftedFor: string; dispatchingTo: string | null; skillId: string } | null;
  /**
   * References totalling more than the transport will carry (R-43, D37). Unlike everything else
   * here this one is not merely named: a request over the ceiling is one the client already
   * refuses, so the dialog must not let it be committed.
   */
  payloadOverflow: PayloadVerdict | null;
  /** Subjects past the model's stated reliable range — carried anyway, and said so (R-42). */
  subjectsOverRange: BudgetResult["subjectsOverRange"];
}

/**
 * Does the guidance this scene was written under match the model about to shoot it (R-21)?
 *
 * A scene with no recorded skill never mismatches — it was drafted under general guidance, which
 * is guidance for no family in particular and therefore wrong for none. A model with no declared
 * family does mismatch a scene that has one: shots written to one family's conventions are being
 * sent somewhere those conventions are not known to apply, and that is worth a sentence before
 * money moves.
 */
export function skillFamilyMismatch(
  scene: Scene,
  model: ManifestModel,
): DispatchWarnings["skillFamilyMismatch"] {
  const drafted = scene.draftedWith;
  if (drafted === undefined) return null;
  if (model.family === drafted.family) return null;
  return {
    draftedFor: drafted.family,
    dispatchingTo: model.family ?? null,
    skillId: drafted.skillId,
  };
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
  /**
   * Raw byte size of each attachable reference file, measured by the caller (SPEC-019 R-43).
   *
   * Planning stays pure — it cannot stat a file — so the sizes are supplied. Absent means the
   * payload cannot be checked here, and the check falls back to the transport, which is the
   * situation R-43 exists to end rather than one it can fix on its own.
   */
  referenceBytes?: Record<string, number>;
  /** The transport's inline ceiling in bytes, when the caller knows it. */
  payloadCeilingBytes?: number;
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
  /**
   * Which pictures steer this dispatch, and why (SPEC-019 R-26). Stated rather than offered as a
   * choice: storyboard input is loose where keyframe input aligns, and nobody should have to know
   * which is stricter in order to get the better one.
   */
  steering: ReferenceSteering;
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
      model.capability,
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
          // A pass is one clip, so its negatives are the clip's. Silence is still stated, but
          // only when the whole clip is silent — one spoken beat among four is not a silent pass.
          negatives: derivedNegatives({
            capability: model.capability,
            shots: pass.plan
              .map((entry) => scene.shots.find((s) => s.id === entry.shotId))
              .filter((s): s is Shot => s !== undefined),
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
    foreignGuests: (() => {
      // The cast is `@` mentions, but a scene also cites its inherited location, which never
      // enters `resolved.cast` and which `budgetFor` deliberately carries into the references and
      // the prompt. Warning only on mentions would let a scene inherit and dispatch another
      // production's guest place in silence, unless the author redundantly mentioned it in a shot.
      const inherited = scene.inherits?.location;
      const cited = [
        ...resolved.cast.map((c) => c.sheet),
        ...(inherited !== undefined ? sheets.filter((s) => s.id === inherited) : []),
      ];
      const seen = new Set<string>();
      return cited.flatMap((sheet) => {
        const owner = sheet.production;
        if (owner === undefined || owner === input.productionId) return [];
        if (seen.has(sheet.id)) return [];
        seen.add(sheet.id);
        return [{ name: sheet.name, owner }];
      });
    })(),
    overlongShots,
    skillFamilyMismatch: skillFamilyMismatch(scene, model),
    subjectsOverRange: sceneBudget.subjectsOverRange,
    payloadOverflow: (() => {
      const sizes = input.referenceBytes;
      const ceiling = input.payloadCeilingBytes;
      if (sizes === undefined || ceiling === undefined) return null;
      const carried =
        mode === "whole-scene"
          ? passReferences.flatMap((pass) => pass.bound.map((reference) => reference.file))
          : shots.flatMap((entry) => entry.bound.map((reference) => reference.file));
      const raw = [...new Set(carried)].reduce((total, file) => total + (sizes[file] ?? 0), 0);
      const verdict = payloadVerdict(raw, ceiling);
      return verdict.over ? verdict : null;
    })(),
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
    steering: chooseReferenceSteering({ scene, selections, model }),
    warnings,
  };
}
