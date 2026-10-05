import { z } from "zod";
import {
  AUDIOBOOK_DELIVERIES,
  AUDIOBOOK_TITLE_KEY,
  CADENCE_NOTE_MAX,
  CADENCE_PHRASE_MAX,
  DeliverySchema,
  SOUNDS,
  SoundSchema,
  audiobookBlockOptions,
  audiobookBlocks,
  audiobookDirectionFor,
  audiobookHeading,
  audiobookNoteKey,
  cadenceSupport,
  cueStart,
  holdDirection,
  normalizeSpeechText,
  orderCues,
  type AudiobookBook,
  type AudiobookDirectionInput,
  type AudiobookReader,
  type CadencePlan,
  type ChapterAudiobook,
  type ChapterVoices,
  type DirectionReads,
  type HarnessAdapter,
  type ManifestModel,
  type Sheet,
  voiceDisplayLabel,
  type VoiceCandidate,
} from "@arke-studio/contracts";
import type { SessionInput } from "../harness/session-files.js";
import type { WorldStore } from "../world/store.js";
import { checkDirection, directionPlan } from "../voice/direction.js";
import {
  castRefusal,
  directionEntry,
  effectiveReader,
  planAudiobook,
  readAudiobook,
  readAudiobookBook,
  readerLanguage,
  updateAudiobook,
  writeAudiobookBookRaised,
  type AudiobookPlan,
  type PlannedBlock,
  type ProposalOverride,
} from "./audiobook.js";
import { CONTINUITY_BOUNDS, makeAdapterJsonDeriver } from "./continuity.js";
import { openChapter } from "./ops.js";
import { composeCast, deriveCast, readVoices, writeCast, type DerivedCast, type VoicesDeriver } from "./voices.js";

/**
 * `Direct this chapter` (design turn 146, SPEC-047 R-10, §2.3): the cast derivation turned on
 * performance. The model is asked for a direction per block — a delivery from the six, a note,
 * a speed, cues, sounds and turns anchored to exact words — and every answer is held to the
 * block it names and to the row of the block's reader: a delivery the reader lacks, a note it
 * takes nowhere, a cue at words the block does not hold exactly once, is dropped and counted
 * rather than accepted into a direction the read could only flag. What verifies is one card,
 * accepted whole through `acceptDirections`, which writes the record and nothing else; the
 * derivation itself writes nothing.
 *
 * Design turn 184 (R-51..R-55): the director reads the book, not only the blocks — the
 * chapter's synopsis and point of view, the tone, the speakers' sheets, the narrator's own
 * description, the book's notes and the blocks directed at the end of the chapter before — so
 * 122 separate passes of words are directed as one reading. Nothing it reads is sent to a voice
 * provider: the context is the prompt's, never a block's.
 */

const RawCueSchema = z.union([
  z.object({ kind: z.literal("pause"), after: z.string(), length: z.enum(["short", "long"]).catch("short") }),
  z.object({ kind: z.literal("breath"), before: z.string(), action: z.enum(["inhale", "exhale"]).catch("inhale") }),
  z.object({ kind: z.literal("emphasis"), words: z.string(), level: z.enum(["moderate", "strong"]).catch("moderate") }),
  /** A vocal event right after the words named (design turn 181): one of `SOUNDS`, never anything else. */
  z.object({ kind: z.literal("sound"), after: z.string(), sound: z.string() }),
  /** A delivery over a span (R-40), so one block can turn: the six, a phrase, or both. */
  z.object({ kind: z.literal("delivery"), words: z.string(), delivery: z.string().optional(), phrase: z.string().nullable().optional() }),
]);
const RawDirectionSchema = z.object({
  blocks: z.array(
    z.object({
      block: z.string(),
      delivery: z.string().optional(),
      /** The block's note (design turn 181): up to 300, a tag reader's to 60. */
      note: z.string().nullable().optional(),
      /** The note under its old name, which a model asked before the rename may still use. */
      phrase: z.string().nullable().optional(),
      speed: z.number().nullable().optional(),
      cues: z.array(RawCueSchema).optional(),
    }),
  ),
  summary: z.string().optional(),
  /** The chapter note, when it was asked for (R-53). */
  chapterNote: z.string().nullable().optional(),
  /** Speaker notes for the speakers named as having none, when they were asked for (R-54). */
  speakerNotes: z.record(z.string(), z.string()).nullable().optional(),
});
export type RawDirection = z.infer<typeof RawDirectionSchema>;

/** What the prompt says of one block: its words, whether it is spoken, and what its reader can do with them. */
export interface DirectionBlockInput {
  key: string;
  text: string;
  reader: string;
  /** Who speaks it, for a spoken line; absent for narration and the title. */
  speaker?: string;
  /** The block holds narration and the lines of the speakers named (design turn 190), read as one passage. */
  mixed?: boolean;
  deliveries: readonly string[];
  /** How the reader takes a note: whole, as a tag of at most 60, or not at all. */
  note: "instruction" | "tag" | "none";
  pause: boolean;
  breath: boolean;
  emphasis: boolean;
  /** The portable sounds this reader makes. */
  sounds: readonly string[];
  /** Whether the reader can turn a span to another delivery or phrase. */
  markers: boolean;
  speed: { min: number; max: number } | null;
}

/**
 * What the director reads besides the blocks (design turn 184, R-51): bounded, so a book with a
 * long synopsis or a crowded cast cannot crowd the blocks out of the window.
 */
export interface DirectionContext {
  chapter: { order: number; title: string; version: number; synopsis?: string; pov?: string };
  tone?: string;
  speakers: Array<{ key: string; name: string; essence?: string; voice?: string; note?: string }>;
  narrator: { label: string; description?: string };
  bookNote?: string;
  chapterNote?: string;
  before: { order: number; title: string; blocks: Array<{ who: string; text: string; delivery?: string; note?: string }> } | null;
}

export const DIRECTION_CONTEXT_BOUNDS = {
  synopsis: 600,
  tone: 200,
  speakers: 12,
  section: 240,
  narrator: 400,
  before: 6,
  beforeText: 160,
  /** The whole of the context in the prompt, beside continuity's pass of blocks. */
  total: 6_000,
} as const;

