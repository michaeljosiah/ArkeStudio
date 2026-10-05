import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { ChapterVoicesSchema, castParagraphHashes, chapterParagraphs, occurrencesOf, rebaseCast, reconcileCast, type ChapterVoicePin, type ChapterVoices, type HarnessAdapter } from "@arke-studio/contracts";
import type { SessionInput } from "../harness/session-files.js";
import { atomicWriteFile } from "../world/atomic.js";
import { CAST_PARAGRAPHS_SCHEMA_VERSION, VOICE_PINS_SCHEMA_VERSION } from "../world/commit.js";
import { fromPortable, toExtendedLength } from "../world/paths.js";
import type { WorldStore } from "../world/store.js";
import { sha256 } from "../world/text-files.js";
import { chapterPasses, makeAdapterJsonDeriver, passTail, sheetOf } from "./continuity.js";
import { openChapter } from "./ops.js";

/**
 * The cast of lines (design turn 130, issue 912, SPEC-012 §2.4.2): each spoken line of a
 * chapter as a verified span attributed to the character who speaks it, derived from the prose
 * in continuity's discipline — a press, passes, every quote a span of the pass it was read in,
 * a speaker tagged with a sheet only by exact id or a name exactly one sheet carries, and
 * nothing written into the world (R-44, R-45). The record lives beside the chapter at
 * `productions/<id>/.voices/<file>.json`, named by the file stem as the chapter's history and
 * its continuity are, keyed to the hash of the prose. A line names its paragraph and its
 * occurrence there, so a stale cast can tell one "No" from another (R-46).
 */

/** The sizes turn 130 fixes; the read schema bounds nothing, the derivation does. */
export const VOICES_BOUNDS = { lines: 400, line: 600 } as const;

const RawVoicesSchema = z
  .object({
    lines: z.array(z.object({ speaker: z.string().min(1), quote: z.string() }).strict()),
  })
  .strict();
export type RawVoices = z.infer<typeof RawVoicesSchema>;

export interface VoicesDeriverInput {
  title: string;
  /** One pass of the chapter: the whole body, or a run of whole paragraphs within the window. */
  body: string;
  /** The tail of the pass before this one, read for who is speaking and never quoted from. */
  context?: string;
  pass: { index: number; of: number };
  /** The production's cast, so a speaker is named as the world names them. */
  cast: ReadonlyArray<{ id: string; name: string }>;
  /**
   * The body is the paragraphs edited since the chapter was cast (design turn 198, SPEC-012 R-68),
   * and `context` the chapter around them rather than the end of the pass before.
   */
  edited?: true;
}
export type VoicesDeriver = (input: VoicesDeriverInput, signal?: AbortSignal) => Promise<RawVoices>;

function buildVoicesPrompt(input: VoicesDeriverInput, retryNote?: string): string {
  const cast = input.cast.map((entry) => `${entry.id} (${entry.name})`).join(", ") || "none";
  const part = input.edited === true
    ? "The text below is the paragraphs of the chapter edited since it was last cast; list only lines spoken in them."
    : input.pass.of > 1
      ? `This is pass ${input.pass.index} of ${input.pass.of} over the chapter; list only lines spoken in this pass's text.`
      : "";
  const context = input.context === undefined || input.context === ""
    ? ""
    : input.edited === true
      ? `\n## The chapter around those paragraphs (read it for who is speaking; do not quote from it)\n${input.context}\n`
      : `\n## The end of the pass before this one (read it for who is speaking; do not quote from it)\n${input.context}\n`;
  return `Read the chapter text below and list every line of dialogue that is spoken aloud, with who speaks it. Respond with ONLY a JSON object:
{"lines": [{"speaker": "<the speaker's name as the chapter gives it, or the sheet slug from the cast>", "quote": "<the spoken words, copied from the chapter exactly, including their quotation marks>"}]}

Rules — every one is enforced mechanically after you answer:
- "quote" is copied from the chapter character for character, one spoken line at a time, in reading order. A paraphrase will be dropped. At most ${VOICES_BOUNDS.line} characters each.
- Narration, thought and reported speech are not lines. Only words spoken aloud.
- Name a speaker by their sheet slug when the cast has one: ${cast}. A speaker the cast does not know is named as the chapter names them.
- A line whose speaker the text does not make clear is left out.
- If nothing is spoken, return {"lines": []}.
${part ? `- ${part}\n` : ""}${retryNote ? `\nYour previous response was rejected: ${retryNote}\n` : ""}${context}
## Chapter (${input.title})
${input.body}`;
}

