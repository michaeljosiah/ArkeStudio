import { z } from "zod";
import {
  AUDIOBOOK_TITLE_KEY,
  BEAT_MAX_SECONDS,
  audiobookBlockOptions,
  audiobookBlocks,
  audiobookHeading,
  beatSeams,
  normalizeSpeechText,
  type AudiobookBlock,
  type AudiobookGap,
  type ChapterAudiobook,
  type HarnessAdapter,
  type JoinedBeat,
} from "@arke-studio/contracts";
import type { SessionInput } from "../harness/session-files.js";
import type { WorldStore } from "../world/store.js";
import { planAudiobook, updateAudiobook } from "./audiobook.js";
import { followChapterTakes } from "./audiobook-book.js";
import { directionContext, renderDirectionContext, type DirectionRoom } from "./audiobook-direction.js";
import { CONTINUITY_BOUNDS, makeAdapterJsonDeriver } from "./continuity.js";

/**
 * Group by beats (SPEC-047 R-172): the director reads the chapter as it reads it to direct it and
 * names where each beat begins — the stretch where one character's intention and the scene's
 * pressure hold — and the blocks of a beat are joined (`beatSeams`), so the narrator reads a beat
 * as one passage and it is directed and heard as one. The seams set before are replaced: the
 * grouping starts from the automatic blocks, one a paragraph, and Reset goes back to them. Under
 * Cast the voices are read apart, so a beat could join nothing and the grouping is refused.
 */

const RawBeatsSchema = z.object({
  beats: z.array(z.object({ start: z.string(), name: z.string().nullable().optional(), whose: z.string().nullable().optional() })),
  summary: z.string().nullable().optional(),
});
export type RawBeats = z.infer<typeof RawBeatsSchema>;

/** One block as the beat prompt shows it: its key, who speaks in it, and whether a scene break comes before it. */
export interface BeatBlockInput {
  key: string;
  text: string;
  speakers?: string;
  sceneBefore?: boolean;
}

export interface BeatsDeriverInput {
  title: string;
  pass: { index: number; of: number };
  context?: Parameters<typeof renderDirectionContext>[0];
  blocks: BeatBlockInput[];
}

export type BeatsDeriver = (input: BeatsDeriverInput, signal?: AbortSignal) => Promise<RawBeats>;

/** Why a chapter was not grouped, in one clause. */
export class BeatRefusal extends Error {}

function buildBeatsPrompt(input: BeatsDeriverInput, retryNote?: string): string {
  const minutes = Math.round(BEAT_MAX_SECONDS / 60);
  const blocks = input.blocks
    .map((block) => `${block.sceneBefore === true ? "— scene break —\n\n" : ""}[${block.key}] ${block.speakers !== undefined ? `narration with lines spoken by ${block.speakers}` : "narration"}\n${block.text}`)
    .join("\n\n");
  const part = input.pass.of > 1 ? `This is pass ${input.pass.index} of ${input.pass.of} over the chapter; group only the blocks listed here, and begin with the first of them.` : "";
  const context = input.context === undefined ? "" : `## The book\n\n${renderDirectionContext(input.context)}\n\n`;
  return `Group the blocks of the chapter below into beats for an audiobook narrator. Read what the book is about first, then read the chapter as one performance.

A beat is the stretch where one character's intention and the pressure of the scene hold. A beat ends where someone gets or loses what they want, changes tactic, a revelation lands, or the time or place shifts. Each beat is read aloud as one passage and directed as one, so its blocks must belong together in the narrator's mouth.

Respond with ONLY a JSON object:
{"beats": [{"start": "<the key of the beat's first block>", "name": "<the beat in two to four words>", "whose": "<the character whose beat it is>"}], "summary": "<one sentence on how the chapter moves>"}

Rules — every one is enforced mechanically after you answer:
- List the beats in order. The first beat starts at the first block listed.
- "start" is a block key exactly as given. A key the chapter does not hold is dropped.
- Keep an exchange — a line, its reply, the narration between — inside one beat unless the exchange itself turns.
- Most beats run thirty seconds to two minutes read aloud. A beat longer than about ${minutes} minutes is cut where it would cross.
- A scene break always begins a beat.
- Never make each block its own beat, and never make the whole chapter one beat.
- Nothing you write is read aloud or goes into the prose.
${part ? `- ${part}\n` : ""}${retryNote ? `\nYour previous response was rejected: ${retryNote}\n` : ""}
${context}## Chapter (${input.title})

${blocks}`;
}

/** Exported for the tests that read the prompt the model is asked. */
export const beatsPromptFor = buildBeatsPrompt;

/** The built-in deriver: the shared runner, asked the beats prompt. */
export function makeAdapterBeatsDeriver(adapter: HarnessAdapter, sessionInput: SessionInput, scratchRoot: string): BeatsDeriver {
  const ask = makeAdapterJsonDeriver(adapter, sessionInput, scratchRoot, RawBeatsSchema, "beats");
  return (input, signal) => ask((note) => buildBeatsPrompt(input, note), signal);
}

