import {
  MAIN_PHOTO_LOOK,
  PICTURE_PROMPT_MAX,
  kitLookLibrary,
  lookLinesFor,
  lookName,
  lookViewFor,
  neutralClothing,
  normalizeSpeechText,
  ownLookPicks,
  pictureAspect,
  pictureLookFor,
  pictureMood,
  pictureOwnLooks,
  pictureQuote,
  placePictures,
  referenceBudget,
  ridingPicks,
  sheetReferencePicture,
  type AudiobookBlock,
  type AudiobookLook,
  type BudgetCandidate,
  type HarnessAdapter,
  type LookView,
  type ManifestModel,
  type PictureOwnLooks,
  type PictureSuggestion,
  type PictureWho,
} from "@arke-studio/contracts";
import type { SessionInput } from "../harness/session-files.js";
import { referenceBudgetFor } from "../references/generate.js";
import type { WorldStore } from "../world/store.js";
import { planAudiobook, readAudiobookBook, type AudiobookPlan } from "./audiobook.js";
import { clip } from "./audiobook-direction.js";
import { anyNarrator } from "./audiobook-listening.js";
import { artDirectionFor, blockSpeakers, chapterPeople, chapterPlaces, nameAt, type ChapterPerson, type ChapterPlace } from "./audiobook-look.js";
import { BRIEF_EXAMPLES, BRIEF_SHAPE, RawBriefSchema, briefGiven, briefRiders, briefRules, holdBrief, pictureChecks, type BriefLine, type RawBrief } from "./audiobook-picture-brief.js";
import { makeAdapterJsonDeriver } from "./continuity.js";

/**
 * Suggest picture (design turn 191a, 193k; SPEC-047 R-99, R-100, R-119..R-121): the writing service
 * is given 193k's brief — the block's words, the chapter around it, who is in it and their look, the
 * places and the chapter's Mood line — and drafts ONE picture the author can edit: its frame, who
 * is in it and who is not, each face's expression, and the prompt. Around it, deterministically:
 * who rides as a reference (who is in frame, each by their chosen look's image, else their main
 * photo; a place by its establishing view), the look lines, the seven checks, the model, the ratio
 * and the price. Nothing is made and nothing is spent by drafting.
 */

export const PICTURE_BOUNDS = { neighbour: 240, synopsis: 600, art: 400, note: 400, reserve: 700 } as const;

export type RawPicture = RawBrief;

export interface PictureDeriverInput {
  title: string;
  /** The chapter's Mood line: light, colour and grain only (design turn 193, rule 9). Never the art direction's free text. */
  mood?: string;
  synopsis?: string;
  /** The chapter's note, from the book's reading notes: what a block that states no feeling is inferred from (193k, rule 5). */
  note?: string;
  block: { key: string; text: string; speaker?: string };
  before?: string;
  after?: string;
  /** The look the prompt takes its lines from: the place, then each person's, with their chosen look's name. */
  lines: readonly BriefLine[];
  people: ReadonlyArray<Pick<ChapterPerson, "key" | "name" | "appearance" | "essence">>;
  places: readonly ChapterPlace[];
  /** Sheets that are never to be pictured: named so the model leaves them out of frame. */
  never: readonly string[];
  maxChars: number;
  /** Why the draft before this one was asked again (check 2): said to the model once. */
  retry?: string;
}
export type PictureDeriver = (input: PictureDeriverInput, signal?: AbortSignal) => Promise<RawPicture>;

/** The brief for one picture (193k), as the writing service is given it. */
export function buildPicturePrompt(input: PictureDeriverInput, retryNote?: string): string {
  const note = retryNote ?? input.retry;
  return `You write the prompt for ONE picture, shown while the block below is heard in an illustrated audiobook. The picture is a still taken from the block: what its words describe, seen by one camera. Answer with ONLY this JSON object:
${BRIEF_SHAPE}
${briefRules(input.maxChars, input.never)}${note ? `\nYour previous response was rejected: ${note}\n` : ""}
${BRIEF_EXAMPLES}

${briefGiven(input)}
## Around the block
${input.before !== undefined ? `Before: ${input.before}\n` : ""}${input.after !== undefined ? `After: ${input.after}\n` : ""}
## The block [${input.block.key}]${input.block.speaker !== undefined ? ` spoken by ${input.block.speaker}` : ""}
${input.block.text}`;
}

