import { frameLevels, PAUSE_SEC, readSpeechWav, runawayTailIndex, sliceSpeech, soundSpans, speechSeconds, writeSpeechWav, type SpeechPcm } from "../audio/speech-wav.js";

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

export { PAUSE_SEC };
/** Whisper drops shorter stretches as blips, so they ride with a neighbour. */
export const MIN_STRETCH_SEC = 0.45;
/** Whisper hears in 30 s windows; a stretch longer than this is cut at its quietest moment near the middle. */
export const MAX_STRETCH_SEC = 24;

/** The stretches of speech between pauses, in seconds, each at least long enough to transcribe. */
export function speechStretches(pcm: SpeechPcm): Array<{ start: number; end: number }> {
  const levels = frameLevels(pcm);
  const frame = 0.01;
  const raw = soundSpans(pcm);
  const short = (span: { start: number; end: number }) => span.end - span.start < MIN_STRETCH_SEC;
  // A blip rides with a neighbour that is speech, across the shorter pause. It used to ride with
  // any neighbour, blips included, and a runaway tail of blips (the turn 185 probe's 26 s after a
  // `<chuckle>`) chained itself onto the last words: their times were spread across the tail, and
  // the last block's cut kept all of it. Blips with no speech beside them stay together instead,
  // with a neighbour only while they are too short to transcribe alone, and a runaway tail is
  // one stretch of its own from its first blip.
  const tail = runawayTailIndex(raw);
  const group = raw.map((span, i) => (tail >= 0 && i >= tail ? tail : short(span) ? -1 : i));
  raw.forEach((span, i) => {
    if (!short(span) || group[i] !== -1) return;
    const before = i > 0 && !short(raw[i - 1]!) ? span.start - raw[i - 1]!.end : Infinity;
    const after = i + 1 < raw.length && !short(raw[i + 1]!) ? raw[i + 1]!.start - span.end : Infinity;
    if (before !== Infinity || after !== Infinity) group[i] = before <= after ? i - 1 : i + 1;
  });
  for (let a = 0; a < raw.length; a++) {
    if (group[a] !== -1) continue;
    let b = a;
    while (b + 1 < raw.length && group[b + 1] === -1) b += 1;
    const before = a > 0 ? raw[a]!.start - raw[a - 1]!.end : Infinity;
    const after = b + 1 < raw.length && (tail < 0 || b + 1 < tail) ? raw[b + 1]!.start - raw[b]!.end : Infinity;
    const own = raw[b]!.end - raw[a]!.start >= MIN_STRETCH_SEC || (before === Infinity && after === Infinity);
    const joined = own ? a : before <= after ? group[a - 1]! : group[b + 1]!;
    for (let i = a; i <= b; i++) group[i] = joined;
    a = b;
  }
  const spans: Array<{ start: number; end: number }> = [];
  raw.forEach((span, i) => {
    if (i > 0 && group[i] === group[i - 1]) spans[spans.length - 1]!.end = span.end;
    else spans.push({ ...span });
  });
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