/** What the director named, held to the blocks it was shown: starts it does not hold dropped and counted. */
export function verifyBeats(raw: RawBeats, keys: readonly string[]): { starts: Map<string, { name?: string; whose?: string }>; dropped: number } {
  const held = new Set(keys);
  const starts = new Map<string, { name?: string; whose?: string }>();
  let dropped = 0;
  for (const beat of raw.beats) {
    const key = beat.start.trim();
    if (!held.has(key) || starts.has(key)) {
      dropped += 1;
      continue;
    }
    const name = beat.name === null || beat.name === undefined ? "" : normalizeSpeechText(beat.name).slice(0, 80);
    const whose = beat.whose === null || beat.whose === undefined ? "" : normalizeSpeechText(beat.whose).slice(0, 120);
    starts.set(key, { ...(name !== "" ? { name } : {}), ...(whose !== "" ? { whose } : {}) });
  }
  return { starts, dropped };
}

export interface GroupedChapter {
  before: number;
  after: number;
  beats: Array<JoinedBeat & { name?: string; whose?: string }>;
  dropped: number;
  cut: number;
  summary?: string;
  record: ChapterAudiobook;
}

/**
 * The chapter grouped by beats and written: the director asked over the automatic blocks, in
 * passes as the director's own are cut, the beats it names joined, and the chapter's takes looked
 * for again — a beat read before as these blocks is found again at no cost, as Reset's are.
 */
export async function groupChapterByBeats(
  store: WorldStore,
  productionId: string,
  chapterId: string,
  deriver: BeatsDeriver,
  room: DirectionRoom,
  signal?: AbortSignal,
): Promise<GroupedChapter> {
  const plan = await planAudiobook(store, productionId, chapterId, { narrator: room.narrator });
  if (plan.record === "unreadable") throw new BeatRefusal("record unreadable · Read the chapter replaces it");
  if (plan.reading === "cast") throw new BeatRefusal("Cast reads each voice apart · beats group one reader's blocks");
  const cast = plan.cast === "unreadable" ? null : plan.cast;
  const auto = audiobookBlocks(plan.body, cast, audiobookHeading(plan.chapter.order, plan.chapter.title), audiobookBlockOptions(plan.book, null));
  const body = auto.blocks.filter((block) => block.key !== AUDIOBOOK_TITLE_KEY);
  if (body.length < 2) throw new BeatRefusal("nothing to group");
  const before = plan.blocks.length;
  const sceneBefore = new Set(auto.seams.gaps.filter((gap: AudiobookGap) => gap.press === "join" && gap.limit === "scene break").map((gap) => gap.block));
  const sheets = store.getBundle().sheets;
  const nameOf = (turn: { speaker?: string; sheet?: string }) =>
    turn.speaker === undefined ? undefined : (turn.sheet === undefined ? turn.speaker : (sheets.find((sheet) => sheet.id === turn.sheet)?.name ?? turn.speaker));
  const speakersOf = (block: AudiobookBlock) => {
    const names = [...new Set((block.rows ?? [block]).flatMap((turn) => { const name = nameOf(turn); return name === undefined ? [] : [name]; }))];
    return names.length === 0 ? undefined : names.join(", ");
  };
  const passes: AudiobookBlock[][] = [];
  let held: AudiobookBlock[] = [];
  let length = 0;
  for (const block of body) {
    if (held.length > 0 && length + block.text.length > CONTINUITY_BOUNDS.pass) {
      passes.push(held);
      held = [];
      length = 0;
    }
    held.push(block);
    length += block.text.length;
  }
  if (held.length > 0) passes.push(held);
  const context = await directionContext(store, productionId, plan, room);
  const starts = new Map<string, { name?: string; whose?: string }>();
  const summaries: string[] = [];
  let dropped = 0;
  for (const [index, pass] of passes.entries()) {
    if (signal?.aborted) throw new Error("stopped");
    const raw = await deriver(
      {
        title: plan.chapter.title,
        pass: { index: index + 1, of: passes.length },
        context,
        blocks: pass.map((block) => {
          const speakers = speakersOf(block);
          return { key: block.key, text: normalizeSpeechText(block.text), ...(speakers !== undefined ? { speakers } : {}), ...(sceneBefore.has(block.key) ? { sceneBefore: true } : {}) };
        }),
      },
      signal,
    );
    if (signal?.aborted) throw new Error("stopped");
    const verified = verifyBeats(raw, pass.map((block) => block.key));
    dropped += verified.dropped;
    // Each pass begins a beat: the director was shown nothing before its first block.
    if (!verified.starts.has(pass[0]!.key)) verified.starts.set(pass[0]!.key, {});
    for (const [key, named] of verified.starts) starts.set(key, named);
    if (typeof raw.summary === "string" && normalizeSpeechText(raw.summary) !== "") summaries.push(normalizeSpeechText(raw.summary));
  }
  const joins = beatSeams(auto.blocks, auto.seams.gaps, new Set(starts.keys()), store.now());
  const record = await updateAudiobook(store, productionId, plan.chapter, (current) => {
    const { seams: _replaced, ...rest } = current;
    return { ...rest, updatedAt: store.now(), ...(joins.seams.length > 0 ? { seams: joins.seams } : {}) };
  });
  await followChapterTakes(store, productionId, plan.chapter, room);
  const after = (await planAudiobook(store, productionId, chapterId, { narrator: room.narrator })).blocks.length;
  return {
    before,
    after,
    beats: joins.beats.map((beat) => ({ ...beat, ...starts.get(beat.start) })),
    dropped,
    cut: joins.cut,
    ...(summaries.length > 0 ? { summary: summaries.join(" ") } : {}),
    record,
  };
}