export function makeAdapterPictureDeriver(adapter: HarnessAdapter, sessionInput: SessionInput, scratchRoot: string): PictureDeriver {
  const ask = makeAdapterJsonDeriver(adapter, sessionInput, scratchRoot, RawBriefSchema, "picture");
  return (input, signal) => ask((note) => buildPicturePrompt(input, note), signal);
}

/**
 * The look lines as the brief gives them (193k): the place, then each person's line, named by the
 * kit look it is the line of where the chapter chose one (`[ife] Ife, look "Cream-gold silk slip
 * dress": …`).
 */
export function briefLines(store: Pick<WorldStore, "getBundle">, look: AudiobookLook | null, keys: readonly string[], carries = true, own?: Readonly<PictureOwnLooks>): BriefLine[] {
  const kits = store.getBundle().referenceKits;
  // A look chosen for this picture alone gives that person's line (R-146): the brief is written for it.
  return lookLinesFor(look, keys, ownLookPicks(ownLooksThatRide(store, look, own)), kitLookLibrary(kits, look)).map((line): BriefLine => {
    const sheet = line.key === null ? undefined : (look?.characters[line.key]?.sheet ?? line.key);
    const chosen = line.lookId === undefined || sheet === undefined ? undefined : kits.find((kit) => kit.sheetId === sheet)?.looks?.find((candidate) => candidate.id === line.lookId);
    // The look's image carries the clothes, so its line is given neutrally (rule 4, 2026-10-04): the
    // garment and its colour, never the skin, the cut or the body a model would copy word for word.
    // Given before the frame is known, so a detail shot (no image rides) reads the neutral line too:
    // a hand or a cuff loses nothing to it, and the cut words are what the safety check refuses. A
    // model that takes no reference picture carries no look image, so its lines stay whole (`carries`).
    return { label: line.label, key: line.key, text: chosen !== undefined && carries ? neutralClothing(line.text) : line.text, ...(chosen !== undefined ? { look: lookName(chosen) } : {}) };
  });
}

/**
 * The looks chosen for one picture that can still ride (R-146): a kit look the kit no longer holds
 * is passed over for the chapter's choice, as `pictureWho` passes it over, so its words never
 * reach a brief or a stamp.
 */
export function ownLooksThatRide(store: Pick<WorldStore, "getBundle">, look: AudiobookLook | null | undefined, own: Readonly<PictureOwnLooks> | undefined): PictureOwnLooks {
  const library = kitLookLibrary(store.getBundle().referenceKits, look);
  return Object.fromEntries(Object.entries(own ?? {}).filter(([key, lookId]) => lookId === MAIN_PHOTO_LOOK || library(key, lookId) !== undefined));
}

/**
 * A drafted prompt held to rule 4 where a look image rides (2026-10-04): whatever the model wrote
 * of skin, cut or the body under the clothes is taken out, as the brief told it, because a provider's
 * safety check refuses the picture for those words while the image itself shows the dress.
 */
export function neutralWhereLooksRide(prompt: string, who: readonly PictureWho[]): string {
  // Rides means carried: a look the model's reference budget left out sends no image (codex on PR 1559).
  // The whole prompt is held once one look rides: its prose cannot be cut person by person, and the
  // safety check refuses the request as a whole for any of those words.
  return who.some((entry) => entry.kind === "character" && entry.look !== undefined && entry.carried) ? neutralClothing(prompt) : prompt;
}

/** A prompt held to its cap: cut after the last whole sentence that fits, else at a word. */
export function clipPrompt(text: string, max: number): string {
  const folded = normalizeSpeechText(text);
  if (folded.length <= max) return folded;
  const cut = folded.slice(0, max);
  const stop = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "));
  if (stop > max / 2) return cut.slice(0, stop + 1);
  const space = cut.lastIndexOf(" ");
  return (space > max / 2 ? cut.slice(0, space) : cut).trimEnd();
}

