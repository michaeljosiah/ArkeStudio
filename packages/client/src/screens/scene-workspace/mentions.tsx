import type { ReactNode } from "react";
import { mentionSpans, propSlug, type Prop, type Sheet } from "@arke-studio/contracts";

/**
 * What a mention reads as when the words are read rather than written: a sheet's name, a
 * prop's name, and for a slug nothing in the world answers to — the scene's location before
 * it has a sheet, say — the slug itself without its sigil (issue 1103).
 */
export function mentionNames(sheets: readonly Sheet[], props: readonly Prop[]): ReadonlyMap<string, string> {
  const names = new Map<string, string>();
  for (const sheet of sheets) names.set(sheet.id, sheet.name);
  for (const prop of props) names.set(propSlug(prop.name), prop.name);
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
