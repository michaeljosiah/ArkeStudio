import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { ChapterVoicesSchema, chapterParagraphs, occurrencesOf, type ChapterVoices, type HarnessAdapter } from "@arke-studio/contracts";
import type { SessionInput } from "../harness/session-files.js";
import { atomicWriteFile } from "../world/atomic.js";
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
}
export type VoicesDeriver = (input: VoicesDeriverInput, signal?: AbortSignal) => Promise<RawVoices>;

function buildVoicesPrompt(input: VoicesDeriverInput, retryNote?: string): string {
  const cast = input.cast.map((entry) => `${entry.id} (${entry.name})`).join(", ") || "none";
  const part = input.pass.of > 1
    ? `This is pass ${input.pass.index} of ${input.pass.of} over the chapter; list only lines spoken in this pass's text.`
    : "";
  const context = input.context !== undefined && input.context !== ""
    ? `\n## The end of the pass before this one (read it for who is speaking; do not quote from it)\n${input.context}\n`
    : "";
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
): Promise<CastLines> {
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
  const record: ChapterVoices = {
    version: opened.version,
    hash: sha256(opened.body),
    derivedAt: store.now(),
    passes: passes.length,
    dropped: merged.dropped,
    omitted: merged.omitted,
    lines: merged.lines,
  };
  const absolute = join(store.dir, fromPortable(voicesPath(productionId, summary.file)));
  await store.ownedWrite(async () => {
    await mkdir(toExtendedLength(join(absolute, "..")), { recursive: true });
    await atomicWriteFile(absolute, `${JSON.stringify(record, null, 2)}\n`);
  });
  await store.reload();
  return { record, lines: merged.lines.length, dropped: merged.dropped, omitted: merged.omitted };
}
