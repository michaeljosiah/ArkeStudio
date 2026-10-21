import { AudioTranscriptComparisonSchema, FullSha256Schema, type AudioTranscriptComparison } from "@arke-studio/contracts";
import { audioHash } from "./qc.js";
import { readFile, stat } from "node:fs/promises";
import type { WorldStore } from "../world/store.js";
import { atomicWriteFile } from "../world/atomic.js";
import { audioWorldPath } from "./storage.js";

export const AUDIO_TEXT_NORMALIZATION_VERSION = 1;
export interface AudioTranscriberIdentity { id: string; version: string }
export interface AudioTranscriber extends AudioTranscriberIdentity {
  transcribe: (bytes: Uint8Array, contentType: string, signal?: AbortSignal) => Promise<string>;
}
/** NFKC + whitespace only: punctuation/case differences remain reviewable, never rewritten. */
const normalize = (text: string) => text.normalize("NFKC").trim().replace(/\s+/gu, " ");
export function transcriptCacheKey(audio: string, text: string, transcriber: { id: string; version: string }): string {
  const target = audioHash(Buffer.from(text));
  const engine = audioHash(Buffer.from(JSON.stringify(transcriber))).slice(7);
  return `${FullSha256Schema.parse(audio).slice(7)}/${target.slice(7)}-${engine}-n${AUDIO_TEXT_NORMALIZATION_VERSION}.json`;
}
export function compareAudioTranscript(input: { audioHash: string; authoredText: string;
  observedText?: string; transcriber: { id: string; version: string }; unavailableReason?: "stt-not-configured" | "stt-failed" }): AudioTranscriptComparison {
  const base = { audioHash: FullSha256Schema.parse(input.audioHash), targetTextHash: audioHash(Buffer.from(input.authoredText)) };
  if (!input.authoredText.trim() || input.observedText === undefined) {
    return AudioTranscriptComparisonSchema.parse({ status: "unavailable", ...base,
      reason: !input.authoredText.trim() ? "no-authored-text" : input.unavailableReason ?? "stt-not-configured" });
  }
  const authored = normalize(input.authoredText), observed = normalize(input.observedText);
  // A bounded word LCS supplies deterministic spans without inventing acoustic timestamps.
  const a = authored ? authored.split(" ") : [], b = observed ? observed.split(" ") : [];
  if (a.length > 2000 || b.length > 2000) throw new Error("audio-text-too-large");
  const width = b.length + 1, dp = new Uint16Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) {
    dp[i * width + j] = a[i] === b[j] ? 1 + dp[(i + 1) * width + j + 1]! :
      Math.max(dp[(i + 1) * width + j]!, dp[i * width + j + 1]!);
  }
  const differences: Array<{ kind: "inserted" | "omitted" | "changed"; authored: string; observed: string }> = [];
  let i = 0, j = 0, removed: string[] = [], added: string[] = [];
  const flush = () => {
    if (removed.length || added.length) differences.push({ kind: removed.length ? added.length ? "changed" : "omitted" : "inserted",
      authored: removed.join(" "), observed: added.join(" ") });
    removed = []; added = [];
  };
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) { flush(); i++; j++; }
    else if (j < b.length && (i === a.length || dp[i * width + j + 1]! > dp[(i + 1) * width + j]!)) added.push(b[j++]!);
    else removed.push(a[i++]!);
  }
  flush();
  return AudioTranscriptComparisonSchema.parse({ status: "compared", ...base, transcriber: { id: input.transcriber.id, version: input.transcriber.version,
    normalizationVersion: AUDIO_TEXT_NORMALIZATION_VERSION }, observedText: input.observedText,
    result: authored === observed ? "exact" : "mismatch", differences, boundaryAlignment: "unavailable" });
}

/** Reading a cache never invokes recognition. Unavailable entries remain evidence, not hits
 * that prevent an explicit retry. Old or malformed entries simply remain unchecked. */
export async function readAudioTranscriptCache(store: WorldStore, input: {
  expectedHash: string; authoredText: string; transcriber: AudioTranscriberIdentity;
}): Promise<AudioTranscriptComparison | null> {
  const key = transcriptCacheKey(input.expectedHash, input.authoredText, input.transcriber);
  const path = await audioWorldPath(store.dir, `.cache/audio-transcripts/${key}`).catch(() => null);
  if (path === null) return null;
  const size = (await stat(path).catch(() => null))?.size;
  if (size === undefined || size > 256_000) return null;
  const cached = await readFile(path, "utf8").then(text => text.length > 256_000 ? null : AudioTranscriptComparisonSchema.parse(JSON.parse(text))).catch(() => null);
  if (cached?.audioHash !== input.expectedHash || cached.targetTextHash !== audioHash(Buffer.from(input.authoredText))) return null;
  if (cached.status === "compared" && (cached.transcriber.id !== input.transcriber.id || cached.transcriber.version !== input.transcriber.version ||
    cached.transcriber.normalizationVersion !== AUDIO_TEXT_NORMALIZATION_VERSION)) return null;
  return cached;
}

/** The existing local VoiceService.transcribe supplies this seam. Inference runs outside the
 * world gate; only the checked result is written under ownership, after caller freshness. */
export async function cachedAudioTranscript(store: WorldStore, input: {
  bytes: Uint8Array; expectedHash: string; authoredText: string;
  transcriber: AudioTranscriber | null;
  signal?: AbortSignal;
  beforeWrite?: () => Promise<void>;
}): Promise<AudioTranscriptComparison> {
  const signal = input.signal ? AbortSignal.any([input.signal, store.closingSignal]) : store.closingSignal;
  signal.throwIfAborted();
  if (audioHash(input.bytes) !== input.expectedHash) throw new Error("audio-source-changed");
  const transcriber = input.transcriber ?? { id: "not-configured", version: "1" };
  if (!input.transcriber || !input.authoredText.trim()) return compareAudioTranscript({ audioHash: input.expectedHash,
    authoredText: input.authoredText, transcriber });
  const cached = await readAudioTranscriptCache(store, { ...input, transcriber });
  if (cached?.status === "compared") { signal.throwIfAborted(); await input.beforeWrite?.(); return cached; }
  let comparison: AudioTranscriptComparison;
  try {
    const observedText = await input.transcriber.transcribe(input.bytes, "audio/wav", signal);
    signal.throwIfAborted();
    if (typeof observedText !== "string" || observedText.length > 100_000) throw new Error("audio-text-too-large");
    comparison = compareAudioTranscript({ audioHash: input.expectedHash, authoredText: input.authoredText, transcriber, observedText });
  } catch {
    signal.throwIfAborted();
    comparison = compareAudioTranscript({ audioHash: input.expectedHash, authoredText: input.authoredText, transcriber, unavailableReason: "stt-failed" });
  }
  await store.derivedWrite(async () => {
    signal.throwIfAborted();
    await input.beforeWrite?.();
    signal.throwIfAborted();
    const key = transcriptCacheKey(input.expectedHash, input.authoredText, transcriber);
    const path = await audioWorldPath(store.dir, `.cache/audio-transcripts/${key}`, true);
    await atomicWriteFile(path, JSON.stringify(comparison));
  });
  return comparison;
}
