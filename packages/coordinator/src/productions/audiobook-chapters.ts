import { mkdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { type AudiobookScope, type ListeningChapter, ulid } from "@arke-studio/contracts";
import { madeAudiobookCredits, type MadeAudiobookCredit } from "./audiobook-credits.js";
import { masterRetailFile, type RetailAudioTools, type RetailMeasurements } from "../audio/retail.js";
import { readPublicationFile } from "../publications/files.js";
import type { ImportFileLease, ImportFileSpace } from "../storage/import-files.js";
import type { FfmpegRunner } from "../takes/export.js";
import { atomicWriteFile } from "../world/atomic.js";
import { containedWorldFilePath } from "../world/contained-file.js";
import type { WorldStore } from "../world/store.js";
import { audiobookListening, anyNarrator } from "./audiobook-listening.js";
import type { AudiobookExportResult } from "./audiobook-export.js";

const signature = (chapters: ListeningChapter[]) => JSON.stringify(chapters.map(chapter => ({ id: chapter.chapterId, title: chapter.title, order: chapter.order,
  state: chapter.state, seconds: chapter.seconds, mix: chapter.mix, blocks: chapter.blocks, arrangement: chapter.audioStudio })));
interface DeliveredChapter {
  file: string; chapterId: string; title: string; part: number; sha256: string; bytes: number;
  measurements: Omit<RetailMeasurements, "noiseFloorDb"> & { noiseFloorDb: number | null };
  assertUnchanged(): Promise<void>;
}

/** Split only at passage boundaries, leaving space for padding and MP3 frame duration. */
export function retailParts(chapter: { seconds: number; blocks: readonly { at: number; seconds: number }[] }): Array<{ from: number; to: number }> {
  if (!Number.isFinite(chapter.seconds) || chapter.seconds <= 0) throw new Error("The chapter has no audio duration.");
  const boundaries: number[] = [];
  let end = 0;
  for (const block of [...chapter.blocks].sort((a, b) => a.at - b.at)) {
    if (block.at >= end - 0.01) boundaries.push(block.at);
    end = Math.max(end, block.at + block.seconds);
  }
  const parts: Array<{ from: number; to: number }> = [];
  let from = 0;
  while (chapter.seconds - from > 7190) {
    const to = boundaries.reduce((best, at) => at > from + 1 && at <= from + 7190 ? at : best, 0);
    if (!to) throw new Error("A passage or overlapping passage exceeds 120 minutes; split it into shorter passages before exporting.");
    parts.push({ from, to }); from = to;
  }
  parts.push({ from, to: chapter.seconds });
  return parts;
}

/** SPEC-047 R-22–R-28: local chapter delivery, staged, measured and promoted whole.
 * Uses the canonical mix, including Audio Studio edits; no synthesis or lossy player input.
 * Today's ACX guidance recommends 1–5 seconds at both ends (R-23's older head was 0.5 s).
 */
export async function exportAudiobookChapters(store: WorldStore, productionId: string, options: {
  clock: () => string; exportId?: string; scope?: AudiobookScope; signal?: AbortSignal;
  ffmpeg?: FfmpegRunner; tools?: RetailAudioTools; fileSpace?: ImportFileSpace;
  onStep?: (step: string, percent: number) => void;
}): Promise<AudiobookExportResult> {
  if (!options.ffmpeg || !options.tools) return { ok: false, blockers: ["Chapter files need FFmpeg and ffprobe audio tools on this machine."] };
  const signal = AbortSignal.any([options.signal ?? new AbortController().signal, store.closingSignal]);
  const scope = options.scope ?? { kind: "book" };
  const exportId = options.exportId ?? `ab_${ulid()}`;
  if (!/^ab_[0-9A-HJKMNP-TV-Z]{26}$/.test(exportId)) throw new Error("Invalid chapter export id.");
  signal.throwIfAborted();
  const listeningOptions = { ffmpeg: options.ffmpeg, scope, signal, abandoned: signal, mixAll: true, finalAudio: true };
  options.onStep?.("Preparing chapter audio", 0);
  const listening = await audiobookListening(store, productionId, listeningOptions);
  const whole = listening.chapters.filter(chapter => chapter.state === "read");
  if (!whole.length) return { ok: false, blockers: ["No chapter is read whole yet."] };
  // A failed canonical render must never fall back to differently assembled takes.
  if (whole.some(chapter => !chapter.mix)) return { ok: false, blockers: ["A chapter mix could not be rendered. Review its audio before exporting."] };
  const expected = signature(listening.chapters), chapters = whole.map(chapter => ({ chapter, parts: retailParts(chapter) }));
  // The credits as files of their own (SPEC-047 R-216), the opening first and the closing last,
  // for the whole book only: a chapter exported alone is a chapter, not the book.
  const credits = scope.kind === "book" ? await madeAudiobookCredits(store, productionId, await anyNarrator(store, productionId)) : {};
  const lastOrder = Math.max(...whole.map(chapter => chapter.order));
  const creditFiles = ([["opening", "00-OpeningCredits.mp3"], ["closing", `${String(lastOrder + 1).padStart(2, "0")}-ClosingCredits.mp3`]] as const)
    .flatMap(([key, name]) => credits[key] !== undefined ? [{ credit: credits[key] as MadeAudiobookCredit, name }] : []);
  // One delivery profile even when chapters are exported separately. Preserve arranged
  // stereo; upmix legacy mono rather than mixing channel formats across a title.
  const channels = 2;
  const outName = `audiobook-${productionId}-chapters-${exportId}`;
  const staging = await containedWorldFilePath(store.dir, `.staging/audiobook-chapters/${exportId}`, true);
  // Exclusive leaf creation: a repeated id never deletes someone else's work.
  await mkdir(staging);
  const stage = join(staging, "manifest.json");
  const leases: ImportFileLease[] = [];
  try {
    await store.assertOwnership();
    if (options.fileSpace) {
      const estimate = chapters.reduce((sum, entry) => sum + entry.parts.reduce((bytes, part) => bytes + Math.ceil((part.to - part.from + 4) * 24_000) + 65_536, 0), 2 * 1024 ** 2);
      leases.push(await options.fileSpace.reserve(staging, estimate, signal, "working-files"));
      leases.push(await options.fileSpace.reserve(join(store.dir, "exports"), 0, signal, "exports"));
    }
    const sources = new Map<string, Awaited<ReturnType<typeof readPublicationFile>>>();
    for (const chapter of whole) for (const file of new Set([chapter.mix!.file, ...chapter.blocks.map(block => block.file)])) {
      if (!sources.has(file)) sources.set(file, await readPublicationFile(store.dir, file, 4 * 1024 ** 3, signal));
    }
    for (const { credit } of creditFiles) if (!sources.has(credit.file)) sources.set(credit.file, await readPublicationFile(store.dir, credit.file, 4 * 1024 ** 3, signal));
    const files: DeliveredChapter[] = [];
    const delivered: Array<Omit<DeliveredChapter, "chapterId" | "title" | "part"> & { credit: "opening" | "closing" }> = [];
    const total = chapters.reduce((sum, entry) => sum + entry.parts.length, 0) + creditFiles.length;
    // A credit is mastered and checked as a chapter's part is (R-23), from its take whole.
    const masterCredit = async ({ credit, name }: (typeof creditFiles)[number]) => {
      signal.throwIfAborted();
      const label = credit.key === "opening" ? "Opening credits" : "Closing credits";
      options.onStep?.(`Mastering ${label}`, (files.length + delivered.length) / total * 100);
      const input = await containedWorldFilePath(store.dir, credit.file);
      const source = await options.tools!.inspect(input, signal, { from: 0, to: credit.seconds });
      if (!Number.isFinite(source.rmsDb) || source.noiseFloorDb > -60 || Number.isNaN(source.noiseFloorDb)) throw new Error(`${label}: no clean quiet window below -60 dBFS was found in the source; review background noise before exporting.`);
      const from = Math.max(0, source.headSeconds - 0.03), to = credit.seconds - Math.max(0, source.tailSeconds - 0.03);
      const final = await masterRetailFile(options.tools!, input, join(staging, name), { from, to, channels, sourceRmsDb: source.rmsDb }, signal,
        () => options.onStep?.(`Checking ${name}`, (files.length + delivered.length) / total * 100)).catch(error => { throw new Error(`${name}: ${error instanceof Error ? error.message : "Audio validation failed"}.`); });
      const digest = await readPublicationFile(staging, name, 174_000_000, signal);
      await leases[0]?.consumed(digest.byteLength);
      delivered.push({ file: name, credit: credit.key, sha256: digest.sha256, bytes: digest.byteLength,
        measurements: { ...final, noiseFloorDb: Number.isFinite(final.noiseFloorDb) ? final.noiseFloorDb : null }, assertUnchanged: digest.assertUnchanged });
    };
    const opening = creditFiles.find(entry => entry.credit.key === "opening");
    if (opening !== undefined) await masterCredit(opening);
    for (const { chapter, parts } of chapters) {
      const input = await containedWorldFilePath(store.dir, chapter.mix!.file);
      for (const [index, part] of parts.entries()) {
        signal.throwIfAborted();
        options.onStep?.(`Mastering Chapter ${chapter.order}${parts.length > 1 ? ` · part ${index + 1}` : ""}`, files.length / total * 100);
        const source = await options.tools.inspect(input, signal, part);
        if (!Number.isFinite(source.rmsDb) || source.noiseFloorDb > -60 || Number.isNaN(source.noiseFloorDb)) throw new Error(`Chapter ${chapter.order}: no clean quiet window below -60 dBFS was found in the source; review background noise before exporting.`);
        if (source.headSeconds >= 5.9 || source.tailSeconds >= 5.9) throw new Error(`Chapter ${chapter.order}: trim the long quiet beginning or end in Audio Studio before exporting.`);
        const from = part.from + Math.max(0, source.headSeconds - 0.03), to = part.to - Math.max(0, source.tailSeconds - 0.03);
        const name = `${String(chapter.order).padStart(2, "0")}-Chapter${chapter.order}${parts.length > 1 ? `-${index + 1}` : ""}.mp3`;
        const output = join(staging, name);
        const final = await masterRetailFile(options.tools, input, output, { from, to, channels, sourceRmsDb: source.rmsDb }, signal,
          () => options.onStep?.(`Checking ${name}`, files.length / total * 100)).catch(error => { throw new Error(`${name}: ${error instanceof Error ? error.message : "Audio validation failed"}.`); });
        const digest = await readPublicationFile(staging, name, 174_000_000, signal);
        await leases[0]?.consumed(digest.byteLength);
        files.push({ file: name, chapterId: chapter.chapterId, title: chapter.title, part: index + 1, sha256: digest.sha256, bytes: digest.byteLength,
          measurements: { ...final, noiseFloorDb: Number.isFinite(final.noiseFloorDb) ? final.noiseFloorDb : null }, assertUnchanged: digest.assertUnchanged });
      }
    }
    const closing = creditFiles.find(entry => entry.credit.key === "closing");
    if (closing !== undefined) await masterCredit(closing);
    const report = { schemaVersion: 1, kind: "audiobook-chapters", title: listening.title, productionId, scope, chapterIds: whole.map(chapter => chapter.chapterId),
      profile: { codec: "mp3", bitrate: 192000, method: "CBR", sampleRate: 44100, channels },
      review: "Technical checks passed. Noise floor is a quiet-window estimate; listen for editing errors and unwanted noise. Verify credits, spoken headings, retail sample and ACX authorization for AI narration separately.",
      omittedChapterIds: listening.chapters.filter(chapter => chapter.state !== "read").map(chapter => chapter.chapterId),
      sources: [...sources].map(([file, digest]) => ({ file, sha256: digest.sha256 })),
      files: files.map(({ assertUnchanged: _, ...file }) => file),
      ...(delivered.length > 0 ? { credits: delivered.map(({ assertUnchanged: _, ...file }) => file) } : {}),
      provenance: { exportId, exportedAt: options.clock() } };
    const text = JSON.stringify(report, null, 2) + "\n";
    if (Buffer.byteLength(text) > 2 * 1024 ** 2) throw new Error("The chapter validation report exceeds its size limit.");
    await atomicWriteFile(stage, text); await leases[0]?.consumed(Buffer.byteLength(text));
    return await store.gateOp(async () => {
      signal.throwIfAborted();
      const again = await audiobookListening(store, productionId, listeningOptions);
      if (signature(again.chapters) !== expected) throw new Error("The book changed during export; export again.");
      for (const source of sources.values()) await source.assertUnchanged();
      for (const file of [...files, ...delivered]) await file.assertUnchanged();
      signal.throwIfAborted(); await store.assertOwnership();
      const destination = await containedWorldFilePath(store.dir, `exports/${outName}`, true);
      signal.throwIfAborted();
      await rename(staging, destination);
      options.onStep?.("Chapter files ready", 100);
      return { ok: true, id: exportId, dir: `exports/${outName}`, file: `exports/${outName}/manifest.json`, chapters: whole.length, pictures: 0,
        bytes: [...files, ...delivered].reduce((sum, file) => sum + file.bytes, Buffer.byteLength(text)), joined: true, scope, chapterIds: report.chapterIds };
    });
  } catch (error) {
    for (const lease of leases) lease.writeFailed();
    return { ok: false, blockers: [signal.aborted ? "the export was cancelled" : error instanceof Error ? error.message : "Chapter export failed."] };
  } finally {
    try { await rm(staging, { recursive: true, force: true }); }
    finally { await Promise.all(leases.map(lease => lease.settle())); }
  }
}