export interface DirectionDeriverInput {
  title: string;
  pass: { index: number; of: number };
  blocks: DirectionBlockInput[];
  /** The book as the director reads it (R-51); absent only for a caller that has none. */
  context?: DirectionContext;
  /** Drafts asked of this pass (R-53, R-54): the chapter note, and notes for the speakers named. */
  asks?: { chapterNote?: boolean; speakerNotes?: Array<{ key: string; name: string }> };
}
export type DirectionDeriver = (input: DirectionDeriverInput, signal?: AbortSignal) => Promise<RawDirection>;

/** A string cut to a bound at a word, with an ellipsis when it was cut; whitespace folded. */
export function clip(text: string | undefined, max: number): string | undefined {
  if (text === undefined) return undefined;
  const folded = normalizeSpeechText(text);
  if (folded === "") return undefined;
  if (folded.length <= max) return folded;
  const cut = folded.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > max / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/**
 * The context as the prompt says it (R-51): one line a fact, the most needed first — the
 * chapter, the tone, the narrator, the notes, then each speaker, then the blocks before — and
 * whatever would run past the bound left out rather than cut mid-line.
 */
export function renderDirectionContext(context: DirectionContext): string {
  const lines: string[] = [];
  const chapter = context.chapter;
  lines.push(`Chapter ${chapter.order} · ${chapter.title} · version ${chapter.version}`);
  if (chapter.synopsis !== undefined) lines.push(`Synopsis: ${chapter.synopsis}`);
  if (chapter.pov !== undefined) lines.push(`Point of view: ${chapter.pov}`);
  if (context.tone !== undefined) lines.push(`Tone: ${context.tone}`);
  lines.push(`Narrator: ${context.narrator.label}${context.narrator.description !== undefined ? ` — ${context.narrator.description}` : ""}`);
  if (context.bookNote !== undefined) lines.push(`Book note (sent with every block already): ${context.bookNote}`);
  if (context.chapterNote !== undefined) lines.push(`Chapter note (sent with every block already): ${context.chapterNote}`);
  for (const speaker of context.speakers) {
    const facts = [
      ...(speaker.note !== undefined ? [`speaker note (sent with each of their lines already): ${speaker.note}`] : []),
      ...(speaker.essence !== undefined ? [`essence: ${speaker.essence}`] : []),
      ...(speaker.voice !== undefined ? [`voice: ${speaker.voice}`] : []),
    ];
    lines.push(`Speaker ${speaker.name} [${speaker.key}]${facts.length > 0 ? ` — ${facts.join(" · ")}` : ""}`);
  }
  if (context.before !== null && context.before.blocks.length > 0) {
    lines.push(`The end of chapter ${context.before.order} (${context.before.title}), as it was directed:`);
    for (const block of context.before.blocks) {
      const how = [block.delivery, block.note].filter((part): part is string => part !== undefined).join(" · ");
      lines.push(`  ${block.who}${how !== "" ? ` (${how})` : ""}: ${block.text}`);
    }
  }
  const kept: string[] = [];
  let length = 0;
  for (const line of lines) {
    if (length + line.length + 1 > DIRECTION_CONTEXT_BOUNDS.total) continue;
    kept.push(line);
    length += line.length + 1;
  }
  return kept.join("\n");
}

function buildDirectionPrompt(input: DirectionDeriverInput, retryNote?: string): string {
  const part = input.pass.of > 1 ? `This is pass ${input.pass.index} of ${input.pass.of} over the chapter; direct only the blocks listed here.` : "";
  const blocks = input.blocks
    .map((block) => {
      const can = [
        `reads ${block.deliveries.join(", ")}`,
        block.note === "instruction" ? `takes a note to ${CADENCE_NOTE_MAX}` : block.note === "tag" ? `takes a note to ${CADENCE_PHRASE_MAX}` : "no note",
        block.speed !== null ? `speed ${block.speed.min}–${block.speed.max}` : "no speed",
        block.pause ? "pause" : "no pause",
        block.breath ? "breath" : "no breath",
        block.emphasis ? "emphasis" : "no emphasis",
        block.sounds.length > 0 ? `sounds ${block.sounds.join(", ")}` : "no sounds",
        block.markers ? "turns" : "no turns",
      ].join(" · ");
      return `[${block.key}] ${block.speaker !== undefined ? (block.mixed === true ? `narration with lines spoken by ${block.speaker}` : `line spoken by ${block.speaker}`) : "narration"} · read by ${block.reader} · ${can}\n${block.text}`;
    })
    .join("\n\n");
  const chapterNote = input.asks?.chapterNote === true;
  const speakerNotes = input.asks?.speakerNotes ?? [];
  const extra = [
    ...(chapterNote ? [`"chapterNote": "<place, time and mood for the whole chapter, at most ${CADENCE_NOTE_MAX} characters>"`] : []),
    ...(speakerNotes.length > 0 ? [`"speakerNotes": {"<speaker key>": "<how the narrator plays them, at most ${CADENCE_PHRASE_MAX} characters>"}`] : []),
  ];
  const context = input.context === undefined ? "" : `## The book\n\n${renderDirectionContext(input.context)}\n\n`;
  return `Direct the reading of the chapter blocks below for an audiobook. Read what the book is about first, then direct the blocks as one reading. Respond with ONLY a JSON object:
{"blocks": [{"block": "<the block's key>", "delivery": "<one of ${AUDIOBOOK_DELIVERIES.join(", ")}>", "note": "<optional: how to read it, in your own words, never words to say>", "speed": <optional: 0.7 to 1.2>, "cues": [{"kind": "pause", "after": "<exact words from the block the pause follows>", "length": "short" | "long"}, {"kind": "breath", "before": "<exact words from the block>", "action": "inhale" | "exhale"}, {"kind": "emphasis", "words": "<exact words from the block>", "level": "moderate" | "strong"}, {"kind": "sound", "after": "<exact words from the block the sound follows>", "sound": "<one of ${SOUNDS.join(", ")}>"}, {"kind": "delivery", "words": "<exact words from the block>", "delivery": "<optional: one of the six>", "phrase": "<optional: at most ${CADENCE_PHRASE_MAX} characters>"}]}], "summary": "<one or two sentences on what you did and why>"${extra.length > 0 ? `, ${extra.join(", ")}` : ""}}

Rules — every one is enforced mechanically after you answer:
- Address every block by its key, in order. A block left out is counted as dropped.
- Each block says who reads it and what that reader can do. Use only the deliveries listed for that block; give a note only where the reader takes one and within its length; place only the kinds of cue and the sounds the reader takes; set a speed only where it has one. Anything else is dropped.
- "measured" is the ordinary reading. Keep one delivery across a run of blocks and change it only where the scene turns: at most about one block in four may change delivery from the block before it, and a change closer to the last one than that is held to the delivery before. Never direct every block the same way for effect.
- The chapter note carries the chapter's mood. Give a block a note only where it reads differently from that; no note is better than one that restates the chapter note or the delivery.
- A sound goes only inside or right after a spoken line — a block marked as a line, or words inside its quotation marks — never in narration.
- A "delivery" cue turns part of a block: the block's own delivery reads the rest. Only where the reader takes turns.
- The book note, the chapter note and the speaker notes are sent with every block already: never repeat them in a block's note.
- "after", "before" and "words" are copied from the block character for character and must occur exactly once in it. At most 40 cues a block.
- Never rewrite the words. Nothing you write goes into the prose.
${chapterNote ? `- "chapterNote" says where and when the chapter is and its mood, for the reader, in at most ${CADENCE_NOTE_MAX} characters.\n` : ""}${speakerNotes.length > 0 ? `- "speakerNotes" gives each of these speakers, from their sheet, how the narrator plays them, in at most ${CADENCE_PHRASE_MAX} characters: ${speakerNotes.map((speaker) => `${speaker.name} [${speaker.key}]`).join(", ")}.\n` : ""}${part ? `- ${part}\n` : ""}${retryNote ? `\nYour previous response was rejected: ${retryNote}\n` : ""}
${context}## Chapter (${input.title})

${blocks}`;
}

/** The built-in deriver: the shared runner, asked the direction's prompt. */
export function makeAdapterDirectionDeriver(adapter: HarnessAdapter, sessionInput: SessionInput, scratchRoot: string): DirectionDeriver {
  const ask = makeAdapterJsonDeriver(adapter, sessionInput, scratchRoot, RawDirectionSchema, "direction");
  return (input, signal) => ask((note) => buildDirectionPrompt(input, note), signal);
}

/** Exported for the tests that read the prompt the model is asked. */
export const directionPromptFor = buildDirectionPrompt;

/** A block as the verification sees it: its words, its reader's row, the reader's language, and whether it is spoken. */
export interface DirectableBlock {
  key: string;
  text: string;
  reader: AudiobookReader;
  model: ManifestModel;
  language?: string;
  /** A spoken line (the cast names its speaker): a sound may go anywhere in it. */
  line?: boolean;
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
 * Whether a point is inside or right after a spoken line (design turn 184, R-52): anywhere in a
 * block the cast names a speaker for, or, in narration, inside quotation marks or at the closing
 * mark — `“I know.” [sighs]` — and never in the narration around them.
 */
export function spokenAt(text: string, at: number, line: boolean): boolean {
  if (line) return true;
  for (const match of text.matchAll(/“[^”]*”|"[^"]*"/g)) {
    const from = match.index ?? 0;
    if (at > from && at <= from + match[0].length) return true;
  }
  return false;
}

/**
 * A plan held to what its reader can do (R-9, R-10, R-13): a delivery the row lacks falls to
 * `measured`, or the first the row reads, and is counted; a note over the cap, or on a reader
 * that takes none, is dropped; a speed outside the plan's range, or on a reader with none, drops
 * to one; a cue of a kind the reader cannot carry is dropped, and cues past the fortieth. Null
 * when the reader reads nothing at all. The derivation and the re-check on a reader change
 * are one rule.
 */
export function conformInput(input: AudiobookDirectionInput, support: ReturnType<typeof cadenceSupport>): { input: AudiobookDirectionInput | null; dropped: number } {
  let dropped = 0;
  const readable = AUDIOBOOK_DELIVERIES.filter((delivery) => support.deliveries[delivery]?.status !== "unsupported");
  if (readable.length === 0) return { input: null, dropped: 1 };
  let delivery: CadencePlan["delivery"] = input.delivery;
  if (delivery !== undefined && !readable.includes(delivery)) {
    dropped += 1;
    delivery = readable.includes("measured") ? "measured" : readable[0]!;
  }
  let note: string | undefined;
  if (input.note !== undefined && input.note !== "") {
    // A tag reader takes a note as a tag only up to a marker phrase's length, and would hold a
    // longer one: proposing it would be a direction the read never sends.
    const tagOnly = support.note.method?.startsWith("tag") === true;
    if (input.note.length > (tagOnly ? CADENCE_PHRASE_MAX : CADENCE_NOTE_MAX) || support.note.status === "unsupported") dropped += 1;
    else note = input.note;
  }
  let speed = 1;
  if (input.speed !== 1) {
    const within = input.speed >= 0.7 && input.speed <= 1.2 && support.speed.status !== "unsupported";
    if (within) speed = input.speed;
    else dropped += 1;
  }
  const cues: CadencePlan["cues"] = [];
  for (const cue of input.cues) {
    const unsupported =
      cue.kind === "delivery"
        ? (cue.delivery !== undefined && support.deliveries[cue.delivery]?.status === "unsupported") || (cue.phrase !== undefined && support.phrase.status === "unsupported")
        : cue.kind === "sound" ? support.sounds[cue.sound].status === "unsupported" : support[cue.kind].status === "unsupported";
    if (cues.length >= 40 || unsupported) {
      dropped += 1;
      continue;
    }
    cues.push(cue);
  }
  return { input: { ...(delivery !== undefined ? { delivery } : {}), speed, cues, ...(note !== undefined ? { note } : {}) }, dropped };
}

/**
 * What the model said, held to each block and its reader (R-10, R-52). A control the reader
 * declares `unsupported` is dropped and counted; a delivery so dropped falls to `measured`, or
 * the first the reader reads; a cue whose words the block does not hold exactly once is dropped;
 * a sound outside the cadence list, or in narration, is dropped; a turn that clashes with
 * another, or that the reader could only hold, is dropped; and the plan that remains must map
 * cleanly, else its cues go, and failing that the block's direction. A block the model did not
 * address is counted once. The words are never changed: every anchor is copied from the block.
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
    const support = cadenceSupport(block.model, block.language);
    // The model's words as a plan: the delivery it asked for, the note, the speed, and the cues
    // placed at the words it named — those the block does not hold exactly once dropped.
    const text = normalizeSpeechText(block.text);
    const placed: CadencePlan["cues"] = [];
    for (const cue of entry.cues ?? []) {
      const span = anchorSpan(text, cue.kind === "pause" || cue.kind === "sound" ? cue.after : cue.kind === "breath" ? cue.before : cue.words);
      if (span === null) {
        dropped += 1;
        continue;
      }
      if (cue.kind === "pause") placed.push({ kind: "pause", at: span.to, length: cue.length });
      else if (cue.kind === "breath") placed.push({ kind: "breath", at: span.from, action: cue.action });
      else if (cue.kind === "emphasis") placed.push({ kind: "emphasis", span: { from: span.from, to: span.to, text: text.slice(span.from, span.to) }, level: cue.level });
      else if (cue.kind === "sound") {
        const sound = SoundSchema.safeParse(cue.sound.trim().toLowerCase());
        if (!sound.success || !spokenAt(text, span.to, block.line === true)) {
          dropped += 1;
          continue;
        }
        placed.push({ kind: "sound", at: span.to, sound: sound.data });
      } else {
        const delivery = cue.delivery === undefined ? undefined : DeliverySchema.safeParse(cue.delivery);
        const phrase = typeof cue.phrase === "string" ? normalizeSpeechText(cue.phrase) : "";
        const phraseOk = phrase !== "" && phrase.length <= CADENCE_PHRASE_MAX;
        if ((delivery !== undefined && !delivery.success) || (phrase !== "" && !phraseOk) || (delivery === undefined && !phraseOk)) {
          dropped += 1;
          continue;
        }
        placed.push({ kind: "delivery", span: { from: span.from, to: span.to, text: text.slice(span.from, span.to) }, ...(delivery?.success ? { delivery: delivery.data } : {}), ...(phraseOk ? { phrase } : {}) });
      }
    }
    // Two cues that would break the plan's rules — the same sound twice at a point, two turns
    // overlapping, an emphasis across a turn's edge — keep the first and count the rest.
    const sorted = [...placed].sort((a, b) => cueStart(a) - cueStart(b));
    const cues = orderCues(sorted);
    dropped += sorted.length - cues.length;
    const asked = DeliverySchema.safeParse(entry.delivery ?? "measured");
    const rawNote = typeof entry.note === "string" ? entry.note : typeof entry.phrase === "string" ? entry.phrase : "";
    const noteAsked = normalizeSpeechText(rawNote);
    const conformed = conformInput(
      {
        delivery: asked.success ? asked.data : "measured",
        speed: typeof entry.speed === "number" && Number.isFinite(entry.speed) ? Math.round(entry.speed * 100) / 100 : 1,
        cues,
        ...(noteAsked !== "" ? { note: noteAsked } : {}),
      },
      support,
    );
    dropped += conformed.dropped + (asked.success ? 0 : entry.delivery === undefined ? 0 : 1);
    if (conformed.input === null) {
      dropped += 1;
      continue;
    }
    let input = conformed.input;
    // What the reader would only hold — a turn its row can make in no way, a sound its syntax
    // cannot carry for this line — is dropped and counted here, as a control the row lacks is:
    // a card proposes what the read will send.
    try {
      const { held } = holdDirection(block.text, directionPlan(block.text, input), block.model, block.language);
      const heldCues = new Set(held.flatMap((control) => (control.cueIndex !== undefined ? [control.cueIndex] : [])));
      if (heldCues.size > 0) {
        dropped += heldCues.size;
        input = { ...input, cues: input.cues.filter((_, index) => !heldCues.has(index)) };
      }
    } catch {
      /* a plan wrong for its words: the check below drops its cues */
    }
    if (checkDirection(block.text, directionPlan(block.text, input), block.model, block.language).ok) {
      proposed[block.key] = input;
      directed += 1;
      continue;
    }
    // The cues did not place — a duplicate position, an overlap: the direction stands without them.
    dropped += input.cues.length;
    const bare: AudiobookDirectionInput = { ...input, cues: [] };
    if (input.cues.length > 0 && checkDirection(block.text, directionPlan(block.text, bare), block.model, block.language).ok) {
      proposed[block.key] = bare;
      directed += 1;
    } else dropped += 1;
  }
  dropped += blocks.filter((block) => !seen.has(block.key)).length;
  dropped += holdDeliveryRuns(proposed, blocks);
  return { proposed, directed, dropped };
}

