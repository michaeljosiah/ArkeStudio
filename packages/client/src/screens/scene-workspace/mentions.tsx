import type { ReactNode } from "react";
import { mentionSpans, propSlug, type Prop, type Sheet } from "@arke-studio/contracts";

/**
 * What a mention reads as when the words are read rather than written: a sheet's name, a
 * prop's name, and for a slug nothing in the world answers to — the scene's location before
 * it has a sheet, say — the slug itself without its sigil (issue 1103).
 *
 * The two namespaces are independent and can meet: `@car` may be a sheet named Carl and a
 * prop named Car at once, and dispatch cites both. The sheet keeps the word here — a sheet's
 * id is the slug itself, a prop's is derived from its name — so a prop only names a slug no
 * sheet has claimed, rather than silently taking one over.
 */
export function mentionNames(sheets: readonly Sheet[], props: readonly Prop[]): ReadonlyMap<string, string> {
  const names = new Map<string, string>();
  for (const sheet of sheets) names.set(sheet.id, sheet.name);
  // Two props can share a slug ("Tea cup", "Tea-cup" — nothing at creation forbids it) and
  // dispatch cites both; naming one would claim the mention is the other's alone, so such a
  // slug stays a slug.
  const claimed = new Set<string>();
  for (const prop of props) {
    const slug = propSlug(prop.name);
    if (names.has(slug) && !claimed.has(slug)) continue;
    if (claimed.has(slug)) names.delete(slug);
    else names.set(slug, prop.name);
    claimed.add(slug);
  }
  return names;
}

/**
 * The script's words for an editor's underlay, in one of two dresses.
 *
 * Read — the editor unfocused — draws each mention as the thing's name in the prose's own
 * dress (not the production page's mono chip, which keeps the token), so a card or a page
 * reads as prose the way the drawings do. Edit keeps the token on the line, chipped as the
 * bench chips its citations, because the caret in the transparent textarea above counts the
 * token's own characters and the underlay has to agree with it letter for letter; a name
 * there would put the caret a word away from where the eye expects it. The spans are the
 * parser's, so what is drawn as a mention is exactly what dispatch will resolve.
 */
export function scriptWords(text: string, names: ReadonlyMap<string, string>, mode: "read" | "edit"): ReactNode[] {
  const out: ReactNode[] = [];
  let at = 0;
  for (const span of mentionSpans(text)) {
    if (span.start > at) out.push(text.slice(at, span.start));
    out.push(
      mode === "read" ? (
        <span key={span.start} className="fy-mentionname" data-slug={span.slug}>{names.get(span.slug) ?? span.slug}</span>
      ) : (
        <mark key={span.start} className="fy-bench__briefchip">{text.slice(span.start, span.end)}</mark>
      ),
    );
    at = span.end;
  }
  if (at < text.length) out.push(text.slice(at));
  return out;
}
