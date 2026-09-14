import { z } from "zod";
import {
  AUDIOBOOK_DELIVERIES,
  CADENCE_PHRASE_MAX,
  DeliverySchema,
  audiobookTextHash,
  cadenceSupport,
  normalizeSpeechText,
  type AudiobookDirection,
  type AudiobookDirectionInput,
  type AudiobookReader,
  type CadencePlan,
  type ChapterAudiobook,
  type HarnessAdapter,
  type ManifestModel,
  type VoiceCandidate,
} from "@arke-studio/contracts";
import type { SessionInput } from "../harness/session-files.js";
import type { WorldStore } from "../world/store.js";
import { castRefusal, checkDirection, directionPlan, effectiveReader, planAudiobook, readerLanguage, updateAudiobook, type PlannedBlock } from "./audiobook.js";
import { CONTINUITY_BOUNDS, makeAdapterJsonDeriver } from "./continuity.js";

/**
 * `Direct this chapter` (design turn 146, SPEC-047 R-10, §2.3): the cast derivation turned on
 * performance. The model is asked for a direction per block — a delivery from the six, a
 * phrase, a speed, cues anchored to exact words — and every answer is held to the block it
 * names and to the row of the block's reader: a delivery the reader lacks, a phrase it takes
 * nowhere, a cue at words the block does not hold exactly once, is dropped and counted rather
 * than accepted into a direction the read could only flag. What verifies is one card, accepted
 * whole through `acceptDirections`, which writes the record and nothing else; the derivation
 * itself writes nothing.
 */

const RawCueSchema = z.union([
  z.object({ kind: z.literal("pause"), after: z.string(), length: z.enum(["short", "long"]).catch("short") }),
  z.object({ kind: z.literal("breath"), before: z.string(), action: z.enum(["inhale", "exhale"]).catch("inhale") }),
  z.object({ kind: z.literal("emphasis"), words: z.string(), level: z.enum(["moderate", "strong"]).catch("moderate") }),
]);
const RawDirectionSchema = z.object({
  blocks: z.array(
    z.object({
      block: z.string(),
      delivery: z.string().optional(),
      phrase: z.string().nullable().optional(),
      speed: z.number().nullable().optional(),
      cues: z.array(RawCueSchema).optional(),
    }),
  ),
  summary: z.string().optional(),
});
export type RawDirection = z.infer<typeof RawDirectionSchema>;

/** What the prompt says of one block: its words, and what its reader can do with them. */
export interface DirectionBlockInput {
  key: string;
  text: string;
  reader: string;
  deliveries: readonly string[];
  phrase: boolean;
  pause: boolean;
  breath: boolean;
  emphasis: boolean;
  speed: { min: number; max: number } | null;
}
export interface DirectionDeriverInput {
  title: string;
  pass: { index: number; of: number };
  blocks: DirectionBlockInput[];
}
export type DirectionDeriver = (input: DirectionDeriverInput, signal?: AbortSignal) => Promise<RawDirection>;

function buildDirectionPrompt(input: DirectionDeriverInput, retryNote?: string): string {
  const part = input.pass.of > 1 ? `This is pass ${input.pass.index} of ${input.pass.of} over the chapter; direct only the blocks listed here.` : "";
  const blocks = input.blocks
    .map((block) => {
      const can = [
        `reads ${block.deliveries.join(", ")}`,
        block.phrase ? "takes a phrase" : "no phrase",
        block.speed !== null ? `speed ${block.speed.min}–${block.speed.max}` : "no speed",
        block.pause ? "pause" : "no pause",
        block.breath ? "breath" : "no breath",
        block.emphasis ? "emphasis" : "no emphasis",
      ].join(" · ");
      return `[${block.key}] read by ${block.reader} · ${can}\n${block.text}`;
    })
    .join("\n\n");
  return `Direct the reading of the chapter blocks below for an audiobook. Respond with ONLY a JSON object:
{"blocks": [{"block": "<the block's key>", "delivery": "<one of ${AUDIOBOOK_DELIVERIES.join(", ")}>", "phrase": "<optional: how to read it, in your own words, at most ${CADENCE_PHRASE_MAX} characters>", "speed": <optional: 0.7 to 1.2>, "cues": [{"kind": "pause", "after": "<exact words from the block the pause follows>", "length": "short" | "long"}, {"kind": "breath", "before": "<exact words from the block>", "action": "inhale" | "exhale"}, {"kind": "emphasis", "words": "<exact words from the block>", "level": "moderate" | "strong"}]}], "summary": "<one or two sentences on what you did and why>"}

Rules — every one is enforced mechanically after you answer:
- Address every block by its key, in order. A block left out is counted as dropped.
- Each block says who reads it and what that reader can do. Use only the deliveries listed for that block; give a phrase only where the reader takes one; place only the kinds of cue the reader takes; set a speed only where it has one. Anything else is dropped.
- "measured" is the ordinary reading. Leave a block measured unless its words ask for something else; direct sparingly, and never every block the same way for effect.
- "after", "before" and "words" are copied from the block character for character and must occur exactly once in it. At most 40 cues a block.
- Never rewrite the words. Nothing you write goes into the prose.
${part ? `- ${part}\n` : ""}${retryNote ? `\nYour previous response was rejected: ${retryNote}\n` : ""}
## Chapter (${input.title})

${blocks}`;
}