/** The built-in deriver: the shared runner, asked the cast's prompt. */
export function makeAdapterVoicesDeriver(adapter: HarnessAdapter, sessionInput: SessionInput, scratchRoot: string): VoicesDeriver {
  const ask = makeAdapterJsonDeriver(adapter, sessionInput, scratchRoot, RawVoicesSchema, "voices");
  return (input, signal) => ask((note) => buildVoicesPrompt(input, note), signal);
}

const fold = (text: string) => text.replace(/\s+/g, " ").trim();

export interface VerifiedVoices {
  lines: ChapterVoices["lines"];
  /** Lines that were not in the pass, or longer than a line. */
  dropped: number;
}

/**
 * What the model said, held to the chapter (R-45): a line is kept only when it is a span of the
 * pass it was read in, whitespace folded, and short enough to be a line; then it is placed in
 * the chapter — the paragraph that holds it, preferring one the pass held, and the n-th
 * occurrence there when the same words are spoken more than once — so the read can find it
 * again exactly there. A quote that fits no paragraph, or is claimed more times than the
 * paragraph holds it, is dropped and counted.
 */
export function verifyVoices(
  raw: RawVoices,
  passBody: string,
  wholeBody: string,
  cast: ReadonlyArray<{ id: string; name: string }> = [],
  placedBefore: ReadonlyArray<{ paragraph: number; quote: string }> = [],
): VerifiedVoices {
  const foldedPass = fold(passBody);
  const paragraphs = chapterParagraphs(wholeBody);
  const inPass = paragraphs.map((paragraph) => foldedPass.includes(fold(paragraph)));
  const lines: ChapterVoices["lines"] = [];
  let dropped = 0;
  const claimed = (paragraph: number, quote: string) =>
    placedBefore.filter((line) => line.paragraph === paragraph && fold(line.quote) === quote).length +
    lines.filter((line) => line.paragraph === paragraph && fold(line.quote) === quote).length;
  for (const entry of raw.lines) {
    const quote = fold(entry.quote);
    const speaker = entry.speaker.trim();
    if (quote === "" || speaker === "" || quote.length > VOICES_BOUNDS.line || !foldedPass.includes(quote)) {
      dropped += 1;
      continue;
    }
    const holders = paragraphs.map((paragraph, index) => ({ index, count: occurrencesOf(paragraph, quote).length })).filter((entry) => entry.count > 0);
    // The first paragraph with an occurrence still unspoken for, those the pass held first
    // (codex on PR 914): "No." said in three paragraphs is three lines in three homes, not one
    // line and two drops.
    const ordered = [...holders.filter((entry) => inPass[entry.index]), ...holders.filter((entry) => !inPass[entry.index])];
    const home = ordered.find((entry) => claimed(entry.index, quote) < entry.count);
    if (home === undefined) {
      // Not in the chapter, or claimed more times than the chapter says it: not a line it holds.
      dropped += 1;
      continue;
    }
    const occurrence = claimed(home.index, quote);
    const sheet = sheetOf(speaker, cast);
    lines.push({ speaker, ...(sheet !== undefined ? { sheet } : {}), paragraph: home.index, occurrence, quote });
  }
  return { lines, dropped };
}

/**
 * The union of a chapter's passes: the lines in reading order — by paragraph, then by where
 * they fall in it — the first four hundred kept and the rest counted as omitted, read as
 * narration (R-45).
 */
export function mergeVoicePasses(passes: readonly VerifiedVoices[], body: string): { lines: ChapterVoices["lines"]; dropped: number; omitted: number } {
  const paragraphs = chapterParagraphs(body);
  const all = passes.flatMap((pass) => pass.lines);
  const at = (line: ChapterVoices["lines"][number]) => occurrencesOf(paragraphs[line.paragraph] ?? "", line.quote)[line.occurrence]?.start ?? 0;
  all.sort((a, b) => a.paragraph - b.paragraph || at(a) - at(b));
  const lines = all.slice(0, VOICES_BOUNDS.lines);
  return { lines, dropped: passes.reduce((sum, pass) => sum + pass.dropped, 0), omitted: all.length - lines.length };
}

