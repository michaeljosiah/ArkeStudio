/** Request packing bounds are separate from billable token counts (SPEC-049 R-6, R-25). */
export interface SpeechInputLimits { maxPromptChars?: number; maxSpeechUtf8Bytes?: number }
export interface SpeechInputPart { text: string; from: number; to: number }

const encoder = new TextEncoder();
export function speechUtf8Bytes(text: string): number { return encoder.encode(text).length; }

/** A speech byte budget includes the style sent beside the words. It is not a tokenizer. */
export function speechInputFits(text: string, limits: SpeechInputLimits, instructions = ""): boolean {
  return (limits.maxPromptChars === undefined || text.length <= limits.maxPromptChars)
    && (limits.maxSpeechUtf8Bytes === undefined || speechUtf8Bytes(text) + speechUtf8Bytes(instructions) <= limits.maxSpeechUtf8Bytes);
}

/**
 * Pack at sentence, clause or word boundaries, with a Unicode-safe hard cut only when needed.
 * Offsets name the original string, so direction can be rebased without searching repeated
 * words. Only whitespace at a seam is omitted. A style which leaves no room is a refusal,
 * never an oversized request or a silently truncated direction.
 */
export function splitSpeechInput(text: string, limits: SpeechInputLimits, instructions = ""): SpeechInputPart[] {
  const byteCap = limits.maxSpeechUtf8Bytes === undefined ? Infinity : limits.maxSpeechUtf8Bytes - speechUtf8Bytes(instructions);
  const charCap = limits.maxPromptChars ?? Infinity;
  if (byteCap < 1 || charCap < 1) throw new Error("The speech direction leaves no room for words in this request.");
  const parts: SpeechInputPart[] = [];
  let from = 0;
  while (from < text.length) {
    while (from < text.length && /\s/u.test(text[from]!)) from++;
    if (from === text.length) break;
    let end = from, bytes = 0;
    for (const point of text.slice(from)) {
      const size = speechUtf8Bytes(point);
      if (end + point.length - from > charCap || bytes + size > byteCap) break;
      end += point.length;
      bytes += size;
    }
    if (end === from) throw new Error("A speech character cannot fit beside this direction; shorten the direction.");
    if (end < text.length) {
      const window = text.slice(from, end);
      // Prefer a natural seam in the back half; short sentences can otherwise make a long
      // passage needlessly expensive when each part reserves a whole output allowance.
      const floor = window.length / 2;
      const last = (pattern: RegExp) => [...window.matchAll(pattern)].at(-1)?.index ?? -1;
      const sentence = last(/[.!?。！？](?=\s|$)/gu);
      const clause = last(/[,;，；](?=\s|$)/gu);
      const word = last(/\s/gu);
      const seam = sentence >= floor ? sentence + 1 : clause >= floor ? clause + 1 : word > 0 ? word : window.length;
      end = from + seam;
    }
    let to = end;
    while (to > from && /\s/u.test(text[to - 1]!)) to--;
    parts.push({ text: text.slice(from, to), from, to });
    from = end;
  }
  return parts;
}