/** How far apart, in blocks, two changes of delivery may be (design turn 185): about one block in four. */
export const DELIVERY_CHANGE_SPACING = 4;

/**
 * Direct less often (design turn 185). Read per paragraph, chapter 01 changed delivery on most
 * blocks, and each line sounded read without the one before it. A delivery is kept across a run:
 * in reading order a block's delivery may differ from the one before it only once
 * `DELIVERY_CHANGE_SPACING` blocks have passed since the last change kept; a change sooner is
 * held to the delivery before it and counted as dropped. The first block's change from the
 * ordinary reading counts as a change; the title stands apart. Returns how many were held.
 * Mutates `proposed`.
 */
export function holdDeliveryRuns(proposed: Record<string, AudiobookDirectionInput>, blocks: readonly Pick<DirectableBlock, "key">[]): number {
  let current: AudiobookDirectionInput["delivery"] = "measured";
  let lastChange = -Infinity;
  let held = 0;
  // The title is its own announcement, not part of the reading's runs: neither held nor counted.
  blocks.filter((block) => block.key !== AUDIOBOOK_TITLE_KEY).forEach((block, index) => {
    const input = proposed[block.key];
    if (input === undefined) return;
    const delivery = input.delivery ?? "measured";
    if (delivery === current) return;
    if (index - lastChange >= DELIVERY_CHANGE_SPACING) {
      current = delivery;
      lastChange = index;
      return;
    }
    proposed[block.key] = { ...input, delivery: current };
    held += 1;
  });
  return held;
}

