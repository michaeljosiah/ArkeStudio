import { dialogueSlots, type DialogueSlot } from "./dialogue-timing.js";
import type { ProductionBundle } from "./client-state.js";
import { resolvedAuthoredDuration, DEFAULT_SHOT_SEC } from "./scene.js";
import { planCharacterAudio, characterAudioInstructions, type CharacterAudioPlan, type FrozenPerformanceAudio, type FrozenMasterAudio, masterPerformanceShotIds } from "./audio-reference.js";
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
  carriesVideoReferences,
  referenceBudget,
  type BudgetCandidate,
  type BudgetResult,
  type PayloadVerdict,
} from "./reference-budget.js";
import { mappedReferenceKinds } from "./provider.js";
import {
  aspectSupport,
  continueDispatchFor,
  dispatchDuration,
  durationLimitsFor,
  durationOptions,
  estimateMicroUsd,
  frameDispatchFor,
  modeUnavailableReason,
  pricedDuration,
  sceneImageOutput,
  type DurationChoice,
  type ManifestModel,
  type SizeTier,
  type TaskMode,
} from "./manifest.js";
import type { ArtifactSidecar } from "./artifact.js";
import { chooseReferenceSteering, type ReferenceSteering } from "./storyboard.js";
import { orderedShots, type SceneRecord } from "./scene-flow.js";
import { effectiveFraming, UNTITLED_SHOT } from "./scene.js";
import { packBoards, packShotsFor } from "./boards.js";
import type { Shot, ShotFraming } from "./scene.js";
import type { Selections } from "./scene.js";
import type { Take } from "./take.js";
import type { Sheet, WorldMeta } from "./world.js";
import type { Prop } from "./prop.js";

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

/** The slug a prop is mentioned by: `@polaroid` for a prop named "Polaroid" (issue 536). */
export function propSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** One prop as a shot dispatches it: turn 105's five fields, plus the names a screen shows. */
export interface ShotPropResolution {
  propId: string;
  propName: string;
  stateId: string | null;
  stateName: string | null;
  referenceId: string | null;
  /** World-relative, like an attachment's file; null dispatches on the prose alone. */
  referenceFile: string | null;
  resolutionSource: "shot" | "override" | "unresolved";
  overrideSource: "manual" | null;
}

/**
 * Which props a shot cites and the state each dispatches in (design turn 105; issue 536).
 *
 * A prop is cited by mention or by an entry on the shot's own control, and the control is the
 * one durable value: nothing carries forward from an earlier shot (`timelineRule:
 * manual-per-dispatch`). No entry, or an entry naming a state the prop no longer has, resolves
 * `unresolved` — reported, never guessed — and a state with no accepted reference dispatches on
 * the prose alone rather than borrowing an unrelated image.
 */
