import { frameLevels, readSpeechWav, silenceThreshold, sliceSpeech, speechSeconds, writeSpeechWav, type SpeechPcm } from "../audio/speech-wav.js";

/**
 * Word times for a grouped request, on this machine (design turn 185): what the split cuts by.
 *
 * Voxa's whisper answers `/stt` with text alone, so the times come from the audio: the request is
 * cut at its pauses, each stretch between pauses is transcribed, and its words are spread across
 * the stretch by their length. A block's turn ends at a pause — the reader takes a breath between
 * one block and the next — so every boundary the split needs is the edge of a stretch, timed by
 * the audio itself; a word's place inside a stretch is an estimate, and only a cut that fell
 * inside one would lean on it, which the words check then catches.
 */
export interface TimedWord {
  text: string;
  start: number;
  end: number;
}

/** A pause long enough to be between sentences or turns, not inside a word. */
export const PAUSE_SEC = 0.15;
/** Whisper drops shorter stretches as blips, so they ride with a neighbour. */
export const MIN_STRETCH_SEC = 0.45;
/** Whisper hears in 30 s windows; a stretch longer than this is cut at its quietest moment near the middle. */
export const MAX_STRETCH_SEC = 24;

/** The stretches of speech between pauses, in seconds, each at least long enough to transcribe. */
export function speechStretches(pcm: SpeechPcm): Array<{ start: number; end: number }> {
  const levels = frameLevels(pcm);
  const threshold = silenceThreshold(levels);
  const frame = 0.01;
  const minPause = Math.round(PAUSE_SEC / frame);
  const spans: Array<{ start: number; end: number }> = [];
  let open = -1;
  let quiet = 0;
  for (let i = 0; i < levels.length; i++) {
    if (levels[i]! >= threshold) {
      if (open < 0) open = i;
      quiet = 0;
    } else if (open >= 0) {
      quiet += 1;
      if (quiet >= minPause) {
        spans.push({ start: open * frame, end: (i - quiet + 1) * frame });
        open = -1;
        quiet = 0;
      }
    }
  }
  if (open >= 0) spans.push({ start: open * frame, end: (levels.length - quiet) * frame });
  // A blip rides with the neighbour across the shorter pause.
  for (let i = 0; i < spans.length && spans.length > 1;) {
    const span = spans[i]!;
    if (span.end - span.start >= MIN_STRETCH_SEC) {
      i += 1;
      continue;
    }
    const before = i > 0 ? span.start - spans[i - 1]!.end : Infinity;
    const after = i + 1 < spans.length ? spans[i + 1]!.start - span.end : Infinity;
    if (before <= after) {
      spans[i - 1]!.end = span.end;
      spans.splice(i, 1);
    } else {
      spans[i + 1]!.start = span.start;
      spans.splice(i, 1);
    }
  }
  // A stretch past whisper's window is cut at its quietest frame between a third and two thirds.
  const out: Array<{ start: number; end: number }> = [];
  const stack = [...spans].reverse();
  while (stack.length > 0) {
    const span = stack.pop()!;
    if (span.end - span.start <= MAX_STRETCH_SEC) {
      out.push(span);
      continue;
    }
    const from = Math.round((span.start + (span.end - span.start) / 3) / frame);
    const to = Math.round((span.start + ((span.end - span.start) * 2) / 3) / frame);
    let at = from;
    for (let i = from; i < to; i++) if (levels[i]! < levels[at]!) at = i;
    stack.push({ start: at * frame, end: span.end }, { start: span.start, end: at * frame });
  }
  return out;
}

/** Each stretch transcribed and its words spread across it by their length. */
export async function timeWords(
  wav: Uint8Array,
  transcribe: (bytes: Uint8Array, contentType: string) => Promise<string>,
  signal?: AbortSignal,
): Promise<{ words: TimedWord[]; seconds: number }> {
  const pcm = readSpeechWav(wav);
  const words: TimedWord[] = [];
  for (const stretch of speechStretches(pcm)) {
    if (signal?.aborted) throw new Error("stopped");
    // A little of the pause either side, so whisper hears the word's onset and release.
    const piece = sliceSpeech(pcm, stretch.start - 0.05, stretch.end + 0.05);
    let text = "";
    try {
      text = await transcribe(writeSpeechWav(piece), "audio/wav");
    } catch {
      // Heard as nothing: the words check says so for the block this stretch belongs to.
    }
    const heard = text.trim().split(/\s+/).filter((word) => word !== "");
    const weight = heard.reduce((sum, word) => sum + word.length, 0);
    let at = stretch.start;
    for (const word of heard) {
      const length = ((stretch.end - stretch.start) * word.length) / Math.max(1, weight);
      words.push({ text: word, start: at, end: at + length });
      at += length;
    }
  }
  return { words, seconds: speechSeconds(pcm) };
}