export interface DirectedChapter {
  proposed: Record<string, AudiobookDirectionInput>;
  directed: number;
  dropped: number;
  summary?: string;
  hash: string;
  chapterVersion: number;
  /** The lines cast first (R-54), held until the proposal is accepted. */
  cast?: { derived: DerivedCast; record: ChapterVoices; lines: number; speakers: number };
  /** The chapter note drafted when asked (R-53). */
  chapterNote?: string;
  /** Speaker notes drafted from the sheets for speakers with none (R-54). */
  speakerNotes?: Record<string, string>;
}

/** What a chapter's direction needs of the room: the narrator, the manifest, and what can speak now. */
export interface DirectionRoom {
  narrator: AudiobookReader;
  models: readonly ManifestModel[];
  catalogue: readonly VoiceCandidate[];
  /** The narrator's own description — a designed voice's brief, a clone's label (R-51). Read by the director only. */
  narratorDescription?: string;
}

/**
 * The blocks a chapter's direction is about, each with the row of the reader that will
 * actually speak it (R-10, R-12) — the assigned voice when it can speak now, the narrator it
 * falls to otherwise, by the run's own rule (codex on PR 1186), so a direction is never
 * accepted for a reader the read will not use. Under `cast` the cast must be current, as the
 * run requires; the refusal is thrown in the run's words. A held proposal's cast and notes
 * stand in for the record's when given (R-54).
 */