/** Where a chapter's cast lives, as a portable path. */
export function voicesPath(productionId: string, chapterFile: string): string {
  return `productions/${productionId}/.voices/${chapterFile}.json`;
}

/** The cast beside a chapter, read plainly; a file that cannot be read is said so, never absent. */
export async function readVoices(store: WorldStore, productionId: string, chapterFile: string): Promise<ChapterVoices | "unreadable" | null> {
  let raw: string;
  try {
    raw = await readFile(toExtendedLength(join(store.dir, fromPortable(voicesPath(productionId, chapterFile)))), "utf8");
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ENOENT" ? null : "unreadable";
  }
  try {
    const parsed = ChapterVoicesSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : "unreadable";
  } catch {
    return "unreadable";
  }
}

export interface CastLines {
  record: ChapterVoices;
  lines: number;
  dropped: number;
  omitted: number;
}

/**
 * Cast one chapter's lines and write the record beside it (turn 130). Read in passes as
 * continuity is, each pass its own model run carrying the tail of the one before, every quote
 * verified against the pass it was read in and placed in the whole chapter; nothing is written
 * until every pass is in, through the store's ownership-checked path, so a stop, a failed pass
 * or a world owned elsewhere by now leaves the last cast standing (R-48).
 */
export async function castLines(
  store: WorldStore,
  productionId: string,
  chapterId: string,
  deriver: VoicesDeriver,
  signal?: AbortSignal,
  scope?: "changed",
): Promise<CastLines> {
  if (scope === "changed") return castChangedParagraphs(store, productionId, chapterId, deriver, signal);
  const derived = await deriveCast(store, productionId, chapterId, deriver, signal);
  const record = await writeCast(store, productionId, derived);
  return { record, lines: derived.lines.length, dropped: derived.dropped, omitted: derived.omitted };
}

/**
 * A chapter's lines cast and nothing written (design turn 184a, SPEC-047 R-54): what `castLines`
 * writes, held instead, so `Direct this chapter` can carry who speaks and how in one proposal
 * and write the cast only when that proposal is accepted.
 */
export interface DerivedCast {
  file: string;
  version: number;
  hash: string;
  body: string;
  passes: number;
  lines: ChapterVoices["lines"];
  dropped: number;
  omitted: number;
}

/**
 * The record a derived cast makes with the author's pins as they stand now (SPEC-012 R-64):
 * each pin whose words are still at its occurrence is carried, and the derived lines it overlaps
 * give way when the record is read (`pinnedLines`); a pin whose words are gone is dropped and
 * counted, never re-placed. Read at the write, not at the press, so a pin written before the run
 * is not lost with it.
 */
export async function composeCast(store: WorldStore, productionId: string, derived: DerivedCast): Promise<ChapterVoices> {
  const prior = await readVoices(store, productionId, derived.file);
  const recorded = prior !== null && prior !== "unreadable" ? (prior.pins ?? []) : [];
  // A record that keeps its paragraphs' hashes finds each pin's paragraph where it stands now
  // (design turn 198): a pin in a paragraph that moved is carried there, not lost to its index.
  const priorPins = prior !== null && prior !== "unreadable" && prior.paragraphs !== undefined ? reconcileCast(prior, derived.body).pins : recorded;
  const paragraphs = chapterParagraphs(derived.body);
  const pins = priorPins.filter((pin) => occurrencesOf(paragraphs[pin.paragraph] ?? "", pin.quote)[pin.occurrence] !== undefined);
  const lost = recorded.length - pins.length;
  return {
    version: derived.version,
    hash: derived.hash,
    derivedAt: store.now(),
    passes: derived.passes,
    dropped: derived.dropped,
    omitted: derived.omitted,
    lines: derived.lines,
    ...(pins.length > 0 ? { pins } : {}),
    ...(lost > 0 ? { lost } : {}),
    // Each paragraph's hash beside the lines (design turn 198, SPEC-012 R-66), so the next edit
    // makes stale only the paragraphs it touches.
    paragraphs: castParagraphHashes(derived.body),
  };
}