// The shape and the price live in contracts, where a made picture's card prices Make again too.
export { pictureAspect, pictureQuote };

/** The longest prompt the Bench will take once the references and the look are written around it. */
export function promptRoom(model: ManifestModel): number {
  const cap = model.limits.maxPromptChars;
  return cap === undefined ? PICTURE_PROMPT_MAX : Math.max(200, Math.min(PICTURE_PROMPT_MAX, cap - PICTURE_BOUNDS.reserve));
}

/**
 * Who rides as a reference (R-100): each named person by their sheet's main picture and the place
 * by its establishing view, ranked as every other budget is — characters before places, leads
 * first, then in the order they come — and cut at the number the model takes. A sheet with no
 * picture is listed and not carried, so the card can say `Make a reference`; one the limit leaves
 * out is listed and not carried either. The model's limit is the only limit.
 */
export function pictureWho(
  store: Pick<WorldStore, "getBundle">,
  model: ManifestModel,
  chosen: ReadonlyArray<{ key: string; name: string; sheet?: string; kind: "character" | "place"; billing?: string }>,
  /**
   * The chapter's look and the picture's frame (design turn 193, R-119, R-118): a character the
   * chapter chose a kit look for rides that look's image instead of the main photo — the close
   * view for a frame that shows faces where the look has one, the full body otherwise.
   */
  options: {
    look?: AudiobookLook | null;
    frame?: string | null;
    /**
     * The looks chosen for this picture alone (design turn 193d, R-146): that person rides the
     * look chosen for it — or the main photo — in place of the chapter's choice, marked `only`. One
     * the kit no longer holds is passed over for the chapter's choice.
     */
    own?: Readonly<PictureOwnLooks>;
  } = {},
): PictureWho[] {
  const world = store.getBundle();
  const kitLook = (sheet: string, lookId: string) => world.referenceKits.find((kit) => kit.sheetId === sheet)?.looks?.find((candidate) => candidate.id === lookId && candidate.kind === "costume");
  const riding = (entry: (typeof chosen)[number]): { file: string | null; look?: { lookId: string; view: LookView }; only?: true } => {
    if (entry.sheet === undefined) return { file: null };
    const ownId = entry.kind === "character" ? options.own?.[entry.key] : undefined;
    if (ownId === MAIN_PHOTO_LOOK) return { file: sheetReferencePicture(world, entry.sheet), only: true };
    const own = ownId === undefined ? undefined : kitLook(entry.sheet, ownId);
    const lookId = entry.kind === "character" ? options.look?.characters[entry.key]?.lookId : undefined;
    const look = own ?? (lookId === undefined ? undefined : kitLook(entry.sheet, lookId));
    // A look the kit no longer holds leaves the main photo to ride, and the stamp records none.
    if (look === undefined) return { file: sheetReferencePicture(world, entry.sheet) };
    const view = lookViewFor(options.frame) === "close" && look.closeFile !== undefined ? "close" : "full";
    return { file: `references/${entry.sheet}/${view === "close" ? look.closeFile! : look.file}`, look: { lookId: look.id, view }, ...(own !== undefined ? { only: true as const } : {}) };
  };
  const resolved = chosen.map(riding);
  const candidates: BudgetCandidate[] = chosen.flatMap((entry, index) =>
    entry.sheet === undefined
      ? []
      : [{ sheetId: entry.sheet, kind: entry.kind === "place" ? "location" as const : "character" as const, ...(entry.billing !== undefined ? { billing: entry.billing } : {}), appearanceOrder: index, hasReference: resolved[index]!.file !== null }],
  );
  const budget = referenceBudget(candidates, { ...model, accepts: { ...model.accepts, referenceImages: referenceBudgetFor(model) } });
  const carried = new Set(budget.carried.filter((candidate) => candidate.referenceRole === "primary").map((candidate) => candidate.sheetId));
  return chosen.map((entry, index): PictureWho => {
    const { file, look, only } = resolved[index]!;
    return {
      key: entry.key,
      name: entry.name,
      ...(entry.sheet !== undefined ? { sheet: entry.sheet } : {}),
      kind: entry.kind,
      reference: file,
      carried: file !== null && entry.sheet !== undefined && carried.has(entry.sheet),
      ...(look !== undefined ? { look } : {}),
      ...(only !== undefined ? { only } : {}),
    };
  });
}

