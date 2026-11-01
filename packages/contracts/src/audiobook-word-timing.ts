import { z } from "zod";
import { ArtifactIdSchema, IsoDateTimeSchema } from "./ids.js";

export const MEASURED_WORD_TIMING_ENGINE = "whisper.cpp/dtw-word-boundaries-v1";

export const AcousticWordSchema = z
  .object({
    text: z.string().min(1).max(500),
    startSec: z.number().finite().min(0),
    endSec: z.number().finite().positive(),
    probability: z.number().finite().min(0).max(1),
  })
  .strict();
export type AcousticWord = z.infer<typeof AcousticWordSchema>;

export const AcousticWordsSchema = z
  .object({
    text: z.string(),
    seconds: z.number().finite().positive(),
    engine: z
      .object({ id: z.string().min(1), version: z.string().min(1), model: z.string().min(1) })
      .strict(),
    words: z.array(AcousticWordSchema).min(1).max(20000),
  })
  .strict();
export type AcousticWords = z.infer<typeof AcousticWordsSchema>;

export const AudiobookWordTimingSchema = z
  .object({
    artifactId: ArtifactIdSchema,
    audioHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    textHash: z.string().min(1),
    engine: AcousticWordsSchema.shape.engine,
    seconds: z.number().positive(),
    words: z.array(AcousticWordSchema).min(1).max(20000),
    at: IsoDateTimeSchema,
  })
  .strict();
export type AudiobookWordTiming = z.infer<typeof AudiobookWordTimingSchema>;

/** Identity comparison is deliberately conservative: a split's phonetic match is not word timing. */
export function timingWord(text: string): string {
  return text
    .normalize("NFKC")
    .toLocaleLowerCase("en")
    .replace(/[’‘]/g, "'")
    .replace(/[^\p{L}\p{N}']/gu, "")
    .replace(/^'+|'+$/g, "");
}

/** Map only complete, confident acoustic sequences to the author's words; never invent an interval. */
export function validateAcousticWords(
  text: string,
  heard: AcousticWords,
): { ok: true; words: AcousticWord[] } | { ok: false; reason: string } {
  if (heard.engine.id !== MEASURED_WORD_TIMING_ENGINE)
    return { ok: false, reason: "this timing engine does not provide validated word boundaries" };
  const authored: string[] = [];
  let prefix = "";
  for (const token of text.trim().split(/\s+/)) {
    if (timingWord(token) !== "") {
      authored.push(prefix + token);
      prefix = "";
    } else if (authored.length > 0) authored[authored.length - 1] += ` ${token}`;
    else prefix += `${token} `;
  }
  const words = heard.words.filter((word) => timingWord(word.text) !== "");
  let end = 0;
  for (const word of words) {
    if (!(word.startSec >= end - 0.005 && word.endSec > word.startSec && word.endSec <= heard.seconds + 0.02))
      return { ok: false, reason: "word timing overlaps or leaves the reading" };
    if (word.probability < 0.5) return { ok: false, reason: `uncertain timing · ${word.text}` };
    end = word.endSec;
  }
  if (words.length === 0) return { ok: false, reason: "no timed words" };
  const matched: AcousticWord[] = [];
  let cursor = 0;
  for (const token of authored) {
    const first = words[cursor];
    if (first && timingWord(first.text) === timingWord(token)) {
      matched.push({ ...first, text: token }); cursor++; continue;
    }
    // A written compound may arrive as separate words. Only its explicit letter-to-letter
    // hyphens authorize joining; every part must match, with adjoining measured intervals.
    // Never bridge a pause, guess a homophone or join arbitrary words into a different word.
    const parts = token.split(/(?<=\p{L})[-‐‑](?=\p{L})/u).map(timingWord);
    const span = words.slice(cursor, cursor + parts.length);
    if (parts.length > 1 && parts.every(part => /^\p{L}+$/u.test(part)) && span.length === parts.length
      && span.every((word, index) => timingWord(word.text) === parts[index]
        && (index === 0 || Math.abs(word.startSec - span[index - 1]!.endSec) <= 0.005))) {
      matched.push({ ...span[0]!, text: token, endSec: span.at(-1)!.endSec, probability: Math.min(...span.map(word => word.probability)) });
      cursor += parts.length;
    } else return { ok: false, reason: `could not match · ${token}` };
  }
  if (cursor !== words.length) return { ok: false, reason: `could not match ${words.length - cursor} extra words` };
  return { ok: true, words: matched };
}

export const AudiobookWordTimingStateSchema = z
  .object({
    available: z.boolean(),
    reason: z.string().optional(),
    running: z.boolean(),
    runningRequestId: z.string().optional(),
    /** The running operation's scope, independent of the requesting window's current selection. */
    chapters: z.array(z.string()).optional(),
    done: z.number().int().min(0),
    total: z.number().int().min(0),
    blocks: z.array(
      z
        .object({
          chapterId: z.string(),
          key: z.string(),
          label: z.string(),
          file: z.string().optional(),
          text: z.string().optional(),
          fromSec: z.number().min(0).optional(),
          toSec: z.number().positive().optional(),
          words: z.array(AcousticWordSchema).optional(),
          ready: z.boolean(),
          reason: z.string().optional(),
        })
        .strict(),
    ),
  })
  .strict();
export type AudiobookWordTimingState = z.infer<typeof AudiobookWordTimingStateSchema>;
