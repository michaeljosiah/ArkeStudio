import { createHash } from "node:crypto";
import { AcousticWordsSchema, AGENT_SPEECH_STRETCH_READER, AGENT_TRANSCRIPT_LIMITS, AGENT_TRANSCRIPT_PROFILE, AgentSpeechTranscriptSchema,
  AgentTranscriptTextSchema, type AcousticWords, type AgentSpeechStretch, type AgentSpeechTranscript } from "@arke-studio/contracts";
import { compareAudioTranscript } from "../audio/transcript-comparison.js";
import { readSpeechWav, sliceSpeech, writeSpeechWav } from "../audio/speech-wav.js";
import { halvedStretch, voicedStretches } from "./speech-stretches.js";

/** Only the supervised local Voxa seam is composed here; no provider or cloud fallback. */
export type AgentSpeechReader = (bytes: Uint8Array, signal: AbortSignal) => Promise<AcousticWords>;
/** The same local runtime's text alone, for a stretch whose words it cannot place in time; local like the reader above. */
export type AgentSpeechTextReader = (wav: Uint8Array, signal: AbortSignal) => Promise<string>;
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

/** The words `recognizeAgentSpeech` stops with, so a stop is told the same way wherever in a read it lands. */
const STOPPED = "Speech recognition was stopped or exceeded its deadline";

/**
 * An interval read a stretch at a time, where a voice is likely (speech-stretches.ts). Film sound
 * given whole to the measured reader was refused for one pause over room tone, and the refusal
 * took every word in the interval with it. Here each stretch is read for itself. One the measured
 * reader refuses is halved at its quietest point and each half read, and a piece it still refuses
 * falls to the plain local reader: its text is kept without word
 * times, or the stretch is called silent when that reader hears no words either. Where no voice is
 * found nothing is read at all, and the transcript is empty. The derivative and its hash stay the
 * whole interval's; a reader is given a canonical slice of it.
 */