/** What the writing service is given of a block's chapter, read once for the suggestion and for the run. */
export interface PictureRoom {
  plan: AudiobookPlan;
  people: ChapterPerson[];
  places: ChapterPlace[];
  look: AudiobookLook | null;
  /** The chapter's Mood line, or the art direction with its clothing cut where the look has none (R-117). */
  mood: string | undefined;
  synopsis: string | undefined;
  /** The chapter's reading note (the book record's), which a face is read from where the block states no feeling (193k, rule 5). */
  note: string | undefined;
  /**
   * The looks a block's next picture is made with for itself (design turn 193d, R-146): those held
   * on the block, else those its picture was made with alone.
   */
  own: (block: string) => PictureOwnLooks;
}

/** What a block's next picture is made with for itself, from the chapter's record as the plan read it (R-146). */
export function blockOwnLooks(plan: Pick<AudiobookPlan, "blocks" | "record">, block: string): PictureOwnLooks {
  const record = plan.record === "unreadable" || plan.record === null ? null : plan.record;
  if (record === null) return {};
  const index = plan.blocks.findIndex((planned) => planned.block.key === block);
  const blocks = plan.blocks.map((planned) => ({ key: planned.block.key, text: planned.block.text }));
  const made = index < 0 ? undefined : placePictures(blocks, record.pictures ?? {}).placed.find((entry) => entry.index === index)?.picture.look;
  return pictureOwnLooks(record.ownLooks?.[block], made);
}

export async function pictureRoom(store: WorldStore, productionId: string, chapterId: string, look: AudiobookLook | null): Promise<PictureRoom> {
  const plan = await planAudiobook(store, productionId, chapterId, { narrator: await anyNarrator(store, productionId) });
  const summary = store.getBundle().productions.find((p) => p.meta.id === productionId)?.chapters.find((c) => c.id === plan.chapter.id);
  const book = await readAudiobookBook(store, productionId).catch(() => null);
  const note = book === null || book === "unreadable" ? undefined : clip(book.chapterNotes?.[plan.chapter.id], PICTURE_BOUNDS.note);
  return {
    plan,
    people: chapterPeople(store, plan),
    places: chapterPlaces(store, plan),
    look,
    mood: pictureMood(look, artDirectionFor(store, productionId)),
    synopsis: clip(summary?.synopsis, PICTURE_BOUNDS.synopsis),
    note,
    own: (block) => blockOwnLooks(plan, block),
  };
}

/** The people a block may show: not those the sheet never lets be pictured. */
export const depictable = (people: readonly ChapterPerson[]): ChapterPerson[] => people.filter((person) => !person.neverDepicted);

/** Who a block shows when the model named no one: those who speak in it, and the characters whose names its words hold. */
export function namedIn(block: Pick<AudiobookBlock, "text" | "sheet" | "speaker" | "rows">, people: readonly ChapterPerson[]): ChapterPerson[] {
  const speaking = new Set((block.rows ?? [block]).flatMap((turn) => (turn.sheet === undefined ? [] : [turn.sheet])));
  return people.filter((person) => (person.sheet !== undefined && speaking.has(person.sheet)) || nameAt(block.text, person.name) >= 0);
}

export interface SuggestOptions {
  deriver: PictureDeriver;
  model: ManifestModel;
  signal?: AbortSignal;
}

/**
 * One block's suggestion (R-99, R-120, R-121): drafted by the deriver under 193k's brief, then held
 * — the keys held to the chapter, who rides is who is in frame (a detail carries no reference, a
 * frame with nobody in it carries the place), a prompt over the model's room cut at a sentence, and
 * the seven checks run. A draft that names someone out of frame is asked again once with the reason;
 * what comes back is shown with its checks, marked where it still fails.
 */
