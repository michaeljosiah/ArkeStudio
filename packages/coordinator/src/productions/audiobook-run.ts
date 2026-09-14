import { createHash } from "node:crypto";
import { readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import {
  audiobookTextHash,
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
  type Job,
  type ManifestModel,
  type VoiceCandidate,
} from "@arke-studio/contracts";
import { fileGeneratedArtifact } from "../artifacts/filing.js";
import type { MediaProbe } from "../media/probe.js";
import type { EnqueueInput } from "../queue/dispatcher.js";
import { clipFor } from "../voice/library.js";
import { cachedVoiceAudioLooksRight, concatWav, speechCacheFile, splitForSpeech, type VoiceService } from "../voice/service.js";
import { atomicWriteFile } from "../world/atomic.js";
import { fromPortable, toExtendedLength } from "../world/paths.js";
import type { WorldStore } from "../world/store.js";
import { audiobookLanding, emptyAudiobook, planAudiobook, writeAudiobook, type PlannedBlock } from "./audiobook.js";

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
  voice: VoiceService;
  models: readonly ManifestModel[];
  narrator: AudiobookReader;
  /** What can speak now (turn 130's rule): a voice the catalogue lacks or marks reads in the narrator's. */
  catalogue: readonly VoiceCandidate[];
  signal: AbortSignal;
  confirmationToken?: string;
  /** Ask once for a cloned voice's recording to leave the machine; true when the run must stop here and wait for the answer. */
  requireUploadConfirmation: () => boolean;
  enqueue: (inputs: EnqueueInput[]) => Promise<{ jobIds: string[]; reason?: string }>;
  waitForJob: (jobId: string) => Promise<Job>;
  cancelJob: (jobId: string) => Promise<void>;
  actualCost: (jobId: string) => Promise<number | null>;
  mediaProbe?: MediaProbe;
  emit: (event: AudiobookRunEvent) => void;
  now: () => string;
}

type Format = "wav" | "mp3" | "flac";

/** The reader that will actually speak a block, after the catalogue has been asked. */
interface Speaking extends PlannedBlock {
  reader: AudiobookReader;
  model: ManifestModel;
  local: boolean;
  cloned: boolean;
  text: string;
  /** The rendered text in parts, each within the reader's cap (R-5). One part for a block within it. */
  parts: string[];
  format: Format;
  cacheFile: string | null;
  substitutedNow?: AudiobookSubstitution;
}

/** MP3 frames concatenate; a later part's ID3v2 tag would not, so it is dropped (R-5). */
export function concatMp3(parts: readonly Uint8Array[]): Uint8Array {
  const stripped = parts.map((part, index) => {
    if (index === 0 || part.length < 10 || part[0] !== 0x49 || part[1] !== 0x44 || part[2] !== 0x33) return part;
    const size = ((part[6]! & 0x7f) << 21) | ((part[7]! & 0x7f) << 14) | ((part[8]! & 0x7f) << 7) | (part[9]! & 0x7f);
    return part.subarray(10 + size);
  });
  return new Uint8Array(Buffer.concat(stripped.map((part) => Buffer.from(part))));
}

const sameReader = (a: AudiobookReader, b: AudiobookReader): boolean => a.provider === b.provider && a.model === b.model && a.voiceId === b.voiceId;

/** The record could not be written: the world's claim is gone, or it closed under the run. Nothing more can be kept. */
class RecordWriteError extends Error {}