export async function readAgentSpeech(input: { bytes: Uint8Array; durationSec: number; streamIndex: number;
  sourceStartSec: number; viewStartSec: number; expectedText?: string; read: AgentSpeechReader; readText?: AgentSpeechTextReader;
  signal: AbortSignal }): Promise<AgentSpeechTranscript> {
  input.signal.throwIfAborted();
  if (input.bytes.length > 2_000_000 || !Number.isFinite(input.durationSec) || input.durationSec <= 0 || input.durationSec > 60) throw new Error("Speech derivative exceeds its profile");
  const pcm = readSpeechWav(input.bytes);
  if (pcm.rate !== 16000 || Math.abs(pcm.samples.length / pcm.rate - input.durationSec) > .000001 ||
    !Buffer.from(input.bytes).equals(Buffer.from(writeSpeechWav(pcm)))) throw new Error("Invalid canonical mono speech derivative");
  const expectedText = input.expectedText === undefined ? undefined : AgentTranscriptTextSchema.parse(input.expectedText);
  // One deadline for the interval, however many stretches it holds: to the model this is one call.
  const deadline = new AbortController(), signal = AbortSignal.any([input.signal, deadline.signal]);
  const timer = setTimeout(() => deadline.abort(), AGENT_TRANSCRIPT_LIMITS.timeoutMs);
  let onAbort: () => void = () => {};
  const stopped = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(new Error(STOPPED));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  // Raced only around the plain reader, so a stop at any other moment must not go unhandled.
  stopped.catch(() => {});
  try {
    const stretches: AgentSpeechStretch[] = [], words: AgentSpeechTranscript["words"] = [];
    let engine: AgentSpeechTranscript["engine"];
    // In order, the next to read last: a refused stretch puts its two halves back on top.
    const waiting = voicedStretches(pcm.samples, pcm.rate).stretches.reverse();
    while (waiting.length) {
      const { startSec, endSec } = waiting.pop()!;
      const piece = sliceSpeech(pcm, startSec, endSec), wav = writeSpeechWav(piece);
      const bounds = { startSec, endSec, viewStartSec: input.viewStartSec + startSec, viewEndSec: input.viewStartSec + endSec };
      let timed: AgentSpeechTranscript;
      try {
        timed = await recognizeAgentSpeech({ bytes: wav, durationSec: piece.samples.length / piece.rate, streamIndex: input.streamIndex,
          sourceStartSec: input.sourceStartSec + startSec, viewStartSec: input.viewStartSec + startSec, read: input.read, signal });
      } catch (refusal) {
        if (signal.aborted) throw new Error(STOPPED);
        // Halved before its times are given up, while the transcript has room for one stretch more (speech-stretches.ts says why).
        const halves = stretches.length + waiting.length + 2 <= AGENT_TRANSCRIPT_LIMITS.stretches ? halvedStretch(pcm.samples, pcm.rate, { startSec, endSec }) : null;
        if (halves) { waiting.push(halves[1], halves[0]); continue; }
        // With no plainer reader to turn to, one refused stretch refuses the read, as it always did.
        if (!input.readText) throw refusal;
        let text: string;
        try {
          const raw = await Promise.race([input.readText(wav, signal), stopped]);
          if (typeof raw !== "string" || raw.length > AGENT_TRANSCRIPT_LIMITS.characters) throw new Error("Speech response exceeds its profile");
          text = raw.trim();
        } catch {
          // The plain reader failing too says nothing new: the refusal that sent the stretch to it is the one to report.
          if (signal.aborted) throw new Error(STOPPED);
          throw refusal;
        }
        // Punctuation alone is that reader saying it heard no words.
        const spoken = /[\p{L}\p{N}]/u.test(text);
        stretches.push({ ...bounds, read: spoken ? "text-only" : "silent", text: spoken ? text : "" });
        continue;
      }
      if (!timed.engine || (engine && (engine.id !== timed.engine.id || engine.version !== timed.engine.version || engine.model !== timed.engine.model))) {
        throw new Error("Speech recognizer changed during the read");
      }
      engine = timed.engine;
      stretches.push({ ...bounds, read: "timed", text: timed.text });
      for (const word of timed.words) {
        // On the interval's clock, like every time in the transcript; rounding never leaves a word past its own stretch.
        const from = startSec + word.startSec, to = Math.min(endSec, startSec + word.endSec);
        words.push({ text: word.text, probability: word.probability, startSec: from, endSec: to, sourceStartSec: input.sourceStartSec + from,
          sourceEndSec: input.sourceStartSec + to, viewStartSec: input.viewStartSec + from, viewEndSec: input.viewStartSec + to });
      }
    }
    const text = stretches.map(stretch => stretch.text).filter(Boolean).join(" ");
    if (text.length > AGENT_TRANSCRIPT_LIMITS.characters || words.length > AGENT_TRANSCRIPT_LIMITS.words ||
      text.split(/\s+/u).length > AGENT_TRANSCRIPT_LIMITS.words) throw new Error("Speech response exceeds its profile");
    const derivativeHash = hash(input.bytes);
    return AgentSpeechTranscriptSchema.parse({ streamIndex: input.streamIndex,
      derivative: { profile: AGENT_TRANSCRIPT_PROFILE, hash: derivativeHash, byteLength: input.bytes.length,
        sampleRate: 16000, channels: 1, format: "pcm-s16le-wav", durationSec: input.durationSec },
      ...(engine ? { engine } : {}), text, wordTimeOrigin: "inspection-interval-start", confidence: "uncalibrated-word-probabilities", words, stretches,
      // Compared once, over the whole interval's text, and also when nothing was heard: a review always carries its comparison.
      ...(expectedText === undefined ? {} : { contentReview: { basis: "recognized-speech-text", expectedText,
        expectedTextHash: hash(Buffer.from(expectedText)), comparison: compareAudioTranscript({ audioHash: derivativeHash, authoredText: expectedText,
          observedText: text, transcriber: AGENT_SPEECH_STRETCH_READER }) } }),
    });
  } finally {
    clearTimeout(timer); signal.removeEventListener("abort", onAbort);
  }
}
