import { createHash } from "node:crypto";
import { readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import {
  CLONED_VOICE_PROVIDER,
  audiobookDirectionFor,
  audiobookDirectionHash,
  audiobookTextHash,
  billableCharacters,
  estimateMicroUsd,
  normalizeSpeechText,
  voiceFormatForModel,
  voiceSourceFor,
  type ArtifactAudiobookGeneration,
  type ArtifactSidecar,
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
import { clipFor, clipHashOf } from "../voice/library.js";
import { cachedVoiceAudioLooksRight, joinSpeech, speechCacheFile, splitForSpeech } from "../voice/service.js";
import { atomicWriteFile } from "../world/atomic.js";
import { fromPortable, toExtendedLength } from "../world/paths.js";
import type { WorldStore } from "../world/store.js";
import { audioHash } from "../audio/qc.js";
import { audiobookLanding, castRefusal, checkDirection, effectiveReader, emptyAudiobook, planAudiobook, readerLanguage, updateAudiobook, type AudiobookPlan, type PlannedBlock } from "./audiobook.js";

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
  | { type: "started"; toMake: number; blocks: number }
  | { type: "priced"; characters: number; estimatedMicroUsd: number; confirmationToken: string; voices: { label: string; provider: string; characters: number; estimatedMicroUsd: number }[] }
  | { type: "progress"; block: string; outcome: "made" | "adopted" | "flagged"; reason?: string; made: number; toMake: number }
  | { type: "finished"; outcome: "read" | "stopped" | "unavailable" | "failed" | "refused"; made: number; flagged: number; record?: ChapterAudiobook; reason?: string };

export interface AudiobookRunDeps {
  store: WorldStore;
  worldId: string;
  productionId: string;
  chapterId: string;
  models: readonly ManifestModel[];
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
  /** That recording's hash (codex on PR 1221): a re-recorded clone is another voice to the cache and to a prior job. */
  reference: string | null;
  text: string;
  /**
   * The block's direction as it stands, mapped for this reader (R-6, R-8): what the reader is
   * sent — the words with the tags in — and the settings beside them; null for a block with
   * none. A direction the reader cannot express is `refusal` instead, and the block is flagged
   * with it rather than made neutral in silence (R-9).
   */
  direction: { hash: string; delivery: string; rendered: string; voiceSettings: Record<string, number>; instructions?: string } | null;
  refusal?: string;
  /** What the reader is sent, in parts each within its cap (R-5): the rendered text under a direction, the words otherwise. */
  parts: string[];
  format: Format;
  cacheFile: string | null;
  substitutedNow?: AudiobookSubstitution;
  /**
   * `Make again` on a block that is made and unchanged (R-30, issue 1190): another performance
   * of the same words, so neither cache — the speech cache nor a cloud line's — may stand in
   * for the reading, and the take goes beside the kept one rather than in its place (R-4).
   */
  remake: boolean;
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
  /** A cloned reader's recording, by hash, or null for a preset: a part made from an older recording is not this part (codex on PR 1221). */
  reference: string | null;
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
      job.params["productionId"] === identity.productionId &&
      job.params["chapterId"] === identity.chapterId &&
      job.params["block"] === identity.block &&
      job.params["textHash"] === identity.textHash &&
      job.provider === identity.provider &&
      job.model === identity.model &&
      job.params["voiceId"] === identity.voiceId &&
      job.params["part"] === part &&
      job.params["parts"] === identity.parts &&
      (job.params["directionHash"] ?? null) === identity.directionHash &&
      (job.params["reference"] ?? null) === identity.reference,
  );
  for (const job of [...matching].reverse()) {
    if (job.status === "succeeded" && job.landedFiles?.[0] !== undefined) return { kind: "landed", job };
    if (job.status !== "succeeded" && job.status !== "failed" && job.status !== "cancelled") return { kind: "running", job };
  }
  return null;
}

/** What a run, the book's run and the door share of a chapter: its plan, its record, and every block to make with the reader that will speak it. */
export interface PreparedChapter {
  plan: AudiobookPlan;
  record: ChapterAudiobook;
  toMake: PlannedBlock[];
  speaking: Speaking[];
  /** The cloud blocks the cache does not hold: what a press would pay for (R-17). */
  misses: Speaking[];
  /** The cloned voices among the misses, hosted readers' first and the engine's last (R-17). */
  clones: { provider: string; voice: ClonedVoice }[];
  priceOf: (block: Speaking) => number;
  estimate: number;
}

export type ChapterPreparation = { kind: "ready"; prepared: PreparedChapter } | { kind: "refused"; reason: string; plan: AudiobookPlan } | { kind: "unavailable"; reason: string };

export interface ReadingRoom {
  narrator: AudiobookReader;
  models: readonly ManifestModel[];
  catalogue: readonly VoiceCandidate[];
}

/**
 * A chapter as a press sees it (R-16, R-17): the plan read once, every block to make with the
 * reader that will actually speak it, its direction mapped for that reader or refused, the
 * parts the cap makes of it, whether the cache already holds it, and what the rest would cost.
 * The run, the book's run and the door read the same answer, so a price the door shows is the
 * price the run asks for.
 */
export async function prepareChapter(store: WorldStore, productionId: string, chapterId: string, room: ReadingRoom, now: () => string, only?: readonly string[]): Promise<ChapterPreparation> {
  const plan = await planAudiobook(store, productionId, chapterId, { narrator: room.narrator });
  // Under `cast` a run needs a cast that is current (R-12): a line whose speaker the cast cannot
  // name would otherwise be made in the narrator's voice without the door having said so.
  const castTrouble = castRefusal(plan);
  if (castTrouble !== null) return { kind: "refused", reason: castTrouble, plan };
  // An unreadable record is no record: the takes it named are still on the shelf, and a run
  // that cannot read which block each was for makes the chapter afresh rather than guessing.
  const record: ChapterAudiobook =
    plan.record === null || plan.record === "unreadable"
      ? emptyAudiobook(plan.chapter.version, plan.chapter.hash, now())
      : { ...plan.record, takes: { ...plan.record.takes }, flags: { ...plan.record.flags } };
  const toMake = only !== undefined ? plan.blocks.filter((planned) => only.includes(planned.block.key)) : plan.blocks.filter((planned) => planned.state !== "made");
  const clonedVoices = store.getBundle().clonedVoices ?? [];
  // Each cloned reader's recording, hashed once for the chapter (codex on PR 1221): the hash
  // keys its cache files and names its parts' jobs, so a voice re-recorded since is read afresh.
  const references = new Map<string, string | null>();
  const referenceOf = async (voice: ClonedVoice): Promise<string | null> => {
    if (!references.has(voice.id)) {
      const clip = await clipFor(store, voice);
      references.set(voice.id, clip === null ? null : clipHashOf(clip));
    }
    return references.get(voice.id)!;
  };

  // Who actually speaks each block (R-12): the one rule the direction was verified against.
  const speaking: Speaking[] = [];
  for (const planned of toMake) {
    const speaks = await effectiveReader(store, planned.assigned, room);
    if (speaks === null) return { kind: "unavailable", reason: "the narrator's voice model is not in the manifest" };
    const { reader, model, substitutedNow } = speaks;
    const text = normalizeSpeechText(planned.block.text);
    // The direction that stands for these words, mapped for the reader that will speak — the
    // narrator's row when the narrator stands in (R-12) — so a control that reader cannot
    // express is refused here, in one clause, and never sent (R-9).
    const held = audiobookDirectionFor(record, planned.block);
    const language = readerLanguage(clonedVoices, reader);
    const cap = model.limits.maxPromptChars;
    let direction: Speaking["direction"] = null;
    let refusal: string | undefined;
    let parts: string[];
    if (held !== null) {
      const check = checkDirection(planned.block.text, held.plan, model, language);
      if (check.ok) {
        direction = {
          hash: audiobookDirectionHash(held.plan),
          delivery: held.plan.delivery,
          rendered: check.parts.join(" "),
          voiceSettings: check.mapped.voiceSettings,
          ...(check.mapped.instructions !== undefined ? { instructions: check.mapped.instructions } : {}),
        };
        parts = check.parts;
      } else {
        refusal = check.reason;
        parts = [text];
      }
    } else parts = cap !== undefined && text.length > cap ? splitForSpeech(text, cap) : [text];
    const local = reader.provider === "kokoro";
    const format = voiceFormatForModel(model);
    const source = voiceSourceFor(clonedVoices, reader.provider, reader.model, reader.voiceId);
    const reference = source.kind === "cloned" ? await referenceOf(source.voice) : null;
    // An explicit `Make again`, whatever the block's state (codex on PR 1193): with its kept
    // take retired, the older take of the same words must not be the answer either.
    const remake = only !== undefined;
    speaking.push({
      ...planned,
      ...(substitutedNow !== undefined ? { substitutedNow } : {}),
      ...(refusal !== undefined ? { refusal } : {}),
      reader,
      model,
      local,
      clone: source.kind === "cloned" ? source.voice : null,
      reference,
      text,
      direction,
      parts,
      format,
      remake,
      // A whole block already in the cache is adopted without a call (R-19); parts are never
      // cached as a block, so a block over the cap is always made, the cache holds no
      // direction, so a directed block never comes from it, and a block made again unchanged
      // is another performance, not the cached one handed back (issue 1190).
      cacheFile: local || parts.length > 1 || direction !== null || remake ? null : speechCacheFile({ provider: model.provider, model: model.id, voiceId: reader.voiceId, text, format, ...(reference !== null ? { reference } : {}) }),
    });
  }

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
  // A cloned voice's recording leaving the machine is asked about before the price (R-17):
  // once per voice and vendor for a hosted reader, whose answer is written onto the voice, and
  // per request for the engine. One question at a time — the run returns at the first
  // unanswered and the window's next press brings the answer — the hosted readers' first,
  // since theirs persist, the engine's last, so the token the window holds at the end is the
  // one the price's answer must carry (codex on PR 1180: without the voice on the question,
  // a hosted reader's line was refused at dispatch and flagged without ever being asked).
  const cloneMap = new Map<string, { provider: string; voice: ClonedVoice }>();
  for (const block of misses) {
    if (block.clone !== null) cloneMap.set(`${block.reader.provider}\n${block.clone.id}`, { provider: block.reader.provider, voice: block.clone });
  }
  const clones = [...cloneMap.values()].sort((a, b) => Number(a.provider === CLONED_VOICE_PROVIDER) - Number(b.provider === CLONED_VOICE_PROVIDER));
  // Priced by the character as the row bills it (SPEC-046 R-8): bytes, or doubled CJK, for the
  // readers that count so — `text.length` alone understates a Fish or Breeze block by up to 3×
  // (codex on PR 1180). The counts the card and the job show stay the prose's, as the page
  // read's do; only the money is the vendor's count.
  const priceOf = (block: Speaking) => block.parts.reduce((sum, part) => sum + estimateMicroUsd(block.model, { characters: billableCharacters(block.model, part) }), 0);
  const estimate = misses.reduce((sum, block) => sum + priceOf(block), 0);
  return { kind: "ready", prepared: { plan, record, toMake, speaking, misses, clones, priceOf, estimate } };
}

/**
 * The price's name for a chapter as it stands (R-17): its words and its cloud misses, each with
 * the reader and the direction it would be made under. The chapter's own press answers with
 * it; the book's run computes it per chapter from the preparation it priced, and the chapter's
 * run compares it against a fresh one before spending on the book's answer (codex on PR 1187).
 */
export function chapterPriceToken(worldId: string, productionId: string, chapterId: string, chapter: { version: number; hash: string }, misses: readonly Speaking[]): string {
  return createHash("sha256")
    .update(["audiobook", worldId, productionId, chapterId, String(chapter.version), chapter.hash, ...misses.map(missIdentity)].join("\n"))
    .digest("hex");
}

/**
 * What a miss is priced as: the block, the words it would send — their own hash, since the
 * chapter's names the prose and not the spoken heading, and a title renamed keeps the version
 * and the body hash while it lengthens the request (codex on PR 1187) — the reader, and the
 * direction.
 */
export function missIdentity(block: Speaking): string {
  return `${block.block.key}:${audiobookTextHash(block.text)}:${block.reader.provider}/${block.reader.model}/${block.reader.voiceId}:${block.direction?.hash ?? ""}`;
}

/** The price's lines (R-17): every cloud voice the words would go to, once each, with its share. */
export function priceLines(misses: readonly Speaking[], priceOf: (block: Speaking) => number): { label: string; provider: string; characters: number; estimatedMicroUsd: number }[] {
  const voices = new Map<string, { label: string; provider: string; characters: number; estimatedMicroUsd: number }>();
  for (const block of misses) {
    const key = `${block.reader.provider}\n${block.reader.voiceId}`;
    const held = voices.get(key) ?? { label: block.reader.label ?? block.reader.voiceId, provider: block.reader.provider, characters: 0, estimatedMicroUsd: 0 };
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

  const preparation = await prepareChapter(store, productionId, chapterId, { narrator, models: deps.models, catalogue: deps.catalogue }, deps.now, deps.only);
  if (preparation.kind !== "ready") {
    if (preparation.kind === "unavailable") emit({ type: "started", toMake: 0, blocks: 0 });
    finish(preparation.kind, { reason: preparation.reason });
    return;
  }
  const { plan, toMake, speaking, misses, clones, priceOf, estimate } = preparation.prepared;
  let record = preparation.prepared.record;
  const chapterFile = plan.chapter.file;
  emit({ type: "started", toMake: toMake.length, blocks: plan.blocks.length });
  if (toMake.length === 0) {
    finish("read", { record });
    return;
  }
  const token = chapterPriceToken(deps.worldId, productionId, chapterId, plan.chapter, misses);
  // The book's run priced every chapter at once (R-17), and its chapters are read on that
  // answer rather than asked again one by one — but only the chapter that was priced. Each
  // chapter is prepared afresh when the book reaches it, and prose, a reading or a voice
  // changed while earlier chapters were read can put cloud work in that preparation the card
  // never showed: that chapter is refused and left to its row rather than read on an answer
  // given for other words (codex on PR 1187). Judged before any consent is asked, so a chapter
  // that moved never puts a question under the book that the book's answer cannot follow.
  if (deps.priced !== undefined && estimate > 0 && deps.priced !== token) {
    finish("refused", { reason: "moved since the book was priced" });
    return;
  }
  for (const reader of clones) {
    if (await deps.requireUploadConfirmation(reader)) return;
  }
  if (estimate > 0 && deps.priced === undefined && deps.confirmationToken !== token) {
    emit({ type: "priced", characters: misses.reduce((sum, block) => sum + block.text.length, 0), estimatedMicroUsd: estimate, confirmationToken: token, voices: priceLines(misses, priceOf) });
    return;
  }

  const landingDir = audiobookLanding(productionId, chapterFile);
  const progress = (block: Speaking, outcome: "made" | "adopted" | "flagged", reason?: string) =>
    emit({ type: "progress", block: block.block.key, outcome, ...(reason !== undefined ? { reason } : {}), made, toMake: toMake.length });
  const file = async (block: Speaking, sourcePath: string, input: { jobId?: string; parts: number; estimatedMicroUsd: number; costMicroUsd: number | null; adopted?: true }): Promise<ArtifactSidecar> => {
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
        ? { directionHash: block.direction.hash, delivery: block.direction.delivery, providerTextHash: audioHash(Buffer.from(block.direction.rendered)) }
        : {}),
      // A block whose kept take is still on the shelf, or that is made again on purpose, is
      // another take beside that one (SPEC-047 R-4, issue 1190), named for it: filed as its
      // own artifact, found again by a retry, and never the older take of the same words
      // returned for a retired selection (codex on PR 1193). A block with no take, or whose
      // take's media is gone and is not asked for again, takes the shelf's own rule instead —
      // the same words, voice and direction already filed are the take it made before the
      // record could say so, or the sidecar its restored file belongs under.
      ...(remakeOf !== undefined ? { remakeOf } : {}),
    };
    return fileGeneratedArtifact(store, {
      sourcePath,
      generation,
      production: productionId,
      ...(deps.mediaProbe !== undefined ? { mediaProbe: deps.mediaProbe } : {}),
      abandoned: () => signal.aborted,
    });
  };
  const keep = async (block: Speaking, artifact: ArtifactSidecar, input: { parts: number; estimatedMicroUsd: number; costMicroUsd: number | null; adopted?: true }) => {
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
      ...(block.direction !== null ? { directionHash: block.direction.hash } : {}),
      madeAt: deps.now(),
    };
    await write((current) => {
      const { [block.block.key]: _dropped, ...flags } = current.flags;
      return { ...current, chapterVersion: plan.chapter.version, hash: plan.chapter.hash, updatedAt: deps.now(), takes: { ...current.takes, [block.block.key]: take }, flags };
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
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    for (const block of speaking) {
      if (signal.aborted) break;
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
          const made = await deps.synthesizeLocal(block.reader.voiceId, block.direction?.rendered ?? block.text, block.direction?.voiceSettings ?? {}, signal);
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
          directionHash: block.direction?.hash ?? null,
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
                characterCount: part.length,
                sheetVersion: plan.chapter.version,
                ...(block.reference !== null ? { reference: block.reference } : {}),
                // The direction rides as the performance path's does (R-8): the words already
                // decorated, the settings beside them, the sentence where the row takes one, and
                // the direction's name so the job is this direction's and no other's.
                ...(block.direction !== null
                  ? {
                      voiceSettings: block.direction.voiceSettings,
                      directionHash: block.direction.hash,
                      ...(block.direction.instructions !== undefined ? { instructions: block.direction.instructions } : {}),
                    }
                  : {}),
              },
              estimatedMicroUsd: estimateMicroUsd(block.model, { characters: billableCharacters(block.model, part) }),
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
