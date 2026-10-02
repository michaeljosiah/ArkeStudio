/*
 * Sentence-sized pieces for speech, kept apart from the voice service so the direction module
 * (`direction.ts`) and the service can both use it without importing each other.
 */

/**
 * How much text the local engine is asked to speak at once (2026-08-24).
 *
 * Measured, not guessed. 500 characters synthesises in about 32 seconds and leaves the engine
 * healthy; 8,610 in one request returns 503 after sixteen seconds and leaves Kokoro permanently
 * unavailable — not just for that request, for every voice feature in the app until it is
 * restarted. The cap this replaces was 10,000, which let the fatal request straight through.
 *
 * 450 sits under the largest size proven safe, with room for the sentence splitter to overshoot
 * slightly rather than cut a clause in half.
 */
const LOCAL_SPEECH_CHUNK = 450;

/**
 * Break text into pieces small enough to synthesise, preferring sentence ends.
 *
 * A chunk boundary is audible — the engine renders each piece with its own opening and closing
 * prosody — so they are placed where a reader would pause anyway. A sentence longer than the cap
 * falls back to clause boundaries, then to a hard cut, because refusing to speak a long sentence
 * would be a worse answer than breathing in an odd place.
 */
export function splitForSpeech(text: string, max = LOCAL_SPEECH_CHUNK): string[] {
  const pieces: string[] = [];
  let held = "";
  const flush = () => {
    if (held.trim() !== "") pieces.push(held.trim());
    held = "";
  };
  // Keep the terminator with the sentence it ends: the engine reads "?" differently from ".".
  for (const sentence of text.split(/(?<=[.!?])\s+/)) {
    if (sentence.length > max) {
      flush();
      let rest = sentence;
      while (rest.length > max) {
        const window = rest.slice(0, max);
        // A comma or semicolon in the back half is a better seam than the middle of a word.
        const seam = Math.max(window.lastIndexOf(", "), window.lastIndexOf("; "));
        const cut = seam > max / 2 ? seam + 1 : Math.max(window.lastIndexOf(" "), max);
        pieces.push(rest.slice(0, cut).trim());
        rest = rest.slice(cut).trim();
      }
      held = rest;
      continue;
    }
    if (held.length + sentence.length + 1 > max) flush();
    held = held === "" ? sentence : `${held} ${sentence}`;
  }
  flush();
  return pieces;
}