/** A derived cast written beside its chapter, with the pins as they stand at the write. */
export async function writeCast(store: WorldStore, productionId: string, derived: DerivedCast): Promise<ChapterVoices> {
  const record = await composeCast(store, productionId, derived);
  await writeVoices(store, productionId, derived.file, record);
  return record;
}

/** Cast one chapter's lines (turn 130) and hold the result; `castLines` writes it, a proposal holds it. */
export async function deriveCast(
  store: WorldStore,
  productionId: string,
  chapterId: string,
  deriver: VoicesDeriver,
  signal?: AbortSignal,
): Promise<DerivedCast> {
  const production = store.getBundle().productions.find((p) => p.meta.id === productionId);
  if (!production) throw new Error("That production is no longer in this world.");
  const summary = production.chapters.find((c) => c.id === chapterId || c.file === chapterId);
  if (!summary) throw new Error("That chapter is no longer in this production.");
  const opened = await openChapter(store, productionId, summary.id);
  const cast = store
    .getBundle()
    .sheets.filter((sheet) => sheet.type === "character" && !sheet.retired && (sheet.production === undefined || sheet.production === productionId))
    .map((sheet) => ({ id: sheet.id, name: sheet.name }));
  const passes = chapterPasses(opened.body);
  const verified: VerifiedVoices[] = [];
  for (const [index, body] of passes.entries()) {
    if (signal?.aborted) throw new Error("stopped");
    const previous = index > 0 ? passes[index - 1]! : undefined;
    const raw = await deriver(
      { title: summary.title, body, ...(previous !== undefined ? { context: passTail(previous) } : {}), pass: { index: index + 1, of: passes.length }, cast },
      signal,
    );
    if (signal?.aborted) throw new Error("stopped");
    verified.push(verifyVoices(raw, body, opened.body, cast, verified.flatMap((pass) => pass.lines)));
  }
  const merged = mergeVoicePasses(verified, opened.body);
  return { file: summary.file, version: opened.version, hash: sha256(opened.body), body: opened.body, passes: passes.length, lines: merged.lines, dropped: merged.dropped, omitted: merged.omitted };
}

/**
 * Write a chapter's cast through the store's ownership-checked path. A record with pins (or a
 * count of lost ones) raises the world past the builds whose strict reader would take it for
 * unreadable (SPEC-047 R-49); one without them keeps the shape they read.
 */
async function writeVoices(store: WorldStore, productionId: string, chapterFile: string, record: ChapterVoices): Promise<void> {
  if (record.pins !== undefined || record.lost !== undefined) await store.ensureSchemaVersion(VOICE_PINS_SCHEMA_VERSION, "voice-pins");
  // Paragraph hashes are a field the strict reader before design turn 198 refuses (SPEC-012 R-66).
  if (record.paragraphs !== undefined) await store.ensureSchemaVersion(CAST_PARAGRAPHS_SCHEMA_VERSION, "cast-paragraphs");
  const absolute = join(store.dir, fromPortable(voicesPath(productionId, chapterFile)));
  await store.ownedWrite(async () => {
    await mkdir(toExtendedLength(join(absolute, "..")), { recursive: true });
    await atomicWriteFile(absolute, `${JSON.stringify(record, null, 2)}\n`);
  });
  await store.reload();
}

/** A pin refused, in the one clause the Audiobook view says it in. */
export class VoicePinRefusal extends Error {}

export interface VoicePinInput {
  paragraph: number;
  occurrence: number;
  quote: string;
  speaker?: string;
  sheet?: string;
  narration?: true;
  clear?: true;
}

/** A cast held to the body as it is now, in the body's own indices, and the paragraphs left to cast. */
type StandingRecord = ChapterVoices & { paragraphs: string[]; toCast: number[] };

/**
 * The record rebased onto the prose as it stands (design turn 198, SPEC-012 R-67): every line and
 * pin at the body's own indices, a paragraph edited since the cast waiting under the empty hash.
 * A record cast before paragraph hashes takes them from the body when the chapter's hash proves it
 * is the body that was cast — safe, since those are the words the lines were placed in — and is
 * otherwise stale whole, as before: null, and the caller says `cast moved`. Once nothing is left
 * to cast the record is current against these words, and says so in its hash and version.
 */