/** The built-in deriver: the shared runner, asked the direction's prompt. */
export function makeAdapterDirectionDeriver(adapter: HarnessAdapter, sessionInput: SessionInput, scratchRoot: string): DirectionDeriver {
  const ask = makeAdapterJsonDeriver(adapter, sessionInput, scratchRoot, RawDirectionSchema, "direction");
  return (input, signal) => ask((note) => buildDirectionPrompt(input, note), signal);
}

/** A block as the verification sees it: its words, its reader's row, the reader's language. */
export interface DirectableBlock {
  key: string;
  text: string;
  reader: AudiobookReader;
  model: ManifestModel;
  language?: string;
}

export interface VerifiedDirections {
  proposed: Record<string, AudiobookDirectionInput>;
  directed: number;
  dropped: number;
}

/** Where `anchor` sits in the normalised text when it sits there exactly once; nowhere otherwise. */
function anchorSpan(text: string, anchor: string): { from: number; to: number } | null {
  const folded = normalizeSpeechText(anchor);
  if (folded === "") return null;
  const first = text.indexOf(folded);
  if (first < 0 || text.indexOf(folded, first + 1) >= 0) return null;
  return { from: first, to: first + folded.length };
}

/**
 * What the model said, held to each block and its reader (R-10). A control the reader declares
 * `unsupported` is dropped and counted; a delivery so dropped falls to `measured`, or the first
 * the reader reads; a cue whose words the block does not hold exactly once is dropped; and the
 * plan that remains must map cleanly, else its cues go, and failing that the block's direction.
 * A block the model did not address is counted once.
 */
