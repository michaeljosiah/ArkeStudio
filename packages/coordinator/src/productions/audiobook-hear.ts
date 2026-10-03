import { readFile, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { audiobookTextHash, groupedText, type ArtifactAudiobookGeneration, type AudiobookLoudness, type AudiobookTake, type Job } from "@arke-studio/contracts";
import { fileGeneratedArtifact } from "../artifacts/filing.js";
import type { MediaProbe } from "../media/probe.js";
import type { EnqueueInput } from "../queue/dispatcher.js";
import { joinSpeech, speechCacheFile } from "../voice/service.js";
import { atomicWriteFile } from "../world/atomic.js";
import { fromPortable, toExtendedLength } from "../world/paths.js";
import type { WorldStore } from "../world/store.js";
import { audioHash } from "../audio/qc.js";
import { audiobookLanding, recordsLoudness, updateAudiobook, type ProposalOverride } from "./audiobook.js";
import { prepareChapter, type PreparedGroup, type ReadingRoom, type Speaking } from "./audiobook-run.js";
import { applyGain, dropRunawayTail, normaliseSpeech, readSpeechWav, sliceSpeech, writeSpeechWav } from "../audio/speech-wav.js";
import type { TimedWord } from "../voice/word-times.js";
import { splitAudio, splitRequest } from "./audiobook-split.js";
import { speechConsentToken } from "../voice/quote.js";

/**
 * A block heard as it would be read (design turn 155g/h, SPEC-047 R-45, R-46): prepared exactly
 * as a press on it would prepare it — the reader that will speak, its direction held to that
 * reader, the notes ahead, the parts the cap makes — and spoken into the speech cache rather
 * than filed. A preview, never a take: nothing on the record moves, and the same line heard
 * again is the cached file. A cloned voice's recording leaving the machine is asked about by a
 * read, so a cloned reader is heard by reading the block.
 *
 * Under a held proposal (design turn 184b, R-55) the block is prepared as the proposal would
 * leave it — its proposed direction, the cast and the notes the proposal carries — and when the
 * proposal is accepted unchanged, the heard file is what a read would send, so it is kept as the
 * block's take rather than paid for again (`adoptHeardTakes`).
 */
export interface HearDeps {
  worldId: string;
  quoteToken?: string;
  local: (voiceId: string, text: string, settings: Record<string, number>) => Promise<{ audio: Uint8Array; parts: number }>;
  enqueue: (input: EnqueueInput) => Promise<string>;
  waitForJob: (jobId: string) => Promise<Job>;
  /** Word times on this machine (design turn 185): with them a block is heard with its neighbours, as a press would read it. */
  wordTimes?: (wav: Uint8Array, signal: AbortSignal) => Promise<{ words: TimedWord[]; seconds: number }>;
}

/** Each request's settings and style, as the block would be sent. */
function partSettings(speaking: Speaking): Array<{ voiceSettings: Record<string, number>; instructions?: string }> {
  return speaking.direction?.perPart ?? speaking.parts.map(() => ({ voiceSettings: {} }));
}

/**
 * Where a heard block's audio is kept: named by every request exactly as it would be sent — the
 * reader, the words with their tags, each part's settings and style — so a file found under the
 * name is the read a press would make, and nothing else.
 */
export function hearCacheFile(speaking: Speaking, group?: PreparedGroup): string {
  const settings = partSettings(speaking);
  // Heard with its neighbours (design turn 185), the request is named whole — every turn sent,
  // and which block of it is kept — so the file is the cut a press would keep, and nothing else.
  const named = group === undefined
    ? JSON.stringify(speaking.parts.map((part, index) => [part, settings[index]]))
    : JSON.stringify({ group: group.turns, packing: group.packing, blocks: group.members.map((block) => block.block.key), kept: speaking.block.key });
  return speechCacheFile({
    provider: speaking.model.provider,
    model: speaking.model.id,
    voiceId: speaking.reader.voiceId,
    text: `hear:${named}`,
    format: speaking.format,
  });
}

/**
 * A heard WAV at the take loudness (design turn 185), so a heard block kept as its take matches
 * the rest, and without a runaway tail, which a take made by a run would not keep either.
 */
function level(bytes: Uint8Array): Uint8Array {
  try {
    const source = readSpeechWav(bytes);
    const untailed = dropRunawayTail(source);
    const normal = normaliseSpeech(untailed);
    return normal.loudness.gainDb === 0 && untailed === source ? bytes : writeSpeechWav(normal.pcm);
  } catch {
    return bytes;
  }
}

export async function hearAudiobookLine(
  store: WorldStore,
  productionId: string,
  chapterFile: string,
  block: string,
  room: ReadingRoom,
  deps: HearDeps,
  override?: ProposalOverride,
): Promise<{ file: string; cached: boolean } | { quote: { token: string; estimatedMicroUsd: number; parts: number } }> {
  const production = store.getBundle().productions.find((p) => p.meta.id === productionId);
  const chapter = production?.chapters.find((c) => c.file === chapterFile || c.id === chapterFile);
  if (chapter === undefined) throw new Error("that chapter is no longer in this production");
  const prepared = await prepareChapter(store, productionId, chapter.id, { ...room, transcriber: deps.wordTimes !== undefined }, () => store.now(), [block], override);
  if (prepared.kind !== "ready") throw new Error(prepared.reason);
  const speaking = prepared.prepared.speaking.find((candidate) => candidate.block.key === block);
  if (speaking === undefined) throw new Error("that block is no longer in the chapter");
  if (speaking.refusal !== undefined) throw new Error(speaking.refusal);
  if (speaking.clone !== null) throw new Error("a cloned voice · read the block to hear it");
  const settings = partSettings(speaking);
  const group = prepared.prepared.groups.find((candidate) => candidate.kept.includes(speaking));
  const cacheFile = hearCacheFile(speaking, group);
  const cachePath = join(store.dir, fromPortable(cacheFile));
  if (await stat(toExtendedLength(cachePath)).then((s) => s.isFile(), () => false)) return { file: cacheFile, cached: true };
  const quotes = group === undefined ? speaking.quotes : [group.quote];
  const token = speechConsentToken(JSON.stringify([deps.worldId, productionId, chapter.file, block, cacheFile]), quotes);
  // Preparation owns the actual request split and direction. A displayed single-request
  // estimate cannot authorise an arbitrary number of token-priced calls.
  // A $0 quote — a free plan's (design turn 182) — authorises nothing it could overspend, and a
  // read that costs nothing asks nothing (SPEC-047 R-17).
  if (quotes.some(quote => quote.unit === "token" && quote.authorisedMicroUsd > 0) && deps.quoteToken !== token) {
    // The author is asked the estimate; each part's service-limit authorisation stays behind
    // it as the dispatcher's cap (SPEC-049 R-6), never the figure on the button.
    return { quote: { token, estimatedMicroUsd: quotes.reduce((sum, quote) => sum + quote.expectedMicroUsd, 0), parts: quotes.length } };
  }
  // Heard with its neighbours (design turn 185): one request of the three, split here, the middle kept.
  if (group !== undefined && deps.wordTimes !== undefined) {
    const text = groupedText(group.turns);
    const jobId = await deps.enqueue({
      worldId: deps.worldId,
      productionId,
      target: { kind: "voice-preview", id: `hear/${group.model.provider}/${group.model.id}/${speaking.reader.voiceId}` },
      capability: "voice-tts",
      provider: group.model.provider,
      model: group.model.id,
      params: { voiceId: speaking.reader.voiceId, text, turns: group.turns, audioFormat: "wav", purpose: "audiobook", hear: true, productionId, chapterId: chapter.id, block, characterCount: text.length },
      estimatedMicroUsd: group.quote.expectedMicroUsd,
      landing: { dir: audiobookLanding(productionId, chapter.file), name: `hear-${block.replace(/[^a-z0-9]+/gi, "-")}-group.wav` },
    });
    const job = await deps.waitForJob(jobId);
    if (job.status !== "succeeded" || job.landedFiles?.[0] === undefined) throw new Error(job.status === "cancelled" ? "stopped" : "the voice job failed · open Activity for details");
    const landed = join(store.dir, fromPortable(job.landedFiles[0]));
    const bytes = new Uint8Array(await readFile(toExtendedLength(landed)));
    const pcm = readSpeechWav(bytes);
    const heard = await deps.wordTimes(bytes, new AbortController().signal);
    const cuts = splitRequest(group.members.map((member) => ({ key: member.block.key, text: member.text })), heard.words, heard.seconds, (start, end) => audioHash(writeSpeechWav(sliceSpeech(pcm, start, end))), splitAudio(pcm));
    const cut = cuts.find((candidate) => candidate.key === block)!;
    const gain = normaliseSpeech(pcm).loudness.gainDb;
    await atomicWriteFile(cachePath, writeSpeechWav(applyGain(sliceSpeech(pcm, cut.start, cut.end), gain)));
    await unlink(toExtendedLength(landed)).catch(() => {});
    return { file: cacheFile, cached: false };
  }
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
          // A chapter block's read, as the run's parts are, so the coordinator settles it for the
          // press waiting on it — as a character audition it ended unheard, the button stuck on
          // `reading…` with the file landed and paid for — and Activity leads to the chapter.
          // `hear` keeps it out of the run's search for a part already paid for.
          purpose: "audiobook",
          hear: true,
          productionId,
          chapterId: chapter.id,
          block,
          characterCount: part.length,
          ...(perPart !== undefined && Object.keys(perPart.voiceSettings).length > 0 ? { voiceSettings: perPart.voiceSettings } : {}),
          ...(perPart?.instructions !== undefined ? { instructions: perPart.instructions } : {}),
        },
        estimatedMicroUsd: quotes[index]!.expectedMicroUsd,
        landing: { dir: landingDir, name: `hear-${block.replace(/[^a-z0-9]+/gi, "-")}-${index}.${speaking.format}` },
      });
      const job = await deps.waitForJob(jobId);
      if (job.status !== "succeeded" || job.landedFiles?.[0] === undefined) throw new Error(job.status === "cancelled" ? "stopped" : "the voice job failed · open Activity for details");
      const landed = join(store.dir, fromPortable(job.landedFiles[0]));
      pieces.push(new Uint8Array(await readFile(toExtendedLength(landed))));
      await unlink(toExtendedLength(landed)).catch(() => {});
    }
  }
  const whole = pieces.length === 1 ? pieces[0]! : joinSpeech(pieces, speaking.format);
  await atomicWriteFile(cachePath, speaking.format === "wav" ? level(whole) : whole);
  return { file: cacheFile, cached: false };
}