function standingRecord(record: ChapterVoices, opened: { body: string; version: number }): StandingRecord | null {
  const bodyHash = sha256(opened.body);
  const hashes = record.paragraphs ?? (bodyHash === record.hash ? castParagraphHashes(opened.body) : null);
  if (hashes === null) return null;
  const rebased = rebaseCast({ ...record, paragraphs: hashes }, opened.body);
  const { pins: _pins, lost: _lost, ...rest } = record;
  const lost = (record.lost ?? 0) + rebased.lost;
  const current = rebased.toCast.length === 0;
  return {
    ...rest,
    ...(current ? { hash: bodyHash, version: opened.version } : {}),
    lines: rebased.lines,
    ...(rebased.pins.length > 0 ? { pins: rebased.pins } : {}),
    ...(lost > 0 ? { lost } : {}),
    paragraphs: rebased.paragraphs,
    toCast: rebased.toCast,
  };
}

/** The record a standing cast is written as: its own fields, without what was worked out for it. */
function recordOf(standing: StandingRecord): ChapterVoices {
  const { toCast: _toCast, ...record } = standing;
  return record;
}

/**
 * Set, or clear, the author's word on who speaks a span (design turn 155, SPEC-012 R-62..R-65).
 * A pin names a paragraph and an occurrence in it, so it is written against the prose as it
 * stands: the record rebased onto it first (design turn 198, R-70), which a cast stale only in
 * some paragraphs can be — giving a line to a speaker stays on in every paragraph the edit did
 * not touch, and on a line an edited paragraph kept or still holds word for word; only words in
 * an edited paragraph that are neither wait for its cast. The words must be there, at that
 * occurrence, and no longer than a line; a sheet must be one the production's cast holds. A pin
 * replaces any pin it overlaps, and one that says what the derivation already says is no pin at
 * all — but choosing a kept line's speaker is a pin, since it is what checks the line.
 */
export async function setVoicePin(store: WorldStore, productionId: string, chapterId: string, input: VoicePinInput): Promise<ChapterVoices> {
  const production = store.getBundle().productions.find((p) => p.meta.id === productionId);
  if (!production) throw new VoicePinRefusal("that production is gone");
  const summary = production.chapters.find((c) => c.id === chapterId || c.file === chapterId);
  if (!summary) throw new VoicePinRefusal("that chapter is gone");
  const recorded = await readVoices(store, productionId, summary.file);
  if (recorded === null) throw new VoicePinRefusal("not cast · cast the lines first");
  if (recorded === "unreadable") throw new VoicePinRefusal("cast unreadable · cast again");
  const opened = await openChapter(store, productionId, summary.id);
  const current = standingRecord(recorded, opened);
  if (current === null) throw new VoicePinRefusal("cast moved · cast again");
  if (input.quote.length > VOICES_BOUNDS.line) throw new VoicePinRefusal("longer than a line");
  const paragraphs = chapterParagraphs(opened.body);
  const span = (pin: { paragraph: number; occurrence: number; quote: string }) =>
    occurrencesOf(paragraphs[pin.paragraph] ?? "", pin.quote)[pin.occurrence];
  const hit = span(input);
  if (hit === undefined) throw new VoicePinRefusal("those words are not there");
  // The lines as they read now, kept ones marked: what a pin in an edited paragraph must land on.
  const standing = reconcileCast(current, opened.body).lines.filter((line) => line.paragraph === input.paragraph);
  const under = standing.filter((line) => {
    const at = span(line);
    return at !== undefined && at.start < hit.end && hit.start < at.end;
  });
  if (current.toCast.includes(input.paragraph) && under.length === 0) throw new VoicePinRefusal("paragraph to cast · cast it first");
  let pin: ChapterVoicePin | null = null;
  if (input.clear !== true) {
    if (input.narration === true) {
      pin = { paragraph: input.paragraph, occurrence: input.occurrence, quote: input.quote, narration: true };
    } else {
      const speaker = input.speaker?.trim() ?? "";
      if (speaker === "") throw new VoicePinRefusal("no speaker");
      if (input.sheet !== undefined) {
        const sheet = store.getBundle().sheets.find((candidate) => candidate.id === input.sheet);
        const inCast = sheet !== undefined && sheet.type === "character" && !sheet.retired && (sheet.production === undefined || sheet.production === productionId);
        if (!inCast) throw new VoicePinRefusal("no such character");
      }
      pin = { paragraph: input.paragraph, occurrence: input.occurrence, quote: input.quote, speaker, ...(input.sheet !== undefined ? { sheet: input.sheet } : {}) };
    }
    // Saying what the derivation says is no correction: the pin is dropped rather than kept. A
    // kept line is not what the derivation said, only what the edit left: its speaker is a pin.
    const derived = standing.find((line) => line.occurrence === input.occurrence && line.quote === input.quote);
    const same = pin.narration === true
      ? derived === undefined
      : derived !== undefined && derived.kept !== true && (pin.sheet !== undefined ? derived.sheet === pin.sheet : derived.sheet === undefined && derived.speaker === pin.speaker);
    if (same) pin = null;
  }
  const overlaps = (other: ChapterVoicePin) => {
    if (other.paragraph !== input.paragraph) return false;
    const at = span(other);
    return at !== undefined && at.start < hit.end && hit.start < at.end;
  };
  const pins = [...(current.pins ?? []).filter((other) => !overlaps(other)), ...(pin !== null ? [pin] : [])];
  if (pins.length > VOICES_BOUNDS.lines) throw new VoicePinRefusal("too many corrections");
  const { pins: _previous, ...rest } = recordOf(current);
  const record: ChapterVoices = pins.length > 0 ? { ...rest, pins } : rest;
  await writeVoices(store, productionId, summary.file, record);
  return record;
}

