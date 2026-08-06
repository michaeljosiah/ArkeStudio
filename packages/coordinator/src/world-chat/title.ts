/**
 * A conversation's name, from the first thing said in it (#70 §15.1).
 *
 * A conversation is created before anyone knows what it is about, so it cannot be named up front
 * without asking a question nobody can answer yet. The opening sentence is what somebody would
 * have called it, so it is used and can be changed later.
 *
 * Cut at a word boundary rather than mid-word: a title ending "…the bells and the lo" reads as a
 * bug, and the list is scanned rather than read.
 */
export function titleFrom(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  if (line.length <= 60) return line || "New conversation";
  const cut = line.slice(0, 60);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > 24 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}