export function verifyDirections(raw: RawDirection, blocks: readonly DirectableBlock[]): VerifiedDirections {
  const proposed: Record<string, AudiobookDirectionInput> = {};
  let directed = 0;
  let dropped = 0;
  const seen = new Set<string>();
  for (const entry of raw.blocks) {
    const block = blocks.find((candidate) => candidate.key === entry.block);
    if (block === undefined || seen.has(block.key)) {
      dropped += 1;
      continue;
    }
    seen.add(block.key);
    const support = cadenceSupport(block.model);
    const readable = AUDIOBOOK_DELIVERIES.filter((delivery) => support.deliveries[delivery]?.status !== "unsupported");
    if (readable.length === 0) {
      dropped += 1;
      continue;
    }
    const asked = DeliverySchema.safeParse(entry.delivery ?? "measured");
    let delivery: CadencePlan["delivery"];
    if (asked.success && readable.includes(asked.data)) delivery = asked.data;
    else {
      dropped += 1;
      delivery = readable.includes("measured") ? "measured" : readable[0]!;
    }
    let phrase: string | undefined;
    const phraseAsked = typeof entry.phrase === "string" ? normalizeSpeechText(entry.phrase) : "";
    if (phraseAsked !== "") {
      if (phraseAsked.length > CADENCE_PHRASE_MAX || support.phrase.status === "unsupported") dropped += 1;
      else phrase = phraseAsked;
    }
    let speed = 1;
    if (typeof entry.speed === "number" && entry.speed !== 1) {
      const rounded = Math.round(entry.speed * 100) / 100;
      const within = Number.isFinite(rounded) && rounded >= 0.7 && rounded <= 1.2 && support.speed.status !== "unsupported";
      if (within) speed = rounded;
      else dropped += 1;
    }
    const text = normalizeSpeechText(block.text);
    const cues: CadencePlan["cues"] = [];
    for (const cue of entry.cues ?? []) {
      if (cues.length >= 40) {
        dropped += 1;
        continue;
      }
      if (support[cue.kind].status === "unsupported") {
        dropped += 1;
        continue;
      }
      const span = anchorSpan(text, cue.kind === "pause" ? cue.after : cue.kind === "breath" ? cue.before : cue.words);
      if (span === null) {
        dropped += 1;
        continue;
      }
      if (cue.kind === "pause") cues.push({ kind: "pause", at: span.to, length: cue.length });
      else if (cue.kind === "breath") cues.push({ kind: "breath", at: span.from, action: cue.action });
      else cues.push({ kind: "emphasis", span: { from: span.from, to: span.to, text: text.slice(span.from, span.to) }, level: cue.level });
    }
    cues.sort((a, b) => (a.kind === "emphasis" ? a.span.from : a.at) - (b.kind === "emphasis" ? b.span.from : b.at));
    const input: AudiobookDirectionInput = { delivery, speed, cues, ...(phrase !== undefined ? { phrase } : {}) };
    if (checkDirection(block.text, directionPlan(block.text, input), block.model, block.language).ok) {
      proposed[block.key] = input;
      directed += 1;
      continue;
    }
    // The cues did not place — a duplicate position, an overlap: the direction stands without them.
    dropped += cues.length;
    const bare: AudiobookDirectionInput = { ...input, cues: [] };
    if (cues.length > 0 && checkDirection(block.text, directionPlan(block.text, bare), block.model, block.language).ok) {
      proposed[block.key] = bare;
      directed += 1;
    } else dropped += 1;
  }
  dropped += blocks.filter((block) => !seen.has(block.key)).length;
  return { proposed, directed, dropped };
}

export interface DirectedChapter {
  proposed: Record<string, AudiobookDirectionInput>;
  directed: number;
  dropped: number;
  summary?: string;
  hash: string;
  chapterVersion: number;
}

/** What a chapter's direction needs of the room: the narrator, the manifest, and what can speak now. */
export interface DirectionRoom {
  narrator: AudiobookReader;
  models: readonly ManifestModel[];
  catalogue: readonly VoiceCandidate[];
}

/**
 * The blocks a chapter's direction is about, each with the row of the reader that will
 * actually speak it (R-10, R-12) — the assigned voice when it can speak now, the narrator it
 * falls to otherwise, by the run's own rule (codex on PR 1186), so a direction is never
 * accepted for a reader the read will not use. Under `cast` the cast must be current, as the
 * run requires; the refusal is thrown in the run's words.
 */
export async function directableBlocks(
  store: WorldStore,
  productionId: string,
  chapterId: string,
  input: DirectionRoom,
): Promise<{ chapter: { id: string; file: string; title: string; version: number; hash: string }; blocks: DirectableBlock[]; planned: PlannedBlock[]; skipped: number }> {
  const plan = await planAudiobook(store, productionId, chapterId, { narrator: input.narrator });
  const refusal = castRefusal(plan);
  if (refusal !== null) throw new Error(refusal);
  const clonedVoices = store.getBundle().clonedVoices ?? [];
  const blocks: DirectableBlock[] = [];
  let skipped = 0;
  for (const planned of plan.blocks) {
    const speaking = await effectiveReader(store, planned.assigned, input);
    if (speaking === null) {
      skipped += 1;
      continue;
    }
    const language = readerLanguage(clonedVoices, speaking.reader);
    blocks.push({ key: planned.block.key, text: planned.block.text, reader: speaking.reader, model: speaking.model, ...(language !== undefined ? { language } : {}) });
  }
  return { chapter: plan.chapter, blocks, planned: plan.blocks, skipped };
}

/**
 * Direct one chapter (R-10): the blocks in passes of whole blocks within continuity's window,
 * each pass its own model run, every answer verified against the block and its reader; nothing
 * written. The card the window shows is this result, and acceptance is a separate press.
 */