/**
 * Blocks heard under a proposal kept as their takes once it is accepted (design turn 184b,
 * R-55): each block prepared afresh against the record as it now stands, and kept only when the
 * heard file is under the very name a read would make now — the same reader, words, tags,
 * settings and style — so a proposal accepted with any of it changed, or a block whose reader
 * moved since, is read as any block is. Returns how many were kept.
 */
export async function adoptHeardTakes(
  store: WorldStore,
  productionId: string,
  chapterId: string,
  blocks: readonly string[],
  room: ReadingRoom,
  deps: { now: () => string; mediaProbe?: MediaProbe; transcriber?: boolean },
): Promise<number> {
  if (blocks.length === 0) return 0;
  let kept = 0;
  // Each block prepared alone, as it was heard: with its neighbours where it was heard with them.
  for (const key of blocks) {
    const prepared = await prepareChapter(store, productionId, chapterId, { ...room, transcriber: deps.transcriber === true }, deps.now, [key]);
    if (prepared.kind !== "ready") continue;
    const { plan } = prepared.prepared;
    for (const speaking of prepared.prepared.speaking) {
      if (speaking.refusal !== undefined || speaking.clone !== null || speaking.recorded === true) continue;
      const cacheFile = hearCacheFile(speaking, prepared.prepared.groups.find((group) => group.kept.includes(speaking)));
      const sourcePath = join(store.dir, fromPortable(cacheFile));
      if (!(await stat(toExtendedLength(sourcePath)).then((s) => s.isFile(), () => false))) continue;
      const estimatedMicroUsd = speaking.local ? 0 : speaking.quotes.reduce((sum, quote) => sum + quote.expectedMicroUsd, 0);
      // The heard file is another performance beside a take the block already has (codex on PR
      // 1476): named for it, as the run names a remake, so the shelf files these bytes rather than
      // handing back an older take of the same words, voice and direction.
      const standing = prepared.prepared.record.takes[speaking.block.key];
      const generation: ArtifactAudiobookGeneration = {
        source: "audiobook",
        productionId,
        chapterId: plan.chapter.id,
        chapterVersion: plan.chapter.version,
        block: speaking.block.key,
        paragraph: speaking.block.paragraph,
        textHash: audiobookTextHash(speaking.text),
        provider: speaking.reader.provider,
        model: speaking.reader.model,
        voiceId: speaking.reader.voiceId,
        ...(speaking.reader.label !== undefined ? { voiceLabel: speaking.reader.label } : {}),
        ...(speaking.sheet !== undefined ? { sheetId: speaking.sheet } : {}),
        ...(speaking.sheetVersion !== undefined ? { sheetVersion: speaking.sheetVersion } : {}),
        parts: speaking.parts.length,
        characters: speaking.text.length,
        estimatedMicroUsd,
        costMicroUsd: null,
        ...(speaking.direction !== null
          ? {
              directionHash: speaking.direction.hash,
              ...(speaking.direction.delivery !== undefined ? { delivery: speaking.direction.delivery } : {}),
              providerTextHash: audioHash(Buffer.from(speaking.direction.rendered)),
            }
          : speaking.takeHash !== undefined
            ? { directionHash: speaking.takeHash }
            : {}),
        ...(standing !== undefined ? { remakeOf: standing.artifactId } : {}),
      };
      // The heard file was brought to the take loudness when it was heard; measured again for the record.
      let loudness: AudiobookLoudness | undefined;
      if (speaking.format === "wav" && recordsLoudness(store)) {
        try {
          loudness = normaliseSpeech(readSpeechWav(new Uint8Array(await readFile(toExtendedLength(sourcePath))))).loudness;
        } catch {
          loudness = undefined;
        }
      }
      const artifact = await fileGeneratedArtifact(store, { sourcePath, generation: { ...generation, ...(loudness !== undefined ? { loudness } : {}) }, production: productionId, ...(deps.mediaProbe !== undefined ? { mediaProbe: deps.mediaProbe } : {}) });
      const substituted = speaking.substitutedNow ?? speaking.substituted;
      const take: AudiobookTake = {
        artifactId: artifact.id,
        textHash: audiobookTextHash(speaking.text),
        reader: speaking.reader,
        ...(substituted !== undefined ? { assigned: speaking.assigned, substituted } : {}),
        ...(speaking.sheet !== undefined ? { sheet: speaking.sheet } : {}),
        format: speaking.format,
        characters: speaking.text.length,
        parts: speaking.parts.length,
        estimatedMicroUsd,
        costMicroUsd: null,
        ...(speaking.takeHash !== undefined ? { directionHash: speaking.takeHash } : {}),
        ...(speaking.noteHeld === true ? { noteHeld: true as const } : {}),
        ...(loudness !== undefined ? { loudness } : {}),
        madeAt: deps.now(),
      };
      await updateAudiobook(store, productionId, plan.chapter, (current) => {
        const { [speaking.block.key]: _flag, ...flags } = current.flags;
        return { ...current, updatedAt: deps.now(), takes: { ...current.takes, [speaking.block.key]: take }, flags };
      });
      kept += 1;
    }
  }
  return kept;
}
