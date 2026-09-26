import { readFile, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { billableCharacters, estimateMicroUsd, type Job } from "@arke-studio/contracts";
import type { EnqueueInput } from "../queue/dispatcher.js";
import { joinSpeech, speechCacheFile } from "../voice/service.js";
import { atomicWriteFile } from "../world/atomic.js";
import { fromPortable, toExtendedLength } from "../world/paths.js";
import type { WorldStore } from "../world/store.js";
import { audiobookLanding } from "./audiobook.js";
import { prepareChapter, type ReadingRoom } from "./audiobook-run.js";

/**
 * A block heard as it would be read (design turn 155g/h, SPEC-047 R-45, R-46): prepared exactly
 * as a press on it would prepare it — the reader that will speak, its direction held to that
 * reader, the speaker's note ahead under `performed`, the parts the cap makes — and spoken into
 * the speech cache rather than filed. A preview, never a take: nothing on the record moves, and
 * the same line heard again is the cached file. A cloned voice's recording leaving the machine
 * is asked about by a read, so a cloned reader is heard by reading the block.
 */
export interface HearDeps {
  worldId: string;
  local: (voiceId: string, text: string, settings: Record<string, number>) => Promise<{ audio: Uint8Array; parts: number }>;
  enqueue: (input: EnqueueInput) => Promise<string>;
  waitForJob: (jobId: string) => Promise<Job>;
}

export async function hearAudiobookLine(store: WorldStore, productionId: string, chapterFile: string, block: string, room: ReadingRoom, deps: HearDeps): Promise<{ file: string; cached: boolean }> {
  const production = store.getBundle().productions.find((p) => p.meta.id === productionId);
  const chapter = production?.chapters.find((c) => c.file === chapterFile || c.id === chapterFile);
  if (chapter === undefined) throw new Error("that chapter is no longer in this production");
  const prepared = await prepareChapter(store, productionId, chapter.id, room, () => store.now(), [block]);
  if (prepared.kind !== "ready") throw new Error(prepared.reason);
  const speaking = prepared.prepared.speaking.find((candidate) => candidate.block.key === block);
  if (speaking === undefined) throw new Error("that block is no longer in the chapter");
  if (speaking.refusal !== undefined) throw new Error(speaking.refusal);
  if (speaking.clone !== null) throw new Error("a cloned voice · read the block to hear it");
  const settings: Array<{ voiceSettings: Record<string, number>; instructions?: string }> = speaking.direction?.perPart ?? speaking.parts.map(() => ({ voiceSettings: {} }));
  const cacheFile = speechCacheFile({
    provider: speaking.model.provider,
    model: speaking.model.id,
    voiceId: speaking.reader.voiceId,
    text: `hear:${JSON.stringify(speaking.parts.map((part, index) => [part, settings[index]]))}`,
    format: speaking.format,
  });
  const cachePath = join(store.dir, fromPortable(cacheFile));
  if (await stat(toExtendedLength(cachePath)).then((s) => s.isFile(), () => false)) return { file: cacheFile, cached: true };
  const pieces: Uint8Array[] = [];
  if (speaking.local) {
    for (const [index, part] of speaking.parts.entries()) pieces.push((await deps.local(speaking.reader.voiceId, part, settings[index]?.voiceSettings ?? {})).audio);
  } else {
    if (speaking.parts.length > 1 && speaking.format === "flac") throw new Error("over the reader's cap · flac parts cannot be joined");
    const landingDir = audiobookLanding(productionId, chapter.file);
    for (const [index, part] of speaking.parts.entries()) {
      const perPart = settings[index];
      const jobId = await deps.enqueue({
        worldId: deps.worldId,
        productionId,
        target: { kind: "voice-preview", id: `hear/${speaking.model.provider}/${speaking.model.id}/${speaking.reader.voiceId}` },
        capability: "voice-tts",
        provider: speaking.model.provider,
        model: speaking.model.id,
        params: {
          voiceId: speaking.reader.voiceId,
          text: part,
          audioFormat: speaking.format,
          purpose: "candidate-preview",
          characterCount: part.length,
          ...(perPart !== undefined && Object.keys(perPart.voiceSettings).length > 0 ? { voiceSettings: perPart.voiceSettings } : {}),
          ...(perPart?.instructions !== undefined ? { instructions: perPart.instructions } : {}),
        },
        estimatedMicroUsd: estimateMicroUsd(speaking.model, { characters: billableCharacters(speaking.model, part) }),
        landing: { dir: landingDir, name: `hear-${block.replace(/[^a-z0-9]+/gi, "-")}-${index}.${speaking.format}` },
      });
      const job = await deps.waitForJob(jobId);
      if (job.status !== "succeeded" || job.landedFiles?.[0] === undefined) throw new Error(job.status === "cancelled" ? "stopped" : "the voice job failed · open Activity for details");
      const landed = join(store.dir, fromPortable(job.landedFiles[0]));
      pieces.push(new Uint8Array(await readFile(toExtendedLength(landed))));
      await unlink(toExtendedLength(landed)).catch(() => {});
    }
  }
  await atomicWriteFile(cachePath, pieces.length === 1 ? pieces[0]! : joinSpeech(pieces, speaking.format));
  return { file: cacheFile, cached: false };
}
