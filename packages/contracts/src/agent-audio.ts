import { z } from "zod";
import { AudioTranscriptComparisonSchema, FullSha256Schema } from "./audio.js";
import { MEASURED_WORD_TIMING_ENGINE, timingWord } from "./audiobook-word-timing.js";

export const AGENT_AUDIO_SCHEMA_VERSION = 80;
/**
 * A transcript read in stretches. A build before it holds every speech receipt to one timed read
 * (an engine, text and a word) in a strict journal and would refuse the conversation, so the world
 * is raised with the first such receipt. (150 follows 149, the board target; no open branch held it.)
 */
export const AGENT_SPEECH_STRETCHES_SCHEMA_VERSION = 150;
export const AGENT_TRANSCRIPT_PROFILE = "arke-stt-16khz-mono-v1";
export const AGENT_TRANSCRIPT_LIMITS = Object.freeze({ characters: 12000, words: 1000, calls: 4, timeoutMs: 120000, stretches: 12 });
/** What a stretch read's script comparison names: its text can come from two local readers, so no one engine made it. */
export const AGENT_SPEECH_STRETCH_READER = Object.freeze({ id: "arke-speech-stretches-v1", version: "1" });
export const AgentTranscriptTextSchema = z.string().trim().min(1).max(AGENT_TRANSCRIPT_LIMITS.characters)
  .refine(text => text.split(/\s+/u).length <= AGENT_TRANSCRIPT_LIMITS.words, "Speech text exceeds its word budget");
const time = z.number().finite().min(0);
/**
 * One stretch of an inspected interval where a voice was likely, and how it was read. Film sound
 * is not a clean read: the measured reader refuses a whole window for one pause over room tone,
 * and a 15-second clip came back with nothing. So the interval is read a stretch at a time, and
 * each says what it got: `timed` holds measured words, `text-only` the plain local reader's text
 * where the words could not be placed in time, `silent` a stretch neither reader heard a word in.
 */
export const AgentSpeechStretchSchema = z.object({ startSec: time, endSec: time, viewStartSec: time, viewEndSec: time,
  read: z.enum(["timed", "text-only", "silent"]), text: z.string().max(AGENT_TRANSCRIPT_LIMITS.characters) }).strict();
export type AgentSpeechStretch = z.infer<typeof AgentSpeechStretchSchema>;
export const AgentSpeechTranscriptSchema = z.object({
  streamIndex: z.number().int().min(0).max(255),
  derivative: z.object({ profile: z.literal(AGENT_TRANSCRIPT_PROFILE), hash: FullSha256Schema,
    byteLength: z.number().int().positive().max(2_000_000), sampleRate: z.literal(16000), channels: z.literal(1),
    format: z.literal("pcm-s16le-wav"), durationSec: z.number().finite().positive().max(60) }).strict(),
  /** Absent only from a stretch read in which nothing was timed. */
  engine: z.object({ id: z.literal(MEASURED_WORD_TIMING_ENGINE), version: z.string().min(1).max(200), model: z.string().min(1).max(200) }).strict().optional(),
  text: z.union([AgentTranscriptTextSchema, z.literal("")]),
  wordTimeOrigin: z.literal("inspection-interval-start"),
  confidence: z.literal("uncalibrated-word-probabilities"),
  words: z.array(z.object({ text: z.string().min(1).max(500).refine(text => !!text.trim(), "A timed word cannot be blank"), startSec: time, endSec: time,
    probability: z.number().finite().min(0).max(1),
    sourceStartSec: time, sourceEndSec: time, viewStartSec: time, viewEndSec: time }).strict()).max(AGENT_TRANSCRIPT_LIMITS.words),
  /** In order, from schema 150; empty when no voice was found. A receipt without it is one timed read of the whole interval. */
  stretches: z.array(AgentSpeechStretchSchema).max(AGENT_TRANSCRIPT_LIMITS.stretches).optional(),
  contentReview: z.object({ basis: z.literal("recognized-speech-text"), expectedText: AgentTranscriptTextSchema,
    expectedTextHash: FullSha256Schema, comparison: AudioTranscriptComparisonSchema }).strict().optional(),
}).strict().superRefine((value, context) => {
  const issue = (message: string) => context.addIssue({ code: z.ZodIssueCode.custom, message });
  // A timed quotation must come from the same recognized content the model receives.
  const agree = (text: string, words: ReadonlyArray<{ text: string }>) => {
    const recognized = text.trim().split(/\s+/u).map(timingWord).filter(Boolean), timed = words.map(word => timingWord(word.text)).filter(Boolean);
    return recognized.length > 0 && recognized.length === timed.length && recognized.every((word, index) => word === timed[index]);
  };
  if (!value.stretches) {
    // Before stretches every read was timed whole, and its receipt is held to what it was written under: an engine, text and a word.
    if (!value.engine) issue("A transcript without stretches names its recognizer");
    if (!agree(value.text, value.words)) issue("Recognized text and timed words disagree");
  } else {
    let end = 0, next = 0;
    for (const stretch of value.stretches) {
      if (stretch.endSec <= stretch.startSec || stretch.startSec < end - .000001 || stretch.endSec > value.derivative.durationSec + .000001) {
        issue("Speech stretches must be ordered, apart and inside decoded audio");
      }
      end = stretch.endSec;
      const first = next;
      while (next < value.words.length && value.words[next]!.startSec >= stretch.startSec - .000001 && value.words[next]!.endSec <= stretch.endSec + .000001) next++;
      // Only a timed stretch holds words, and its text is theirs; a silent one has nothing to say.
      if (stretch.text !== stretch.text.trim() || (stretch.read === "timed" ? !agree(stretch.text, value.words.slice(first, next))
        : next > first || (stretch.read === "silent") !== (stretch.text === ""))) {
        issue("A speech stretch's text and timed words must match how it was read");
      }
    }
    if (next < value.words.length) issue("Every timed word must lie inside a timed stretch");
    if (value.text !== value.stretches.map(stretch => stretch.text).filter(Boolean).join(" ")) issue("Recognized text must be its stretches' text in order");
    if (!value.engine !== !value.stretches.some(stretch => stretch.read === "timed")) issue("A recognizer is named exactly when a stretch was timed");
  }
  if (value.words.reduce((count, word) => count + word.text.length, 0) > AGENT_TRANSCRIPT_LIMITS.characters) {
    issue("Timed speech text exceeds its character budget");
  }
  let previous = 0;
  for (const word of value.words) {
    if (word.endSec <= word.startSec || word.startSec < previous - .005 || word.endSec > value.derivative.durationSec + .000001) {
      issue("Recognition word bounds must be ordered and inside decoded audio");
    }
    previous = word.endSec;
  }
  const comparison = value.contentReview?.comparison, transcriber = value.stretches ? AGENT_SPEECH_STRETCH_READER : value.engine;
  if (comparison && (comparison.status !== "compared" || comparison.audioHash !== value.derivative.hash ||
    comparison.targetTextHash !== value.contentReview!.expectedTextHash || comparison.observedText !== value.text ||
    comparison.transcriber.id !== transcriber?.id || comparison.transcriber.version !== transcriber?.version)) {
    issue("Speech comparison must cite the recognized derivative and its reader");
  }
});
export type AgentSpeechTranscript = z.infer<typeof AgentSpeechTranscriptSchema>;
