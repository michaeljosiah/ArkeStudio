import { chapterParagraphs, readBreaksFor, DEFAULT_GROUP_PACKING, groupedText, SPLIT_DID_NOT_MATCH, type AudiobookGrouped, type AudiobookLoudness, type AudiobookSplitFlag, freeCreditDraw, freeCreditOverrun, freeLimitReason, freePlanFailure, freePlanShortfall, GOOGLE_DAILY_LIMIT, GOOGLE_FREE_LIMIT, groupReads, packTurns, quoteGroupedSpeech, quoteSpeech, readsGrouped, shareByCharacters, speechAsks, type FreePlanAllowance, type FreePlanShort, type GroupPacking, type ReadBreak, type SpeechQuote, type SpeechTurn } from "@arke-studio/contracts";
import { createHash } from "node:crypto";
import { readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import {
  audiobookDirectionFor,
  audiobookTakeDirectionHash,
  performanceNote,
  readingNotesLead,
  soundMode,
  audiobookTextHash,
  firstReadNotice,
  normalizeSpeechText,
  speechInputFits,
  speechUtf8Bytes,
  voiceFormatForModel,
  voiceDisplayLabel,
  voiceSourceFor,
  type VoiceNames,
  type ArtifactAudiobookGeneration,
  type BlockTurns,
  type ArtifactSidecar,
  type AudiobookDirection,
  type AudiobookReader,
  type AudiobookSubstitution,
  type AudiobookTake,
  type ChapterAudiobook,
  type ClonedVoice,
  type Job,
  type ManifestModel,
  type VoiceCandidate,
} from "@arke-studio/contracts";
import { fileGeneratedArtifact } from "../artifacts/filing.js";
import type { MediaProbe } from "../media/probe.js";
import type { EnqueueInput } from "../queue/dispatcher.js";
import { cachedVoiceAudioLooksRight, joinSpeech, speechCacheFile } from "../voice/service.js";
import { clipFor, clipHashOf } from "../voice/library.js";
import { piecesFor } from "../voice/pieces.js";
import { atomicWriteFile } from "../world/atomic.js";
import { fromPortable, toExtendedLength } from "../world/paths.js";
import type { WorldStore } from "../world/store.js";
import { audioHash } from "../audio/qc.js";
import { applyGain, dropRunawayTail, normaliseSpeech, readSpeechWav, samplePeak, sliceSpeech, trimSpeech, writeSpeechWav } from "../audio/speech-wav.js";
import type { TimedWord } from "../voice/word-times.js";
import { LONG_TAIL, splitAudio, splitLexicon, splitRequest } from "./audiobook-split.js";
import { checkDirection, directionPlan, type RenderedPart } from "../voice/direction.js";
import { plannedReactions } from "./audiobook-timing.js";
import { audiobookLanding, recordsLoudness, castLeftToCast, castRefusal, currentDirection, directionEntry, effectiveReader, emptyAudiobook, planAudiobook, readerLanguage, updateAudiobook, type AudiobookPlan, type PlannedBlock, type ProposalOverride } from "./audiobook.js";

/**
 * A read ended by a limit the rest of the run would only meet again — the free day, a billed key,
 * or a paid key's own daily quota — which ends the run with it.
 * The message is what the block's flag says; `reason` is what the run ends with, which keeps the
 * limit and the reset Google named for the note under the button.
 */
class FreePlanEnded extends Error {
  constructor(message: string, readonly reason: string = message) {
    super(message);
  }
}

/**
 * A chapter read into kept takes (design turn 146, SPEC-047 R-16..R-19): every block that is
 * not `made`, in reading order, each in the reader it is meant for — or the narrator, said
 * first, when that reader cannot speak now — priced once for the cloud blocks the cache does
 * not hold and confirmed by token, a local block made on this machine, a cached line adopted,
 * a cloud block made through the queue and joined from parts when it is over the reader's cap;
 * each take filed as an artifact and written into the record before the next begins, so a stop
 * or a lost claim leaves what was made standing.
 */

export type AudiobookRunEvent =
  | { type: "started"; toMake: number; blocks: number; requests?: number; groups?: string[][] }
  | { type: "priced"; characters: number; estimatedMicroUsd: number; confirmationToken: string; voices: { label: string; provider: string; characters: number; estimatedMicroUsd: number }[]; notices: string[]; freePlan?: FreePlanShort; requests?: number; perParagraph?: number; toCast?: number }
  | { type: "request"; index: number; of: number; keys: string[] }
  | { type: "progress"; block: string; outcome: "made" | "adopted" | "flagged"; reason?: string; made: number; toMake: number }
  | { type: "finished"; outcome: "read" | "stopped" | "unavailable" | "failed" | "refused"; made: number; flagged: number; record?: ChapterAudiobook; reason?: string };

export interface AudiobookRunDeps {
  store: WorldStore;
  worldId: string;
  productionId: string;
  chapterId: string;
  models: readonly ManifestModel[];
  /** What is left of the month's free credit (design turn 182); absent is not known to be short. */
  creditLeftMicroUsd?: number;
  /** Each Google model's free day; absent is not known to be short. */
  freePlanAllowance?: (model: string) => FreePlanAllowance;
  narrator: AudiobookReader;
  /** What can speak now (turn 130's rule): a voice the catalogue lacks or marks reads in the narrator's. */
  catalogue: readonly VoiceCandidate[];
  signal: AbortSignal;
  confirmationToken?: string;
  /** These blocks alone, whatever their state — the panel's `Make again` (R-30); every block not made otherwise. */
  only?: readonly string[];
  /**
   * The book's run priced this chapter with the rest (R-17): the chapter's own price token as
   * the book computed it from its preparation. Read on that answer while the chapter is still
   * what was priced, and refused — never read unpriced — once it has moved under the book's run.
   */
  priced?: string;
  /**
   * Cast the paragraphs left to cast before a word is read (design turn 198, SPEC-012 R-69): the
   * confirm's ticked `Cast 2 paragraphs first`. The chapter is priced as its cast stands, and the
   * cast runs once the price is answered, or at once where nothing is asked; the read then goes
   * on as the new cast says, asking again only if that moved its price. Null when cast, else why not.
   */
  castFirst?: () => Promise<string | null>;
  /**
   * Ask for a cloned voice's recording to leave the machine (SPEC-046 R-16): per voice and
   * vendor for a hosted reader, whose answer is written onto the voice, per request for the
   * engine. True when the run must stop here and wait for the answer.
   */
  requireUploadConfirmation: (reader: { provider: string; voice: ClonedVoice }) => boolean | Promise<boolean>;
  /**
   * Speech on this machine, into the speech cache: the voice service's, which takes one
   * synthesis at a time whoever asks, since the engine is one small model that several
   * syntheses at once can fell for the whole process; ended by the signal. `parts` is how many
   * requests made the file, a cache hit's too.
   */
  localSpeech: (voiceId: string, text: string, signal: AbortSignal) => Promise<{ file: string; cached: boolean; parts: number }>;
  /**
   * A directed block on this machine (R-6): a fresh synthesis with the direction's settings —
   * the speed a delivery maps to — through the same one-at-a-time rule, never the speech cache,
   * whose files carry no direction (R-19).
   */
  synthesizeLocal: (voiceId: string, text: string, settings: Record<string, number>, signal: AbortSignal) => Promise<{ audio: Uint8Array; parts: number }>;
  enqueue: (inputs: EnqueueInput[]) => Promise<{ jobIds: string[]; reason?: string }>;
  waitForJob: (jobId: string) => Promise<Job>;
  cancelJob: (jobId: string) => Promise<void>;
  /** Every job the queue holds, so a part already paid for is found before another is asked for (R-16). */
  findJobs: () => readonly Job[];
  actualCost: (jobId: string) => Promise<number | null>;
  /**
   * Word times for a grouped request's audio, heard on this machine (design turn 185); absent
   * when no local transcriber runs, and then nothing is grouped.
   */
  wordTimes?: (wav: Uint8Array, signal: AbortSignal) => Promise<{ words: TimedWord[]; seconds: number }>;
  mediaProbe?: MediaProbe;
  emit: (event: AudiobookRunEvent) => void;
  now: () => string;
}

type Format = "wav" | "mp3" | "flac";

/** The reader that will actually speak a block, after the catalogue has been asked. */
export interface Speaking extends PlannedBlock {
  reader: AudiobookReader;
  model: ManifestModel;
  local: boolean;
  /** The library voice the reader is, when it is one: its recording is what leaves the machine. */
  clone: ClonedVoice | null;
  /** That recording's hash (SPEC-046 R-39): a re-recorded clone is another voice to the cache and to a prior job. */
  reference: string | null;
  text: string;
  /**
   * The block's direction as it stands, mapped for this reader (R-6, R-8): what the reader is
   * sent — the words with the tags in — and the settings beside them; null for a block with
   * none. A direction the reader cannot express is `refusal` instead, and the block is flagged
   * with it rather than made neutral in silence (R-9).
   */
  direction: {
    hash: string;
    /** The block's delivery; none for a line directed by its speaker's note alone (R-45). */
    delivery?: string;
    rendered: string;
    voiceSettings: Record<string, number>;
    instructions?: string;
    /**
     * Each part's own settings and sentence, beside `parts` (R-41): a marker made in parts
     * reads its span with its delivery's, so one block's requests need not share them.
     */
    perPart: Array<{ voiceSettings: Record<string, number>; instructions?: string }>;
  } | null;
  refusal?: string;
  /** The speaker's note could not be played on this reader (R-45): the line is read without it, and the take says so. */
  noteHeld?: true;
  /** The block's direction makes a sound: the grouped split hears "uh-huh" or "ah" there as it, not as a word. */
  sounds?: true;
  /**
   * The direction the take is made under, as the take names it (R-14, R-45): the plan's and the
   * note's, even when the note is held and nothing of it is sent, so the take is judged by the
   * same name the record's state is.
   */
  takeHash?: string;
  /**
   * The direction as it was carried to these words (R-43) when the record holds it for earlier
   * ones. The take is named by it, so keeping the take keeps it too: otherwise the plan, which
   * reads only a direction written for these exact words, would find none and call the take
   * it was just made under stale.
   */
  carried?: AudiobookDirection;
  /** What the reader is sent, in parts each within its cap (R-5): the rendered text under a direction, the words otherwise. */
  parts: string[];
  /** One preparation's rates: shared by its total, confirmation identity and dispatch. */
  quotes: SpeechQuote[];
  format: Format;
  cacheFile: string | null;
  substitutedNow?: AudiobookSubstitution;
  /**
   * `Make again` on a block that is made and unchanged (R-30, issue 1190): another performance
   * of the same words, so neither cache — the speech cache nor a cloud line's — may stand in
   * for the reading, and the take goes beside the kept one rather than in its place (R-4).
   */
  remake: boolean;
  /** Exact byte-bounded compilation, shared by consent and durable part adoption (SPEC-049 R-25). */
  compiledSpeechHash?: string;
  /**
   * The parts as a grouped request takes them (design turn 185): the notes the chapter shares
   * apart, and each part's words with its own style — its delivery, note and speaker's note.
   * `soloTurns` of this is exactly what a solo read sends.
   */
  turns: Pick<BlockTurns, "shared" | "parts">;
}

/** The record could not be written: the world's claim is gone, or it closed under the run. Nothing more can be kept. */
class RecordWriteError extends Error {}


/** What names one part's job, frozen into its params so a later run can find it (R-16). */
export interface PartIdentity {
  productionId: string;
  chapterId: string;
  block: string;
  textHash: string;
  provider: string;
  model: string;
  voiceId: string;
  parts: number;
  /** The direction's name, or null for a block made with none — a job under another direction is not this part (R-14). */
  directionHash: string | null;
  compiledSpeechHash?: string;
  /** A cloned reader's recording, by hash, or null for a preset: a part made from an older recording is not this part (SPEC-046 R-39). */
  reference?: string | null;
}

/**
 * A part already paid for, or still being made, found in the queue's durable rows before
 * another request is asked for (codex on PR 1180). A process that exits after a job reaches
 * its end but before the take is filed loses the waiter and the record write; the job itself,
 * its landed file and its params survive, and the next press picks up where it left off — a
 * landed job is filed, a running one is waited for, and only a block with neither is asked for.
 * The newest match wins: a retry after a failure is a later row.
 */
export function priorPartJob(jobs: readonly Job[], identity: PartIdentity, part: number): { kind: "landed" | "running"; job: Job } | null {
  const matching = jobs.filter(
    (job) =>
      job.target.kind === "voice-preview" &&
      job.params["purpose"] === "audiobook" &&
      job.params["hear"] !== true &&
      job.params["productionId"] === identity.productionId &&
      job.params["chapterId"] === identity.chapterId &&
      job.params["block"] === identity.block &&
      job.params["textHash"] === identity.textHash &&
      job.provider === identity.provider &&
      job.model === identity.model &&
      job.params["voiceId"] === identity.voiceId &&
      job.params["part"] === part &&
      job.params["parts"] === identity.parts &&
      (identity.compiledSpeechHash === undefined || job.params["compiledSpeechHash"] === identity.compiledSpeechHash) &&
      (identity.reference === undefined || (job.params["voiceClipHash"] ?? null) === identity.reference) &&
      (job.params["directionHash"] ?? null) === identity.directionHash,
  );
  for (const job of [...matching].reverse()) {
    if (job.status === "succeeded" && job.landedFiles?.[0] !== undefined) return { kind: "landed", job };
    if (job.status !== "succeeded" && job.status !== "failed" && job.status !== "cancelled") return { kind: "running", job };
  }
  return null;
}

/** What a run, the book's run and the door share of a chapter: its plan, its record, and every block to make with the reader that will speak it. */
export interface PreparedChapter {
  /** The paragraphs a read that casts first will cast before a word is read (design turn 198); none otherwise. */
  toCast: number[];
  plan: AudiobookPlan;
  record: ChapterAudiobook;
  toMake: PlannedBlock[];
  speaking: Speaking[];
  /** The cloud blocks the cache does not hold: what a press would pay for (R-17). */
  misses: Speaking[];
  /** The cloned voices among the misses (R-17), each with its recording's hash. */
  clones: { provider: string; voice: ClonedVoice; reference: string | null }[];
  priceOf: (block: Speaking) => number;
  estimate: number;
  /**
   * Whether pressing read asks first: a price outside a free plan or credit (SPEC-047 R-17,
   * design turn 182). A chapter read wholly on a free key, or from a free credit, starts at once —
   * unless its draw on the credit runs past what is left of the month, when it asks.
   */
  asks: boolean;
  /** What the chapter would draw from the free credit, for a book weighed whole against it. */
  creditDraw: number;
  /** The requests each miss would make, for a book weighed whole against Google's free day. */
  freeReads: { model: ManifestModel; requests: number }[];
  /** The chapter's requests on Google's free plan past what is left of the day; it then asks, or is refused once Google has said the day is used up. */
  freePlan: { short: FreePlanShort; allowance: FreePlanAllowance } | null;
  /** The grouped requests (design turn 185): empty for a reader that reads per paragraph. */
  groups: PreparedGroup[];
  /** The requests the misses make: one a grouped request, one a part otherwise. */
  requests: number;
  /** As many as they would make a block a request. */
  perParagraph: number;
  /** The names and words not in English the grouped split expects whisper to mishear (`splitLexicon`). */
  lexicon: ReadonlySet<string>;
}

export type ChapterPreparation = { kind: "ready"; prepared: PreparedChapter } | { kind: "refused"; reason: string; plan: AudiobookPlan } | { kind: "unavailable"; reason: string };

export interface ReadingRoom {
  narrator: AudiobookReader;
  models: readonly ManifestModel[];
  catalogue: readonly VoiceCandidate[];
  /** What is left of the month's free credit; absent is not known to be short. */
  creditLeftMicroUsd?: number;
  /** Each Google model's free day (design turn 182 follow-up); absent is not known to be short. */
  freePlanAllowance?: (model: string) => FreePlanAllowance;
  /** This machine can split a grouped request (design turn 185); grouping is not offered without it. */
  transcriber?: boolean;
}

/**
 * A chapter as a press sees it (R-16, R-17): the plan read once, every block to make with the
 * reader that will actually speak it, its direction mapped for that reader or refused, the
 * parts the cap makes of it, whether the cache already holds it, and what the rest would cost.
 * The run, the book's run and the door read the same answer, so a price the door shows is the
 * price the run asks for.
 */
export async function prepareChapter(
  store: WorldStore,
  productionId: string,
  chapterId: string,
  room: ReadingRoom,
  now: () => string,
  only?: readonly string[],
  override?: ProposalOverride,
  options: { castPending?: boolean } = {},
): Promise<ChapterPreparation> {
  const plan = await planAudiobook(store, productionId, chapterId, { narrator: room.narrator, ...(override !== undefined ? { override } : {}) });
  // Under `cast` a run needs a cast that is current (R-12): a line whose speaker the cast cannot
  // name would otherwise be made in the narrator's voice without the door having said so. One
  // stale in some paragraphs (design turn 198) is priced as it stands when the read will cast
  // them first, and lets a block be made alone where the edit left its paragraph.
  const castTrouble = castRefusal(plan, { ...(only !== undefined ? { only } : {}), ...(options.castPending === true ? { castPending: true } : {}) });
  if (castTrouble !== null) return { kind: "refused", reason: castTrouble, plan };
  // An unreadable record is no record: the takes it named are still on the shelf, and a run
  // that cannot read which block each was for makes the chapter afresh rather than guessing.
  const record: ChapterAudiobook =
    plan.record === null || plan.record === "unreadable"
      ? emptyAudiobook(plan.chapter.version, plan.chapter.hash, now())
      : { ...plan.record, takes: { ...plan.record.takes }, flags: { ...plan.record.flags } };
  // Reactions are read when the chapter is (design turn 187, R-83), after its blocks, priced as
  // any read; `Make again` on one names it as it names a block.
  const reactions = plannedReactions(store, plan, room.narrator);
  const toMake = [
    ...(only !== undefined ? plan.blocks.filter((planned) => only.includes(planned.block.key)) : plan.blocks.filter((planned) => planned.state !== "made" && planned.state !== "awaiting")),
    ...(only !== undefined ? reactions.filter((planned) => only.includes(planned.block.key)) : reactions.filter((planned) => planned.state !== "made" && planned.state !== "awaiting")),
  ];
  const clonedVoices = store.getBundle().clonedVoices ?? [];
  // Each cloned reader's recording, hashed once for the chapter (SPEC-046 R-39): the hash keys
  // its cache files and names its parts' jobs, so a voice re-recorded since is read afresh.
  const references = new Map<string, string | null>();
  const referenceOf = async (voice: ClonedVoice): Promise<string | null> => {
    if (!references.has(voice.id)) {
      const clip = await clipFor(store, voice);
      references.set(voice.id, clip === null ? null : clipHashOf(clip));
    }
    return references.get(voice.id)!;
  };

  // A single block made again, re-read or heard is read with its neighbours (design turn 185):
  // the block before and after it, prepared as the run would prepare them, ride in its request
  // for their context and are cut away. Whether they share its voice is known once each is spoken.
  const neighbourKeys = new Set<string>();
  if (only !== undefined && only.length === 1 && room.transcriber === true && plan.book?.requests !== "per-paragraph") {
    const at = plan.blocks.findIndex((planned) => planned.block.key === only[0]);
    for (const near of [plan.blocks[at - 1], plan.blocks[at + 1]]) if (at >= 0 && near !== undefined && near.recorded !== true) neighbourKeys.add(near.block.key);
  }
  const toSpeak = neighbourKeys.size === 0 ? toMake : plan.blocks.filter((planned) => neighbourKeys.has(planned.block.key) || toMake.includes(planned));
  // Who actually speaks each block (R-12): the one rule the direction was verified against.
  const spoken: Speaking[] = [];
  const quotedAt = now();
  for (const planned of toSpeak) {
    const speaks = await effectiveReader(store, planned.assigned, room);
    if (speaks === null) return { kind: "unavailable", reason: "the narrator's voice model is not in the manifest" };
    const { reader, model, substitutedNow } = speaks;
    const text = normalizeSpeechText(planned.block.text);
    // The direction that stands for these words, mapped for the reader that will speak — the
    // narrator's row when the narrator stands in (R-12) — so a control that reader cannot
    // express is refused here, in one clause, and never sent (R-9).
    // A direction written for earlier words is carried to these by its anchors (R-43).
    // A held proposal's directions stand whole in place of the record's (design turn 184b): a
    // block it leaves undirected is read undirected, as accepting it would leave it.
    const proposed = override?.directions === undefined ? undefined : override.directions[planned.block.key];
    const held = override?.directions !== undefined
      ? proposed === undefined ? null : directionEntry(planned.block.text, directionPlan(planned.block.text, proposed), store.now())
      : currentDirection(record, planned.block, store.now());
    const language = readerLanguage(clonedVoices, reader);
    const cap = model.limits.maxPromptChars;
    let direction: Speaking["direction"] = null;
    let refusal: string | undefined;
    let parts: string[];
    // The speaker's note under `performed` (R-45): the line's leading phrase through the row's
    // phrase path, ahead of the line's own direction. A row that takes no phrase cannot play
    // it, so the line is read without it and the take records that; the note still names the
    // take, so changing it makes every line of the speaker's stale.
    const note = planned.note;
    const playing = note === undefined ? null : performanceNote(note, model, language);
    const noteHeld = playing?.mode === "unsupported";
    // The book note and the chapter note (design turn 184, R-53) lead every block before its
    // own direction and the speaker's note, so a chapter of separate requests sounds like one
    // reader: sentences in the style on an instruction row, a tag each on a tag row while
    // short enough, held otherwise. They name the take whether sent or held, as the note does.
    const reading = planned.reading;
    const context = reading === undefined ? { tags: [] as string[], held: [] } : readingNotesLead(reading, model, language);
    const contextChars = context.tags.reduce((sum, tag) => sum + tag.length + 1, 0);
    const capLeft = cap === undefined ? cap : (note !== undefined && !noteHeld) || contextChars > 0 ? Math.max(1, cap - (note !== undefined && !noteHeld ? note.length + 3 : 0) - contextChars) : cap;
    // The performed note and the reading notes are prepended after cadence compilation. Reserve
    // their bytes (and separators) before packing, just as tag readers reserve their character prefix.
    const byteCap = model.limits.maxSpeechUtf8Bytes;
    const contextBytes = context.tags.reduce((sum, tag) => sum + speechUtf8Bytes(tag) + 1, 0) + (context.instructions !== undefined ? speechUtf8Bytes(context.instructions) + 1 : 0);
    const byteCapLeft = byteCap === undefined ? undefined : byteCap - contextBytes - (playing?.mode === "instruction" ? speechUtf8Bytes(note!) + 1 : playing?.mode === "tag" ? speechUtf8Bytes(playing.tag) + 1 : 0);
    const packingModel = { ...model, limits: { ...model.limits,
      ...(capLeft !== undefined ? { maxPromptChars: capLeft } : {}),
      ...(byteCapLeft !== undefined ? { maxSpeechUtf8Bytes: byteCapLeft } : {}) } };
    const leadTags = [...context.tags, ...(playing?.mode === "tag" ? [playing.tag] : [])];
    const leadStyle = [...(context.instructions !== undefined ? [context.instructions] : []), ...(playing?.mode === "instruction" ? [note!] : [])].join(" ");
    const lead = (part: RenderedPart): RenderedPart => ({
      ...part,
      text: leadTags.length > 0 ? `${leadTags.join(" ")} ${part.text}` : part.text,
      ...(leadStyle !== "" ? { instructions: part.instructions === undefined ? leadStyle : `${leadStyle} ${part.instructions}` } : {}),
    });
    const takeHash = audiobookTakeDirectionHash(held?.plan ?? null, note, reading);
    // Each part's own style apart from the notes the whole chapter shares (design turn 185): a
    // grouped request sends the notes once and each later turn only this.
    const playedNote = playing?.mode === "instruction" ? note! : undefined;
    let own: Array<string | undefined> = [];
    try {
      if (held !== null) {
        // What this reader cannot express is held (R-47): left out of what it is sent, kept on
        // the record, and never a reason to flag the block. Only a direction wrong for its words
        // is refused.
        const check = checkDirection(planned.block.text, held.plan, packingModel, language, "hold");
        if (check.ok) {
          const rendered = check.parts.map(lead);
          direction = {
            hash: takeHash!,
            delivery: held.plan.delivery,
            rendered: rendered.map((part) => part.text).join(" "),
            voiceSettings: rendered[0]?.voiceSettings ?? check.mapped.voiceSettings,
            ...(rendered[0]?.instructions !== undefined ? { instructions: rendered[0].instructions } : {}),
            perPart: rendered.map((part) => ({ voiceSettings: part.voiceSettings, ...(part.instructions !== undefined ? { instructions: part.instructions } : {}) })),
          };
          parts = rendered.map((part) => part.text);
          own = check.parts.map((part) => [playedNote, part.instructions].filter((style) => style !== undefined && style !== "").join(" ") || undefined);
        } else {
          refusal = check.reason;
          parts = [text];
        }
      } else if (note !== undefined || reading !== undefined) {
        // A block directed by its notes alone: the words as they are, the notes ahead, no settings.
        const words = piecesFor(text, packingModel, voiceFormatForModel(model));
        const rendered = words.map((words) => lead({ text: words, voiceSettings: {} }));
        direction = {
          hash: takeHash!,
          rendered: rendered.map((part) => part.text).join(" "),
          voiceSettings: {},
          ...(rendered[0]?.instructions !== undefined ? { instructions: rendered[0].instructions } : {}),
          perPart: rendered.map((part) => ({ voiceSettings: part.voiceSettings, ...(part.instructions !== undefined ? { instructions: part.instructions } : {}) })),
        };
        parts = rendered.map((part) => part.text);
        own = words.map(() => playedNote);
      } else parts = piecesFor(text, model, voiceFormatForModel(model));
      if (parts.some((part, index) => !speechInputFits(part, model.limits, direction?.perPart[index]?.instructions))) {
        throw new Error("The words and direction exceed this reader's request limit.");
      }
    } catch (error) {
      refusal = error instanceof Error ? error.message : String(error);
      parts = [text];
    }
    // A reaction that is a sound (R-83) is sent as the reader's own tag for it, alone: the take
    // still names what the reaction says (`[laughs]`), and a reader that makes no such sound is
    // refused in one clause rather than reading the word aloud.
    const sound = planned.reaction?.sound;
    if (sound !== undefined) {
      const how = soundMode(sound, model, language);
      if (how.mode === "unsupported") refusal = `${model.displayName} makes no ${sound}`;
      else {
        parts = [how.tag];
        direction = null;
      }
    }
    const local = reader.provider === "kokoro";
    const format = voiceFormatForModel(model);
    const source = voiceSourceFor(clonedVoices, reader.provider, reader.model, reader.voiceId);
    const reference = source.kind === "cloned" ? await referenceOf(source.voice) : null;
    // An explicit `Make again`, whatever the block's state (codex on PR 1193): with its kept
    // take retired, the older take of the same words must not be the answer either.
    const remake = only !== undefined;
    const compiledSpeechHash = byteCap === undefined ? undefined : audioHash(Buffer.from(JSON.stringify({
      compiler: "speech-input-v1", model: model.providerModelId ?? model.id, format,
      parts: parts.map((part, index) => ({ text: part,
        voiceSettings: direction?.perPart[index]?.voiceSettings ?? direction?.voiceSettings ?? {},
        instructions: direction?.perPart[index]?.instructions ?? direction?.instructions ?? null })),
    })));
    spoken.push({
      ...planned,
      ...(substitutedNow !== undefined ? { substitutedNow } : {}),
      ...(refusal !== undefined ? { refusal } : {}),
      ...(noteHeld ? { noteHeld: true as const } : {}),
      ...(held?.plan.cues.some((cue) => cue.kind === "sound") === true ? { sounds: true as const } : {}),
      ...(refusal === undefined && takeHash !== undefined ? { takeHash } : {}),
      // A block a seam shaped is directed from its blocks' own entries every time (design turn 198):
      // writing that here would put it over the first block's, which a split or Reset wants back.
      ...(held !== null && override?.directions === undefined && planned.block.shaped !== true && audiobookDirectionFor(record, planned.block) === null ? { carried: held } : {}),
      reader,
      model,
      local,
      clone: source.kind === "cloned" ? source.voice : null,
      reference,
      text,
      direction,
      parts,
      // Each part with the style it goes with, as the dispatcher quotes it.
      quotes: parts.map((part, index) => {
        const instructions = direction?.perPart[index]?.instructions ?? direction?.instructions;
        return quoteSpeech(model, part, { at: quotedAt, ...(instructions !== undefined ? { instructions } : {}) });
      }),
      format,
      remake,
      ...(compiledSpeechHash !== undefined ? { compiledSpeechHash } : {}),
      turns: { ...(context.instructions !== undefined ? { shared: context.instructions } : {}), parts: parts.map((part, index) => ({ text: part, ...(own[index] !== undefined ? { style: own[index] } : {}) })) },
      // A whole block already in the cache is adopted without a call (R-19); parts are never
      // cached as a block, so a block over the cap is always made, the cache holds no
      // direction, so a directed block never comes from it, and a block made again unchanged
      // is another performance, not the cached one handed back (issue 1190).
      cacheFile: local || parts.length > 1 || direction !== null || remake ? null : speechCacheFile({ provider: model.provider, model: model.id, voiceId: reader.voiceId, text, format, ...(reference !== null ? { reference } : {}) }),
    });
  }

  const speaking = spoken.filter((block) => !neighbourKeys.has(block.block.key));

  // What the cache lacks, priced once (R-17).
  const misses: Speaking[] = [];
  for (const block of speaking) {
    if (block.local || block.refusal !== undefined) continue;
    if (block.cacheFile !== null) {
      try {
        const bytes = new Uint8Array(await readFile(toExtendedLength(join(store.dir, fromPortable(block.cacheFile)))));
        if (cachedVoiceAudioLooksRight(bytes, block.format)) continue;
      } catch {
        /* a miss */
      }
    }
    misses.push(block);
  }
  // Ask before the price when a recording first leaves for a hosted reader (R-17). The answer
  // persists per voice and vendor; one question at a time keeps each consent tied to its voice.
  const cloneMap = new Map<string, { provider: string; voice: ClonedVoice; reference: string | null }>();
  for (const block of misses) {
    if (block.clone !== null) cloneMap.set(`${block.reader.provider}\n${block.clone.id}`, { provider: block.reader.provider, voice: block.clone, reference: block.reference });
  }
  const clones = [...cloneMap.values()];
  // Priced by the character as the row bills it (SPEC-046 R-8): bytes, or doubled CJK, for the
  // readers that count so — `text.length` alone understates a Fish or Breeze block by up to 3×
  // (codex on PR 1180). The counts the card and the job show stay the prose's, as the page
  // read's do; only the money is the vendor's count.
  // A token reader's part is priced at its estimate: what the card shows and the author answers.
  // Each part's service-limit authorisation stays on its quote as the dispatcher's cap (SPEC-049
  // R-6); priced at that cap, a 122-block chapter read as $18.49 for about $0.40 of speech.
  const prices = new Map(misses.map(block => [block, block.quotes.reduce((sum, quote) => sum + quote.expectedMicroUsd, 0)]));
  // Grouped requests (design turn 185): a group's one quote shared among the blocks it keeps by
  // their characters, so the card's lines and the sum are the requests' estimates.
  const groups = readGroupsFor(plan, speaking, misses, spoken.filter((block) => neighbourKeys.has(block.block.key)), room, quotedAt);
  for (const group of groups) {
    const shares = shareByCharacters(group.quote.expectedMicroUsd, group.kept.map((block) => block.text.length));
    group.kept.forEach((block, index) => prices.set(block, shares[index]!));
  }
  const grouped = new Set(groups.flatMap((group) => group.kept));
  const priceOf = (block: Speaking) => prices.get(block) ?? 0;
  const estimate = misses.reduce((sum, block) => sum + priceOf(block), 0);
  const creditDraw = freeCreditDraw(misses.map((block) => ({ model: block.model, microUsd: priceOf(block) })));
  // A request a part, weighed whole against what is left of Google's free day: 122 blocks on a
  // ten-a-day free tier ask before the first is sent rather than meeting the limit at the eleventh.
  // A grouped request is one, however many blocks it carries.
  const freeReads = [...misses.filter((block) => !grouped.has(block)).map((block) => ({ model: block.model, requests: block.parts.length })), ...groups.map((group) => ({ model: group.model, requests: 1 }))];
  const requests = freeReads.reduce((sum, read) => sum + read.requests, 0);
  const perParagraph = misses.reduce((sum, block) => sum + block.parts.length, 0);
  const freePlan = room.freePlanAllowance === undefined ? null : freePlanShortfall(freeReads, room.freePlanAllowance);
  const asks = misses.some((block) => speechAsks(block.model, priceOf(block))) || freeCreditOverrun(creditDraw, room.creditLeftMicroUsd ?? Infinity) || freePlan !== null;
  // The world's names and the chapter's, which whisper is expected to mishear (2026-10-03): every
  // sheet's name and region, the cast's speakers, and the chapter's capitalised words.
  const names = store.getBundle().sheets.filter((sheet) => sheet.retired !== true).flatMap((sheet) => [sheet.name, ...(sheet.region !== undefined ? [sheet.region] : [])]);
  const speakers = plan.cast === null || plan.cast === "unreadable" ? [] : [...new Set(plan.cast.lines.map((line) => line.speaker))];
  const lexicon = splitLexicon([...names, ...speakers], plan.blocks.map((planned) => planned.block.text));
  return { kind: "ready", prepared: { plan, record, toMake, speaking, misses, clones, priceOf, estimate, asks, creditDraw, freeReads, freePlan, groups, requests, perParagraph, lexicon, toCast: options.castPending === true ? castLeftToCast(plan) : [] } };
}

/** A grouped request as a run sends it (design turn 185): its blocks, the ones it keeps, its turns and its one quote. */
export interface PreparedGroup {
  /** Every block the request carries, in reading order. */
  members: Speaking[];
  /** The blocks whose cuts are filed: all of them for a chapter's run, the middle one for a block read with its neighbours. */
  kept: Speaking[];
  model: ManifestModel;
  packing: GroupPacking;
  turns: SpeechTurn[];
  quote: SpeechQuote;
}

/**
 * Where a request may close after each block (design turn 185): after the title or before a
 * scene break, a scene; after the last block of a paragraph that is narration alone, a paragraph;
 * nowhere else — not between a line and its tag, not inside an exchange.
 */
export function readBreaks(plan: Pick<AudiobookPlan, "blocks" | "body">): Map<string, ReadBreak> {
  return readBreaksFor(plan.blocks.map((planned) => planned.block), chapterParagraphs(plan.body));
}

/** Whether a block can ride in a grouped request: a cloud read of a reader that groups, in WAV, with nothing refused or cloned. */
function groupable(block: Speaking, room: ReadingRoom, book: AudiobookPlan["book"]): boolean {
  return readsGrouped(block.model, room.transcriber === true, book) && !block.local && block.refusal === undefined && block.format === "wav" && block.clone === null;
}

const readerKey = (block: Speaking) => `${block.model.provider}/${block.model.id}/${block.reader.voiceId}`;

/**
 * The chapter's grouped requests (design turn 185): consecutive cloud misses of one groupable
 * reader, in reading order, packed under the caps and closed at natural breaks; a block not sent
 * closes the request. A single block read with its neighbours is one request of the three, keeping
 * the middle. A request of one block is read as it always was, so only groups of two or more.
 */
function readGroupsFor(plan: AudiobookPlan, speaking: readonly Speaking[], misses: readonly Speaking[], neighbours: readonly Speaking[], room: ReadingRoom, at: string): PreparedGroup[] {
  const packing = DEFAULT_GROUP_PACKING;
  const make = (members: Speaking[], kept: Speaking[]): PreparedGroup => {
    const turns = packTurns(members.map((block) => ({ key: block.block.key, reader: readerKey(block), ...block.turns })), packing).map(({ keys: _keys, ...turn }) => turn);
    return { members, kept, model: members[0]!.model, packing, turns, quote: quoteGroupedSpeech(members[0]!.model, turns, { at }) };
  };
  if (neighbours.length > 0) {
    const block = speaking[0];
    if (block === undefined || !misses.includes(block) || !groupable(block, room, plan.book)) return [];
    const near = neighbours.filter((other) => groupable(other, room, plan.book) && readerKey(other) === readerKey(block));
    if (near.length === 0) return [];
    const order = plan.blocks.map((planned) => planned.block.key);
    const members = [...near, block].sort((a, b) => order.indexOf(a.block.key) - order.indexOf(b.block.key));
    return [make(members, [block])];
  }
  const byKey = new Map(speaking.map((block) => [block.block.key, block]));
  const breaks = readBreaks(plan);
  const candidates = plan.blocks.map((planned): BlockTurns | null => {
    const block = byKey.get(planned.block.key);
    if (block === undefined || !misses.includes(block) || !groupable(block, room, plan.book)) return null;
    const breakAfter = breaks.get(planned.block.key);
    return { key: planned.block.key, reader: readerKey(block), ...block.turns, ...(breakAfter !== undefined ? { breakAfter } : {}) };
  });
  return groupReads(candidates, packing)
    .filter((group) => group.keys.length >= 2)
    .map((group) => {
      const members = group.keys.map((key) => byKey.get(key)!);
      return make(members, members);
    });
}

/**
 * The price's name for a chapter as it stands (R-17): its words and its cloud misses, each with
 * the reader and the direction it would be made under. The chapter's own press answers with
 * it; the book's run computes it per chapter from the preparation it priced, and the chapter's
 * run compares it against a fresh one before spending on the book's answer (codex on PR 1187).
 */
export function chapterPriceToken(worldId: string, productionId: string, chapterId: string, chapter: { version: number; hash: string }, misses: readonly Speaking[], groups: readonly PreparedGroup[] = []): string {
  return createHash("sha256")
    .update(["audiobook", worldId, productionId, chapterId, String(chapter.version), chapter.hash, ...misses.map(missIdentity), ...groups.map(groupIdentity)].join("\n"))
    .digest("hex");
}

/**
 * A grouped request's name (design turn 185): its blocks and the ones it keeps, each with the
 * words and direction a miss is named by, its packing and its turns — frozen into the job so a
 * later run finds a request already paid for, and part of the price's name so a regrouping asks.
 */
export function groupIdentity(group: PreparedGroup): string {
  return createHash("sha256")
    .update(JSON.stringify({ members: group.members.map(missIdentity), kept: group.kept.map((block) => block.block.key), packing: group.packing, turns: group.turns }))
    .digest("hex");
}

/** A grouped request already paid for, or still being made, found in the queue's durable rows (design turn 185, as `priorPartJob`). */
export function priorGroupJob(jobs: readonly Job[], identity: string): { kind: "landed" | "running"; job: Job } | null {
  const matching = jobs.filter((job) => job.target.kind === "voice-preview" && job.params["purpose"] === "audiobook" && job.params["hear"] !== true && job.params["group"] === identity);
  for (const job of [...matching].reverse()) {
    if (job.status === "succeeded" && job.landedFiles?.[0] !== undefined) return { kind: "landed", job };
    if (job.status !== "succeeded" && job.status !== "failed" && job.status !== "cancelled") return { kind: "running", job };
  }
  return null;
}

/**
 * What a miss is priced as: the block, the words it would send — their own hash, since the
 * chapter's names the prose and not the spoken heading, and a title renamed keeps the version
 * and the body hash while it lengthens the request (codex on PR 1187) — the reader, and the
 * direction.
 */
export function missIdentity(block: Speaking): string {
  // The plan is in it (design turn 182): a free credit's price is the paid price, so without it
  // a book answered on credit would read on, unasked, after the author switched to paid.
  return `${block.block.key}:${audiobookTextHash(block.text)}:${block.reader.provider}/${block.reader.model}/${block.reader.voiceId}:${block.takeHash ?? ""}:${JSON.stringify(block.quotes.map(q => [q.rateVersion, q.expectedMicroUsd, q.authorisedMicroUsd, q.tokenLimits, ...(q.plan !== undefined ? [q.plan] : [])]))}${block.compiledSpeechHash !== undefined ? `:${block.compiledSpeechHash}` : ""}${block.reference !== null ? `:${block.reference}` : ""}`;
}

/**
 * What a first read through a slot-keeping reader adds (SPEC-046 R-14, R-40), said on the read
 * that incurs it: a line a voice and vendor, keyed by id so two clones named alike are two
 * charges said twice, and nothing once the library records the slot. A vendor's clone charge is
 * not in the estimate, so this is the whole of its disclosure.
 */
export function firstReadNotices(clones: readonly { provider: string; voice: ClonedVoice; reference?: string | null }[]): string[] {
  const lines = new Map<string, string>();
  for (const { provider, voice, reference } of clones) {
    const notice = firstReadNotice(voice, provider, reference ?? undefined);
    if (notice !== null) lines.set(`${provider}\n${voice.id}`, `${voice.name} · ${notice}`);
  }
  return [...lines.values()];
}

/** The price's lines (R-17): every cloud voice the words would go to, once each, with its share. */
export function priceLines(misses: readonly Speaking[], priceOf: (block: Speaking) => number, names: VoiceNames = {}): { label: string; provider: string; characters: number; estimatedMicroUsd: number }[] {
  const voices = new Map<string, { label: string; provider: string; characters: number; estimatedMicroUsd: number }>();
  for (const block of misses) {
    const key = `${block.reader.provider}\n${block.reader.voiceId}`;
    const held = voices.get(key) ?? { label: voiceDisplayLabel(block.reader, names), provider: block.reader.provider, characters: 0, estimatedMicroUsd: 0 };
    held.characters += block.text.length;
    held.estimatedMicroUsd += priceOf(block);
    voices.set(key, held);
  }
  return [...voices.values()];
}

export async function runAudiobookChapter(deps: AudiobookRunDeps): Promise<void> {
  const { store, productionId, chapterId, narrator, signal, emit } = deps;
  let made = 0;
  let flaggedCount = 0;
  const finish = (outcome: Extract<AudiobookRunEvent, { type: "finished" }>["outcome"], extra: { record?: ChapterAudiobook; reason?: string } = {}) =>
    emit({ type: "finished", outcome, made, flagged: flaggedCount, ...extra });

  const transcriber = deps.wordTimes !== undefined;
  const preparation = await prepareChapter(store, productionId, chapterId, { narrator, models: deps.models, catalogue: deps.catalogue, transcriber, ...(deps.creditLeftMicroUsd !== undefined ? { creditLeftMicroUsd: deps.creditLeftMicroUsd } : {}), ...(deps.freePlanAllowance !== undefined ? { freePlanAllowance: deps.freePlanAllowance } : {}) }, deps.now, deps.only, undefined, deps.castFirst !== undefined ? { castPending: true } : {});
  if (preparation.kind !== "ready") {
    if (preparation.kind === "unavailable") emit({ type: "started", toMake: 0, blocks: 0 });
    finish(preparation.kind, { reason: preparation.reason });
    return;
  }
  const { plan, toMake, speaking, misses, clones, priceOf, estimate, asks, freePlan, groups, requests, perParagraph, toCast } = preparation.prepared;
  // Cast first (design turn 198, R-69): the price is asked as the cast stands, saying what will be
  // cast; once answered — or where nothing is asked — the paragraphs are cast and the read is
  // prepared again from the new cast, so it reads what the cast now says.
  if (deps.castFirst !== undefined && toCast.length > 0) {
    const priced = chapterPriceToken(deps.worldId, productionId, chapterId, plan.chapter, misses, groups);
    const asked = freePlan !== null ? createHash("sha256").update(`${priced}\n${JSON.stringify(freePlan.short)}`).digest("hex") : priced;
    if (asks && deps.confirmationToken !== asked) {
      emit({ type: "priced", characters: misses.reduce((sum, block) => sum + block.text.length, 0), estimatedMicroUsd: estimate, confirmationToken: asked, voices: priceLines(misses, priceOf, store.getBundle()), notices: firstReadNotices(clones), ...(freePlan !== null ? { freePlan: freePlan.short } : {}), ...(groups.length > 0 ? { requests, perParagraph } : {}), toCast: toCast.length });
      return;
    }
    const refused = await deps.castFirst();
    if (refused !== null) {
      finish("refused", { reason: refused });
      return;
    }
    const { castFirst: _castFirst, ...read } = deps;
    await runAudiobookChapter(read);
    return;
  }
  const partPrices = new Map(misses.map(block => [block, block.quotes.map(quote => quote.expectedMicroUsd)]));
  let record = preparation.prepared.record;
  const chapterFile = plan.chapter.file;
  // A grouped run counts its requests and names each group's blocks (design turn 185b): the
  // progress and the margin's brackets. A run that groups nothing says what it always said.
  const counted = groups.length > 0 ? { requests, groups: groups.map((group) => group.kept.map((block) => block.block.key)).filter((keys) => keys.length >= 2) } : {};
  emit({ type: "started", toMake: toMake.length, blocks: plan.blocks.length, ...counted });
  if (toMake.length === 0) {
    finish("read", { record });
    return;
  }
  // Google has said the day is used up: the run ends before a word is sent, as it would at the
  // first refusal, and says when the day resets — rather than sitting at `reading… 0 of 122`.
  if (freePlan?.allowance.reached === true) {
    finish("failed", { reason: freeLimitReason(freePlan.allowance), record });
    return;
  }
  const token = chapterPriceToken(deps.worldId, productionId, chapterId, plan.chapter, misses, groups);
  // The book's run priced every chapter at once (R-17), and its chapters are read on that
  // answer rather than asked again one by one — but only the chapter that was priced. Each
  // chapter is prepared afresh when the book reaches it, and prose, a reading or a voice
  // changed while earlier chapters were read can put cloud work in that preparation the card
  // never showed: that chapter is refused and left to its row rather than read on an answer
  // given for other words (codex on PR 1187). Judged before any consent is asked, so a chapter
  // that moved never puts a question under the book that the book's answer cannot follow.
  if (deps.priced !== undefined && asks && deps.priced !== token) {
    finish("refused", { reason: "moved since the book was priced" });
    return;
  }
  for (const reader of clones) {
    if (await deps.requireUploadConfirmation(reader)) return;
  }
  // The free day's question is part of what the chapter's own press answers (codex on PR 1475),
  // so `Read 1 now` left open across the reset is asked again. A book's chapters keep the plain
  // token: the day moves as the book reads, and the book's answer covered it.
  const answer = freePlan !== null ? createHash("sha256").update(`${token}\n${JSON.stringify(freePlan.short)}`).digest("hex") : token;
  if (asks && deps.priced === undefined && deps.confirmationToken !== answer) {
    emit({ type: "priced", characters: misses.reduce((sum, block) => sum + block.text.length, 0), estimatedMicroUsd: estimate, confirmationToken: answer, voices: priceLines(misses, priceOf, store.getBundle()), notices: firstReadNotices(clones), ...(freePlan !== null ? { freePlan: freePlan.short } : {}), ...(groups.length > 0 ? { requests, perParagraph } : {}) });
    return;
  }

  const landingDir = audiobookLanding(productionId, chapterFile);
  const progress = (block: Speaking, outcome: "made" | "adopted" | "flagged", reason?: string) =>
    emit({ type: "progress", block: block.block.key, outcome, ...(reason !== undefined ? { reason } : {}), made, toMake: toMake.length });
  // The loudness each filed take was brought to (design turn 185), by artifact, for its take.
  const loudnessOf = new Map<string, AudiobookLoudness>();
  const file = async (block: Speaking, sourcePath: string, input: { jobId?: string; parts: number; estimatedMicroUsd: number; costMicroUsd: number | null; adopted?: true; grouped?: AudiobookGrouped; loudness?: AudiobookLoudness }): Promise<ArtifactSidecar> => {
    // One loudness for every take (design turn 185): a WAV take alone is measured and gained
    // to the target as it is filed, and a groupable reader's is trimmed to a grouped take's
    // pause first, so a block read alone does not stand out between cuts that share theirs. A
    // grouped cut arrives gained already, by its request's measure. A file this cannot read as
    // 16-bit PCM is filed as it came. Any reader's take loses a runaway tail: a solo read can run
    // on past its words as a grouped one did.
    let leveled: { path: string; loudness: AudiobookLoudness } | null = null;
    if (input.loudness === undefined && block.format === "wav") {
      try {
        const source = readSpeechWav(new Uint8Array(await readFile(toExtendedLength(sourcePath))));
        const trimmed = readsGrouped(block.model, transcriber, plan.book) ? trimSpeech(source) : dropRunawayTail(source);
        const normal = normaliseSpeech(trimmed);
        if (normal.loudness.gainDb === 0 && trimmed === source) leveled = { path: sourcePath, loudness: normal.loudness };
        else {
          const path = join(store.dir, fromPortable(`${landingDir}/${block.block.key.replace(/[^a-z0-9]+/gi, "-")}-level.wav`));
          await atomicWriteFile(path, writeSpeechWav(normal.pcm));
          leveled = { path, loudness: normal.loudness };
        }
      } catch {
        leveled = null;
      }
    }
    const loudness = input.loudness ?? (recordsLoudness(store) ? leveled?.loudness : undefined);
    const kept = record.takes[block.block.key];
    const remakeOf = kept !== undefined && (plan.present.has(kept.artifactId) || block.remake) ? kept.artifactId : undefined;
    const generation: ArtifactAudiobookGeneration = {
      source: "audiobook",
      ...(input.jobId !== undefined ? { jobId: input.jobId } : {}),
      productionId,
      chapterId: plan.chapter.id,
      chapterVersion: plan.chapter.version,
      block: block.block.key,
      paragraph: block.block.paragraph,
      textHash: audiobookTextHash(block.text),
      provider: block.reader.provider,
      model: block.reader.model,
      voiceId: block.reader.voiceId,
      ...(block.reader.label !== undefined ? { voiceLabel: block.reader.label } : {}),
      ...(block.sheet !== undefined ? { sheetId: block.sheet } : {}),
      ...(block.sheetVersion !== undefined ? { sheetVersion: block.sheetVersion } : {}),
      parts: input.parts,
      characters: block.text.length,
      estimatedMicroUsd: input.estimatedMicroUsd,
      costMicroUsd: input.costMicroUsd,
      // The direction lives on the take and never on the chapter (R-8): its name, its delivery,
      // and the digest of what the reader was actually sent.
      ...(block.direction !== null
        ? {
            directionHash: block.direction.hash,
            ...(block.direction.delivery !== undefined ? { delivery: block.direction.delivery } : {}),
            providerTextHash: audioHash(Buffer.from(block.direction.rendered)),
          }
        : block.takeHash !== undefined
          ? { directionHash: block.takeHash }
          : {}),
      // A block whose kept take is still on the shelf, or that is made again on purpose, is
      // another take beside that one (SPEC-047 R-4, issue 1190), named for it: filed as its
      // own artifact, found again by a retry, and never the older take of the same words
      // returned for a retired selection (codex on PR 1193). A block with no take, or whose
      // take's media is gone and is not asked for again, takes the shelf's own rule instead —
      // the same words, voice and direction already filed are the take it made before the
      // record could say so, or the sidecar its restored file belongs under.
      ...(remakeOf !== undefined ? { remakeOf } : {}),
      ...(input.grouped !== undefined ? { grouped: input.grouped } : {}),
      ...(loudness !== undefined ? { loudness } : {}),
    };
    try {
      const artifact = await fileGeneratedArtifact(store, {
        sourcePath: leveled?.path ?? sourcePath,
        generation,
        production: productionId,
        ...(deps.mediaProbe !== undefined ? { mediaProbe: deps.mediaProbe } : {}),
        abandoned: () => signal.aborted,
      });
      if (loudness !== undefined) loudnessOf.set(artifact.id, loudness);
      return artifact;
    } finally {
      if (leveled !== null && leveled.path !== sourcePath) await unlink(toExtendedLength(leveled.path)).catch(() => {});
    }
  };
  const keep = async (block: Speaking, artifact: ArtifactSidecar, input: { parts: number; estimatedMicroUsd: number; costMicroUsd: number | null; adopted?: true; grouped?: AudiobookGrouped }) => {
    const loudness = loudnessOf.get(artifact.id);
    const substituted = block.substitutedNow ?? block.substituted;
    const take: AudiobookTake = {
      artifactId: artifact.id,
      textHash: audiobookTextHash(block.text),
      reader: block.reader,
      ...(substituted !== undefined ? { assigned: block.assigned, substituted } : {}),
      ...(block.sheet !== undefined ? { sheet: block.sheet } : {}),
      format: block.format,
      characters: block.text.length,
      parts: input.parts,
      estimatedMicroUsd: input.estimatedMicroUsd,
      costMicroUsd: input.costMicroUsd,
      ...(input.adopted !== undefined ? { adopted: true as const } : {}),
      ...(block.takeHash !== undefined ? { directionHash: block.takeHash } : {}),
      ...(block.noteHeld === true ? { noteHeld: true as const } : {}),
      ...(input.grouped !== undefined ? { grouped: input.grouped } : {}),
      ...(loudness !== undefined ? { loudness } : {}),
      madeAt: deps.now(),
    };
    await write((current) => {
      const { [block.block.key]: _dropped, ...flags } = current.flags;
      // A direction carried to these words stays with the take made under it, unless one written for these very words arrived while the run went.
      const direction = block.carried !== undefined && current.direction[block.block.key]?.textHash !== block.carried.textHash ? { ...current.direction, [block.block.key]: block.carried } : current.direction;
      return { ...current, chapterVersion: plan.chapter.version, hash: plan.chapter.hash, updatedAt: deps.now(), takes: { ...current.takes, [block.block.key]: take }, flags, direction };
    });
    made += 1;
  };
  // The record the run holds is the record on disk (codex on PR 1180): every write reads the
  // file afresh under the chapter's lane and merges this block's take or flag into it, so a
  // direction set or a card accepted while the run goes is kept, not overwritten from the
  // run's snapshot (codex on PR 1186); a write that failed — the claim lost, an I/O fault —
  // leaves the record as it was, so the finished event never carries a take the file does not.
  const write = async (mutate: (current: ChapterAudiobook) => ChapterAudiobook) => {
    try {
      record = await updateAudiobook(store, productionId, plan.chapter, mutate);
    } catch (err) {
      throw new RecordWriteError(err instanceof Error ? err.message : String(err));
    }
  };
  const flag = async (block: Speaking, reason: string) => {
    await write((current) => ({ ...current, updatedAt: deps.now(), flags: { ...current.flags, [block.block.key]: { reason, at: deps.now() } } }));
    flaggedCount += 1;
    progress(block, "flagged", reason);
  };

  let jobInFlight: string | null = null;
  const onAbort = () => {
    if (jobInFlight !== null) void deps.cancelJob(jobInFlight).catch(() => {});
  };

  /**
   * One grouped request (design turn 185): sent, or found already paid for; its audio heard on
   * this machine with word times and cut at the middle of each pause between blocks; the whole
   * request measured once and every cut gained by it; each cut that matches its words filed as
   * its block's take with its share of the request's cost by characters, and one that does not
   * filed on the shelf and flagged with what was heard. A request refused for the day ends the
   * run with its blocks unread, for the next press to group again.
   */
  const groupOf = new Map<Speaking, PreparedGroup>();
  for (const group of groups) for (const block of group.kept) groupOf.set(block, group);
  let requestAt = 0;
  const readGroup = async (group: PreparedGroup, settled: Set<string>): Promise<{ ended: string } | null> => {
    requestAt += 1;
    const keys = group.members.map((block) => block.block.key);
    emit({ type: "request", index: requestAt, of: requests, keys: group.kept.map((block) => block.block.key) });
    const identity = groupIdentity(group);
    const first = group.kept[0]!;
    let prior = priorGroupJob(deps.findJobs(), identity);
    if (prior?.kind === "landed") {
      const stillThere = await readFile(toExtendedLength(join(store.dir, fromPortable(prior.job.landedFiles![0]!)))).then(() => true).catch(() => false);
      if (!stillThere) prior = null;
    }
    let job: Job;
    if (prior?.kind === "landed") job = prior.job;
    else {
      let jobId = prior?.job.id;
      if (jobId === undefined) {
        const text = groupedText(group.turns);
        const queued = await deps.enqueue([{
          worldId: deps.worldId,
          productionId,
          target: { kind: "voice-preview", id: `${first.sheet ?? "narrator"}/${group.model.provider}/${group.model.id}/${first.reader.voiceId}` },
          capability: "voice-tts",
          provider: group.model.provider,
          model: group.model.id,
          params: {
            voiceId: first.reader.voiceId,
            text,
            turns: group.turns,
            audioFormat: "wav",
            purpose: "audiobook",
            productionId,
            chapterId: plan.chapter.id,
            // Activity leads to the first block kept; `blocks` names every block it carries.
            block: first.block.key,
            blocks: keys,
            group: identity,
            packing: group.packing,
            characterCount: text.length,
            sheetVersion: plan.chapter.version,
          },
          estimatedMicroUsd: group.quote.expectedMicroUsd,
          landing: { dir: landingDir, name: `group-${first.block.key.replace(/[^a-z0-9]+/gi, "-")}-${keys.length}.wav` },
        }]);
        jobId = queued.jobIds[0];
        if (jobId === undefined) throw new Error(queued.reason ?? "the voice job could not be queued");
      }
      jobInFlight = jobId;
      job = await deps.waitForJob(jobId);
      jobInFlight = null;
    }
    if (job.status !== "succeeded" || job.landedFiles?.[0] === undefined) {
      if (job.status === "cancelled" || signal.aborted) return null;
      // The day's refusal ends the run before any of the request's blocks is flagged: they stay
      // unread, and the next press groups them again.
      const ended = job.status === "failed" ? freePlanFailure(job.error) : null;
      if (ended !== null) return { ended };
      if (job.status === "failed" && job.error?.includes(GOOGLE_DAILY_LIMIT)) return { ended: GOOGLE_DAILY_LIMIT };
      for (const block of group.kept) {
        await flag(block, "the voice job failed · open Activity for details");
        settled.add(block.block.key);
      }
      return null;
    }
    const landed = join(store.dir, fromPortable(job.landedFiles[0]));
    const bytes = new Uint8Array(await readFile(toExtendedLength(landed)));
    if (deps.wordTimes === undefined) {
      for (const block of group.kept) {
        await flag(block, "split unavailable · no local transcriber");
        settled.add(block.block.key);
      }
      return null;
    }
    const pcm = readSpeechWav(bytes);
    const heard = await deps.wordTimes(bytes, signal);
    if (signal.aborted) return null;
    const cuts = splitRequest(group.members.map((block) => ({ key: block.block.key, text: block.text, ...(block.sounds === true ? { sounds: true } : {}) })), heard.words, heard.seconds, (start, end) => audioHash(writeSpeechWav(sliceSpeech(pcm, start, end))), splitAudio(pcm), preparation.prepared.lexicon);
    // One request is one performance: measured whole and gained as one, so a whisper inside it
    // stays a whisper beside the lines around it.
    const level = normaliseSpeech(pcm);
    const actual = await deps.actualCost(job.id);
    const characters = group.kept.map((block) => block.text.length);
    const costs = shareByCharacters(actual, characters);
    const estimates = shareByCharacters(job.estimatedMicroUsd, characters) as number[];
    for (const [index, block] of group.kept.entries()) {
      const cut = cuts.find((candidate) => candidate.key === block.block.key)!;
      const piece = applyGain(sliceSpeech(pcm, cut.start, cut.end), level.loudness.gainDb);
      const loudness: AudiobookLoudness = { ...level.loudness, peakDbfs: samplePeak(piece) === null ? null : Math.round(samplePeak(piece)! * 100) / 100 };
      const grouped: AudiobookGrouped = { request: job.id, blocks: keys, packing: group.packing, offsetSec: Math.round(cut.start * 1000) / 1000, durationSec: Math.max(0.001, Math.round((cut.end - cut.start) * 1000) / 1000) };
      const path = join(store.dir, fromPortable(`${landingDir}/${block.block.key.replace(/[^a-z0-9]+/gi, "-")}-grouped.wav`));
      await atomicWriteFile(path, writeSpeechWav(piece));
      const provenance = { jobId: job.id, parts: 1, estimatedMicroUsd: estimates[index]!, costMicroUsd: costs[index]!, grouped, loudness };
      const artifact = await file(block, path, provenance);
      await unlink(toExtendedLength(path)).catch(() => {});
      settled.add(block.block.key);
      if (cut.matched) {
        await keep(block, artifact, provenance);
        // A request that ran long is said on its takes' progress; the record keeps no note, which
        // would be another strict field and another world schema for what the cut already dropped.
        progress(block, "made", cut.longTail ? LONG_TAIL : undefined);
      } else {
        const split: AudiobookSplitFlag = { artifactId: artifact.id, heard: cut.heard.slice(0, 4000), request: job.id, offsetSec: grouped.offsetSec, durationSec: grouped.durationSec };
        const reason = `${SPLIT_DID_NOT_MATCH} · ${cut.longTail ? `${LONG_TAIL} · ` : ""}\u201c${cut.heard.length > 80 ? `${cut.heard.slice(0, 79)}\u2026` : cut.heard}\u201d`;
        await write((current) => ({ ...current, updatedAt: deps.now(), flags: { ...current.flags, [block.block.key]: { reason, at: deps.now(), split } } }));
        flaggedCount += 1;
        progress(block, "flagged", reason);
      }
    }
    await unlink(toExtendedLength(landed)).catch(() => {});
    return null;
  };

  signal.addEventListener("abort", onAbort, { once: true });
  try {
    for (const block of speaking) {
      if (signal.aborted) break;
      const group = groupOf.get(block);
      if (group !== undefined) {
        if (group.kept[0] !== block) continue;
        const settled = new Set<string>();
        try {
          const read = await readGroup(group, settled);
          if (read !== null) {
            finish("failed", { reason: read.ended, record });
            return;
          }
        } catch (err) {
          if (signal.aborted) break;
          const message = err instanceof Error ? err.message : String(err);
          if (err instanceof RecordWriteError) {
            finish("failed", { reason: message, record });
            return;
          }
          try {
            for (const kept of group.kept) if (!settled.has(kept.block.key)) await flag(kept, message);
          } catch (flagErr) {
            finish("failed", { reason: flagErr instanceof Error ? flagErr.message : String(flagErr), record });
            return;
          }
        }
        continue;
      }
      if (misses.includes(block)) requestAt += block.parts.length;
      try {
        // A direction this reader cannot express is refused in one clause (R-9), never sent
        // and never made neutral: the block is flagged, and the panel says which control.
        if (block.refusal !== undefined) {
          await flag(block, block.refusal);
          continue;
        }
        if (block.local && (block.direction !== null || block.remake)) {
          // A directed local block is a fresh synthesis with the direction's settings (R-6):
          // the speech cache keys on the words alone, so it can neither serve nor keep one. So
          // is a block made again unchanged (issue 1190): the cache would hand back the very
          // take being remade.
          // Parts that share their settings are one synthesis, as a directed block always was;
          // a marker made in parts changes them mid-block (R-41), so each part is its own and
          // the parts are joined here.
          const perPart = block.direction?.perPart ?? [];
          const uniform = perPart.every((part) => JSON.stringify(part.voiceSettings) === JSON.stringify(perPart[0]?.voiceSettings));
          let made: { audio: Uint8Array; parts: number };
          if (uniform || block.format === "flac") {
            made = await deps.synthesizeLocal(block.reader.voiceId, block.direction?.rendered ?? block.text, block.direction?.voiceSettings ?? {}, signal);
          } else {
            const pieces: Uint8Array[] = [];
            let count = 0;
            for (const [index, part] of block.parts.entries()) {
              if (signal.aborted) break;
              const piece = await deps.synthesizeLocal(block.reader.voiceId, part, perPart[index]?.voiceSettings ?? {}, signal);
              pieces.push(piece.audio);
              count += piece.parts;
            }
            made = { audio: joinSpeech(pieces, block.format), parts: count };
          }
          if (signal.aborted) break;
          const sourcePath = join(store.dir, fromPortable(`${landingDir}/${block.block.key.replace(/[^a-z0-9]+/gi, "-")}-directed.${block.format}`));
          await atomicWriteFile(sourcePath, made.audio);
          const artifact = await file(block, sourcePath, { parts: made.parts, estimatedMicroUsd: 0, costMicroUsd: 0 });
          await keep(block, artifact, { parts: made.parts, estimatedMicroUsd: 0, costMicroUsd: 0 });
          await unlink(toExtendedLength(sourcePath)).catch(() => {});
          progress(block, "made");
          continue;
        }
        if (block.local) {
          // Local speech lands in the speech cache as it always has; the take is a copy of it
          // filed as the production's own, so the cache can be emptied without losing the book.
          // A file the cache already held — a page read, an earlier run — is adopted (R-19) and
          // says so; a made one records the requests it took (codex on PR 1180).
          const result = await deps.localSpeech(block.reader.voiceId, block.text, signal);
          const provenance = { parts: result.parts, estimatedMicroUsd: 0, costMicroUsd: 0, ...(result.cached ? { adopted: true as const } : {}) };
          const artifact = await file(block, join(store.dir, fromPortable(result.file)), provenance);
          await keep(block, artifact, provenance);
          progress(block, result.cached ? "adopted" : "made");
          continue;
        }
        if (block.cacheFile !== null && !misses.includes(block)) {
          const artifact = await file(block, join(store.dir, fromPortable(block.cacheFile)), { parts: 1, estimatedMicroUsd: 0, costMicroUsd: 0, adopted: true });
          await keep(block, artifact, { parts: 1, estimatedMicroUsd: 0, costMicroUsd: 0, adopted: true });
          progress(block, "adopted");
          continue;
        }
        if (block.parts.length > 1 && block.format === "flac") {
          await flag(block, "over the reader's cap · flac parts cannot be joined");
          continue;
        }
        // One request a part, in order, each awaited: a local reader is one job at a time on
        // this machine and a cloud reader is bounded by the queue, and the record is written
        // only once the whole block is a file.
        const landed: string[] = [];
        let estimated = 0;
        let cost: number | null = 0;
        let firstJob: string | undefined;
        const textHash = audiobookTextHash(block.text);
        const identity: PartIdentity = {
          productionId,
          chapterId: plan.chapter.id,
          block: block.block.key,
          textHash,
          provider: block.model.provider,
          model: block.model.id,
          voiceId: block.reader.voiceId,
          parts: block.parts.length,
          directionHash: block.takeHash ?? null,
          ...(block.compiledSpeechHash !== undefined ? { compiledSpeechHash: block.compiledSpeechHash } : {}),
          reference: block.reference,
        };
        for (const [index, part] of block.parts.entries()) {
          if (signal.aborted) break;
          // Paid for already, or on its way: the queue's rows outlive this process, so a part
          // whose job landed before the take was filed is filed now, and one still being made
          // is waited for, before another request is asked for (R-16).
          let prior = priorPartJob(deps.findJobs(), identity, index);
          if (prior?.kind === "landed") {
            const stillThere = await readFile(toExtendedLength(join(store.dir, fromPortable(prior.job.landedFiles![0]!)))).then(() => true).catch(() => false);
            if (!stillThere) prior = null;
          }
          let job: Job;
          if (prior !== null) {
            firstJob ??= prior.job.id;
            if (prior.kind === "running") {
              jobInFlight = prior.job.id;
              job = await deps.waitForJob(prior.job.id);
              jobInFlight = null;
            } else {
              job = prior.job;
            }
          } else {
            const input: EnqueueInput = {
              worldId: deps.worldId,
              productionId,
              target: { kind: "voice-preview", id: `${block.sheet ?? "narrator"}/${block.model.provider}/${block.model.id}/${block.reader.voiceId}` },
              capability: "voice-tts",
              provider: block.model.provider,
              model: block.model.id,
              params: {
                voiceId: block.reader.voiceId,
                text: part,
                audioFormat: block.format,
                purpose: "audiobook",
                productionId,
                chapterId: plan.chapter.id,
                block: block.block.key,
                textHash,
                part: index,
                parts: block.parts.length,
                ...(block.compiledSpeechHash !== undefined ? { compiledSpeechHash: block.compiledSpeechHash } : {}),
                // The recording this part is made from, for `priorPartJob`; the coordinator's and
                // never a reader's — the dispatcher strips it before submission (SPEC-046 R-39).
                ...(block.reference !== null ? { voiceClipHash: block.reference } : {}),
                characterCount: part.length,
                sheetVersion: plan.chapter.version,
                // The direction rides as the performance path's does (R-8): the words already
                // decorated, the settings beside them, the sentence where the row takes one, and
                // the direction's name so the job is this direction's and no other's.
                ...(block.direction !== null
                  ? {
                      voiceSettings: block.direction.perPart[index]?.voiceSettings ?? block.direction.voiceSettings,
                      directionHash: block.direction.hash,
                      ...((block.direction.perPart[index]?.instructions ?? block.direction.instructions) !== undefined
                        ? { instructions: block.direction.perPart[index]?.instructions ?? block.direction.instructions }
                        : {}),
                    }
                  : {}),
              },
              estimatedMicroUsd: partPrices.get(block)![index]!,
              landing: { dir: landingDir, name: `${block.block.key.replace(/[^a-z0-9]+/gi, "-")}-${index}.${block.format}` },
              ...(block.clone !== null ? { voiceReference: true } : {}),
            };
            const queued = await deps.enqueue([input]);
            const jobId = queued.jobIds[0];
            if (jobId === undefined) throw new Error(queued.reason ?? "the voice job could not be queued");
            firstJob ??= jobId;
            jobInFlight = jobId;
            job = await deps.waitForJob(jobId);
            jobInFlight = null;
          }
          const jobId = job.id;
          if (job.status !== "succeeded" || job.landedFiles?.[0] === undefined) {
            const ended = job.status === "failed" ? freePlanFailure(job.error) : null;
            // The flag says the limit plainly; the run's ending keeps the reset Google named.
            if (ended !== null) throw new FreePlanEnded(ended.startsWith(GOOGLE_FREE_LIMIT) ? GOOGLE_FREE_LIMIT : ended, ended);
            // A paid key's own day ends the run too (codex on PR 1475): flagged and passed over,
            // a 122-block chapter sent 122 requests to the same refusal and ended `read`.
            if (job.status === "failed" && job.error?.includes(GOOGLE_DAILY_LIMIT)) throw new FreePlanEnded(GOOGLE_DAILY_LIMIT);
            throw new Error(job.status === "cancelled" ? "stopped" : "the voice job failed · open Activity for details");
          }
          landed.push(job.landedFiles[0]);
          estimated += job.estimatedMicroUsd;
          const actual = await deps.actualCost(jobId);
          cost = cost === null || actual === null ? null : cost + actual;
        }
        if (signal.aborted) break;
        let sourcePath: string;
        if (landed.length === 1) {
          sourcePath = join(store.dir, fromPortable(landed[0]!));
        } else {
          const bytes = await Promise.all(landed.map(async (rel) => new Uint8Array(await readFile(toExtendedLength(join(store.dir, fromPortable(rel)))))));
          const joined = joinSpeech(bytes, block.format);
          sourcePath = join(store.dir, fromPortable(`${landingDir}/${block.block.key.replace(/[^a-z0-9]+/gi, "-")}-joined.${block.format}`));
          await atomicWriteFile(sourcePath, joined);
        }
        const artifact = await file(block, sourcePath, { ...(firstJob !== undefined ? { jobId: firstJob } : {}), parts: landed.length, estimatedMicroUsd: estimated, costMicroUsd: cost });
        await keep(block, artifact, { parts: landed.length, estimatedMicroUsd: estimated, costMicroUsd: cost });
        for (const rel of landed) await unlink(toExtendedLength(join(store.dir, fromPortable(rel)))).catch(() => {});
        if (landed.length > 1) await unlink(toExtendedLength(sourcePath)).catch(() => {});
        progress(block, "made");
      } catch (err) {
        if (signal.aborted) break;
        const message = err instanceof Error ? err.message : String(err);
        // The record could not be written at all: the world's claim is gone, or it closed under
        // the run. Nothing more can be kept, so the run ends rather than flagging every block.
        if (err instanceof RecordWriteError) {
          finish("failed", { reason: message, record });
          return;
        }
        try {
          await flag(block, message);
        } catch (flagErr) {
          finish("failed", { reason: flagErr instanceof Error ? flagErr.message : String(flagErr), record });
          return;
        }
        // A free plan's end stops the chapter (design turn 182): the day's limit fails every
        // later read the same way, and a billed key must not keep reading on a free price.
        if (err instanceof FreePlanEnded) {
          finish("failed", { reason: err.reason, record });
          return;
        }
      }
    }
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
  if (signal.aborted) {
    finish("stopped", { record });
    return;
  }
  finish("read", { record });
}

/**
 * A grouped read's cut whose words did not match, kept as the block's take as it is (design turn
 * 185c): the author heard it and keeps it. Kept only while the flag stands, its cut is still on
 * the shelf, and the block still says the words it was cut for; the take is the cut's, with the
 * request, its place and its loudness, and the flag goes.
 */
export async function keepSplitTake(store: WorldStore, productionId: string, chapterId: string, block: string, narrator: AudiobookReader, now: () => string): Promise<ChapterAudiobook> {
  const plan = await planAudiobook(store, productionId, chapterId, { narrator });
  const planned = plan.blocks.find((candidate) => candidate.block.key === block);
  if (planned === undefined) throw new Error("that block is no longer in the chapter");
  return updateAudiobook(store, productionId, plan.chapter, (current) => {
    const split = current.flags[block]?.split;
    if (split === undefined) throw new Error("nothing to keep · the block is not flagged");
    const artifact = store.getBundle().artifacts.find((candidate) => candidate.id === split.artifactId && candidate.retiredAt === undefined);
    const g = artifact?.generation;
    if (artifact === undefined || g?.source !== "audiobook") throw new Error("the cut is no longer on the shelf");
    if (g.textHash !== audiobookTextHash(normalizeSpeechText(planned.block.text))) throw new Error("the words changed · read the block again");
    const reader: AudiobookReader = { provider: g.provider, model: g.model, voiceId: g.voiceId, ...(g.voiceLabel !== undefined ? { label: g.voiceLabel } : {}) };
    const standIn = planned.assigned.provider !== reader.provider || planned.assigned.model !== reader.model || planned.assigned.voiceId !== reader.voiceId;
    const take: AudiobookTake = {
      artifactId: artifact.id,
      textHash: g.textHash,
      reader,
      ...(standIn ? { assigned: planned.assigned, substituted: planned.substituted ?? "voice unavailable" } : {}),
      ...(g.sheetId !== undefined ? { sheet: g.sheetId } : {}),
      format: "wav",
      characters: g.characters,
      parts: g.parts,
      estimatedMicroUsd: g.estimatedMicroUsd,
      costMicroUsd: g.costMicroUsd,
      ...(g.directionHash !== undefined ? { directionHash: g.directionHash } : {}),
      ...(g.grouped !== undefined ? { grouped: g.grouped } : {}),
      ...(g.loudness !== undefined ? { loudness: g.loudness } : {}),
      madeAt: now(),
    };
    const { [block]: _kept, ...flags } = current.flags;
    return { ...current, updatedAt: now(), takes: { ...current.takes, [block]: take }, flags };
  });
}
