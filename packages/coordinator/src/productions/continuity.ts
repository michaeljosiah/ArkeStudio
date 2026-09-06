import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { ChapterContinuitySchema, type ChapterContinuity, type HarnessAdapter } from "@arke-studio/contracts";
import { extractJson } from "../canon/ask.js";
import { createPreparedSession, type SessionInput } from "../harness/session-files.js";
import { atomicWriteFile } from "../world/atomic.js";
import { fromPortable, toExtendedLength } from "../world/paths.js";
import type { WorldStore } from "../world/store.js";
import { openChapter } from "./ops.js";

/**
 * Continuity after a chapter (design turn 129, issue 901, SPEC-012 §2.4.1): who is where and
 * what they learn, derived from the prose in the discipline SPEC-015 holds fact extraction to —
 * the model answers with JSON, every line and every placing is a span of the chapter verified
 * character for character, what does not verify is dropped and counted, and nothing here writes
 * a world file the gate owns (R-38, R-40). The record lives beside the chapters at
 * `productions/<id>/.continuity/<file>.json`: derived, unversioned, durable and exported,
 * because a derivation is a paid model run and the index is the cache anyone may delete for
 * free. The whole chapter is read, in passes of whole paragraphs when it is longer than one
 * pass of the model's window, and the passes are unioned into one record (R-41).
 */

/** The sizes turn 129 fixes; the read schema bounds nothing, the derivation does. */
export const CONTINUITY_BOUNDS = { characters: 12, lines: 6, line: 300, where: 120, character: 120, pass: 24_000 } as const;

const RawContinuitySchema = z
  .object({
    characters: z.array(
      z
        .object({
          character: z.string().min(1),
          present: z.boolean().optional(),
          where: z.string().optional(),
          placed: z.string().optional(),
          knows: z.array(z.string()).optional(),
        })
        .strict(),
    ),
  })
  .strict();
export type RawContinuity = z.infer<typeof RawContinuitySchema>;

export interface ContinuityDeriverInput {
  title: string;
  /** One pass of the chapter: the whole body, or a run of whole paragraphs within the window. */
  body: string;
  /** Which pass this is, so the prompt can say the text is part of a chapter, not all of it. */
  pass: { index: number; of: number };
  /** The production's cast, so a placed character is named as the world names it. */
  cast: ReadonlyArray<{ id: string; name: string }>;
}
export type ContinuityDeriver = (input: ContinuityDeriverInput, signal?: AbortSignal) => Promise<RawContinuity>;

function buildContinuityPrompt(input: ContinuityDeriverInput, retryNote?: string): string {
  const cast = input.cast.map((entry) => `${entry.id} (${entry.name})`).join(", ") || "none";
  const part = input.pass.of > 1
    ? `This is pass ${input.pass.index} of ${input.pass.of} over the chapter; say only what this pass's text evidences.`
    : "";
  return `Read the chapter text below and say, for each character the prose places, where they are and what they learn by its end. Respond with ONLY a JSON object:
{"characters": [{"character": "<sheet slug from the cast, or the name the chapter introduces>", "present": true, "where": "<a location slug or the chapter's own words>", "placed": "<the span of the chapter that puts them there, copied exactly>", "knows": ["<a span copied from the chapter, character for character>"]}]}

Rules — every one is enforced mechanically after you answer:
- "knows" holds spans copied from the chapter exactly. A paraphrase will be dropped. Each at most ${CONTINUITY_BOUNDS.line} characters, at most ${CONTINUITY_BOUNDS.lines} per character.
- "placed" is the span, copied exactly, that puts the character where "where" says. A "where" with no such span will be dropped.
- At most ${CONTINUITY_BOUNDS.characters} characters. Name a character by its sheet slug when the cast has one: ${cast}.
- "where" is where the character is at the end of this text, in a location slug or the chapter's own words; leave it out when the text does not place them.
- If the text places no one, return {"characters": []}.
${part ? `- ${part}\n` : ""}${retryNote ? `\nYour previous response was rejected: ${retryNote}\n` : ""}
## Chapter (${input.title})
${input.body}`;
}

const WALL_CLOCK_MS = 120_000;

/**
 * The built-in deriver: a sandboxed session as extraction runs one, stoppable the same way. A
 * seam takes its place under test. One session per pass, so a pass is a run of its own (R-41).
 */
