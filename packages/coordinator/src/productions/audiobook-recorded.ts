import { copyFile, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import {
  audiobookTextHash,
  retailLevel,
  type AudioQcAnalysis,
  type AudioTechnical,
  type AudioTranscriptComparison,
  type AudiobookTake,
  type ChapterAudiobook,
} from "@arke-studio/contracts";
import { fileGeneratedArtifact } from "../artifacts/filing.js";
import { hashAudioFile, readAudioBytes, type AudioMediaTools } from "../audio/media-tools.js";
import { appendAudioRights } from "../audio/rights.js";
import { compareAudioTranscript } from "../audio/transcript-comparison.js";
import { MAX_AUDIO_BYTES } from "../audio/qc.js";
import type { MediaProbe } from "../media/probe.js";
import { RECORDED_TAKE_SCHEMA_VERSION } from "../world/commit.js";
import type { WorldStore } from "../world/store.js";
import { castRefusal, planAudiobook, updateAudiobook } from "./audiobook.js";

/**
 * A take a person recorded (design turn 155c, SPEC-047 R-34..R-36). The file is chosen on this
 * machine, copied aside, prepared by the audio foundation into the take format and checked —
 * loudness, peak, noise, and the words heard against the block's — and nothing of it leaves the
 * machine. Kept, it is filed as the block's take under a rights acknowledgement given once, and
 * the chapter's record takes it through the chapter's own lane, as a run's take is written.
 */

/** What a recording may be (R-35): the formats the foundation decodes, within its byte bound, and ten minutes. */
export const RECORDED_TAKE_EXTENSIONS = [".wav", ".mp3", ".flac", ".m4a"] as const;
export const RECORDED_TAKE_MAX_SECONDS = 600;

/** A recording refused, in the one clause the dialog says it in. */
export class RecordedTakeRefusal extends Error {}

export interface StagedRecording {
  productionId: string;
  chapterId: string;
  block: string;
  text: string;
  paragraph: number;
  /** Where the copy and its prepared file sit until kept or let go. */
  dir: string;
  file: string;
  sourceHash: string;
  source: AudioTechnical;
  preparedPath: string;
  preparedHash: string;
  qc: AudioQcAnalysis;
  words: AudioTranscriptComparison;
}

export interface RecordedTakeDeps {
  tools: AudioMediaTools;
  /** The local transcriber, when one runs; the words are then checked, and said `unchecked` otherwise. */
  transcribe: ((bytes: Uint8Array, contentType: string) => Promise<string>) | null;
  narrator: import("@arke-studio/contracts").AudiobookReader;
  signal: AbortSignal;
}

/** The QC codes a kept take says it was kept with (R-35): every check that warned. */
export function recordingWarnings(qc: AudioQcAnalysis): string[] {
  if (qc.status !== "complete") return [`checks unavailable · ${qc.reason}`];
  const level = retailLevel(qc.report.measurements);
  return [
    ...(level.loudness === "warning" ? ["loudness: outside retail"] : []),
    ...(level.peak === "warning" ? ["peak: over retail"] : []),
    ...Object.entries(qc.report.checks)
      .filter(([, check]) => check.outcome === "warning")
      .map(([name, check]) => `${name}: ${check.code}`),
  ].slice(0, 20);
}

/** Prepare and check a chosen file as a take for one block, refusing only what cannot be one. */
export async function stageRecording(
  store: WorldStore,
  deps: RecordedTakeDeps,
  input: { productionId: string; chapterId: string; block: string; sourcePath: string },
): Promise<StagedRecording> {
  const plan = await planAudiobook(store, input.productionId, input.chapterId, { narrator: deps.narrator });
  const refusal = castRefusal(plan);
  if (refusal !== null) throw new RecordedTakeRefusal(refusal);
  const planned = plan.blocks.find((candidate) => candidate.block.key === input.block);
  if (planned === undefined) throw new RecordedTakeRefusal("that block is no longer in the chapter");
  const extension = extname(input.sourcePath).toLowerCase();
  if (!(RECORDED_TAKE_EXTENSIONS as readonly string[]).includes(extension)) throw new RecordedTakeRefusal("not a WAV, FLAC, MP3 or M4A file");
  const size = (await stat(input.sourcePath)).size;
  if (size === 0) throw new RecordedTakeRefusal("the file is empty");
  if (size > MAX_AUDIO_BYTES) throw new RecordedTakeRefusal(`over ${Math.round(MAX_AUDIO_BYTES / 1_048_576)} MB`);
  const dir = await mkdtemp(join(tmpdir(), "arke-recorded-take-"));
  try {
    const copy = join(dir, `source${extension}`);
    await copyFile(input.sourcePath, copy);
    const { hash: sourceHash } = await hashAudioFile(copy, deps.signal);
    const probed = await deps.tools.probe({ absolutePath: copy, expectedHash: sourceHash, signal: deps.signal });
    if (!probed.hasAudio) throw new RecordedTakeRefusal("no audio in the file");
    if ((probed.technical.durationSec ?? 0) > RECORDED_TAKE_MAX_SECONDS) throw new RecordedTakeRefusal("longer than 10 minutes");
    const preparedPath = join(dir, "prepared.wav");
    const prepared = await deps.tools.preparePcmWav({ sourcePath: copy, expectedSourceHash: sourceHash, destinationPath: preparedPath, signal: deps.signal });
    const qc = await deps.tools.analyze({ absolutePath: preparedPath, expectedHash: prepared.outputHash, signal: deps.signal });
    // A warning never refuses (R-35); only a check the foundation calls a hard incompatibility does.
    if (qc.status === "complete") {
      const hard = Object.entries(qc.report.checks).find(([, check]) => check.outcome === "hard-incompatibility");
      if (hard !== undefined) throw new RecordedTakeRefusal(`${hard[0]} · ${hard[1].code}`);
    }
    const text = planned.block.text;
    let words: AudioTranscriptComparison;
    const transcriber = { id: "voxa-whisper", version: "runtime-unreported" };
    if (deps.transcribe === null) {
      words = compareAudioTranscript({ audioHash: prepared.outputHash, authoredText: text, transcriber });
    } else {
      try {
        const bytes = await readAudioBytes(preparedPath, deps.signal);
        const observedText = await deps.transcribe(bytes, "audio/wav");
        words = compareAudioTranscript({ audioHash: prepared.outputHash, authoredText: text, observedText, transcriber });
      } catch {
        words = compareAudioTranscript({ audioHash: prepared.outputHash, authoredText: text, transcriber, unavailableReason: "stt-failed" });
      }
    }
    return {
      productionId: input.productionId,
      chapterId: plan.chapter.id,
      block: input.block,
      text,
      paragraph: planned.block.paragraph,
      dir,
      file: basename(input.sourcePath),
      sourceHash,
      source: probed.technical,
      preparedPath,
      preparedHash: prepared.outputHash,
      qc,
      words,
    };
  } catch (err) {
    await rm(dir, { recursive: true, force: true });
    throw err;
  }
}

/** Let a staged recording go: its copies are deleted, nothing in the world was written. */
export async function discardRecording(staged: StagedRecording): Promise<void> {
  await rm(staged.dir, { recursive: true, force: true });
}

/**
 * Keep a staged recording as the block's take (R-34, R-36). The block must still say the words
 * the recording was checked against; the world is raised past the builds that cannot read a
 * recorded take before anything is written; the rights are acknowledged over the prepared audio
 * with the `recorded-take` scope; the file is filed as the block's take and the record takes it.
 */
export async function keepRecording(
  store: WorldStore,
  staged: StagedRecording,
  input: { basis: "self" | "authorized" | "licensed"; performer?: string; narrator: import("@arke-studio/contracts").AudiobookReader; ackId: string; now: () => string; mediaProbe?: MediaProbe },
): Promise<ChapterAudiobook> {
  const plan = await planAudiobook(store, staged.productionId, staged.chapterId, { narrator: input.narrator });
  const planned = plan.blocks.find((candidate) => candidate.block.key === staged.block);
  if (planned === undefined || audiobookTextHash(planned.block.text) !== audiobookTextHash(staged.text)) {
    throw new RecordedTakeRefusal("the words changed · upload again");
  }
  await store.ensureSchemaVersion(RECORDED_TAKE_SCHEMA_VERSION, "recorded-take");
  await appendAudioRights(store, {
    schemaVersion: 1,
    action: "acknowledge",
    id: input.ackId,
    audioHash: staged.preparedHash,
    ...(input.performer !== undefined ? { performerRef: input.performer } : {}),
    basis: input.basis,
    scopes: ["recorded-take"],
    statementVersion: 1,
    at: input.now(),
  });
  const textHash = audiobookTextHash(staged.text);
  const artifact = await fileGeneratedArtifact(store, {
    sourcePath: staged.preparedPath,
    production: staged.productionId,
    ...(input.mediaProbe !== undefined ? { mediaProbe: input.mediaProbe } : {}),
    generation: {
      source: "audiobook",
      productionId: staged.productionId,
      chapterId: plan.chapter.id,
      chapterVersion: plan.chapter.version,
      block: staged.block,
      paragraph: staged.paragraph,
      textHash,
      provider: "recording",
      model: "recorded",
      voiceId: "recorded",
      ...(input.performer !== undefined ? { voiceLabel: input.performer } : {}),
      ...(planned.sheet !== undefined ? { sheetId: planned.sheet } : {}),
      parts: 1,
      characters: staged.text.length,
      estimatedMicroUsd: 0,
      costMicroUsd: 0,
      recording: { sourceHash: staged.sourceHash, preparedHash: staged.preparedHash, acknowledgementId: input.ackId },
    },
  });
  const words = staged.words.status === "compared" ? (staged.words.result === "exact" ? "match" : "differ") : "unchecked";
  const take: AudiobookTake = {
    artifactId: artifact.id,
    textHash,
    reader: { provider: "recording", model: "recorded", voiceId: "recorded", label: input.performer ?? "recorded" },
    ...(planned.sheet !== undefined ? { sheet: planned.sheet } : {}),
    format: "wav",
    characters: staged.text.length,
    parts: 1,
    estimatedMicroUsd: 0,
    costMicroUsd: 0,
    source: "recorded",
    recording: {
      acknowledgementId: input.ackId,
      ...(input.performer !== undefined ? { performer: input.performer } : {}),
      warnings: recordingWarnings(staged.qc),
      words,
    },
    madeAt: input.now(),
  };
  const record = await updateAudiobook(store, staged.productionId, plan.chapter, (current) => {
    const { [staged.block]: _cleared, ...flags } = current.flags;
    return { ...current, chapterVersion: plan.chapter.version, hash: plan.chapter.hash, updatedAt: input.now(), takes: { ...current.takes, [staged.block]: take }, flags };
  });
  await discardRecording(staged);
  return record;
}
