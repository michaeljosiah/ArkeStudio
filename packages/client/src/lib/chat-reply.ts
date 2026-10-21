const PART_CHARACTERS = 8_000;

/** Display boundaries only: joining the parts must recover every character of the saved reply. */
export function chatReplyParts(text: string): string[] {
  if (text.length <= PART_CHARACTERS) return [text];
  const parts: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + PART_CHARACTERS, text.length);
    const window = text.slice(start, end);
    // A chapter/section heading starts a new part, with its prose. Otherwise stop after a
    // paragraph; only a paragraph longer than a display part needs a word boundary.
    const heading = [...window.matchAll(/^#{1,2}[ \t]+\S.*$/gm)].find(match => match.index > 0 && window.slice(0, match.index).trim());
    if (heading) end = start + heading.index;
    else if (end < text.length) {
      const paragraph = [...window.matchAll(/\r?\n[ \t]*\r?\n/g)].at(-1);
      const boundary = paragraph ?? [...window.matchAll(/\s+/g)].at(-1);
      if (boundary) end = start + boundary.index + boundary[0].length;
      // Do not leave a standalone heading at the foot of the preceding part.
      const trailingHeading = /(?:^|\n)(#{1,6}[ \t]+[^\n]+\r?\n\s*)$/.exec(text.slice(start, end));
      if (trailingHeading && trailingHeading.index > 0) end = start + trailingHeading.index + (trailingHeading[0].startsWith("\n") ? 1 : 0);
    }
    if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1]!)) end--;
    parts.push(text.slice(start, end));
    start = end;
  }
  return parts;
}