/** How much of the chapter around the edited paragraphs a partial cast reads for who is speaking. */
const AROUND_BOUND = 6_000;

/**
 * The chapter around the paragraphs left to cast, for the model to read who is speaking and
 * never quote from: the two paragraphs before each and the one after, those not themselves left
 * to cast, in order, with a gap marked where the chapter is skipped.
 */
function chapterAround(paragraphs: readonly string[], toCast: readonly number[]): string {
  const waiting = new Set(toCast);
  const near = [...new Set(toCast.flatMap((j) => [j - 2, j - 1, j + 1]))].filter((at) => at >= 0 && at < paragraphs.length && !waiting.has(at)).sort((a, b) => a - b);
  const parts: string[] = [];
  let total = 0;
  let last = -2;
  for (const at of near) {
    const text = paragraphs[at]!;
    if (total + text.length > AROUND_BOUND) break;
    if (last >= 0 && at > last + 1) parts.push("…");
    parts.push(text);
    total += text.length;
    last = at;
  }
  return parts.join("\n\n");
}

/**
 * Cast only the paragraphs edited since the chapter was cast (design turn 198, SPEC-012 R-68):
 * the record rebased onto the prose, the model given those paragraphs alone — the chapter around
 * them as context — and every line it finds there verified as a full cast's are and merged into
 * the record in place of what those paragraphs carried. Lines elsewhere, and their paragraphs,
 * are left as they stand. A chapter with no cast, or one cast before paragraph hashes whose prose
 * has moved since, has nothing to merge into and is cast whole. Nothing is written until every
 * pass is in, with the pins as they stand at the write.
 */