export async function runAudiobookChapter(deps: AudiobookRunDeps): Promise<void> {
  const { store, productionId, chapterId, voice, narrator, signal, emit } = deps;
  let made = 0;
  let flaggedCount = 0;
  const finish = (outcome: Extract<AudiobookRunEvent, { type: "finished" }>["outcome"], extra: { record?: ChapterAudiobook; reason?: string } = {}) =>
    emit({ type: "finished", outcome, made, flagged: flaggedCount, ...extra });

  const plan = await planAudiobook(store, productionId, chapterId, { narrator });
  const chapterFile = plan.chapter.file;
  // Under `cast` a run needs a cast that is current (R-12): a line whose speaker the cast cannot
  // name would otherwise be made in the narrator's voice without the door having said so.
  if (plan.reading === "cast") {
    if (plan.cast === null) {
      finish("refused", { reason: "not cast · cast the lines first" });
      return;
    }
    if (plan.cast === "unreadable") {
      finish("refused", { reason: "cast unreadable · cast again" });
      return;
    }
    if (plan.cast.hash !== plan.chapter.hash) {
      finish("refused", { reason: "cast moved · cast again" });
      return;
    }
  }
  // An unreadable record is no record: the takes it named are still on the shelf, and a run
  // that cannot read which block each was for makes the chapter afresh rather than guessing.
  let record: ChapterAudiobook =
    plan.record === null || plan.record === "unreadable"
      ? emptyAudiobook(plan.chapter.version, plan.chapter.hash, deps.now())
      : { ...plan.record, takes: { ...plan.record.takes }, flags: { ...plan.record.flags } };
  const toMake = plan.blocks.filter((planned) => planned.state !== "made");
  emit({ type: "started", toMake: toMake.length, blocks: plan.blocks.length });
  if (toMake.length === 0) {
    finish("read", { record });
    return;
  }

  const modelOf = (reader: AudiobookReader): ManifestModel | null =>
    deps.models.find((m) => m.provider === reader.provider && m.id === reader.model && m.capability === "voice-tts") ?? null;
  const narratorModel = modelOf(narrator);
  if (narratorModel === null) {
    finish("unavailable", { reason: "the narrator's voice model is not in the manifest" });
    return;
  }
  const clonedVoices = store.getBundle().clonedVoices ?? [];

  // Who actually speaks each block: the assigned reader when the manifest knows its model, the
  // catalogue says it can speak now and, for a cloned voice, its recording is still there;
  // otherwise the narrator, with the reason kept on the take (R-12).
  const speaking: Speaking[] = [];
  for (const planned of toMake) {
    let reader = planned.assigned;
    let substitutedNow: AudiobookSubstitution | undefined;
    let model = sameReader(reader, narrator) ? narratorModel : modelOf(reader);
    if (!sameReader(reader, narrator)) {
      const listed = deps.catalogue.find((candidate) => candidate.provider === reader.provider && candidate.model === reader.model && candidate.voiceId === reader.voiceId);
      const source = voiceSourceFor(clonedVoices, reader.provider, reader.model, reader.voiceId);
      const clipMissing = source.kind === "missing-clone" || (source.kind === "cloned" && (await clipFor(store, source.voice)) === null);
      if (model === null || listed === undefined || listed.unavailableReason !== undefined || clipMissing) {
        reader = narrator;
        model = narratorModel;
        substitutedNow = "voice unavailable";
      }
    }
    if (model === null) throw new Error("unreachable: the narrator's model was checked");
    const text = normalizeSpeechText(planned.block.text);
    const cap = model.limits.maxPromptChars;
    const parts = cap !== undefined && text.length > cap ? splitForSpeech(text, cap) : [text];
    const local = reader.provider === "kokoro";
    const format = voiceFormatForModel(model);
    const source = voiceSourceFor(clonedVoices, reader.provider, reader.model, reader.voiceId);
    speaking.push({
      ...planned,
      ...(substitutedNow !== undefined ? { substitutedNow } : {}),
      reader,
      model,
      local,
      cloned: source.kind === "cloned",
      text,
      parts,
      format,
      // A whole block already in the cache is adopted without a call (R-19); parts are never
      // cached as a block, so a block over the cap is always made.
      cacheFile: local || parts.length > 1 ? null : speechCacheFile({ provider: model.provider, model: model.id, voiceId: reader.voiceId, text, format }),
    });
  }

  // What the cache lacks, priced once (R-17).
  const misses: Speaking[] = [];
  for (const block of speaking) {
    if (block.local) continue;
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
  if (misses.some((block) => block.cloned) && deps.requireUploadConfirmation()) return;
  const priceOf = (block: Speaking) => block.parts.reduce((sum, part) => sum + estimateMicroUsd(block.model, { characters: part.length }), 0);
  const estimate = misses.reduce((sum, block) => sum + priceOf(block), 0);
  if (estimate > 0) {
    const token = createHash("sha256")
      .update(["audiobook", deps.worldId, productionId, chapterId, String(plan.chapter.version), plan.chapter.hash, ...misses.map((block) => `${block.block.key}:${block.reader.provider}/${block.reader.model}/${block.reader.voiceId}`)].join("\n"))
      .digest("hex");
    if (deps.confirmationToken !== token) {
      const voices = new Map<string, { label: string; provider: string; characters: number; estimatedMicroUsd: number }>();
      for (const block of misses) {
        const key = `${block.reader.provider}\n${block.reader.voiceId}`;
        const held = voices.get(key) ?? { label: block.reader.label ?? block.reader.voiceId, provider: block.reader.provider, characters: 0, estimatedMicroUsd: 0 };
        held.characters += block.text.length;
        held.estimatedMicroUsd += priceOf(block);
        voices.set(key, held);
      }
      emit({ type: "priced", characters: misses.reduce((sum, block) => sum + block.text.length, 0), estimatedMicroUsd: estimate, confirmationToken: token, voices: [...voices.values()] });
      return;
    }
  }

  const landingDir = audiobookLanding(productionId, chapterFile);
  const progress = (block: Speaking, outcome: "made" | "adopted" | "flagged", reason?: string) =>
    emit({ type: "progress", block: block.block.key, outcome, ...(reason !== undefined ? { reason } : {}), made, toMake: toMake.length });
  const file = async (block: Speaking, sourcePath: string, input: { jobId?: string; parts: number; estimatedMicroUsd: number; costMicroUsd: number | null; adopted?: true }): Promise<ArtifactSidecar> => {
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
      madeAt: deps.now(),
    };
    const { [block.block.key]: _dropped, ...flags } = record.flags;
    record = { ...record, chapterVersion: plan.chapter.version, hash: plan.chapter.hash, updatedAt: deps.now(), takes: { ...record.takes, [block.block.key]: take }, flags };
    await write(record);
    made += 1;
  };
  const write = async (next: ChapterAudiobook) => {
    try {
      await writeAudiobook(store, productionId, chapterFile, next);
    } catch (err) {
      throw new RecordWriteError(err instanceof Error ? err.message : String(err));
    }
  };
  const flag = async (block: Speaking, reason: string) => {
    record = { ...record, updatedAt: deps.now(), flags: { ...record.flags, [block.block.key]: { reason, at: deps.now() } } };
    await write(record);
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
        if (block.local) {
          // Local speech lands in the speech cache as it always has; the take is a copy of it
          // filed as the production's own, so the cache can be emptied without losing the book.
          const result = await voice.localSpeech(store, block.reader.voiceId, block.text);
          const artifact = await file(block, join(store.dir, fromPortable(result.file)), { parts: 1, estimatedMicroUsd: 0, costMicroUsd: 0 });
          await keep(block, artifact, { parts: 1, estimatedMicroUsd: 0, costMicroUsd: 0 });
          progress(block, "made");
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
        for (const [index, part] of block.parts.entries()) {
          if (signal.aborted) break;
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
              part: index,
              parts: block.parts.length,
              characterCount: part.length,
              sheetVersion: plan.chapter.version,
            },
            estimatedMicroUsd: estimateMicroUsd(block.model, { characters: part.length }),
            landing: { dir: landingDir, name: `${block.block.key.replace(/[^a-z0-9]+/gi, "-")}-${index}.${block.format}` },
            ...(block.cloned ? { voiceReference: true } : {}),
          };
          const queued = await deps.enqueue([input]);
          const jobId = queued.jobIds[0];
          if (jobId === undefined) throw new Error(queued.reason ?? "the voice job could not be queued");
          firstJob ??= jobId;
          jobInFlight = jobId;
          const job = await deps.waitForJob(jobId);
          jobInFlight = null;
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
          const joined = block.format === "wav" ? concatWav(bytes) : concatMp3(bytes);
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