export async function suggestPicture(store: WorldStore, room: PictureRoom, blockKey: string, options: SuggestOptions): Promise<PictureSuggestion> {
  const index = room.plan.blocks.findIndex((planned) => planned.block.key === blockKey);
  if (index < 0) throw new Error("that block is no longer in the chapter");
  const planned = room.plan.blocks[index]!;
  const visible = depictable(room.people);
  const sheets = store.getBundle().sheets;
  const speaker = blockSpeakers(sheets, planned.block);
  const maxChars = promptRoom(options.model);
  // A look chosen for this block's picture alone is what the brief is written for and what rides (R-146).
  const own = ownLooksThatRide(store, room.look, room.own(blockKey));
  const library = kitLookLibrary(store.getBundle().referenceKits, room.look);
  const lines = briefLines(store, room.look, visible.map((person) => person.key), referenceBudgetFor(options.model) > 0, own);
  const given: PictureDeriverInput = {
    title: room.plan.chapter.title,
    ...(room.mood !== undefined ? { mood: room.mood } : {}),
    ...(room.synopsis !== undefined ? { synopsis: room.synopsis } : {}),
    ...(room.note !== undefined ? { note: room.note } : {}),
    block: { key: planned.block.key, text: normalizeSpeechText(planned.block.text), ...(speaker !== undefined ? { speaker } : {}) },
    ...(index > 0 ? { before: clip(room.plan.blocks[index - 1]!.block.text, PICTURE_BOUNDS.neighbour)! } : {}),
    ...(index < room.plan.blocks.length - 1 ? { after: clip(room.plan.blocks[index + 1]!.block.text, PICTURE_BOUNDS.neighbour)! } : {}),
    lines,
    people: visible,
    places: room.places,
    never: room.people.filter((person) => person.neverDepicted).map((person) => person.name),
    maxChars,
  };
  const draft = async (retry?: string) => {
    if (options.signal?.aborted) throw new Error("stopped");
    const raw = await options.deriver(retry === undefined ? given : { ...given, retry }, options.signal);
    if (options.signal?.aborted) throw new Error("stopped");
    const prompt = clipPrompt(raw.prompt, maxChars);
    if (prompt === "") throw new Error("the writing service gave no picture");
    const drafted = holdBrief(raw, { people: visible, places: room.places, prompt, fallback: () => namedIn(planned.block, visible) });
    const who = pictureWho(store, options.model, briefRiders(drafted), { look: room.look, frame: drafted.frame, own });
    const held = { ...drafted, prompt: neutralWhereLooksRide(drafted.prompt, who) };
    // A detail's hand keeps the look its person has for this picture too.
    const used = lookLinesFor(room.look, [...held.inFrame.map((person) => person.key), ...held.details.map((detail) => detail.of)], { ...ownLookPicks(own), ...ridingPicks(who) }, library);
    const checks = pictureChecks({ held, who, people: visible, lines: used, block: planned.block.text, mood: room.mood });
    return { held, who, used, checks };
  };
  let drafted = await draft();
  const outside = drafted.checks.find((check) => check.id === "not-in-frame" && !check.ok);
  // Check 2 (rule 14): a draft that names someone out of frame is asked again once, with the reason.
  if (outside !== undefined) drafted = await draft(`${outside.note ?? "it names someone"} who is not in frame. Name nobody in "notInFrame" in the prompt, not as a shoulder, a reflection or behind the camera.`);
  const { held, who, used, checks } = drafted;
  const picks = ridingPicks(who);
  const aspect = pictureAspect(options.model);
  const stamp = pictureLookFor(room.look, held.inFrame.map((person) => person.key), picks, library);
  return {
    block: blockKey,
    prompt: held.prompt,
    who,
    lines: used.map((line) => ({ label: line.label, text: line.text })),
    model: { provider: options.model.provider, id: options.model.id, name: options.model.displayName, references: referenceBudgetFor(options.model),
      ...(options.model.pricing.kind === "included-plan" ? { plan: "included-plan" as const } : {}) },
    ...(aspect !== undefined ? { aspect } : {}),
    estimatedMicroUsd: pictureQuote(options.model, who.filter((entry) => entry.carried).length, aspect),
    ...(stamp !== undefined ? { look: stamp } : {}),
    shot: { frame: held.frame, inFrame: held.inFrame.map((person) => person.key), notInFrame: held.notInFrame, expressions: held.expressions, details: held.details, checks },
  };
}