export async function castChangedParagraphs(
  store: WorldStore,
  productionId: string,
  chapterId: string,
  deriver: VoicesDeriver,
  signal?: AbortSignal,
): Promise<CastLines> {
  const production = store.getBundle().productions.find((p) => p.meta.id === productionId);
  if (!production) throw new Error("That production is no longer in this world.");
  const summary = production.chapters.find((c) => c.id === chapterId || c.file === chapterId);
  if (!summary) throw new Error("That chapter is no longer in this production.");
  const prior = await readVoices(store, productionId, summary.file);
  const opened = await openChapter(store, productionId, summary.id);
  const standing = prior === null || prior === "unreadable" ? null : standingRecord(prior, opened);
  if (standing === null) return castLines(store, productionId, summary.id, deriver, signal);
  const paragraphs = chapterParagraphs(opened.body);
  const waiting = new Set(standing.toCast);
  const cast = store
    .getBundle()
    .sheets.filter((sheet) => sheet.type === "character" && !sheet.retired && (sheet.production === undefined || sheet.production === productionId))
    .map((sheet) => ({ id: sheet.id, name: sheet.name }));
  const found: VerifiedVoices[] = [];
  if (waiting.size > 0) {
    const body = standing.toCast.map((j) => paragraphs[j]!).join("\n\n");
    const context = chapterAround(paragraphs, standing.toCast);
    const passes = chapterPasses(body);
    for (const [index, pass] of passes.entries()) {
      if (signal?.aborted) throw new Error("stopped");
      const raw = await deriver({ title: summary.title, body: pass, ...(context !== "" ? { context } : {}), pass: { index: index + 1, of: passes.length }, cast, edited: true }, signal);
      if (signal?.aborted) throw new Error("stopped");
      found.push(verifyVoices(raw, pass, opened.body, cast, found.flatMap((verified) => verified.lines)));
    }
  }
  // Only what lands in a paragraph left to cast is this run's: a quote the model found that the
  // chapter also holds elsewhere is no reason to touch a paragraph nobody edited.
  const lines = found.flatMap((verified) => verified.lines);
  const ours = lines.filter((line) => waiting.has(line.paragraph));
  const dropped = found.reduce((sum, verified) => sum + verified.dropped, 0) + (lines.length - ours.length);
  const merged = mergeVoicePasses([{ lines: standing.lines.filter((line) => !waiting.has(line.paragraph)), dropped: 0 }, { lines: ours, dropped }], opened.body);
  // The pins as they stand at the write, so one set while the model read is not lost with it.
  const latest = await readVoices(store, productionId, summary.file);
  const pinsNow = latest === null || latest === "unreadable" ? standing : (standingRecord(latest, opened) ?? standing);
  const record: ChapterVoices = {
    version: opened.version,
    hash: sha256(opened.body),
    derivedAt: store.now(),
    passes: standing.passes,
    dropped: merged.dropped,
    omitted: merged.omitted,
    lines: merged.lines,
    ...(pinsNow.pins !== undefined ? { pins: pinsNow.pins } : {}),
    ...(pinsNow.lost !== undefined ? { lost: pinsNow.lost } : {}),
    paragraphs: castParagraphHashes(opened.body),
  };
  await writeVoices(store, productionId, summary.file, record);
  return { record, lines: ours.length, dropped: merged.dropped, omitted: merged.omitted };
}

/**
 * A cast as a chapter opens with it (design turn 198, SPEC-012 R-71): a record cast before
 * paragraph hashes, while the chapter's hash is still its own, is given them from the body — the
 * words it was cast against — so the screen reads it as every record written now is read.
 */
export function openedVoices(record: ChapterVoices, body: string): ChapterVoices {
  return record.paragraphs === undefined && sha256(body) === record.hash ? { ...record, paragraphs: castParagraphHashes(body) } : record;
}

/**
 * Stamp paragraph hashes on a cast written before them (design turn 198, SPEC-012 R-71), before a
 * save changes the prose under it: while the chapter's hash is the record's, the body on disk is
 * the one it was cast against, so its paragraphs are the cast's, and the save's edit is then stale
 * in the paragraphs it touches alone. Once the prose has moved under such a record nothing can be
 * stamped safely, and it stays stale whole until it is cast again. A failure here costs the save
 * nothing: the record is left as it was.
 */
export async function stampCastParagraphs(store: WorldStore, productionId: string, chapterFile: string): Promise<void> {
  try {
    const record = await readVoices(store, productionId, chapterFile);
    if (record === null || record === "unreadable" || record.paragraphs !== undefined) return;
    const summary = store.getBundle().productions.find((p) => p.meta.id === productionId)?.chapters.find((c) => c.file === chapterFile || c.id === chapterFile);
    if (summary === undefined) return;
    const opened = await openChapter(store, productionId, summary.id);
    if (sha256(opened.body) !== record.hash) return;
    await writeVoices(store, productionId, summary.file, { ...record, paragraphs: castParagraphHashes(opened.body) });
  } catch {
    // The save goes on; the record is as it was.
  }
}
