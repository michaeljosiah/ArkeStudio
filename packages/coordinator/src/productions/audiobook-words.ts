import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { audiobookTextHash, type AudiobookWordsRow, type AudiobookWordsState } from "@arke-studio/contracts";
import { audioHash } from "../audio/qc.js";
import { audioWorldPath } from "../audio/storage.js";
import { readAudioBytes, type AudioMediaTools } from "../audio/media-tools.js";
import { cachedAudioTranscript, readAudioTranscriptCache, type AudioTranscriberIdentity } from "../audio/transcript-comparison.js";
import type { WorldStore } from "../world/store.js";
import { planAudiobook } from "./audiobook.js";
import { anyNarrator } from "./audiobook-listening.js";

export interface AudiobookWordsScope {
  productionId: string;
  chapters?: string[];
  blocks?: { chapterId: string; key: string }[];
}
export interface AudiobookWordsDeps {
  identity: (signal: AbortSignal) => Promise<AudioTranscriberIdentity | null>;
  transcribe: (audio: Uint8Array, contentType: string, signal: AbortSignal) => Promise<string>;
  tools?: AudioMediaTools;
}

const sameIdentity = (a: AudioTranscriberIdentity | null, b: AudioTranscriberIdentity | null) =>
  a !== null && b !== null && a.id === b.id && a.version === b.version;
const unavailable = "local transcription is unavailable · check Voxa in Settings";
const reason = (error: unknown): string => {
  const text = error instanceof Error ? error.message : "";
  return ["the reading or words changed · check again", "the local recognizer changed · check again", "this block has no current reading",
    "this reading exceeds 10 minutes", "this block exceeds 2,000 words", "this reading is unavailable", "this chapter could not be read"].includes(text) ? text : unavailable;
};

/** Every check starts from the currently selected take, not a historical artifact with a similar title. */
async function currentSource(store: WorldStore, productionId: string, chapterId: string, key: string, signal: AbortSignal) {
  signal.throwIfAborted();
  const plan = await planAudiobook(store, productionId, chapterId, { narrator: await anyNarrator(store, productionId) });
  const block = plan.blocks.find(entry => entry.block.key === key)?.block;
  const take = plan.record !== "unreadable" ? plan.record?.takes[key] : undefined;
  const artifact = take ? store.getBundle().artifacts.find(entry => entry.id === take.artifactId) : undefined;
  if (!block || !take || !artifact || !plan.present.has(take.artifactId) || take.textHash !== audiobookTextHash(block.text))
    throw new Error("this block has no current reading");
  if (block.text.length > 100_000 || block.text.trim().split(/\s+/u).length > 2000) throw new Error("this block exceeds 2,000 words");
  const path = await audioWorldPath(store.dir, `artifacts/${artifact.file}`);
  const bytes = await readAudioBytes(path, signal);
  const hash = audioHash(bytes);
  if (!hash.startsWith(artifact.hash)) throw new Error("this reading is unavailable");
  return { text: block.text, artifactId: take.artifactId, hash, bytes, path };
}

/** A current projection reads derived evidence only. Missing/unreadable chapters remain in coverage. */
export async function readAudiobookWords(store: WorldStore, scope: AudiobookWordsScope,
  identity: AudioTranscriberIdentity | null, signal: AbortSignal): Promise<AudiobookWordsState> {
  const production = store.getBundle().productions.find(entry => entry.meta.id === scope.productionId);
  const chapters = (production?.chapters ?? []).filter(chapter => !chapter.retired &&
    (scope.chapters === undefined || scope.chapters.includes(chapter.id)) &&
    (scope.blocks === undefined || scope.blocks.some(block => block.chapterId === chapter.id))).sort((a, b) => a.order - b.order);
  const rows: AudiobookWordsRow[] = [];
  for (const chapter of chapters) {
    signal.throwIfAborted();
    try {
      const plan = await planAudiobook(store, scope.productionId, chapter.id, { narrator: await anyNarrator(store, scope.productionId) });
      if (plan.record === "unreadable") throw new Error("this chapter could not be read");
      for (const [index, planned] of plan.blocks.entries()) {
        const key = planned.block.key;
        if (scope.blocks !== undefined && !scope.blocks.some(block => block.chapterId === chapter.id && block.key === key)) continue;
        const row: AudiobookWordsRow = { chapterId: chapter.id, chapterTitle: chapter.title, key,
          label: key === "title" ? "Title" : `Block ${index + 1}`, text: planned.block.text };
        try {
          const source = await currentSource(store, scope.productionId, chapter.id, key, signal);
          row.artifactId = source.artifactId;
          if (identity !== null) {
            const comparison = await readAudioTranscriptCache(store, { expectedHash: source.hash, authoredText: source.text, transcriber: identity });
            if (comparison !== null) row.comparison = comparison;
          }
        } catch (error) { signal.throwIfAborted(); row.reason = reason(error); }
        rows.push(row);
      }
    } catch (error) {
      signal.throwIfAborted();
      rows.push({ chapterId: chapter.id, chapterTitle: chapter.title, key: "chapter-unavailable", label: "Chapter", text: "", reason: reason(error) });
    }
  }
  for (const chapterId of new Set([...(scope.chapters ?? []), ...(scope.blocks?.map(block => block.chapterId) ?? [])])) {
    if (!chapters.some(chapter => chapter.id === chapterId)) rows.push({ chapterId, chapterTitle: chapterId,
      key: "chapter-unavailable", label: "Chapter", text: "", reason: "this chapter could not be read" });
  }
  for (const wanted of scope.blocks ?? []) {
    if (chapters.some(chapter => chapter.id === wanted.chapterId) && !rows.some(row => row.chapterId === wanted.chapterId &&
      (row.key === wanted.key || row.key === "chapter-unavailable"))) rows.push({ chapterId: wanted.chapterId,
      chapterTitle: chapters.find(chapter => chapter.id === wanted.chapterId)!.title, key: wanted.key,
      label: "Block", text: "", reason: "this block has no current reading" });
  }
  return { available: identity !== null, ...(identity === null ? { reason: "local recognizer identity is unavailable · check Voxa in Settings" } : {}),
    ...(production === undefined ? { reason: "this book could not be read" } : {}),
    running: false, done: 0, total: rows.length, chapters: [...new Set(rows.map(row => row.chapterId))], rows };
}