export async function directableBlocks(
  store: WorldStore,
  productionId: string,
  chapterId: string,
  input: DirectionRoom,
  override?: ProposalOverride,
): Promise<{ chapter: { id: string; file: string; title: string; version: number; hash: string }; blocks: DirectableBlock[]; planned: PlannedBlock[]; plan: AudiobookPlan }> {
  const plan = await planAudiobook(store, productionId, chapterId, { narrator: input.narrator, ...(override !== undefined ? { override } : {}) });
  const refusal = castRefusal(plan);
  if (refusal !== null) throw new Error(refusal);
  const clonedVoices = store.getBundle().clonedVoices ?? [];
  const blocks: DirectableBlock[] = [];
  for (const planned of plan.blocks) {
    const speaking = await effectiveReader(store, planned.assigned, input);
    // The narrator's own model missing is the run's `unavailable`, not a block dropped (codex
    // on PR 1186): a card of nothing, accepted, would clear the chapter's directions.
    if (speaking === null) throw new Error("the narrator's voice model is not in the manifest");
    const language = readerLanguage(clonedVoices, speaking.reader);
    blocks.push({
      key: planned.block.key,
      text: planned.block.text,
      reader: speaking.reader,
      model: speaking.model,
      ...(language !== undefined ? { language } : {}),
      ...(planned.block.speaker !== undefined || (planned.block.rows ?? []).some((turn) => turn.speaker !== undefined) ? { line: true } : {}),
    });
  }
  return { chapter: plan.chapter, blocks, planned: plan.blocks, plan };
}

/** A sheet's section by its heading (`## Essence`, `## Voice`), whatever its case. */
export function section(sheet: Sheet | undefined, heading: RegExp): string | undefined {
  return sheet?.sections.find((candidate) => heading.test(candidate.heading.trim()))?.body;
}

/**
 * What the director reads of the book (design turn 184, R-51), each part bounded: the chapter's
 * synopsis, point of view and version; the world's tone; the sheets of the chapter's speakers,
 * essence and voice, with their notes; the narrator's own description; the book note and the
 * chapter note; and the last directed blocks of the chapter before, so a voice carries across
 * chapters. Read, never written.
 */
export async function directionContext(store: WorldStore, productionId: string, plan: AudiobookPlan, room: Pick<DirectionRoom, "narrator" | "narratorDescription">, override?: ProposalOverride): Promise<DirectionContext> {
  const bundle = store.getBundle();
  const production = bundle.productions.find((p) => p.meta.id === productionId);
  const summary = production?.chapters.find((c) => c.id === plan.chapter.id);
  const sheets = bundle.sheets;
  const book: AudiobookBook | null = plan.book;
  const notes = { ...override?.speakerNotes, ...book?.notes };
  const speakers: DirectionContext["speakers"] = [];
  // A block that holds several turns (design turn 190) has each of its speakers read.
  scan: for (const planned of plan.blocks) {
    for (const turn of planned.block.rows ?? [planned.block]) {
      const key = audiobookNoteKey(turn);
      if (key === null || speakers.some((speaker) => speaker.key === key)) continue;
      if (speakers.length >= DIRECTION_CONTEXT_BOUNDS.speakers) break scan;
      const sheet = turn.sheet === undefined ? undefined : sheets.find((candidate) => candidate.id === turn.sheet);
      const essence = clip(section(sheet, /^essence/i), DIRECTION_CONTEXT_BOUNDS.section);
      const voice = clip(section(sheet, /^voice|^speech/i), DIRECTION_CONTEXT_BOUNDS.section);
      const note = plan.reading === "performed" ? notes[key] : undefined;
      speakers.push({ key, name: sheet?.name ?? turn.speaker ?? key, ...(essence !== undefined ? { essence } : {}), ...(voice !== undefined ? { voice } : {}), ...(note !== undefined ? { note } : {}) });
    }
  }
  const synopsis = clip(summary?.synopsis, DIRECTION_CONTEXT_BOUNDS.synopsis);
  const pov = summary?.pov === undefined ? undefined : (sheets.find((sheet) => sheet.id === summary.pov)?.name ?? summary.pov);
  const tone = clip(bundle.meta.tone, DIRECTION_CONTEXT_BOUNDS.tone);
  const description = clip(room.narratorDescription, DIRECTION_CONTEXT_BOUNDS.narrator);
  const chapterNote = override?.chapterNote ?? book?.chapterNotes?.[plan.chapter.id];
  return {
    chapter: { order: plan.chapter.order, title: plan.chapter.title, version: plan.chapter.version, ...(synopsis !== undefined ? { synopsis } : {}), ...(pov !== undefined ? { pov } : {}) },
    ...(tone !== undefined ? { tone } : {}),
    speakers,
    narrator: { label: voiceDisplayLabel(room.narrator, bundle), ...(description !== undefined ? { description } : {}) },
    ...(book?.note !== undefined ? { bookNote: book.note } : {}),
    ...(chapterNote !== undefined ? { chapterNote } : {}),
    before: await chapterBefore(store, productionId, plan.chapter.order),
  };
}

/**
 * The chapter before this one and the last of its blocks that stand directed (R-51): who
 * speaks, how, and the tail of the words. Null for the first chapter; a chapter before with no
 * readable record has none.
 */