export async function directChapter(
  store: WorldStore,
  productionId: string,
  chapterId: string,
  deriver: DirectionDeriver,
  input: DirectionRoom,
  signal?: AbortSignal,
): Promise<DirectedChapter> {
  const { chapter, blocks, skipped } = await directableBlocks(store, productionId, chapterId, input);
  const passes: DirectableBlock[][] = [];
  let held: DirectableBlock[] = [];
  let length = 0;
  for (const block of blocks) {
    if (held.length > 0 && length + block.text.length > CONTINUITY_BOUNDS.pass) {
      passes.push(held);
      held = [];
      length = 0;
    }
    held.push(block);
    length += block.text.length;
  }
  if (held.length > 0) passes.push(held);
  const proposed: Record<string, AudiobookDirectionInput> = {};
  let directed = 0;
  let dropped = skipped;
  const summaries: string[] = [];
  for (const [index, pass] of passes.entries()) {
    if (signal?.aborted) throw new Error("stopped");
    const raw = await deriver(
      {
        title: chapter.title,
        pass: { index: index + 1, of: passes.length },
        blocks: pass.map((block) => {
          const support = cadenceSupport(block.model);
          return {
            key: block.key,
            text: normalizeSpeechText(block.text),
            reader: `${block.reader.label ?? block.reader.voiceId} · ${block.model.displayName}`,
            deliveries: AUDIOBOOK_DELIVERIES.filter((delivery) => support.deliveries[delivery]?.status !== "unsupported"),
            phrase: support.phrase.status !== "unsupported",
            pause: support.pause.status !== "unsupported",
            breath: support.breath.status !== "unsupported",
            emphasis: support.emphasis.status !== "unsupported",
            speed: block.model.cadence?.speed ?? null,
          };
        }),
      },
      signal,
    );
    if (signal?.aborted) throw new Error("stopped");
    const verified = verifyDirections(raw, pass);
    Object.assign(proposed, verified.proposed);
    directed += verified.directed;
    dropped += verified.dropped;
    if (raw.summary !== undefined && normalizeSpeechText(raw.summary) !== "") summaries.push(normalizeSpeechText(raw.summary));
  }
  return { proposed, directed, dropped, ...(summaries.length > 0 ? { summary: summaries.join(" ") } : {}), hash: chapter.hash, chapterVersion: chapter.version };
}

export type AcceptedDirections = { outcome: "accepted"; record: ChapterAudiobook; dropped: number } | { outcome: "refused"; reason: string };

/**
 * A card accepted whole (R-10): every direction checked once more against the chapter as it
 * stands — the prose must be the prose the card was made for, and each block's reader may have
 * changed since — then the record's direction replaced with what still verifies, the rest
 * dropped and counted, and nothing else written or staged.
 */
export async function acceptDirections(
  store: WorldStore,
  productionId: string,
  chapterId: string,
  accepted: { hash: string; directions: Record<string, AudiobookDirectionInput> },
  input: DirectionRoom,
): Promise<AcceptedDirections> {
  let room: Awaited<ReturnType<typeof directableBlocks>>;
  try {
    room = await directableBlocks(store, productionId, chapterId, input);
  } catch (err) {
    return { outcome: "refused", reason: err instanceof Error ? err.message : String(err) };
  }
  const { chapter, blocks } = room;
  if (chapter.hash !== accepted.hash) return { outcome: "refused", reason: "the prose moved · direct again" };
  const direction: ChapterAudiobook["direction"] = {};
  let dropped = 0;
  const at = store.now();
  for (const [key, entry] of Object.entries(accepted.directions)) {
    const block = blocks.find((candidate) => candidate.key === key);
    if (block === undefined) {
      dropped += 1;
      continue;
    }
    const plan = directionPlan(block.text, entry);
    if (!checkDirection(block.text, plan, block.model, block.language).ok) {
      dropped += 1;
      continue;
    }
    const held: AudiobookDirection = { textHash: audiobookTextHash(block.text), plan, at };
    direction[key] = held;
  }
  const record = await updateAudiobook(store, productionId, chapter, (current) => ({ ...current, updatedAt: at, direction }));
  return { outcome: "accepted", record, dropped };
}
