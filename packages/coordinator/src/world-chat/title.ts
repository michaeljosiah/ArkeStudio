/**
 * A conversation's name, from the first thing said in it (#70 §15.1).
 *
 * A conversation is created before anyone knows what it is about, so it cannot be named up front
 * without asking a question nobody can answer yet. The opening sentence is what somebody would
 * have called it, so it is used and can be changed later.
 *
 * Two ways of getting there, and they are ordered rather than alternatives. `titleFrom` is the
 * opening sentence cut to length: instant, always available, and never wrong about what was
 * said. `namingBrief` asks the harness for the name a person would have given the same message —
 * "Maren's inheritance" rather than "so I was thinking about who raised Maren, because the aunt
 * thing chan…" — and that answer replaces the cut one when it arrives. The cut is written first
 * so the row is never blank and never "New conversation", and the generated name is a promotion
 * on top of something that already works.
 */

/**
 * The longest title kept, generated or cut.
 *
 * The list is scanned rather than read, and a row that runs the width of the rail is no faster
 * to scan than the message itself. The event schema allows 160; that is a ceiling on what can be
 * stored, not a target.
 */
export const TITLE_MAX_CHARS = 60;

/**
 * Cut at a word boundary rather than mid-word: a title ending "…the bells and the lo" reads as a
 * bug, and the list is scanned rather than read.
 */
export function titleFrom(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  if (line.length <= TITLE_MAX_CHARS) return line || "New conversation";
  const cut = line.slice(0, TITLE_MAX_CHARS);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > 24 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

/**
 * What the namer is told.
 *
 * The message, and the world it was said in — nothing else. The world's name and logline are
 * here for one reason: so a name is spelled the way the world spells it. A message that says
 * "Maren" and a title that says "Marin" is worse than no title, because the row is then wrong
 * about the only word anybody scans for.
 *
 * The message is passed through as it stands, bounded rather than summarised. A long opening
 * message is common — somebody arrives with a paragraph — and the first part of it is reliably
 * what it is about, so a cut costs nothing a summary would have saved.
 */
export function namingBrief(text: string, world?: { name: string; logline?: string }): string {
  const message = text.replace(/\s+/g, " ").trim().slice(0, 2000);
  const context =
    world === undefined
      ? []
      : [
          `The world they are talking about: ${world.name}` +
            (world.logline?.trim() ? ` — ${world.logline.trim()}` : "") +
            ". This is here so you spell names the way they are spelled, and for nothing else.",
        ];
  return [
    "Name the conversation this message opens.",
    ...context,
    `What they said:\n${message}`,
    `Answer with JSON only: {"title": "..."} — at most ${TITLE_MAX_CHARS} characters, no prose around it.`,
  ].join("\n\n");
}

/**
 * What came back, made safe to put on a row — or nothing.
 *
 * A model asked for a label sometimes returns a labelled label: wrapped in quotes, ended with a
 * full stop, prefixed "Title:". None of those are worth a failed turn, and none are worth showing
 * either, so they are taken off. What survives has to be a title; a refusal, an empty string or a
 * paragraph is `null`, and `null` means the cut opening sentence stays where it is.
 */
export function cleanTitle(raw: string): string | null {
  let line = raw.replace(/\s+/g, " ").trim();
  line = line.replace(/^(?:title|name)\s*[:\-–—]\s*/i, "");
  // Quotes come back in either alphabet, and sometimes only on one end.
  line = line.replace(/^["'“”‘’«»]+/, "").replace(/["'“”‘’«»]+$/, "");
  // A closing full stop, but not the "…" a cut leaves, and not a question or an exclamation —
  // those are part of what was said rather than punctuation the model added.
  line = line.replace(/\.+$/, "").trim();
  if (line.length === 0) return null;
  // A paragraph is not a title. Cutting one to length would produce a plausible-looking row out
  // of something that was never a name, so it is refused and the opening sentence keeps the row.
  if (line.length > 160) return null;
  return line.length <= TITLE_MAX_CHARS ? line : titleFrom(line);
}