export function makeAdapterContinuityDeriver(
  adapter: HarnessAdapter,
  sessionInput: SessionInput,
  scratchRoot: string,
): ContinuityDeriver {
  return async (input, signal) => {
    const stopped = () => new Error("stopped");
    if (signal?.aborted) throw stopped();
    const sandbox = join(scratchRoot, `continuity-${Date.now().toString(36)}-${input.pass.index}`);
    await mkdir(toExtendedLength(sandbox), { recursive: true });
    const session = await createPreparedSession(adapter, sandbox, sessionInput({}), {
      purpose: "extraction",
      agent: "canon-author",
    });
    if (signal?.aborted) throw stopped();

    const turn = async (prompt: string): Promise<string> => {
      if (signal?.aborted) throw stopped();
      let finalText = "";
      const abort = new AbortController();
      const onStop = () => {
        void (adapter as { interrupt?: (id: string) => Promise<void> }).interrupt
          ?.call(adapter, session.sessionId)
          .catch(() => {});
        abort.abort();
      };
      signal?.addEventListener("abort", onStop, { once: true });
      if (signal?.aborted) onStop();
      const events = adapter.streamEvents(abort.signal);
      const collected = (async () => {
        for await (const event of events) {
          if (!("sessionId" in event) || event.sessionId !== session.sessionId) continue;
          if (event.type === "message.completed") {
            finalText = event.text ?? "";
            return;
          }
          if (event.type === "session.error") throw new Error(event.message);
        }
      })();
      await adapter.dispatchAsync({ sessionId: session.sessionId, parts: [{ type: "text", text: prompt }] });
      let deadline: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => {
        deadline = setTimeout(() => reject(new Error("deriving took too long")), WALL_CLOCK_MS);
      });
      try {
        await Promise.race([collected, timeout]);
      } finally {
        clearTimeout(deadline);
        signal?.removeEventListener("abort", onStop);
        abort.abort();
      }
      if (signal?.aborted) throw stopped();
      return finalText;
    };

    let raw = await turn(buildContinuityPrompt(input));
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return RawContinuitySchema.parse(extractJson(raw));
      } catch (err) {
        // One correction, never a loop; a second bad answer is a failed run, said as such, not
        // an empty record presented as the chapter placing no one.
        if (attempt === 1) throw new Error("the model did not answer with a continuity record");
        raw = await turn(
          buildContinuityPrompt(
            input,
            `not valid JSON matching the contract (${err instanceof Error ? err.message.slice(0, 200) : "parse error"})`,
          ),
        );
      }
    }
    throw new Error("the model did not answer with a continuity record");
  };
}

const fold = (text: string) => text.replace(/\s+/g, " ").trim();

/**
 * A paragraph longer than the window — pasted prose with no blank lines — cannot be read whole
 * (codex on turn 129): it is split at sentence ends into pieces that fit, never mid-sentence
 * while a sentence fits, and a sentence longer than the window is split at the window as the
 * last resort. A line the model quotes across a split is in neither piece and is dropped and
 * counted like any other, so the record never claims more than the check proved.
 */
