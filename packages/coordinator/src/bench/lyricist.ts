/**
 * "Write for me" (design turn 73): the task text handed to the lyricist agent.
 *
 * Deliberately narrower than the enhancer's brief beside it, which carries the world's look and
 * its settled canon. A rewritten image prompt describes something the world already established;
 * a song *asserts* things, and a verse that names a person, a place or an ending nobody approved
 * has put canon into the world through a door that was never meant to write. So the author's
 * description is the whole of the content, and the style line is the whole of the register.
 *
 * The draft is never applied here in any case — it opens a dialog, and only "Use these words"
 * moves it into the song.
 */
export function lyricistBrief(input: { description: string; style?: string }): string {
  const style = input.style?.trim();
  return [
    "Draft lyrics for a song.",
    `What the song is about, which is the whole of what it may say:\n${input.description.trim()}`,
    style !== undefined && style.length > 0
      ? `The musical style it is being written for — write to its meter and register:\n${style}`
      : "No style has been written yet. Keep the meter plain and the register neutral.",
    [
      "Rules:",
      "- Use structure tags on their own lines: [intro], [verse], [pre-chorus], [chorus], [bridge], [outro].",
      "- Write only words to be sung. No stage directions, no chord names, no commentary.",
      "- Invent nothing the description did not state.",
      '- Answer with JSON only: {"lyrics": "..."} — no prose around it.',
    ].join("\n"),
  ].join("\n\n");
}

/**
 * The longest draft accepted from the agent.
 *
 * Generous rather than tight: the enhancer's ceiling is a model's published prompt cap, and a
 * rewrite over it is a rewrite that would be refused anyway. A song has no such cap — the route
 * declares no maxLength on `lyrics` — so this exists only to bound the payload, and it sits well
 * under the 20,000 the contract allows so a long draft is never thrown away as "no answer".
 */
export const LYRICS_MAX_CHARS = 8000;