/** One ordinary, serial author action. Successful fresh comparisons resume from cache; stop,
 * close and source changes cannot turn an old recording's result into a current pass. */
export async function checkAudiobookWords(store: WorldStore, scope: AudiobookWordsScope, deps: AudiobookWordsDeps,
  signal: AbortSignal, update: (state: AudiobookWordsState) => void): Promise<AudiobookWordsState> {
  const identity = await deps.identity(signal);
  const state = await readAudiobookWords(store, scope, identity, signal);
  if (identity === null || deps.tools === undefined) {
    return { ...state, available: false, reason: identity === null ? state.reason! : "local audio preparation is unavailable" };
  }
  state.running = true;
  update({ ...state, rows: [...state.rows] });
  try {
    for (const [index, row] of state.rows.entries()) {
      signal.throwIfAborted();
      if (row.comparison?.status !== "compared" && row.artifactId !== undefined) {
        try {
          const source = await currentSource(store, scope.productionId, row.chapterId, row.key, signal);
          const verify = async () => {
            signal.throwIfAborted();
            const fresh = await currentSource(store, scope.productionId, row.chapterId, row.key, signal);
            if (fresh.artifactId !== source.artifactId || fresh.hash !== source.hash || fresh.text !== source.text)
              throw new Error("the reading or words changed · check again");
            if (!sameIdentity(identity, await deps.identity(signal))) throw new Error("the local recognizer changed · check again");
          };
          const comparison = await cachedAudioTranscript(store, { bytes: source.bytes, expectedHash: source.hash, authoredText: source.text,
            signal, beforeWrite: verify, transcriber: { ...identity, transcribe: async () => {
              const deadline = AbortSignal.any([signal, AbortSignal.timeout(120_000)]);
              const probed = await deps.tools!.probe({ absolutePath: source.path, expectedHash: source.hash, signal: deadline });
              if (!probed.hasAudio || probed.technical.durationSec === null || probed.technical.durationSec <= 0) throw new Error("this reading is unavailable");
              if (probed.technical.durationSec > 600) throw new Error("this reading exceeds 10 minutes");
              const dir = await mkdtemp(join(tmpdir(), "arke-words-"));
              try {
                const file = join(dir, "prepared.wav");
                await deps.tools!.preparePcmWav({ sourcePath: source.path, expectedSourceHash: source.hash, destinationPath: file, signal: deadline });
                return await deps.transcribe(await readAudioBytes(file, deadline), "audio/wav", deadline);
              } finally { await rm(dir, { recursive: true, force: true }); }
            } } });
          await verify();
          state.rows[index] = { ...row, artifactId: source.artifactId, text: source.text, comparison };
        } catch (error) {
          signal.throwIfAborted();
          const { comparison: _old, ...bare } = row;
          state.rows[index] = { ...bare, reason: reason(error) };
        }
      }
      state.done++;
      update({ ...state, rows: [...state.rows] });
    }
  } finally { state.running = false; }
  const currentIdentity = await deps.identity(signal);
  if (!sameIdentity(identity, currentIdentity)) return { ...state, available: false, reason: "the local recognizer changed · check again",
    rows: state.rows.map(({ comparison: _previous, ...row }) => ({ ...row, reason: "the local recognizer changed · check again" })) };
  const fresh = await readAudiobookWords(store, scope, identity, signal);
  // A failed cache write is still an unavailable attempt in this response, not a silently
  // unchecked row. Reopened coverage only claims durable evidence that actually exists.
  fresh.rows = fresh.rows.map(row => {
    const attempted = state.rows.find(previous => previous.chapterId === row.chapterId && previous.key === row.key);
    return row.comparison === undefined && row.reason === undefined && attempted?.reason !== undefined &&
      row.artifactId === attempted.artifactId && row.text === attempted.text ? { ...row, reason: attempted.reason } : row;
  });
  return { ...fresh, done: Math.min(state.done, fresh.total) };
}
