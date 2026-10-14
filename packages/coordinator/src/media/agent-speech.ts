import { createHash } from "node:crypto";
import { AcousticWordsSchema, AGENT_TRANSCRIPT_LIMITS, AGENT_TRANSCRIPT_PROFILE, AgentSpeechTranscriptSchema,
  AgentTranscriptTextSchema, type AcousticWords, type AgentSpeechTranscript } from "@arke-studio/contracts";
import { compareAudioTranscript } from "../audio/transcript-comparison.js";
import { readSpeechWav, writeSpeechWav } from "../audio/speech-wav.js";

/** Only the supervised local Voxa seam is composed here; no provider or cloud fallback. */
export type AgentSpeechReader = (bytes: Uint8Array, signal: AbortSignal) => Promise<AcousticWords>;
const hash = (bytes: Uint8Array) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

export async function recognizeAgentSpeech(input: { bytes: Uint8Array; durationSec: number; streamIndex: number;
  sourceStartSec: number; viewStartSec: number; expectedText?: string; read: AgentSpeechReader; signal: AbortSignal }): Promise<AgentSpeechTranscript> {
  input.signal.throwIfAborted();
  if (input.bytes.length > 2_000_000 || !Number.isFinite(input.durationSec) || input.durationSec <= 0 || input.durationSec > 60) throw new Error("Speech derivative exceeds its profile");
  const pcm = readSpeechWav(input.bytes);
  if (pcm.rate !== 16000 || Math.abs(pcm.samples.length / pcm.rate - input.durationSec) > .000001 ||
    !Buffer.from(input.bytes).equals(Buffer.from(writeSpeechWav(pcm)))) throw new Error("Invalid canonical mono speech derivative");
  const deadline = new AbortController(), signal = AbortSignal.any([input.signal, deadline.signal]);
  const timer = setTimeout(() => deadline.abort(), AGENT_TRANSCRIPT_LIMITS.timeoutMs);
  let onAbort: () => void = () => {};
  const stopped = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(new Error("Speech recognition was stopped or exceeded its deadline"));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    const raw = await Promise.race([input.read(input.bytes, signal), stopped]);
    signal.throwIfAborted();
    // Bound before parsing/copying the sidecar response, then validate measured coverage.
    if (typeof raw?.text !== "string" || raw.text.length > AGENT_TRANSCRIPT_LIMITS.characters ||
      !Array.isArray(raw.words) || raw.words.length > AGENT_TRANSCRIPT_LIMITS.words) throw new Error("Speech response exceeds its profile");
    const heard = AcousticWordsSchema.parse(raw), text = AgentTranscriptTextSchema.parse(heard.text);
    if (Math.abs(heard.seconds - input.durationSec) > .025) throw new Error("Recognizer duration does not match the derivative");
    const derivativeHash = hash(input.bytes);
    const expectedText = input.expectedText === undefined ? undefined : AgentTranscriptTextSchema.parse(input.expectedText);
    return AgentSpeechTranscriptSchema.parse({ streamIndex: input.streamIndex,
      derivative: { profile: AGENT_TRANSCRIPT_PROFILE, hash: derivativeHash, byteLength: input.bytes.length,
        sampleRate: 16000, channels: 1, format: "pcm-s16le-wav", durationSec: input.durationSec },
      engine: heard.engine, text, wordTimeOrigin: "inspection-interval-start", confidence: "uncalibrated-word-probabilities",
      words: heard.words.map(word => ({ ...word, sourceStartSec: input.sourceStartSec + word.startSec,
        sourceEndSec: input.sourceStartSec + word.endSec, viewStartSec: input.viewStartSec + word.startSec, viewEndSec: input.viewStartSec + word.endSec })),
      ...(expectedText === undefined ? {} : { contentReview: { basis: "recognized-speech-text", expectedText,
        expectedTextHash: hash(Buffer.from(expectedText)), comparison: compareAudioTranscript({ audioHash: derivativeHash, authoredText: expectedText,
          observedText: text, transcriber: heard.engine }) } }),
    });
  } finally {
    clearTimeout(timer); signal.removeEventListener("abort", onAbort);
  }
}