function pieces(paragraph: string, limit: number): string[] {
  if (paragraph.length <= limit) return [paragraph];
  const out: string[] = [];
  let current = "";
  for (const sentence of paragraph.split(/(?<=[.!?…]["”’)\]]?)\s+/)) {
    const parts = sentence.length <= limit ? [sentence] : Array.from({ length: Math.ceil(sentence.length / limit) }, (_, i) => sentence.slice(i * limit, (i + 1) * limit));
    for (const part of parts) {
      if (current !== "" && current.length + 1 + part.length > limit) {
        out.push(current);
        current = part;
      } else {
        current = current === "" ? part : `${current} ${part}`;
      }
    }
  }
  if (current !== "") out.push(current);
  return out;
}

/**
 * The passes a chapter is read in (R-41): the whole body when it fits the window, else runs of
 * whole paragraphs packed up to it — nothing is cut at a window's edge, and only a paragraph
 * that could not fit a pass on its own is split, at sentence ends.
 */
export function chapterPasses(body: string, limit: number = CONTINUITY_BOUNDS.pass): string[] {
  const text = body.trim();
  if (text === "") return [""];
  if (text.length <= limit) return [text];
  const passes: string[] = [];
  let current = "";
  for (const paragraph of text.split(/\n\s*\n/).flatMap((whole) => pieces(whole, limit))) {
    if (current !== "" && current.length + 2 + paragraph.length > limit) {
      passes.push(current);
      current = paragraph;
    } else {
      current = current === "" ? paragraph : `${current}\n\n${paragraph}`;
    }
  }
  if (current !== "") passes.push(current);
  return passes;
}

export interface VerifiedContinuity {
  characters: ChapterContinuity["characters"];
  /** Lines and placings that were not in the chapter. */
  dropped: number;
  /** Characters beyond the cap. */
  omitted: number;
  /** Lines beyond a character's sixth, verified or not (codex on turn 129): counted, never silent. */
  cut: number;
}

/**
 * What the model said, held to the chapter (SPEC-015 D2, D3; SPEC-012 R-40): a line, and a
 * placing, is kept only when it is a span of the body — whitespace folded, since the file wraps
 * where the model would not — and everything else is dropped and counted. A placing that does
 * not verify takes `where` with it: a location the model invented never reaches the table, let
 * alone carries. Sizes are enforced here, never trusted, and characters beyond the cap are
 * counted as omitted rather than silently cut.
 */
export function verifyContinuity(raw: RawContinuity, body: string): VerifiedContinuity {
  const folded = fold(body);
  const inBody = (quote: string) => quote !== "" && quote.length <= CONTINUITY_BOUNDS.line && folded.includes(quote);
  let dropped = 0;
  let cut = 0;
  const characters: ChapterContinuity["characters"] = [];
  const named = raw.characters.filter((entry) => entry.character.trim() !== "");
  for (const entry of named.slice(0, CONTINUITY_BOUNDS.characters)) {
    const character = entry.character.trim().slice(0, CONTINUITY_BOUNDS.character);
    const knows: string[] = [];
    for (const line of entry.knows ?? []) {
      const quote = fold(line);
      if (!inBody(quote)) dropped++;
      else if (knows.includes(quote)) continue;
      else if (knows.length >= CONTINUITY_BOUNDS.lines) cut++;
      else knows.push(quote);
    }
    const where = entry.where === undefined ? "" : fold(entry.where).slice(0, CONTINUITY_BOUNDS.where);
    const placed = entry.placed === undefined ? "" : fold(entry.placed);
    const placedHere = where !== "" && inBody(placed);
    if (where !== "" && !placedHere) dropped++;
    characters.push({
      character,
      present: entry.present ?? true,
      ...(placedHere ? { where, placed } : {}),
      knows,
    });
  }
  return { characters, dropped, omitted: Math.max(0, named.length - CONTINUITY_BOUNDS.characters), cut };
}

/**
 * The union of a chapter's passes (R-41): `where` and its placing from the last pass that placed
 * the character, `knows` from every pass up to the cap, the counts summed, and the cap applied
 * once more over the union in order of first appearance.
 */
export function mergePasses(passes: readonly VerifiedContinuity[]): VerifiedContinuity {
  const byCharacter = new Map<string, ChapterContinuity["characters"][number]>();
  let dropped = 0;
  let omitted = 0;
  let cut = 0;
  for (const pass of passes) {
    dropped += pass.dropped;
    omitted += pass.omitted;
    cut += pass.cut;
    for (const entry of pass.characters) {
      const held = byCharacter.get(entry.character);
      if (held === undefined) {
        byCharacter.set(entry.character, { ...entry, knows: [...entry.knows] });
        continue;
      }
      held.present = held.present || entry.present;
      if (entry.where !== undefined) {
        held.where = entry.where;
        held.placed = entry.placed!;
      }
      for (const line of entry.knows) {
        if (held.knows.includes(line)) continue;
        if (held.knows.length >= CONTINUITY_BOUNDS.lines) cut++;
        else held.knows.push(line);
      }
    }
  }
  const all = [...byCharacter.values()];
  const characters = all.slice(0, CONTINUITY_BOUNDS.characters);
  return { characters, dropped, omitted: omitted + (all.length - characters.length), cut };
}

/** Where a chapter's record lives, as a portable path. */
export function continuityPath(productionId: string, chapterFile: string): string {
  return `productions/${productionId}/.continuity/${chapterFile}.json`;
}

/**
 * The record beside a chapter, read plainly. A file that is there but cannot be read — cut
 * short, hand-edited, or written by a newer build — is not no record (codex on turn 129): it is
 * a paid run, said to be unreadable rather than absent, and only a derivation replaces it.
 */
export async function readContinuity(store: WorldStore, productionId: string, chapterFile: string): Promise<ChapterContinuity | "unreadable" | null> {
  let raw: string;
  try {
    raw = await readFile(toExtendedLength(join(store.dir, fromPortable(continuityPath(productionId, chapterFile)))), "utf8");
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ENOENT" ? null : "unreadable";
  }
  try {
    const parsed = ChapterContinuitySchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : "unreadable";
  } catch {
    return "unreadable";
  }
}

export interface DerivedContinuity {
  record: ChapterContinuity;
  placed: number;
  dropped: number;
  omitted: number;
}

/**
 * Derive one chapter's continuity and write the record beside it (turn 129). Keyed to the bytes
 * read here — the hash decides staleness, since a direct save keeps the version (R-39). Read in
 * passes when the body is longer than the window, each pass its own model run, stoppable
 * between and during them; nothing is written until every pass is in, so a stop or a failed
 * pass leaves the last record standing.
 */
export async function deriveContinuity(
  store: WorldStore,
  productionId: string,
  chapterId: string,
  deriver: ContinuityDeriver,
  signal?: AbortSignal,
): Promise<DerivedContinuity> {
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
  const verified: VerifiedContinuity[] = [];
  for (const [index, body] of passes.entries()) {
    if (signal?.aborted) throw new Error("stopped");
    const raw = await deriver({ title: summary.title, body, pass: { index: index + 1, of: passes.length }, cast }, signal);
    if (signal?.aborted) throw new Error("stopped");
    verified.push(verifyContinuity(raw, body));
  }
  const merged = mergePasses(verified);
  const record: ChapterContinuity = {
    version: opened.version,
    hash: opened.hash,
    derivedAt: store.now(),
    passes: passes.length,
    dropped: merged.dropped,
    omitted: merged.omitted,
    cut: merged.cut,
    characters: merged.characters,
  };
  const absolute = join(store.dir, fromPortable(continuityPath(productionId, summary.file)));
  await mkdir(toExtendedLength(join(absolute, "..")), { recursive: true });
  await atomicWriteFile(absolute, `${JSON.stringify(record, null, 2)}\n`);
  await store.reload();
  return { record, placed: merged.characters.length, dropped: merged.dropped, omitted: merged.omitted };
}
