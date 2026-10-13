import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import {
  AcousticWordsSchema,
  audiobookTextHash,
  validateAcousticWords,
  type AcousticWords,
  type AcousticWord,
  type AudiobookWordTiming,
  type ListeningChapter,
} from "@arke-studio/contracts";
import type { WorldStore } from "../world/store.js";
import { toExtendedLength } from "../world/paths.js";
import { containedWorldFile } from "./interactive.js";
import { planAudiobook, updateAudiobook, type AudiobookPlan } from "./audiobook.js";
import { chapterTiming } from "./audiobook-timing.js";
import { anyNarrator } from "./audiobook-listening.js";
import { decodeAudiobookAudio } from "./audiobook-mix.js";
import { writeSpeechWav } from "../audio/speech-wav.js";
import type { FfmpegRunner } from "../takes/export.js";

export type AcousticWordReader = (audio: Uint8Array, signal: AbortSignal) => Promise<AcousticWords>;
export const audiobookAudioHash = (audio: Uint8Array): string =>
  `sha256:${createHash("sha256").update(audio).digest("hex")}`;

async function currentBytes(store: WorldStore, file: string): Promise<Uint8Array> {
  const real = await containedWorldFile(store.dir, file);
  if (real === null) throw new Error("the reading is not a file inside this world");
  if ((await stat(toExtendedLength(real))).size > 64 * 1024 * 1024)
    throw new Error("this reading is too large for local word timing");
  return new Uint8Array(await readFile(toExtendedLength(real)));
}

/** Prepare exactly the current saved take. A replacement during inference must not inherit its timing. */
export async function prepareAudiobookWordTiming(
  store: WorldStore,
  productionId: string,
  plan: AudiobookPlan,
  blockKey: string,
  read: AcousticWordReader,
  signal: AbortSignal,
  ffmpeg?: FfmpegRunner,
): Promise<AudiobookWordTiming> {
  const block = plan.blocks.find((entry) => entry.block.key === blockKey)?.block;
  const take = plan.record !== "unreadable" ? plan.record?.takes[blockKey] : undefined;
  const artifact =
    take === undefined
      ? undefined
      : store.getBundle().artifacts.find((entry) => entry.id === take.artifactId);
  if (
    block === undefined ||
    take === undefined ||
    artifact === undefined ||
    take.textHash !== audiobookTextHash(block.text)
  )
    throw new Error("this block has no current reading");
  const file = `artifacts/${artifact.file}`;
  const bytes = await currentBytes(store, file);
  const hash = audiobookAudioHash(bytes);
  const wav =
    take.format === "wav"
      ? bytes
      : writeSpeechWav(await decodeAudiobookAudio(store.dir, file, ffmpeg, signal));
  const heard = AcousticWordsSchema.parse(await read(wav, signal));
  if (signal.aborted) throw new Error("stopped");
  const measured = artifact.mediaInfo?.durationSec ?? take.grouped?.durationSec;
  if (measured !== undefined && Math.abs(measured - heard.seconds) > Math.max(0.15, measured * 0.01))
    throw new Error("word timing does not match this recording’s duration");
  const checked = validateAcousticWords(block.text, heard);
  if (!checked.ok) throw new Error(checked.reason);
  const timing: AudiobookWordTiming = {
    artifactId: take.artifactId,
    audioHash: hash,
    textHash: take.textHash,
    engine: heard.engine,
    seconds: heard.seconds,
    words: checked.words,
    at: store.now(),
  };
  if (audiobookAudioHash(await currentBytes(store, file)) !== hash)
    throw new Error("the reading changed · prepare timing again");
  const fresh = await planAudiobook(store, productionId, plan.chapter.file, {
    narrator: await anyNarrator(store, productionId),
  });
  if (fresh.blocks.find((entry) => entry.block.key === blockKey)?.block.text !== block.text)
    throw new Error("the words changed · prepare timing again");
  await updateAudiobook(store, productionId, plan.chapter, (current) => {
    const chosen = current.takes[blockKey];
    if (chosen?.artifactId !== take.artifactId || chosen.textHash !== take.textHash || signal.aborted)
      throw new Error("the reading changed · prepare timing again");
    return { ...current, updatedAt: store.now(), wordTiming: { ...current.wordTiming, [blockKey]: timing } };
  });
  return timing;
}

/** Annotate the shared listening clock after exact take/text/byte verification. No estimated timing enters it. */
export async function applyAudiobookWordTiming(
  store: WorldStore,
  plan: AudiobookPlan,
  chapter: ListeningChapter,
): Promise<void> {
  const record = plan.record === "unreadable" ? null : plan.record;
  const verified = new Map<string, AudiobookWordTiming>();
  const reasons = new Map<string, string>();
  for (const block of chapter.blocks) {
    delete block.words;
    delete block.wordTimingReason;
    const timing = record?.wordTiming?.[block.key];
    const take = record?.takes[block.key];
    if (timing === undefined) {
      reasons.set(block.key, "word timing not prepared");
      continue;
    }
    if (timing.artifactId !== block.artifactId || timing.textHash !== take?.textHash) {
      reasons.set(block.key, "the reading or words changed");
      continue;
    }
    const authored = plan.blocks.find((entry) => entry.block.key === block.key)?.block.text;
    if (
      authored === undefined ||
      !validateAcousticWords(authored, {
        text: authored,
        seconds: timing.seconds,
        engine: timing.engine,
        words: timing.words,
      }).ok
    ) {
      reasons.set(block.key, "word timing needs a check");
      continue;
    }
    try {
      if (audiobookAudioHash(await currentBytes(store, block.file)) !== timing.audioHash) {
        reasons.set(block.key, "the audio changed");
        continue;
      }
    } catch {
      reasons.set(block.key, "the reading is unavailable");
      continue;
    }
    verified.set(block.key, timing);
  }
  const clock = chapterTiming(store, plan, "skip");
  for (const block of chapter.blocks) {
    const bar =
      chapter.mix === undefined
        ? undefined
        : clock.bars.find((entry) => entry.kind === "block" && entry.key === block.key);
    const segments = bar?.segments ?? [{ file: block.file, from: 0, to: block.seconds }];
    if (
      bar?.overlaps === true ||
      clock.bars.some(
        (entry) =>
          entry.kind === "reaction" &&
          entry.made &&
          entry.at < block.at + block.seconds &&
          entry.at + entry.seconds > block.at,
      )
    ) {
      block.wordTimingReason = "overlapping voices need a caption lane";
      continue;
    }
    let at = block.at;
    const words: AcousticWord[] = [];
    let reason = reasons.get(block.key);
    for (const segment of segments) {
      const owners = chapter.blocks.filter((owner) => owner.file === segment.file && verified.has(owner.key));
      const timing =
        segment.file === block.file
          ? verified.get(block.key)
          : owners.length === 1
            ? verified.get(owners[0]!.key)
            : undefined;
      if (timing === undefined) {
        reason ??= "word timing not prepared for the current mix";
        break;
      }
      for (const word of timing.words) {
        if (word.endSec <= segment.from || word.startSec >= segment.to) continue;
        if (word.startSec < segment.from - 0.02 || word.endSec > segment.to + 0.02) {
          reason = "a trim cuts through a word";
          break;
        }
        words.push({
          ...word,
          startSec: at + Math.max(0, word.startSec - segment.from),
          endSec: at + Math.min(segment.to - segment.from, word.endSec - segment.from),
        });
      }
      at += segment.to - segment.from;
    }
    if (reason !== undefined || words.length === 0)
      block.wordTimingReason = reason ?? "no words in this reading";
    else block.words = words;
  }
}
