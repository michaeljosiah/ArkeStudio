import { AudioTranscriptComparisonSchema, FullSha256Schema, type AudioTranscriptComparison } from "@arke-studio/contracts";
import { audioHash } from "./qc.js";
import { readFile } from "node:fs/promises";
import type { WorldStore } from "../world/store.js";
import { atomicWriteFile } from "../world/atomic.js";
import { audioWorldPath } from "./storage.js";

export const AUDIO_TEXT_NORMALIZATION_VERSION = 1;
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

/** The existing local VoiceService.transcribe can supply this seam. Never use a cloud
 * provider here; caller-owned text/voice identity is deliberately absent from the QC cache. */
export async function cachedAudioTranscript(store: WorldStore, input: {
  bytes: Uint8Array; expectedHash: string; authoredText: string;
  transcriber: { id: string; version: string; transcribe: (bytes: Uint8Array, contentType: string) => Promise<string> } | null;
}): Promise<AudioTranscriptComparison> {
  if (audioHash(input.bytes) !== input.expectedHash) throw new Error("audio-source-changed");
  const transcriber = input.transcriber ?? { id: "not-configured", version: "1" };
  if (!input.transcriber || !input.authoredText.trim()) return compareAudioTranscript({ audioHash: input.expectedHash,
    authoredText: input.authoredText, transcriber });
  return store.gateOp(async () => {
    const key = transcriptCacheKey(input.expectedHash, input.authoredText, transcriber);
    const path = await audioWorldPath(store.dir, `.cache/audio-transcripts/${key}`, true);
    const cached = await readFile(path, "utf8").then(text => AudioTranscriptComparisonSchema.parse(JSON.parse(text))).catch(() => null);
    const targetTextHash = audioHash(Buffer.from(input.authoredText));
    if (cached?.status === "compared" && cached.audioHash === input.expectedHash && cached.targetTextHash === targetTextHash &&
      cached.transcriber.id === transcriber.id && cached.transcriber.version === transcriber.version &&
      cached.transcriber.normalizationVersion === AUDIO_TEXT_NORMALIZATION_VERSION) return cached;
    let observedText: string;
    try { observedText = await input.transcriber!.transcribe(input.bytes, "audio/wav"); }
    catch { return compareAudioTranscript({ audioHash: input.expectedHash, authoredText: input.authoredText,
      transcriber, unavailableReason: "stt-failed" }); }
    if (store.closingSignal.aborted) throw new Error("audio-cancelled");
    const comparison = compareAudioTranscript({ audioHash: input.expectedHash, authoredText: input.authoredText, transcriber, observedText });
    await atomicWriteFile(path, JSON.stringify(comparison));
    return comparison;
  });
}
