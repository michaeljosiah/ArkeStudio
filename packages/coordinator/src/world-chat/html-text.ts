/**
 * Readable text out of a page, without pulling in a parser.
 *
 * Scripts and styles go first — their contents are not prose and would be quoted as though they
 * were — then tags become spaces, entities are decoded, and runs of blank space collapse. This
 * is deliberately plain: a quotation has to match what was stored, so the transformation that
 * produces the stored text must be one anybody can reason about later.
 */
export function readableText(html: string): string {
  const withoutCode = html
    .replace(/<(script|style|template|noscript|iframe|object|head)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ");
  const entities: Record<string, string> = {
    "&nbsp;": " ", "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&apos;": "'",
    // The marks prose actually uses. Left raw, "&mdash;" would sit inside a stored quotation
    // and never match what the model read on the page.
    "&mdash;": "—", "&ndash;": "–", "&hellip;": "…", "&rsquo;": "’",
    "&lsquo;": "‘", "&ldquo;": "“", "&rdquo;": "”", "&#8217;": "’",
  };
  return withoutCode
    .replace(/<\/(p|div|h[1-6]|li|tr|section|article|br)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<(?:"[^"]*"|'[^']*'|[^>"'])*>/g, " ")
    .replace(/&(#(?:x[0-9a-f]+|[0-9]+)|[a-z][a-z0-9]+);/gi, (whole, value: string) => {
      if (!value.startsWith("#")) return entities[whole.toLowerCase()] ?? whole;
      const hex = /^#x/i.test(value), code = Number.parseInt(value.slice(hex ? 2 : 1), hex ? 16 : 10);
      return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : whole;
    })
    // Horizontal space only: the newlines above are the paragraph structure, and collapsing
    // them here would join sentences that the page kept apart.
    .replace(/[^\S\n]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^[ \t]+|[ \t]+$/gm, "")
    .trim();
}