async function chapterBefore(store: WorldStore, productionId: string, order: number): Promise<DirectionContext["before"]> {
  const production = store.getBundle().productions.find((p) => p.meta.id === productionId);
  const previous = [...(production?.chapters ?? [])].filter((c) => !c.retired && c.order < order).sort((a, b) => b.order - a.order)[0];
  if (previous === undefined) return null;
  const record = await readAudiobook(store, productionId, previous.file);
  if (record === null || record === "unreadable" || Object.keys(record.direction).length === 0) return { order: previous.order, title: previous.title, blocks: [] };
  let body: string;
  try {
    body = (await openChapter(store, productionId, previous.id)).body;
  } catch {
    return { order: previous.order, title: previous.title, blocks: [] };
  }
  const cast = await readVoices(store, productionId, previous.file);
  const bookFile = await readAudiobookBook(store, productionId);
  const derived = audiobookBlocks(body, cast === "unreadable" ? null : cast, audiobookHeading(previous.order, previous.title), audiobookBlockOptions(bookFile === null || bookFile === "unreadable" ? null : bookFile, record));
  const sheets = store.getBundle().sheets;
  const directed = derived.blocks.flatMap((block) => {
    const direction = audiobookDirectionFor(record, block);
    if (direction === null) return [];
    const text = normalizeSpeechText(block.text);
    const tail = text.length > DIRECTION_CONTEXT_BOUNDS.beforeText ? `…${text.slice(text.length - DIRECTION_CONTEXT_BOUNDS.beforeText + 1)}` : text;
    const who = block.speaker === undefined ? "narration" : (sheets.find((sheet) => sheet.id === block.sheet)?.name ?? block.speaker);
    return [{ who, text: tail, ...(direction.plan.delivery !== undefined ? { delivery: direction.plan.delivery } : {}), ...(direction.plan.note !== undefined ? { note: clip(direction.plan.note, 120)! } : {}) }];
  });
  return { order: previous.order, title: previous.title, blocks: directed.slice(-DIRECTION_CONTEXT_BOUNDS.before) };
}

/**
 * What `Direct this chapter` would read, before it runs (design turn 184a, R-51): the context's
 * rows as counts and names — and, under `performed` or `cast`, why the lines are not cast, so
 * the sheet can offer casting first. Nothing run, nothing written.
 */
export async function directionReads(store: WorldStore, productionId: string, chapterId: string, room: Pick<DirectionRoom, "narrator" | "narratorDescription">): Promise<DirectionReads> {
  const plan = await planAudiobook(store, productionId, chapterId, { narrator: room.narrator });
  const context = await directionContext(store, productionId, plan, room);
  const refusal = castRefusal(plan);
  const book = plan.book;
  const speakerKeys = plan.reading === "performed" ? [...new Set(plan.blocks.flatMap((planned) => (planned.block.rows ?? [planned.block]).flatMap((turn) => { const key = audiobookNoteKey(turn); return key === null ? [] : [key]; })))] : [];
  return {
    chapter: { order: context.chapter.order, version: context.chapter.version, synopsis: context.chapter.synopsis !== undefined, ...(context.chapter.pov !== undefined ? { pov: context.chapter.pov } : {}) },
    ...(context.tone !== undefined ? { tone: context.tone } : {}),
    speakers: context.speakers.map((speaker) => speaker.name),
    narrator: context.narrator,
    notes: { book: book?.note !== undefined, chapter: context.chapterNote !== undefined, speakers: context.speakers.filter((speaker) => speaker.note !== undefined).length },
    before: context.before === null ? null : { order: context.before.order, blocks: context.before.blocks.length },
    ...(refusal !== null ? { cast: refusal } : {}),
    ...(plan.reading === "performed" && refusal === null ? { speakerNotes: { set: speakerKeys.filter((key) => book?.notes?.[key] !== undefined).length, of: speakerKeys.length } } : {}),
  };
}

export interface DirectOptions {
  /** Cast the lines first when they are not cast and the reading needs them (R-54): the cast's own deriver. */
  castWith?: VoicesDeriver;
  /** Draft the chapter note (R-53). */
  chapterNote?: boolean;
  /** Draft the missing speaker notes from the sheets, under `performed` (R-54). */
  speakerNotes?: boolean;
}

/**
 * Direct one chapter (R-10, R-51..R-54): the blocks in passes of whole blocks within
 * continuity's window, each pass its own model run with the book's context beside it, every
 * answer verified against the block and its reader; nothing written. Under `performed` or
 * `cast`, a chapter whose lines are not cast is cast first when asked, and the cast is held with
 * the directions in the one proposal. The card the window shows is this result, and acceptance
 * is a separate press.
 */