export function resolvePropStates(
  shot: Shot,
  props: readonly Prop[],
  overrides?: Readonly<Record<string, string>>,
): ShotPropResolution[] {
  if (props.length === 0) return [];
  const mentioned = parseMentions(shot.description);
  const cited = props.filter(
    (prop) =>
      mentioned.includes(propSlug(prop.name)) || shot.propStates?.some((entry) => entry.propId === prop.id) === true,
  );
  return cited.map((prop) => {
    const override = overrides?.[prop.id];
    const chosen = override ?? shot.propStates?.find((entry) => entry.propId === prop.id)?.stateId;
    const state = chosen === undefined ? undefined : prop.states.find((candidate) => candidate.id === chosen);
    return {
      propId: prop.id,
      propName: prop.name,
      stateId: state?.id ?? null,
      stateName: state?.name ?? null,
      referenceId: state?.reference?.id ?? null,
      referenceFile: state?.reference !== undefined ? `references/${prop.id}/${state.reference.file}` : null,
      resolutionSource: state === undefined ? "unresolved" : override !== undefined ? "override" : "shot",
      overrideSource: state !== undefined && override !== undefined ? "manual" : null,
    };
  });
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
  const trimmed = text.trim();
  if (trimmed.length === 0) return "";
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
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

/** The production's visual language, nearest first; blank overrides mean inherit. */
export function productionStyleFor(
  production: { styleOverride?: string } | null | undefined,
  worldArtDirection?: string,
): string | undefined {
  const override = production?.styleOverride?.trim();
  if (override) return override;
  const inherited = worldArtDirection?.trim();
  return inherited || undefined;
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
  /** This shot's cinematic intent, camera, authored timing and audio — part of the beat, in a pass. */
  direction: string;
  /** Empty for shot prompts: the production look is input to the writer (issue 942). */
  persistent: string;
}

export interface AssembleInput {
  world: WorldMeta;
  sheets: Sheet[];
  scene: SceneRecord;
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
export function spatialLayoutFor(scene: SceneRecord, sheets: readonly Sheet[]): string | null {
  const locationId = scene.inherits?.location;
  const location = locationId !== undefined ? sheets.find((sheet) => sheet.id === locationId) : undefined;
  if (location?.type !== "location") return null;

  const look = location.sections.find((section) => section.heading === "Look")?.body.trim();
  if (look === undefined || look.length === 0) return null;

  return `SPATIAL LAYOUT\n${location.name} — ${look.replace(/\s+/g, " ")}`;
}

/** The blocks, before they are joined (R-5). */
/**
 * The structured camera as one line a model reads as camera grammar.
 *
 * Order is the order a crew says it in — size, angle, lens, focus, movement, pace — then the
 * light and the look, which are conditions rather than operations. Only what is set is said: an
 * absent lens must not become "default lens", which is a real instruction to a model that reads
 * everything it is given.
 */
export function framingClause(framing: ShotFraming): string {
  const said = [
    framing.size,
    framing.angle,
    framing.lens,
    framing.focus,
    framing.movement,
    framing.pace,
    framing.lighting,
    framing.timeOfDay,
    framing.grade,
  ]
    .map((value) => value?.trim() ?? "")
    .filter((value) => value.length > 0);
  return said.length > 0 ? said.join(", ") : "";
}

export function assembleBlocks(input: AssembleInput): PromptBlocks {
  const { sheets, scene, shot } = input;
  const carried = input.carriedSheetIds ?? new Set<string>();
  const { cast } = resolveCast(shot.description, sheets);
  const location =
    scene.inherits?.location !== undefined
      ? sheets.find((s) => s.id === scene.inherits!.location)
      : undefined;

  // Local subjects and setting remain an editable seed for shots without an authored prompt.
  // A shot still carrying its birth title has no name, and contributes none: the literal
  // `Untitled shot.` was reaching the model as content on every unnamed shot in a scene.
  const who = cast.map((c) => c.sheet.name);
  const whoClause =
    who.length === 0
      ? ""
      : who.length === 1
        ? who[0]!
        : `${who.slice(0, -1).join(", ")} and ${who[who.length - 1]!}`;
  const where = [location?.name, scene.inherits?.timeOfDay].filter((s): s is string => !!s).join(", ");
  const title = shot.title.trim() === UNTITLED_SHOT ? "" : shot.title;
  const summary = [
    whoClause && where ? sentence(`${whoClause} at ${where}`) : sentence(whoClause || where),
    sentence(title),
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
  const authoredCamera = input.capability === "image" ? "" : (shot.camera?.trim() ?? "");
  /*
   * The structured camera, said out loud (2026-08-23).
   *
   * `framing` is nine authored fields — size, angle, lens, focus, movement, pace, lighting, time
   * of day, grade — edited on the shot sheet, versioned, shown in the UI, and until now dropped
   * before the prompt was built: the word `framing` appeared nowhere in this file. A director set
   * a 28mm low-angle slow push and the model was told whatever the prose happened to imply.
   *
   * Resolved against the scene's defaults rather than read raw, because presence is the override
   * flag (turn 97) — a shot that inherits the scene's lens must still say the lens.
   */
  const framing = effectiveFraming(scene, shot);
  const framingLine = framingClause(input.capability === "image" ? { ...framing, movement: undefined, pace: undefined } : framing);
  const cameraLines = [authoredCamera, framingLine].filter((line) => line.length > 0).join("\n");
  const cameraAnchor = spatial.length > 0 && cameraLines.length > 0 ? `CAMERA ANCHOR\n${cameraLines}` : "";

  // 5 — direction: this shot's intent, camera, local timing and audio. Per-beat, so in a pass it
  // travels with the beat. Authored timing labels never become the pass's machine boundaries.
  // The camera is spoken once: if it has been raised into its own anchor block, it does not also
  // trail the description.
  const directionParts: string[] = [];
  if (shot.visualFacts) {
    directionParts.push(`Authored on-screen composition: ${shot.visualFacts.composition}.`);
    const castFacts = shot.visualFacts.onScreenCharacters.map(c => `${sheets.find(s => s.id === c.characterId)?.name ?? c.characterId}: ${c.presentation}, ${c.depth}`);
    directionParts.push(castFacts.length ? `Authored on-screen cast: ${castFacts.join("; ")}.` : "No characters are authored on screen.");
  }
  const cinematicIntent = shot.intent?.trim() ?? "";
  if (cinematicIntent.length > 0) {
    directionParts.push(
      sentence(`Cinematic intent (infer unset camera choices from this; explicit camera settings win): ${cinematicIntent}`),
    );
  }
  // Two sentences, not one run-on: without the anchor block to separate them, "facing the doorway
  // medium close-up, low" reads as a single garbled instruction.
  if (cameraAnchor.length === 0) {
    if (authoredCamera.length > 0) directionParts.push(sentence(authoredCamera));
    if (framingLine.length > 0) directionParts.push(sentence(framingLine));
  }
  if (input.capability !== "image") {
    for (const beat of shot.beats ?? []) {
      const span = beat.span.trim();
      const text = beat.text.trim();
      if (span.length > 0 && text.length > 0) {
        directionParts.push(sentence(`Shot timing ${span}: ${text}`));
      }
    }
  }
  if (input.capability !== "image" && shot.audio?.kind && shot.audio.kind !== "silence") {
    directionParts.push(
      sentence(shot.audio.line ? `${shot.audio.kind}: "${shot.audio.line}"` : shot.audio.kind),
    );
  }
  /*
   * The rest of the soundtrack, beside the action it belongs to.
   *
   * `ambience` and `effects` are authored on the shot sheet and were read by nothing. They sit
   * here rather than in a block at the end because sound direction works next to the thing that
   * makes the sound — one global "market noise" applies it to the quiet room two shots later.
   */
  //
  // Silence wins over both. The Sound fields stay editable on a shot directed silent, so an
  // ambience left behind from before the shot went quiet would otherwise be asked for in the same
  // prompt that `derivedNegatives` ends with "No audio." — a clip told to be silent and to carry
  // a generator. The direction that contradicts the negative is the one that goes.
  const silent = input.capability === "image" || shot.audio?.kind === "silence";
  const ambience = silent ? "" : (shot.audio?.ambience?.trim() ?? "");
  const effects = silent ? "" : (shot.audio?.effects?.trim() ?? "");
  if (ambience.length > 0) directionParts.push(sentence(`Ambience: ${ambience}`));
  if (effects.length > 0) directionParts.push(sentence(`Sound: ${effects}`));
  const direction = directionParts.filter((s) => s.length > 0).join(" ");

  // The look informs Arke when it writes the shot. Repeating production-wide direction
  // here drowned out the shot-specific words (issue 942). Mechanical constraints stay outside.
  const persistent = "";

  return { summary, standing, spatial, cameraAnchor, body, direction, persistent };
}

/** One board prompt: shared scene context, then the ordered beats it must hold together. */
export function assembleBoardPrompt(input: {
  world: WorldMeta;
  sheets: Sheet[];
  scene: SceneRecord;
  shots: readonly Shot[];
  aspect: string;
  artDirection?: string;
}): string {
  const location =
    input.scene.inherits?.location === undefined
      ? undefined
      : input.sheets.find((sheet) => sheet.id === input.scene.inherits?.location);
  const contexts = input.shots.map((shot) =>
    assembleBlocks({
      world: input.world,
      sheets: input.sheets,
      scene: input.scene,
      shot,
      ...(input.artDirection !== undefined ? { artDirection: input.artDirection } : {}),
      capability: "image",
    }),
  );
  // A board is still imagery. The look is writer context, not a repeated cell instruction.
  const context = [
    location?.name,
    input.scene.inherits?.timeOfDay,
    input.scene.defaults?.lighting,
    input.aspect,
    ...contexts.flatMap((blocks) => [blocks.spatial, blocks.standing]),
  ].filter((part, index, all): part is string =>
    typeof part === "string" && part.trim().length > 0 && all.indexOf(part) === index,
  );
  const head = `${context.join(", ")}. Continuous cast, light and grade across every cell.`;
  const beats = input.shots.map((shot, index) => {
    if (shot.promptOverride && shot.promptOverride.capability !== "video") return `${index + 1}. ${shot.promptOverride.text}`;
    const blocks = contexts[index]!;
    const framing = effectiveFraming(input.scene, shot);
    const camera = [framing.size, framing.lens].filter(Boolean).join(", ");
    const direction = [blocks.cameraAnchor, blocks.direction].filter(Boolean).join(" ");
    return `${index + 1}. ${camera.length > 0 ? `${camera} — ` : ""}${blocks.body}${direction.length > 0 ? ` ${direction}` : ""}`;
  });
  return [head, ...beats].join("\n\n");
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
  scene: SceneRecord;
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
  const lead = first && !first.prompt.overridden ? blocksFor(first.shot) : null;
  // The standing description is the union across the pass, deduplicated: one location look, and
  // each uncarried subject named once however many beats they appear in.
  const standing: string[] = [];
  for (const entry of input.entries) {
    if (entry.prompt.overridden) continue;
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
    // An authored pass already describes its room; only un-authored beats need a seed.
    spatial: input.entries.some(entry => !entry.prompt.overridden) ? spatialFromScene() : "",
    beats,
    persistent: lead?.persistent ?? "",
  };

  function spatialFromScene(): string {
    return input.capability === "video" ? (spatialLayoutFor(input.scene, input.sheets) ?? "") : "";
  }
}

/** The assembled form: cited sheets, scene and world context, and all authored shot direction. */
export function assemblePrompt(
  world: WorldMeta,
  sheets: Sheet[],
  scene: SceneRecord,
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
  scene: SceneRecord,
  shot: Shot,
  artDirection?: string,
  carriedSheetIds?: ReadonlySet<string>,
  capability?: string,
): { text: string; overridden: boolean } {
  // An override owns every word of its body, including whatever it says about the room and the
  // camera. Nothing generated is merged into it (D10's reasoning, one layer up).
  if (shot.promptOverride && (!capability || !shot.promptOverride.capability || shot.promptOverride.capability === capability)) {
    return { text: shot.promptOverride.text, overridden: true };
  }
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



/**
 * Greedy, order-preserving; a shot is never split (D9). Oversize disables whole-scene (D10).
 *
 * Route-aware (issue #390): a pass that carries references dispatches on the reference route,
 * whose ceiling can be shorter — Wan 2.7 makes 15 seconds from text and 10 from references. The
 * pack must respect the ceiling of the route each pass will actually take, so the cap is
 * dynamic: the moment a pass contains one reference-carrying shot, the whole pass is held to
 * `referenceCapSec`, retroactively — a pass already past that line closes before the shot that
 * would shorten it joins. One deterministic forward walk; no pack-then-discover-failure.
 */
export function packScene(
  shots: Shot[],
  capSec: number,
  opts?: {
    referenceCapSec?: number;
    shotCarriesReferences?: (shotId: string) => boolean;
    /**
     * Shot ids a pass may not run through (SPEC-035 R-13): the board boundaries — continuity
     * breaks and the author's own splits and merges. A pass never spans one, and a route cap
     * may still subdivide the board between them into several passes.
     */
    forceBreakBefore?: ReadonlySet<string>;
  },
): PackResult {
  const referenceCap = opts?.referenceCapSec ?? capSec;
  const carries = opts?.shotCarriesReferences ?? (() => false);
  const forced = opts?.forceBreakBefore;
  const passes: Pass[] = [];
  let current: ShotPlanEntry[] = [];
  let cursor = 0;
  let total = 0;
  let currentHasReferences = false;
  const close = () => {
    if (current.length === 0) return;
    passes.push({ index: passes.length + 1, durationSec: cursor, plan: current });
    current = [];
    cursor = 0;
    currentHasReferences = false;
  };
  for (const shot of shots) {
    const duration = resolvedAuthoredDuration(shot);
    const shotRefs = carries(shot.id);
    const shotCap = shotRefs ? referenceCap : capSec;
    if (duration > shotCap) {
      return {
        ok: false,
        oversizeShot: { shotId: shot.id, number: shot.number, durationSec: duration, capSec: shotCap },
      };
    }
    // A board boundary closes the pass before the cap is even consulted: continuity and the
    // author's seams decide where a pass MAY run, the route cap decides how far it CAN.
    if (forced?.has(shot.id) === true) close();
    // The cap the pass would live under if this shot joined it.
    const effectiveCap = currentHasReferences || shotRefs ? referenceCap : capSec;
    if (cursor + duration > effectiveCap) close();
    current.push({ shotId: shot.id, number: shot.number, startSec: cursor, endSec: cursor + duration });
    cursor += duration;
    total += duration;
    currentHasReferences = currentHasReferences || shotRefs;
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
  mode: "designated" | "main-photo" | "scoped-look" | "sketch-citation" | "prop-state";
  role: "primary" | "secondary";
  staleGap: string | null;
  /** A prop-state reference has no sheet to name; `sheetId` holds the prop id (issue 536). */
  prop?: { name: string; state: string };
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
  /**
   * The attachment that chose this file, kept structured (design 67).
   *
   * `rolePhrase` says the same thing in the prompt's words, and a screen wanting to state that a
   * character rides in a production's own look had to match that prose to find out — a sentence
   * written for a model, read as an enum. The screens read this instead.
   */
  mode: AttachmentDecision["mode"];
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
    if (decision.prop !== undefined) {
      bound.push({
        index: bound.length + 1,
        sheetId: decision.sheetId,
        subject: decision.prop.name,
        file: decision.file,
        kind: "image",
        rolePhrase: `prop reference — the ${decision.prop.name}, ${decision.prop.state}`,
        mode: decision.mode,
        sameSubjectAs: null,
      });
      continue;
    }
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
      mode: decision.mode,
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

/**
 * Which surface a staged reference belongs to (design 67).
 *
 * Keyed rather than one field per surface, because the six of them want the same thing and a
 * seventh will too. The key becomes a directory name under `incoming/staged-refs/`, so it is
 * built from a fixed vocabulary and a slug rather than from anything a user typed.
 */
export type StagedReferenceSurface =
  | "world-image"
  | "master-look"
  | "main-photo"
  | "character-sheet"
  | "look"
  | "location-view";

/**
 * The key a surface stages under. `--` rather than `:` because this is a folder on Windows too,
 * where a colon in a name is not a name at all — it is a drive letter or an alternate stream.
 */
export function stagedReferenceKey(surface: StagedReferenceSurface, sheetId?: string): string {
  return sheetId === undefined ? surface : `${surface}--${sheetId}`;
}

/**
 * A key as it is allowed to arrive over the wire.
 *
 * Anchored and character-classed rather than free text, because the coordinator turns it into a
 * path: `..`, a separator or a drive letter here would be a directory traversal wearing the name
 * of a feature. The surfaces are enumerated and the slug half is the same shape as every other
 * sheet id.
 */
export const STAGED_REFERENCE_KEY = /^(world-image|master-look|main-photo|character-sheet|look|location-view)(--[a-z0-9]+(?:-[a-z0-9]+)*)?$/;

/**
 * How many previews one image generation may ask for (design 65).
 *
 * Four is what fits the dialog's preview column as a 2×2 at a size you can actually judge, and it
 * was already the cap main photo, looks and location views each spelled as a bare `4`. Named once
 * so the frame that validates it, the control that offers it and the request builder that fans it
 * out cannot drift — every one of them charges per image, so the number is money, not layout.
 */
export const MAX_IMAGE_PREVIEWS = 4;

/**
 * The world's key image, from what the world already says about itself.
 *
 * There is no clever prompt here on purpose: the logline is the author's sentence and it goes in
 * as written. Adding adjectives of our own would put the studio's taste in front of theirs.
 *
 * It lives in contracts rather than beside the coordinator's other request builders because both
 * ends now need it (design 64): the coordinator composes it when nothing else writes one, and the
 * art-direction page opens its prompt box with it, so what the author edits is exactly what the
 * app would otherwise have sent.
 */
export function worldImagePrompt(
  meta: { name: string; logline?: string; tone?: string; genre?: string },
  direction?: { description?: string },
): string {
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

/**
 * The standing-constraint suffix a reference or board prompt carries, or "" (#244, round 2).
 *
 * Scene dispatch reaches the failure modes through planScene; nothing else did, so key art,
 * main photos, character sheets, looks, location views and storyboards were all outside a rule
 * named "what every generation must obey". One composer keeps the ordering and the byte-shape
 * identical everywhere — and returns "" rather than a lone space, so a world with no failure
 * modes leaves every prompt byte-identical to what it was before this existed.
 */
export function imageConstraintSuffix(
  direction: { audio?: AudioPolicy; failureModes?: readonly string[] } | null | undefined,
  production?: { musicPolicy?: "environmental-only"; failureModes?: readonly string[] } | null,
): string {
  const negatives = derivedNegatives({ capability: "image", constraints: standingConstraints(direction, production) });
  return negatives === null ? "" : ` ${negatives}`;
}

/**
 * A keep-out said as an instruction, whatever the author typed (codex, 2026-08-23).
 *
 * The field's own placeholder is a noun list — "Modern boats, text, lens flare" — and appending
 * that verbatim produces "No subtitles. Modern boats, text, lens flare", which names three things
 * and forbids none of them. That is precisely the failure the field exists to prevent, and the
 * one the skill warns about: a thing named is a thing you handed the model.
 *
 * An author who already wrote a sentence keeps it. A list becomes one.
 */
function asExclusion(keepOut: string): string {
  const trimmed = keepOut.replace(/\s+/g, " ").trim();
  // Already an instruction: "No wristwatch", "Never show the harbour", "Avoid lens flare."
  if (/^(no\b|none\b|never\b|avoid\b|without\b|exclude\b|keep out\b)/i.test(trimmed)) {
    return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
  }
  const body = trimmed.replace(/[.;,]+$/, "");
  return `Do not show: ${body}.`;
}

export function derivedNegatives(input: NegativeInput): string | null {
  const parts: string[] = [];
  // The audio and subtitle clauses are about a clip's soundtrack and its burned-in text, so they
  // are video's alone. A standing failure mode is not: "hands stay whole and countable" and "no
  // lens flare on the harbour lamps" are things a still gets wrong just as readily, and a world
  // that wrote them down meant them for every generation (#244). So the video-only guard moved
  // off the whole function and onto the two clauses that are genuinely video-only.
  if (input.capability === "video") {
    // Always. A take is immutable, so burned-in text is damage with no version of the take
    // without it; no surface asks for subtitles and the cut renders its own titles (R-10, D8).
    parts.push("No subtitles.");
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
  }
  /*
   * What this shot says must not be in it (2026-08-23).
   *
   * `continuity.keepOut` is documented in the schema as "the negative half of the same promise"
   * and was read by nothing — an author wrote what must stay out of frame and it went to disk and
   * no further. It belongs here rather than in the description, because a negative stated inside
   * the prose is a noun the model has been handed: "no coffee cup" puts a coffee cup in the room.
   *
   * Before the world's standing modes, because it is about this shot specifically and the general
   * rule should be the last word.
   */
  for (const shot of input.shots ?? (input.shot ? [input.shot] : [])) {
    const keepOut = shot.continuity?.keepOut?.trim();
    if (keepOut) parts.push(asExclusion(keepOut));
  }
  // Standing failure modes last, after the audio direction: they are the world's accumulated
  // "this keeps going wrong", and a model reading in order should meet the specific request, then
  // what must not happen to it.
  for (const mode of input.constraints?.failureModes ?? []) parts.push(mode);
  // Null rather than "" when there is nothing to say, so a still with no failure modes carries
  // exactly the prompt it carried before this existed.
  return parts.length > 0 ? parts.join(" ") : null;
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
 * These are the content seconds. Provider step padding remains unused source handle after
 * the last boundary; it must not expand a shot or claim authored time.
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

/**
 * The look holding one exact scope, by the rule collisions are resolved with (codex round 4).
 *
 * A world written before attaching displaced can hold two looks claiming one production, and
 * "the first in the array" is a different answer from "the most recently accepted" — so the
 * production's cast row marked one look active while the dispatcher carried the other, which is
 * a false confirmation of the very thing that row exists to confirm. One rule, exported, so the
 * screen and the resolver cannot drift.
 */
export function lookHoldingScope(
  kit: ReferenceKit | null,
  scope: NonNullable<NonNullable<ReferenceKit["looks"]>[number]["attachedTo"]>,
): NonNullable<ReferenceKit["looks"]>[number] | undefined {
  return (kit?.looks ?? [])
    .filter((look) => {
      const held = look.attachedTo;
      if (!held || held.kind !== scope.kind || held.productionId !== scope.productionId) return false;
      return held.kind !== "scene" || scope.kind !== "scene" || held.sceneId === scope.sceneId;
    })
    .reduce<NonNullable<ReferenceKit["looks"]>[number] | undefined>(
      (best, look) => (best === undefined || acceptedAt(look) > acceptedAt(best) ? look : best),
      undefined,
    );
}

/**
 * Acceptance as an instant, never as a string. `IsoDateTimeSchema` admits an offset and optional
 * fractional seconds, and lexical order is neither: `2026-08-02T00:00:00+12:00` sorts above
 * `2026-08-01T23:00:00Z` while being the earlier moment, and `…:00.500Z` sorts below `…:00Z`.
 * Both spellings occur here — the store's clock writes milliseconds, older records do not.
 */
function acceptedAt(look: NonNullable<ReferenceKit["looks"]>[number]): number {
  return Date.parse(look.acceptedAt);
}

export function attachmentFor(
  kit: ReferenceKit | null,
  sheet: Sheet,
  role: "primary" | "secondary" = "primary",
  scope?: { productionId?: string; sceneId?: string },
): AttachmentDecision {
  const scopedLooks = (kit?.looks ?? []).filter((look) => {
    if (!look.attachedTo || !scope?.productionId) return false;
    if (look.attachedTo.productionId !== scope.productionId) return false;
    return look.attachedTo.kind === "production" || look.attachedTo.sceneId === scope.sceneId;
  });
  /*
   * Two rules, so this is total rather than order-dependent (design 67).
   *
   * The narrower scope wins: a look attached to this scene and one attached to the whole
   * production both match, and `.find` answered by array order — so which of the two rode a
   * scene depended on the order the attachments happened to be written in.
   *
   * Within a scope, the most recently accepted wins. Attaching displaces now, so a *new*
   * same-scope collision cannot arise — but worlds written before that rule can already hold
   * two looks claiming one production, and the schema still admits them. Falling back to the
   * first in the array picked the OLDEST, because acceptance appends. An upgraded world would
   * have gone on dispatching the older appearance until somebody happened to reattach.
   */
  const narrower = (look: (typeof scopedLooks)[number]): boolean => look.attachedTo?.kind === "scene";
  const scopedLook = scopedLooks.reduce<(typeof scopedLooks)[number] | undefined>((best, look) => {
    if (best === undefined) return look;
    if (narrower(look) !== narrower(best)) return narrower(look) ? look : best;
    return acceptedAt(look) > acceptedAt(best) ? look : best;
  }, undefined);
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
  /**
   * Shots whose dispatch opens on a durable boundary frame (issue 154), stated before commit.
   * The frame route takes exactly one image, so the sheet references that would otherwise ride
   * along step aside — `setAside` names them, because a subject silently losing its reference
   * image is a change in what money buys.
   */
  framedShots: Array<{ shotId: string; number: number; artifactId: string; setAside: string[] }>;
  /**
   * Frame selections that name something a dispatch must not send (issue 154): an artifact
   * missing from this world, superseded, or not an image at all. Named here and refused at
   * dispatch — a dangling frame silently dropped is a shot that opens on whatever the model
   * invents, which is the failure boundary frames exist to prevent.
   */
  staleFrames: Array<{ shotId: string; number: number; detail: string }>;
  /**
   * Shots that will dispatch as an extension of the previous shot's footage (R-50), stated
   * before commit because it changes what money buys: the same prompt against the same model
   * takes a different route and produces a different thing.
   *
   * `setAside` names what stepped aside, for the reason `framedShots` does. The extend route
   * takes a video and a prompt and declares no image field, so sheet references cannot ride and
   * a selected boundary frame is redundant — continuation already carries the motion the frame
   * was a lossy stand-in for.
   */
  continuedShots: Array<{
    shotId: string;
    number: number;
    fromTakeId: string;
    /** Extended on an extend route, or carried as a motion reference where there is none (issue 852). */
    kind: "extend" | "carry";
    setAside: string[];
  }>;
  /**
   * Shots that asked to continue and cannot, each with its reason (R-51, R-52, R-34).
   *
   * Named rather than silently downgraded. A shot that asked to extend and generates from
   * scratch instead is paid-for footage that does not cut against what came before, and the
   * discovery would otherwise come after the money moved.
   */
  continuationUnavailable: Array<{ shotId: string; number: number; reason: string }>;
  sketchCitations: string[];
  droppedReferences: BudgetResult["dropped"];
  staleModelSheets: string[];
  retiredCitations: string[];
  unknownMentions: string[];
  /**
   * Cited props with no state chosen, or a chosen state with no accepted reference (design turn
   * 105): named before spend, never guessed and never blocking. The shot dispatches on its prose.
   */
  propStates: Array<{
    shotId: string;
    number: number;
    prop: string;
    state: string | null;
    issue: "unresolved" | "missing-reference";
  }>;
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
   * `becauseReferences` says which route set the ceiling (issue #390): a 12s shot fits the text
   * route and not the reference route, and the words have to say so or the fix looks arbitrary.
   */
  overlongShots: Array<{
    shotId: string;
    number: number;
    durationSec: number;
    longestSec: number;
    becauseReferences: boolean;
  }>;
  /** Whole-scene passes over their selected route's ceiling (issue #390), named before commit. */
  overlongPasses: Array<{ passIndex: number; durationSec: number; longestSec: number; becauseReferences: boolean }>;
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
  /**
   * The production's delivery aspect is one the selected route cannot make (issue 389). A
   * refusal, not a warning: the supported shapes are named beside the model, and composition
   * throws rather than letting money move toward footage in the wrong shape.
   */
  aspectUnsupported: { aspect: string; model: string; supported: readonly string[] } | null;
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
  scene: SceneRecord,
  model: ManifestModel,
): DispatchWarnings["skillFamilyMismatch"] {
  const drafted = scene.draftedWith;
  if (drafted === undefined) return null;
  /*
   * Family first, then the models the document named (codex, 2026-08-23).
   *
   * A skill that narrows is guidance for those models and no others. Comparing families alone
   * called 2.5's document a match for 2.0 — same family, opposite advice about the one thing the
   * document is about — which is a warning that stays silent exactly when it is needed.
   */
  if (model.family === drafted.family) {
    if (drafted.models === undefined || drafted.models.includes(model.id)) return null;
    return {
      draftedFor: drafted.models.join(", "),
      dispatchingTo: model.id,
      skillId: drafted.skillId,
    };
  }
  return {
    draftedFor: drafted.family,
    dispatchingTo: model.family ?? null,
    skillId: drafted.skillId,
  };
}

export interface ScenePlanInput {
  timingProduction?: ProductionBundle;
  /** Explicit bypass applies only to this dispatch. */
  audioReferencesDisabled?: boolean;
  performanceReferences?: readonly FrozenPerformanceAudio[];
  masterReferences?: readonly FrozenMasterAudio[];
  world: WorldMeta;
  sheets: Sheet[];
  kits: ReferenceKit[];
  /** The world's props (design turn 105; issue 536): what a shot's `propStates` resolves against. */
  props?: readonly Prop[];
  /**
   * One-shot overrides made before spend, shot id → prop id → state id. Recorded on the take as
   * `override` / `manual` and never written back to the shot (turn 105, `overrideScope: shot`).
   */
  propStateOverrides?: Readonly<Record<string, Readonly<Record<string, string>>>>;
  scene: SceneRecord;
  selections: Selections;
  /**
   * The production's takes, which is how a continuation finds the footage it extends (R-50).
   *
   * Supplied rather than looked up, exactly as `artifacts` is: planning is pure and cannot open
   * a world. Absent means no shot can resolve a continuation — the honest answer for a caller
   * that predates the capability, and the reason the flag alone is never enough to dispatch one.
   */
  takes?: readonly Take[];
  model: ManifestModel;
  resolution?: string;
  /** Stills: the chosen size tier, which becomes real output dimensions at dispatch. */
  tier?: SizeTier;
  /**
   * The production's delivery aspect (issue 389), shaping still dimensions, video payloads and
   * the pass prompt alike. Absent means the documented default behaviour — landscape stills and
   * no aspect on the wire — exactly what every production made before aspect existed got.
   */
  aspect?: string;
  productionId?: string;
  artDirection?: ResolvedArtDirection;
  /**
   * The production's standing constraints, for the merge with the world's (#244). Separate from
   * `productionId` because planning is pure and cannot look a production up — the caller holds
   * the bundle. Absent means the production adds nothing, which is the common case.
   */
  production?: {
    styleOverride?: string;
    musicPolicy?: "environmental-only";
    failureModes?: readonly string[];
  };
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
  /**
   * The world's artifacts, for resolving durable boundary frames (issue 154). Planning stays
   * pure, so the caller hands the shelf in. Absent means frame selections cannot be resolved
   * here at all — no frame travels and none is called stale, which is what a caller that
   * predates boundary frames already expects.
   */
  artifacts?: readonly ArtifactSidecar[];
}

/** The durable still a shot's dispatch opens on (issue 154), resolved from its selection. */
export interface BoundaryFramePlan {
  artifactId: string;
  /** World-relative path, the same shape references travel as. */
  file: string;
  hash: string;
}

export interface ShotDispatchPlan {
  slot?: DialogueSlot;
  authoredDurationSec?: number;
  audioReferences?: CharacterAudioPlan;
  shot: Shot;
  prompt: { text: string; overridden: boolean };
  references: AttachmentDecision[];
  /** The carried assets, numbered in transmission order (R-2). */
  bound: BoundReference[];
  /** Each cited prop as this shot dispatches it (design turn 105; issue 536). */
  propStates: ShotPropResolution[];
  /** Preamble, overridable body and negatives, kept apart so only the body is editable (R-3, R-13). */
  parts: PromptParts;
  budget: BudgetResult;
  estimatedMicroUsd: number;
  /**
   * Present exactly when this dispatch carries a strict start frame (issue 154): the model
   * declares a first-frame route and the shot's selection names a valid image artifact. The
   * frame route takes one image, so a shot that carries this carries no sheet references —
   * `bound` is empty and the warnings name what stepped aside.
   */
  frame?: BoundaryFramePlan;
  /**
   * Present exactly when this dispatch extends the previous shot's footage (SPEC-019 R-50): the
   * shot declared it, the model has a continue route, and the predecessor's accepted take is one
   * a single hop may be built on. The extend route declares no image field at all, so a shot
   * that carries this carries neither sheet references nor a boundary frame — both step aside
   * and the warnings name them.
   */
  continuation?: ContinuationPlan;
}

export interface ScenePlan {
  timingProblems?: string[];
  timingWarnings?: string[];
  mode: "per-shot" | "whole-scene";
  /** The effective production/world visual language frozen into every assembled prompt. */
  effectiveStyle: string;
  /** The normalized production override when it won; compiled into the existing params bag. */
  productionStyleOverride?: string;
  shots: ShotDispatchPlan[];
  passReferences: Array<{
    audioReferences?: CharacterAudioPlan;
    passIndex: number;
    references: AttachmentDecision[];
    budget: BudgetResult;
    /** The pass's carried assets, numbered in transmission order (R-2). */
    bound: BoundReference[];
    /** The clip's derived negatives, computed here so the dialog and the dispatch agree (R-9). */
    negatives: string | null;
    /** The prop states the pass's shots cite, distinct by prop and state (issue 536). */
    propStates: ShotPropResolution[];
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
  /** The delivery aspect these estimates were shaped at (issue 389), carried for the same reason. */
  aspect?: string;
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
  scene: SceneRecord,
  sheets: Sheet[],
  props: readonly Prop[],
): { resolved: ResolvedCast; perShot: Map<string, ResolvedCast> } {
  const perShot = new Map<string, ResolvedCast>();
  const shots = orderedShots(scene);
  const seen = new Map<string, { sheet: Sheet; retired: boolean }>();
  const unknown = new Set<string>();
  // A mention that names a prop is not unknown (issue 536): it resolves one list over.
  const propSlugs = new Set(props.map((prop) => propSlug(prop.name)));
  for (const shot of shots) {
    const cast = resolveCast(shot.description, sheets);
    const resolved = { ...cast, unknown: cast.unknown.filter((slug) => !propSlugs.has(slug)) };
    perShot.set(shot.id, resolved);
    for (const entry of resolved.cast) if (!seen.has(entry.sheet.id)) seen.set(entry.sheet.id, entry);
    for (const u of resolved.unknown) unknown.add(u);
  }
  return { resolved: { cast: [...seen.values()], unknown: [...unknown] }, perShot };
}

function budgetFor(
  cast: ResolvedCast["cast"],
  kits: ReferenceKit[],
  scene: SceneRecord,
  sheets: Sheet[],
  model: ManifestModel,
  productionId?: string,
  propStates: readonly ShotPropResolution[] = [],
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
  // Prop states ride after the cast and the location (turn 105's rank), and only when a state
  // has an accepted reference: an unresolved or reference-less state never spends a slot.
  const propCandidates: BudgetCandidate[] = propStates
    .filter((entry) => entry.referenceFile !== null)
    .map((entry, i) => ({
      sheetId: entry.propId,
      kind: "prop",
      appearanceOrder: withLocation.length + i,
      hasReference: true,
      label: `${entry.propName} · ${entry.stateName ?? "unresolved"}`,
    }));
  return referenceBudget([...candidates, ...propCandidates], model);
}

/**
 * The line a strict start frame replaces the binding preamble with (issue 154). The image-to-
 * video route takes one picture and treats it as frame one; the words have to say that is what
 * it is, or the model reads it as loose inspiration and the continuity the frame exists for is
 * lost.
 */
export const START_FRAME_PREAMBLE =
  "The attached image is this clip's exact first frame. Continue the motion from it.";

/**
 * The line a continuation replaces the binding preamble with (SPEC-019 R-50).
 *
 * The extend route takes the footage plus a prompt describing how it should be extended, and
 * declares no image field at all. The words have to place the video in time or the prompt reads
 * as a description of the whole clip, and what comes back re-stages the opening rather than
 * carrying on from it — the same failure START_FRAME_PREAMBLE exists to prevent, one input up.
 */
export const CONTINUATION_PREAMBLE =
  "The attached video is the footage immediately before this clip. Continue it from its final frame, holding the motion, framing and light.";

/**
 * The line a carried continuation adds beneath the binding preamble (issue 852).
 *
 * On a row with no extend route the predecessor's take rides as a motion reference instead, in
 * the video array the reference route reads, cited the way that route cites clips — "Video 1".
 * The sheets still ride and are still numbered, so this is appended to their preamble rather
 * than replacing it. A weaker promise than CONTINUATION_PREAMBLE's: the composition is described
 * rather than pinned, and nothing is shared with the predecessor but what the model sees.
 */
export const CARRY_PREAMBLE =
  "Video 1 is the footage immediately before this clip. Pick up from its final frame, holding its motion, framing and light.";

/**
 * The footage a continuation will actually extend, resolved before anything is priced.
 *
 * Deliberately carries the take ids and the filename rather than a composed path: a segment's
 * media lives with the pass that produced it, and the one place that knows how a world lays its
 * take directories out is the coordinator. Planning stays pure and says WHAT to extend; the
 * dispatch path says where that lives.
 */
export interface ContinuationPlan {
  /** The exact predecessor take being extended, frozen here and validated again at arrival. */
  takeId: string;
  /** The shot that take covers — what a screen names when it says what is being continued. */
  fromShotId: string;
  fromShotNumber: number;
  /**
   * The take whose directory actually holds the file, which is not always `takeId`: a pass
   * segment owns a range into the pass's media and no file of its own (SPEC-013 R-3).
   */
  mediaTakeId: string;
  /** Filename within that take's directory, e.g. "clip.mp4". */
  media: string;
  /** The range to cut losslessly out of that file before dispatch (R-50, T-32). */
  segment?: { inSec: number; outSec: number };
  /**
   * Extended on the model's extend route, or carried as a motion reference where it has none
   * but its reference route takes video (issue 852). The compiler routes on this, the dispatch
   * path decides which wire field the bytes become from it, and arrival records it on the take.
   */
  kind: "extend" | "carry";
}

export type ContinuationAvailability =
  | { available: true; predecessor: Take }
  | { available: false; reason: string };

/**
 * May this shot continue its predecessor (R-50, R-51, R-52)?
 *
 * Three refusals, all named rather than hidden. There is no predecessor at all. Or there is no
 * accepted take to depend on — the dependency is on a *specific* take and there is not one yet.
 * Or the predecessor was itself produced by continuation, which is where §1.4's one-hop decision
 * stops being an intention: a decision nothing checks is one an implementation walks straight
 * past, every shot in a scene declaring continuation and a single reselection invalidating the
 * whole tail.
 *
 * Deliberately about the take graph and nothing else. Whether the footage can actually be sent —
 * media on disk, a route to send it to — is a dispatch question, answered by the callers below,
 * because the graph answer is the same on a machine with no ffmpeg and no provider key.
 */
export function continuationAvailable(input: {
  shotIndex: number;
  shots: ReadonlyArray<{ id: string; number: number }>;
  selections: Selections;
  takes: readonly Take[];
}): ContinuationAvailability {
  const previous = input.shots[input.shotIndex - 1];
  if (!previous) {
    return { available: false, reason: "this is the first shot — there is nothing before it to continue" };
  }
  const selectedId = input.selections[previous.id]?.acceptedTakeId ?? null;
  if (!selectedId) {
    return { available: false, reason: `shot ${previous.number} has no accepted take to continue from` };
  }
  const predecessor = input.takes.find((take) => take.id === selectedId);
  if (!predecessor) {
    return { available: false, reason: `shot ${previous.number}'s accepted take is no longer available` };
  }
  if (predecessor.continuedFrom !== undefined) {
    return {
      available: false,
      reason: `shot ${previous.number}'s take was itself continued — continuation stops at one hop, so this would chain`,
    };
  }
  return { available: true, predecessor };
}

/**
 * How each shot's continuation flag resolves against the selections, the takes and the model.
 *
 * Only shots that asked appear in the map at all: continuation is opt-in (R-50), so a shot that
 * never declared it has nothing to be told. A shot that did appears either with the footage it
 * will extend or with the reason it cannot, which is R-51 and R-52's "named rather than hidden"
 * in the one place both the dialog and the compiler read.
 */
function resolveContinuations(
  scene: SceneRecord,
  selections: Selections,
  model: ManifestModel,
  takes: readonly Take[] | undefined,
  mode: "per-shot" | "whole-scene",
): Map<string, { continuation?: ContinuationPlan; unavailable?: string }> {
  const states = new Map<string, { continuation?: ContinuationPlan; unavailable?: string }>();
  const shots = orderedShots(scene);
  // Without the takes nothing can be resolved — the caller that cannot supply them is the caller
  // that predates continuation, and it gets exactly the dispatch it got before.
  if (takes === undefined) return states;
  const route = continueDispatchFor(model);
  // No extend route is not the end of the question (issue 852). A row whose reference route
  // takes video can carry the predecessor's take as a motion reference instead: the sheets ride
  // beside it and the composition is described rather than pinned — a weaker promise than
  // extension, named as such everywhere downstream, and taken only where a true extend route
  // does not exist, which stays preferred.
  const carries = route === null && carriesVideoReferences(model, mappedReferenceKinds(model.provider));
  for (const [shotIndex, shot] of shots.entries()) {
    if (shot.continuity?.continuesPrevious !== true) continue;
    if (mode !== "per-shot") {
      states.set(shot.id, {
        unavailable: "a whole-scene pass covers several shots at once, and extension takes one clip",
      });
      continue;
    }
    if (route === null && !carries) {
      states.set(shot.id, { unavailable: modeUnavailableReason(model, "continue") ?? "no continue route" });
      continue;
    }
    const availability = continuationAvailable({ shotIndex, shots: shots, selections, takes });
    if (!availability.available) {
      states.set(shot.id, { unavailable: availability.reason });
      continue;
    }
    const predecessor = availability.predecessor;
    const from = shots[shotIndex - 1]!;
    /*
     * The file lives with the PASS, not with the segment (SPEC-013 R-3).
     *
     * Arrival writes `media` onto the pass take only, so a segment's own is always undefined —
     * reading it here would have refused every pass segment with "no footage to extend", which is
     * exactly the case T-32 exists for. `spine-cut.ts` and `takes/boundary.ts` resolve it the same
     * way, and this is the third place that has had to learn it.
     */
    const mediaTakeId = predecessor.segment?.passTakeId ?? predecessor.id;
    const mediaTake =
      predecessor.segment === undefined ? predecessor : takes.find((candidate) => candidate.id === mediaTakeId);
    if (mediaTake?.media === undefined) {
      states.set(shot.id, { unavailable: `shot ${from.number}'s accepted take has no footage to continue from` });
      continue;
    }
    if (carries) {
      // The reference route budgets clips in seconds, so the predecessor has to be a length the
      // plan can state: a segment is its range, a whole take is the length it was asked for, which
      // its params kept. Unknown refuses rather than fits — the budget's own rule (issue 305).
      const clipSec =
        predecessor.segment !== undefined
          ? predecessor.segment.outSec - predecessor.segment.inSec
          : typeof predecessor.params["durationSec"] === "number"
            ? predecessor.params["durationSec"]
            : null;
      const ceiling = model.limits.maxReferenceVideoSec ?? 0;
      if (clipSec === null) {
        states.set(shot.id, {
          unavailable: `shot ${from.number}'s accepted take has no known length, and ${model.displayName} budgets a carried clip in seconds`,
        });
        continue;
      }
      if (clipSec > ceiling) {
        states.set(shot.id, {
          unavailable: `shot ${from.number}'s take runs ${clipSec}s — longer than the ${ceiling}s of video ${model.displayName} reads as a reference`,
        });
        continue;
      }
    }
    states.set(shot.id, {
      continuation: {
        takeId: predecessor.id,
        fromShotId: from.id,
        fromShotNumber: from.number,
        mediaTakeId,
        media: mediaTake.media,
        ...(predecessor.segment !== undefined
          ? { segment: { inSec: predecessor.segment.inSec, outSec: predecessor.segment.outSec } }
          : {}),
        kind: carries ? "carry" : "extend",
      },
    });
  }
  return states;
}

/** How each shot's boundary-frame selection resolves against the world's shelf (issue 154). */
function resolveBoundaryFrames(
  scene: SceneRecord,
  selections: Selections,
  model: ManifestModel,
  artifacts: readonly ArtifactSidecar[] | undefined,
  mode: "per-shot" | "whole-scene",
): Map<string, { frame?: BoundaryFramePlan; stale?: string }> {
  const states = new Map<string, { frame?: BoundaryFramePlan; stale?: string }>();
  const shots = orderedShots(scene);
  // Without the shelf nothing can be resolved — no frame travels, none is called stale. The
  // caller that cannot supply artifacts is the caller that predates them.
  if (artifacts === undefined) return states;
  const route = frameDispatchFor(model, 1);
  for (const [shotIndex, shot] of shots.entries()) {
    const artifactId = selections[shot.id]?.startFrameArtifactId ?? null;
    if (artifactId === null) continue;
    const artifact = artifacts.find((candidate) => candidate.id === artifactId);
    if (artifact === undefined) {
      states.set(shot.id, { stale: `${artifactId} is not in this world` });
      continue;
    }
    /*
     * A chained frame travels only where the shot asked for it (issue 851). Accepting a take
     * cuts a still out of it and files it onto the next shot unconditionally, and on a
     * reference-capable model that still then displaces the cast sheets — so an unopposed run of
     * accepts walks a recurring face off its own reference, one shot at a time, with nobody
     * told. `openOnPrevious` is the shot's word for this and now decides it, default off on
     * SPEC-019 R-50's reasoning: most cuts are cuts. The artifact stays filed and the answer is
     * reversible from the checkbox alone — no re-accept, no redraw.
     *
     * A drawn, imported or run frame carries no `boundaryExtraction` and is untouched here: it
     * was chosen, which is the same distinction `hasOwnFrame` reads (SPEC-036 R-20).
     */
    if (artifact.boundaryExtraction !== undefined && shot.continuity?.openOnPrevious !== true) continue;
    if (artifact.kind !== "image") {
      states.set(shot.id, { stale: `${artifactId} is ${artifact.kind}, not an image` });
      continue;
    }
    if (artifacts.some((candidate) => candidate.supersedes === artifactId)) {
      states.set(shot.id, { stale: `${artifactId} has been superseded` });
      continue;
    }
    const predecessor = shotIndex > 0 ? shots[shotIndex - 1] : undefined;
    const selectedPredecessor = predecessor
      ? (selections[predecessor.id]?.acceptedTakeId ?? null)
      : null;
    if (
      artifact.boundaryExtraction !== undefined &&
      artifact.boundaryExtraction.sourceTakeId !== selectedPredecessor
    ) {
      states.set(shot.id, { stale: `${artifactId} was cut from footage no longer selected` });
      continue;
    }
    // A valid frame only travels where a route exists to receive it, and only per-shot — a
    // whole-scene pass covers many shots and the route takes one picture (SPEC-019 T-1).
    if (route !== null && model.capability === "video" && mode === "per-shot") {
      states.set(shot.id, {
        frame: { artifactId, file: `artifacts/${artifact.file}`, hash: artifact.hash },
      });
    }
  }
  return states;
}

/** The whole plan, computed before a dollar moves (R-17, R-20). Nothing here blocks (D12). */
export function planScene(input: ScenePlanInput, mode: "per-shot" | "whole-scene"): ScenePlan {
  const { world, sheets, kits, scene, selections, model } = input;
  const productionStyleOverride = input.production?.styleOverride?.trim() || undefined;
  const effectiveStyle = styleFor(world, productionStyleFor(input.production, input.artDirection?.description));
  const props = input.props ?? [];
  const { resolved, perShot } = sceneCast(scene, sheets, props);
  // A carried prop state attaches its accepted reference; everything else attaches as before.
  const attachmentsFor = (
    carried: readonly BudgetCandidate[],
    propStates: readonly ShotPropResolution[],
  ): AttachmentDecision[] =>
    carried.map((c) => {
      if (c.kind === "prop") {
        const entry = propStates.find((candidate) => candidate.propId === c.sheetId)!;
        return {
          sheetId: c.sheetId,
          file: entry.referenceFile,
          mode: "prop-state",
          role: "primary",
          staleGap: null,
          prop: { name: entry.propName, state: entry.stateName ?? "unresolved" },
        };
      }
      return attachmentFor(
        kits.find((k) => k.sheetId === c.sheetId) ?? null,
        sheets.find((s) => s.id === c.sheetId)!,
        c.referenceRole,
        { ...(input.productionId ? { productionId: input.productionId } : {}), sceneId: scene.id },
      );
    });
  const capSec = durationLimitsFor(model).maxDurationSec ?? Number.POSITIVE_INFINITY;
  const authored = orderedShots(scene);
  const timingProduction = input.timingProduction;
  const hasClock = timingProduction !== undefined && (timingProduction.spine !== null || timingProduction.timeline?.status === "ready" || timingProduction.timeline?.status === "invalid");
  const slots = hasClock ? dialogueSlots(timingProduction!) : [];
  const byShot = new Map<string, DialogueSlot>();
  const timingProblems: string[] = [], timingWarnings: string[] = [];
  for (const slot of slots) {
    if (byShot.has(slot.shotId)) timingProblems.push(`${slot.shotId}: multiple picture placements make generation timing ambiguous.`);
    byShot.set(slot.shotId,slot);
  }
  if (timingProduction?.timeline?.status === "invalid") timingProblems.push("Repair the invalid production timeline before generation.");
  for (const shot of authored) if (hasClock && !byShot.has(shot.id)) timingWarnings.push(`${shot.id}: unanchored; per-shot generation uses authored fallback and whole-scene packing excludes it.`);
  const ordered = authored.filter(shot => mode !== "whole-scene" || !hasClock || byShot.has(shot.id)).map(shot => {
    const slot = byShot.get(shot.id);
    return slot ? { ...shot, durationSec: slot.endSec-slot.startSec } : shot;
  });
  if (mode === "whole-scene" && hasClock && !ordered.length) timingProblems.push("Place at least one scene shot on the timeline before whole-scene generation.");
  if (mode === "whole-scene" && hasClock) ordered.sort((a,b)=>byShot.get(a.id)!.startSec-byShot.get(b.id)!.startSec);
  const chronologicalSlots = [...slots].sort((a,b) => a.startSec-b.startSec);
  const sceneShotIds = new Set(authored.map(shot => shot.id));
  let furthest = chronologicalSlots[0];
  for (const slot of chronologicalSlots.slice(1)) {
    if (furthest && slot.startSec < furthest.endSec && (sceneShotIds.has(slot.shotId) || sceneShotIds.has(furthest.shotId))) timingProblems.push(`${slot.shotId} / ${furthest.shotId}: picture slots overlap across the production.`);
    if (!furthest || slot.endSec > furthest.endSec) furthest = slot;
  }
  const timingBreaks = new Set<string>();
  if (hasClock) for (let i=1;i<ordered.length;i++) {
    const previous=byShot.get(ordered[i-1]!.id), next=byShot.get(ordered[i]!.id);
    if (!previous || !next || previous.endSec!==next.startSec) timingBreaks.add(ordered[i]!.id);
    if (previous && next && previous.endSec>next.startSec) timingProblems.push(`${ordered[i]!.id}: picture slots overlap; repair the timing before dispatch.`);
  }

  // Boundary frames resolved before anything is bound or priced (issue 154): a shot that opens
  // on a durable frame takes the first-frame route, which changes what else may travel with it.
  const boundaryFrames = resolveBoundaryFrames(scene, selections, model, input.artifacts, mode);
  // Resolved beside them, and consulted first where both landed on one shot (R-50): a frame is
  // issue 154's workaround for models that could not take video, and this model can. Continuing
  // keeps the motion and the audio the extracted still throws away, so the frame steps aside
  // rather than the capability it stands in for.
  const continuations = resolveContinuations(scene, selections, model, input.takes, mode);
  const taskModeForShot = (shotId: string): TaskMode => {
    const continuation = continuations.get(shotId)?.continuation;
    // A carry is a reference dispatch that happens to carry a clip (issue 852): no mode of its
    // own on the wire, so it prices and routes as generation with references.
    if (continuation !== undefined) return continuation.kind === "extend" ? "continue" : "generate";
    if (boundaryFrames.get(shotId)?.frame !== undefined) return frameDispatchFor(model, 1)?.mode ?? "generate";
    return "generate";
  };

  // Merged once for the whole plan (#244). Both dispatch shapes are the same clip's constraints,
  // and computing it twice is how the per-shot and whole-scene paths come to disagree about what
  // the world forbids.
  const constraints = standingConstraints(input.artDirection, input.production);

  const shots: ShotDispatchPlan[] = ordered.map((shot) => {
    const cast = perShot.get(shot.id)!;
    const propStates = resolvePropStates(shot, props, input.propStateOverrides?.[shot.id]);
    const budget = budgetFor(cast.cast, kits, scene, sheets, model, input.productionId, propStates);
    const references = attachmentsFor(budget.carried, propStates);
    // A strict start frame displaces the sheet references (issue 154): the first-frame route
    // takes exactly one image, so nothing else may ride, and the budget's carried set is named
    // in the warnings as what stepped aside rather than silently thinned.
    const continuation = continuations.get(shot.id)?.continuation;
    const frame = continuation !== undefined ? undefined : boundaryFrames.get(shot.id)?.frame;
    // Bound before the duration is priced (issue #390): what actually travels decides which
    // route the provider takes, and the reference route's ceiling can be shorter.
    // A carried continuation keeps its sheets (issue 852): the reference route takes the clip
    // in one array and the pictures in another, so nothing has to step aside for it.
    const bound =
      frame !== undefined || continuation?.kind === "extend" ? [] : bindReferences(references, sheets);
    // The length that will actually be asked for. A route takes one of a fixed few lengths, so
    // a 6.5s shot becomes a 7s dispatch — and the estimate has to be the 7, or the figure shown
    // and the figure billed are for two different requests. A shot longer than anything the
    // route offers keeps its own seconds here and is refused by name in the warnings.
    const duration = pricedDuration(model, resolvedAuthoredDuration(shot), {
      taskMode: taskModeForShot(shot.id),
      withReferences: bound.length > 0,
    });
    const estimate =
      model.capability === "video"
        ? estimateMicroUsd(model, {
            durationSec: duration,
            ...(input.resolution !== undefined ? { resolution: input.resolution } : {}),
          })
        : (() => {
            // Priced from the frame that will actually be asked for. Without the megapixels a
            // per-megapixel model came out at zero, which is not an estimate.
            // Shaped by the production's delivery aspect (issue 389): a 9:16 still has
            // different pixels, and therefore a different per-megapixel price, than the old
            // landscape habit.
            const output = sceneImageOutput(model, input.tier, input.aspect);
            return estimateMicroUsd(model, {
              images: 1,
              referenceImages: references.filter((reference) => reference.file !== null).length,
              megapixels: (output.width * output.height) / 1_000_000,
              ...(output.resolution !== undefined ? { resolution: output.resolution } : {}),
            });
          })();
    // What travels also decides what the prose still has to say: a subject whose image is
    // carried loses its appearance clause (R-8), and only carried assets get numbered.
    const prompt = promptFor(
      world,
      sheets,
      scene,
      shot,
      effectiveStyle,
      new Set(bound.map((reference) => reference.sheetId)),
      model.capability,
    );
    const parts: PromptParts = {
      // A framed shot states what its one image IS (issue 154); a continued shot says where in
      // time its video sits (R-50); a referenced shot numbers its assets. Never more than one —
      // the route carries a picture, a clip or an array, and no route carries two of them.
      preamble:
        continuation?.kind === "extend"
          ? CONTINUATION_PREAMBLE
          : continuation?.kind === "carry"
            // The one exception to "never more than one" (issue 852), and only apparently: the
            // reference route carries the clip and the pictures in two arrays of its own, so the
            // clip's line sits beneath the pictures' numbering rather than replacing it.
            ? [bindingPreamble(bound), CARRY_PREAMBLE].filter(Boolean).join("\n")
            : frame !== undefined
              ? START_FRAME_PREAMBLE
              : bindingPreamble(bound),
      body: prompt.text,
      negatives: derivedNegatives({
        capability: model.capability,
        shot,
        constraints,
        ...(input.audioDesign !== undefined ? { audioDesign: input.audioDesign } : {}),
      }),
    };
    return {
      shot,
      ...(byShot.has(shot.id) ? { slot: byShot.get(shot.id)!, authoredDurationSec: resolvedAuthoredDuration(authored.find(s=>s.id===shot.id)!) } : {}),
      prompt,
      references,
      bound,
      parts,
      propStates,
      budget,
      estimatedMicroUsd: estimate,
      ...(frame !== undefined ? { frame } : {}),
      ...(continuation !== undefined ? { continuation } : {}),
    };
  });

  const perShotTotal = shots.reduce((a, s) => a + s.estimatedMicroUsd, 0);

  // Packing happens with the reference presence already known (issue #390): a pass that will
  // dispatch on the reference route is packed against that route's ceiling, so a plan cannot
  // price 15 seconds and fail when the provider takes the 10-second route.
  const boundByShot = new Map(shots.map((s) => [s.shot.id, s.bound.length > 0]));
  const referenceCapCandidates = durationOptions(model, { taskMode: "generate", withReferences: true });
  const referenceCapSec =
    model.limits.maxReferenceDurationSec ??
    (referenceCapCandidates.length > 0 ? referenceCapCandidates[referenceCapCandidates.length - 1]! : capSec);
  /*
   * Where a pass may not run through (SPEC-035 R-13).
   *
   * Boards are the continuity structure — time-of-day and cast breaks, plus the author's own
   * splits and merges — and passes are a refinement of them, never a rival: a pass never spans
   * a board boundary, and the route cap may subdivide the shots between two boundaries into
   * several passes. That is SPEC-029 R-43's surviving principle exactly, in the one place it
   * always belonged: a provider limit is execution policy, and it subdivides authored
   * structure without ever rewriting it.
   *
   * Packed at the text cap here rather than the reference cap: this call is only being asked
   * where the CONTINUITY seams fall, and `packScene` below owns every cap decision, including
   * the retroactive reference ceiling it alone can see (issue #390).
   */
  const boardOverrides = scene.boards;
  const boardBoundaries = ((): ReadonlySet<string> => {
    const packed = packBoards(
      packShotsFor({
        scene,
        shots: ordered,
        selections,
        takes: input.takes ?? [],
        /*
         * Characters, not every sheet a shot mentions. `@the-vigil` is where the shot is, not
         * who is in it — and counting a location as cast makes a scene set in one place break
         * wherever the prose happens to name the place again, which is the same self-defeat
         * the lighting exemption exists to prevent (R-6). Found against the fixture: four
         * shots in one location packed into three boards on location mentions alone.
         */
        castOf: (shot) =>
          resolveCast(shot.description, sheets)
            .cast.filter((entry) => entry.sheet.type === "character")
            .map((entry) => entry.sheet.id),
        defaultDurationSec: DEFAULT_SHOT_SEC,
      }),
      capSec,
      new Set(boardOverrides?.splits ?? []),
      new Set(boardOverrides?.merges ?? []),
      // Frame coverage does not move a seam; it only counts, and nothing here reads the count.
      () => true,
    );
    // A refusal is `packScene`'s to report, in its own shape, from its own oversize check.
    if (!packed.ok) return new Set();
    return new Set(
      packed.boards.slice(1).map((board) => board.memberShotIds[0]!).filter((id) => id !== undefined),
    );
  })();

  const pack = packScene(ordered, capSec, {
    referenceCapSec,
    shotCarriesReferences: (shotId) => boundByShot.get(shotId) ?? false,
    forceBreakBefore: new Set([...boardBoundaries,...timingBreaks]),
  });

  const passReferences: ScenePlan["passReferences"] = pack.ok
    ? pack.passes.map((pass) => {
        const seen = new Map<string, ResolvedCast["cast"][number]>();
        for (const entry of pass.plan) {
          for (const cast of perShot.get(entry.shotId)?.cast ?? []) {
            if (!seen.has(cast.sheet.id)) seen.set(cast.sheet.id, cast);
          }
        }
        // Every prop state the pass's shots cite, distinct by prop and state; the first state of
        // a prop cited twice takes the slot, and the take's provenance still names both.
        const propStates = pass.plan
          .flatMap((entry) => {
            const shot = ordered.find((s) => s.id === entry.shotId);
            return shot ? resolvePropStates(shot, props, input.propStateOverrides?.[shot.id]) : [];
          })
          .filter(
            (entry, i, all) =>
              all.findIndex((other) => other.propId === entry.propId && other.stateId === entry.stateId) === i,
          );
        const budget = budgetFor([...seen.values()], kits, scene, sheets, model, input.productionId, propStates);
        const references = attachmentsFor(budget.carried, propStates);
        return {
          passIndex: pass.index,
          references,
          budget,
          bound: bindReferences(references, sheets),
          propStates,
          // A pass is one clip, so its negatives are the clip's. Silence is still stated, but
          // only when the whole clip is silent — one spoken beat among four is not a silent pass.
          negatives: derivedNegatives({
            capability: model.capability,
            shots: pass.plan
              .map((entry) => ordered.find((s) => s.id === entry.shotId))
              .filter((s): s is Shot => s !== undefined),
            constraints,
            ...(input.audioDesign !== undefined ? { audioDesign: input.audioDesign } : {}),
          }),
        };
      })
    : [];
  // Whether each pass will take the reference route — priced and warned with the same answer
  // the transport will give (issue #390).
  const passCarriesReferences = new Map(
    passReferences.map((pass) => [pass.passIndex, pass.bound.length > 0]),
  );
  const wholeSceneTotal =
    pack.ok && model.capability === "video"
      ? pack.passes.reduce(
          (a, p) =>
            a +
            estimateMicroUsd(model, {
              durationSec: pricedDuration(model, p.durationSec, {
                taskMode: "generate",
                withReferences: passCarriesReferences.get(p.index) ?? false,
              }),
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
  const overlongShots = ordered
    .map((shot) => ({
      shot,
      choice: dispatchDuration(model, resolvedAuthoredDuration(shot), {
        taskMode: taskModeForShot(shot.id),
        // The route the shot will actually take (issue #390): a 12-second shot with references
        // is over-cap on a 15s-text/10s-reference model, and saying so here is the difference
        // between a refusal before commit and a provider failure after it.
        withReferences: boundByShot.get(shot.id) ?? false,
      }),
    }))
    // Extracted from the union rather than restated: a hand-written copy of the variant's shape
    // stops compiling the day the variant gains a field, which is how this line broke once.
    .filter((entry): entry is { shot: Shot; choice: Extract<DurationChoice, { kind: "over-cap" }> } =>
      entry.choice.kind === "over-cap",
    )
    .map((entry) => ({
      shotId: entry.shot.id,
      number: entry.shot.number,
      durationSec: resolvedAuthoredDuration(entry.shot),
      longestSec: entry.choice.longest,
      becauseReferences: entry.choice.becauseReferences,
    }));
  // A pass the pack could not keep under its route's ceiling — only reachable when a single
  // shot exceeds the reference route alone, since the pack itself is route-aware now — plus any
  // pass whose priced route disagrees, named before commit rather than discovered after.
  const overlongPasses = pack.ok
    ? pack.passes.flatMap((pass) => {
        const withReferences = passCarriesReferences.get(pass.index) ?? false;
        const choice = dispatchDuration(model, pass.durationSec, { taskMode: "generate", withReferences });
        return choice.kind === "over-cap"
          ? [
              {
                passIndex: pass.index,
                durationSec: pass.durationSec,
                longestSec: choice.longest,
                becauseReferences: choice.becauseReferences,
              },
            ]
          : [];
      })
    : [];
  const warnings: DispatchWarnings = {
    // Only where a frame would actually travel (issue 154). The authority is the same one the
    // dispatch uses — a first-frame task-mode route — with the legacy accepts flag honoured for
    // the rows that still claim frames without one. Warning on a model that cannot take a frame
    // tells the user to fix something that would change nothing about the dispatch.
    // A shot that resolved a continuation is excluded for the same reason: it opens on footage
    // rather than a picture, so "no start frame" is not a gap in it.
    shotsWithoutFrame:
      frameDispatchFor(model, 1) !== null || model.accepts.startFrame
        ? ordered
            .filter(
              (s) =>
                continuations.get(s.id)?.continuation === undefined &&
                !(selections[s.id]?.startFrameArtifactId ?? selections[s.id]?.startFrameTakeId ?? null),
            )
            .map((s) => ({ shotId: s.id, number: s.number }))
        : [],
    framedShots: shots.flatMap((entry) =>
      entry.frame !== undefined
        ? [
            {
              shotId: entry.shot.id,
              number: entry.shot.number,
              artifactId: entry.frame.artifactId,
              // Deduplicated: a subject carrying a primary and a secondary reference stepped
              // aside once, not once per asset.
              setAside: [...new Set(entry.budget.carried.map((candidate) => candidate.sheetId))],
            },
          ]
        : [],
    ),
    // A continued shot's frame selection is not consulted, so it cannot be stale in any sense
    // that matters — and leaving it here would be worse than noise: compilation refuses a plan
    // with any stale frame, so an old selection on a shot now extending footage would block the
    // whole dispatch over a field this route never reads.
    staleFrames: ordered.flatMap((shot) => {
      if (continuations.get(shot.id)?.continuation !== undefined) return [];
      const stale = boundaryFrames.get(shot.id)?.stale;
      return stale !== undefined ? [{ shotId: shot.id, number: shot.number, detail: stale }] : [];
    }),
    continuedShots: shots.flatMap((entry) =>
      entry.continuation !== undefined
        ? [
            {
              shotId: entry.shot.id,
              number: entry.shot.number,
              fromTakeId: entry.continuation.takeId,
              kind: entry.continuation.kind,
              // Deduplicated on the same grounds as `framedShots`, and carrying the boundary
              // frame too where one was selected: it stepped aside as surely as a sheet did.
              // A carry sets no sheet aside — they ride beside the clip (issue 852) — and only
              // the frame, which the clip makes redundant.
              setAside: [
                ...(entry.continuation.kind === "extend"
                  ? new Set(entry.budget.carried.map((candidate) => candidate.sheetId))
                  : []),
                ...(boundaryFrames.get(entry.shot.id)?.frame !== undefined ? ["start frame"] : []),
              ],
            },
          ]
        : [],
    ),
    continuationUnavailable: ordered.flatMap((shot) => {
      const reason = continuations.get(shot.id)?.unavailable;
      return reason !== undefined ? [{ shotId: shot.id, number: shot.number, reason }] : [];
    }),
    sketchCitations: resolved.cast.filter((c) => c.sheet.status === "sketch").map((c) => c.sheet.name),
    droppedReferences,
    staleModelSheets: resolved.cast
      .map((c) => attachmentFor(kits.find((k) => k.sheetId === c.sheet.id) ?? null, c.sheet).staleGap)
      .filter((g): g is string => g !== null),
    retiredCitations: resolved.cast.filter((c) => c.retired).map((c) => c.sheet.name),
    unknownMentions: resolved.unknown,
    propStates: shots.flatMap((entry) =>
      entry.propStates.flatMap((prop): DispatchWarnings["propStates"] => {
        const named = { shotId: entry.shot.id, number: entry.shot.number, prop: prop.propName };
        if (prop.stateId === null) return [{ ...named, state: null, issue: "unresolved" }];
        if (prop.referenceFile === null) return [{ ...named, state: prop.stateName, issue: "missing-reference" }];
        return [];
      }),
    ),
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
    overlongPasses,
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
    overriddenStale: ordered
      .map((s) => ({ shotId: s.id, number: s.number, against: overrideStaleAgainst(s, sheets) }))
      .filter((s) => s.against.length > 0),
    // Refused by name before enqueue (issue 389): the shape, the model, and what it does offer.
    // Stills are exempt — imageOutputFor's backstop already falls back to the nearest honest
    // orientation, and a still in a fallback shape is recoverable where paid footage is not.
    aspectUnsupported: (() => {
      if (input.aspect === undefined || model.capability !== "video") return null;
      const verdict = aspectSupport(model, input.aspect);
      return verdict.ok
        ? null
        : { aspect: input.aspect, model: model.displayName, supported: verdict.supported };
    })(),
  };

  for (const entry of shots) {
    entry.audioReferences = planCharacterAudio({ scene, shots: [entry.shot], sheets, kits, model,
      imageCount: entry.bound.length, taskMode: entry.continuation?.kind === "extend" ? "continue" : entry.frame ? "first-frame" : "generate",
      disabled: input.audioReferencesDisabled, performanceReferences: input.performanceReferences, masterReferences: input.masterReferences, requiredMasterShots: masterPerformanceShotIds(input.timingProduction) });
    const audioText = characterAudioInstructions(entry.audioReferences);
    if (audioText) entry.parts.preamble = [entry.parts.preamble, audioText].filter(Boolean).join("\n");
  }
  for (const reference of passReferences) {
    const packed = pack.ok ? pack.passes.find(p => p.index === reference.passIndex) : undefined;
    const ids = new Set(packed?.plan.map(p => p.shotId) ?? []);
    reference.audioReferences = planCharacterAudio({ scene, shots: shots.filter(s => ids.has(s.shot.id)).map(s => s.shot),
      sheets, kits, model, imageCount: reference.bound.length, disabled: input.audioReferencesDisabled, performanceReferences: input.performanceReferences, masterReferences: input.masterReferences, requiredMasterShots: masterPerformanceShotIds(input.timingProduction) });
  }

  return {
    mode,
    ...(hasClock ? { timingProblems, timingWarnings } : {}),
    effectiveStyle,
    ...(productionStyleOverride !== undefined ? { productionStyleOverride } : {}),
    shots,
    passReferences,
    pack,
    ...(input.resolution !== undefined ? { resolution: input.resolution } : {}),
    ...(input.tier !== undefined ? { tier: input.tier } : {}),
    ...(input.aspect !== undefined ? { aspect: input.aspect } : {}),
    totalEstimatedMicroUsd: mode === "whole-scene" ? wholeSceneTotal : perShotTotal,
    steering: chooseReferenceSteering({
      scene,
      selections,
      model,
      ...(input.aspect !== undefined ? { aspect: input.aspect } : {}),
    }),
    warnings,
  };
}

export { DEFAULT_SHOT_SEC } from "./scene.js";