export async function directChapter(
  store: WorldStore,
  productionId: string,
  chapterId: string,
  deriver: DirectionDeriver,
  input: DirectionRoom,
  signal?: AbortSignal,
  options: DirectOptions = {},
): Promise<DirectedChapter> {
  let cast: DirectedChapter["cast"];
  let override: ProposalOverride | undefined;
  if (options.castWith !== undefined) {
    const before = await planAudiobook(store, productionId, chapterId, { narrator: input.narrator });
    if (castRefusal(before) !== null) {
      const derived = await deriveCast(store, productionId, chapterId, options.castWith, signal);
      if (signal?.aborted) throw new Error("stopped");
      const record: ChapterVoices = await composeCast(store, productionId, derived);
      override = { cast: record };
      cast = { derived, record, lines: derived.lines.length, speakers: new Set(derived.lines.map((line) => line.sheet ?? line.speaker)).size };
    }
  }
  const { chapter, blocks, plan } = await directableBlocks(store, productionId, chapterId, input, override);
  const context = await directionContext(store, productionId, plan, input, override);
  const missing = plan.reading === "performed" && options.speakerNotes === true ? context.speakers.filter((speaker) => speaker.note === undefined).map((speaker) => ({ key: speaker.key, name: speaker.name })) : [];
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
  let dropped = 0;
  const summaries: string[] = [];
  let chapterNote: string | undefined;
  const speakerNotes: Record<string, string> = {};
  // Who speaks a block, by name: a block that holds several turns (design turn 190) names each speaker in it.
  const nameOf = (turn: { speaker?: string; sheet?: string }): string | undefined =>
    turn.speaker === undefined ? undefined : (turn.sheet === undefined ? turn.speaker : (store.getBundle().sheets.find((sheet) => sheet.id === turn.sheet)?.name ?? turn.speaker));
  const mixedKeys = new Set(plan.blocks.filter((planned) => planned.block.rows !== undefined).map((planned) => planned.block.key));
  const speakerOf = new Map(plan.blocks.map((planned) => {
    const names = [...new Set((planned.block.rows ?? [planned.block]).flatMap((turn) => { const name = nameOf(turn); return name === undefined ? [] : [name]; }))];
    return [planned.block.key, names.length === 0 ? undefined : names.join(", ")] as const;
  }));
  for (const [index, pass] of passes.entries()) {
    if (signal?.aborted) throw new Error("stopped");
    // The drafts are asked of the first pass, which reads the chapter's opening with the
    // synopsis; a chapter note drafted there is read by every pass after it.
    const asks = index === 0 && (options.chapterNote === true || missing.length > 0) ? { ...(options.chapterNote === true ? { chapterNote: true } : {}), ...(missing.length > 0 ? { speakerNotes: missing } : {}) } : undefined;
    const raw = await deriver(
      {
        title: chapter.title,
        pass: { index: index + 1, of: passes.length },
        context: { ...context, ...(chapterNote !== undefined ? { chapterNote } : {}), speakers: context.speakers.map((speaker) => (speakerNotes[speaker.key] !== undefined ? { ...speaker, note: speakerNotes[speaker.key] } : speaker)) },
        ...(asks !== undefined ? { asks } : {}),
        blocks: pass.map((block) => {
          const support = cadenceSupport(block.model, block.language);
          const speaker = speakerOf.get(block.key);
          return {
            key: block.key,
            text: normalizeSpeechText(block.text),
            reader: `${voiceDisplayLabel(block.reader, store.getBundle())} · ${block.model.displayName}`,
            ...(speaker !== undefined ? { speaker } : {}),
            ...(mixedKeys.has(block.key) ? { mixed: true } : {}),
            deliveries: AUDIOBOOK_DELIVERIES.filter((delivery) => support.deliveries[delivery]?.status !== "unsupported"),
            note: support.note.status === "unsupported" ? "none" : support.note.method?.startsWith("tag") === true ? "tag" : "instruction",
            pause: support.pause.status !== "unsupported",
            breath: support.breath.status !== "unsupported",
            emphasis: support.emphasis.status !== "unsupported",
            sounds: SOUNDS.filter((sound) => support.sounds[sound].status !== "unsupported"),
            markers: AUDIOBOOK_DELIVERIES.some((delivery) => support.deliveries[delivery]?.status !== "unsupported"),
            speed: block.model.cadence?.speed ?? null,
          } satisfies DirectionBlockInput;
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
    if (asks?.chapterNote === true && typeof raw.chapterNote === "string") {
      // A note over its cap is dropped and counted, never cut: a cut note is a direction nobody wrote.
      const note = normalizeSpeechText(raw.chapterNote);
      if (note.length > CADENCE_NOTE_MAX) dropped += 1;
      else if (note !== "") chapterNote = note;
    }
    if (asks?.speakerNotes !== undefined && raw.speakerNotes !== null && raw.speakerNotes !== undefined) {
      for (const [key, value] of Object.entries(raw.speakerNotes)) {
        // Only a speaker named as having none (R-54): an author's note is never replaced.
        if (!asks.speakerNotes.some((speaker) => speaker.key === key)) {
          dropped += 1;
          continue;
        }
        const note = normalizeSpeechText(value);
        if (note.length > CADENCE_PHRASE_MAX) dropped += 1;
        else if (note !== "") speakerNotes[key] = note;
      }
    }
  }
  return {
    proposed,
    directed,
    dropped,
    ...(summaries.length > 0 ? { summary: summaries.join(" ") } : {}),
    hash: chapter.hash,
    chapterVersion: chapter.version,
    ...(cast !== undefined ? { cast } : {}),
    ...(chapterNote !== undefined ? { chapterNote } : {}),
    ...(Object.keys(speakerNotes).length > 0 ? { speakerNotes } : {}),
  };
}

export type AcceptedDirections = { outcome: "accepted"; record: ChapterAudiobook; dropped: number } | { outcome: "refused"; reason: string };

/** What a proposal carries besides its directions (R-53, R-54), written on acceptance and not before. */
export interface ProposalExtras {
  cast?: DerivedCast;
  chapterNote?: string;
  speakerNotes?: Readonly<Record<string, string>>;
}

/**
 * The notes a proposal drafted, written onto the book record (R-53, R-54): the chapter note,
 * and each drafted speaker note only where the speaker still has none — an author's note is
 * never replaced — marked as drawn from the sheet.
 */
export async function writeProposalNotes(store: WorldStore, productionId: string, chapterId: string, extras: Pick<ProposalExtras, "chapterNote" | "speakerNotes">): Promise<void> {
  if (extras.chapterNote === undefined && (extras.speakerNotes === undefined || Object.keys(extras.speakerNotes).length === 0)) return;
  const held = await readAudiobookBook(store, productionId);
  const base: AudiobookBook = held === null || held === "unreadable" ? { schemaVersion: 1, reading: "narrator" } : held;
  const notes = { ...base.notes };
  const sources = { ...base.noteSources };
  for (const [key, note] of Object.entries(extras.speakerNotes ?? {})) {
    if (notes[key] !== undefined) continue;
    notes[key] = note;
    sources[key] = "sheet";
  }
  await writeAudiobookBookRaised(store, productionId, {
    ...base,
    ...(Object.keys(notes).length > 0 ? { notes } : {}),
    ...(Object.keys(sources).length > 0 ? { noteSources: sources } : {}),
    ...(extras.chapterNote !== undefined ? { chapterNotes: { ...base.chapterNotes, [chapterId]: extras.chapterNote } } : {}),
  });
}

/**
 * A card accepted whole (R-10, R-54): the cast it carries written first, when it was made for
 * the prose as it stands, then its drafted notes; then every direction checked once more against
 * the chapter as it stands — the prose must be the prose the card was made for, and each block's
 * reader may have changed since — and the record's direction replaced with what still verifies,
 * the rest dropped and counted, and nothing else written or staged.
 */
export async function acceptDirections(
  store: WorldStore,
  productionId: string,
  chapterId: string,
  accepted: { hash: string; directions: Record<string, AudiobookDirectionInput> },
  input: DirectionRoom,
  extras: ProposalExtras = {},
): Promise<AcceptedDirections> {
  // Everything is judged before anything is written (codex on PR 1476): a card refused for prose
  // that moved, or a cast that no longer fits, must leave the cast and the book's notes as they
  // were. The held cast stands in for the record's while the directions are checked against it.
  if (extras.cast !== undefined && extras.cast.hash !== accepted.hash) return { outcome: "refused", reason: "the prose moved · direct again" };
  const cast = extras.cast === undefined ? undefined : await composeCast(store, productionId, extras.cast);
  let room: Awaited<ReturnType<typeof directableBlocks>>;
  try {
    room = await directableBlocks(store, productionId, chapterId, input, cast === undefined ? undefined : { cast });
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
    // A reader changed since the card was made holds what it cannot express (R-47) rather
    // than dropping the block's direction; only a direction wrong for its words is dropped.
    if (!checkDirection(block.text, plan, block.model, block.language, "hold").ok) {
      dropped += 1;
      continue;
    }
    direction[key] = directionEntry(block.text, plan, at);
  }
  // The card verified: its cast, with the pins as they stand now, then its notes, then its directions.
  if (extras.cast !== undefined) await writeCast(store, productionId, extras.cast);
  if (extras.chapterNote !== undefined || extras.speakerNotes !== undefined) await writeProposalNotes(store, productionId, chapter.id, extras);
  const record = await updateAudiobook(store, productionId, chapter, (current) => ({ ...current, updatedAt: at, direction }));
  return { outcome: "accepted", record, dropped };
}

// ---------------------------------------------------------------------------
// Speaker notes from the sheets (design turn 184c, R-54)
// ---------------------------------------------------------------------------

const RawSpeakerNotesSchema = z.object({ notes: z.record(z.string(), z.string()) });
export type RawSpeakerNotes = z.infer<typeof RawSpeakerNotesSchema>;
export interface SpeakerNotesInput {
  speakers: Array<{ key: string; name: string; essence?: string; voice?: string }>;
}
export type SpeakerNotesDeriver = (input: SpeakerNotesInput, signal?: AbortSignal) => Promise<RawSpeakerNotes>;

function buildSpeakerNotesPrompt(input: SpeakerNotesInput, retryNote?: string): string {
  const speakers = input.speakers
    .map((speaker) => [`[${speaker.key}] ${speaker.name}`, ...(speaker.essence !== undefined ? [`essence: ${speaker.essence}`] : []), ...(speaker.voice !== undefined ? [`voice: ${speaker.voice}`] : [])].join("\n"))
    .join("\n\n");
  return `One narrator reads an audiobook and plays every character. From each character's sheet below, write how the narrator plays them: a direction in a few words — register, pace, accent, manner — never words they say. Respond with ONLY a JSON object:
{"notes": {"<the character's key>": "<at most ${CADENCE_PHRASE_MAX} characters>"}}

Rules — enforced mechanically after you answer:
- Use only the keys listed. At most ${CADENCE_PHRASE_MAX} characters a note; a longer one is dropped.
- Leave a character out when the sheet says nothing of how they sound or carry themselves.
${retryNote ? `\nYour previous response was rejected: ${retryNote}\n` : ""}
## Characters

${speakers}`;
}

export function makeAdapterSpeakerNotesDeriver(adapter: HarnessAdapter, sessionInput: SessionInput, scratchRoot: string): SpeakerNotesDeriver {
  const ask = makeAdapterJsonDeriver(adapter, sessionInput, scratchRoot, RawSpeakerNotesSchema, "speaker-notes");
  return (input, signal) => ask((note) => buildSpeakerNotesPrompt(input, note), signal);
}

/**
 * The book's speakers with no note, each drafted from their sheet (design turn 184c, R-54): the
 * speakers every chapter's cast names, keyed as notes are keyed — the sheet, else the name — and
 * only those the author has not given a note. What verifies is written at once, marked as the
 * sheet's; an author's note is never replaced, and a draft is the author's to change.
 */
export async function draftSpeakerNotes(store: WorldStore, productionId: string, deriver: SpeakerNotesDeriver, signal?: AbortSignal, options: { blocked?: () => string | null } = {}): Promise<{ drafted: number }> {
  const production = store.getBundle().productions.find((p) => p.meta.id === productionId);
  if (!production) throw new Error("That production is no longer in this world.");
  const held = await readAudiobookBook(store, productionId);
  const base: AudiobookBook = held === null || held === "unreadable" ? { schemaVersion: 1, reading: "narrator" } : held;
  const sheets = store.getBundle().sheets;
  const wanted = new Map<string, SpeakerNotesInput["speakers"][number]>();
  for (const chapter of production.chapters.filter((c) => !c.retired).sort((a, b) => a.order - b.order)) {
    const voices = chapter.voices;
    if (voices === undefined || "unreadable" in voices) continue;
    for (const who of voices.speakers) {
      const key = who.sheet ?? who.speaker;
      if (wanted.has(key) || base.notes?.[key] !== undefined) continue;
      const sheet = who.sheet === undefined ? undefined : sheets.find((candidate) => candidate.id === who.sheet);
      const essence = clip(section(sheet, /^essence/i), DIRECTION_CONTEXT_BOUNDS.section);
      const voice = clip(section(sheet, /^voice|^speech/i), DIRECTION_CONTEXT_BOUNDS.section);
      // A name no sheet carries has nothing to draft from.
      if (essence === undefined && voice === undefined) continue;
      wanted.set(key, { key, name: sheet?.name ?? who.speaker, ...(essence !== undefined ? { essence } : {}), ...(voice !== undefined ? { voice } : {}) });
    }
  }
  if (wanted.size === 0) return { drafted: 0 };
  const raw = await deriver({ speakers: [...wanted.values()].slice(0, 40) }, signal);
  if (signal?.aborted) throw new Error("stopped");
  const drafted: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw.notes)) {
    if (!wanted.has(key)) continue;
    const note = normalizeSpeechText(value);
    if (note !== "" && note.length <= CADENCE_PHRASE_MAX) drafted[key] = note;
  }
  if (Object.keys(drafted).length === 0) return { drafted: 0 };
  // A read begun while the model worked was prepared under the notes as they were (codex on PR
  // 1476): writing now would make its takes stale as they land, so the drafts are refused.
  const busy = options.blocked?.() ?? null;
  if (busy !== null) throw new Error(busy);
  // Read again at the write: a note the author typed while the model worked is theirs.
  const now = await readAudiobookBook(store, productionId);
  const current: AudiobookBook = now === null || now === "unreadable" ? base : now;
  const notes = { ...current.notes };
  const sources = { ...current.noteSources };
  let count = 0;
  for (const [key, note] of Object.entries(drafted)) {
    if (notes[key] !== undefined) continue;
    notes[key] = note;
    sources[key] = "sheet";
    count += 1;
  }
  if (count > 0) await writeAudiobookBookRaised(store, productionId, { ...current, notes, noteSources: sources });
  return { drafted: count };
}
