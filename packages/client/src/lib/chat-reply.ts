const PART_CHARACTERS = 8_000;
const MIN_PART_CHARACTERS = PART_CHARACTERS / 4;

/** Display boundaries only: joining the parts must recover every character of the saved reply. */
export function chatReplyParts(text: string): string[] {
  if (text.length <= PART_CHARACTERS) return [text];
  const parts: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + PART_CHARACTERS, text.length);
    const window = text.slice(start, end);
    if (end < text.length) {
      // Keep stacked headings together. Coalescing short sections bounds both the page
      // count and the work here: each window advances by at least a quarter of a part.
      let prose = false, block: number | null = null, heading = 0;
      for (const line of window.matchAll(/[^\n]*(?:\n|$)/g)) {
        if (!line[0].trim()) continue;
        const lineStart = line.index > 0 || start === 0 || text[start - 1] === "\n";
        if (lineStart && /^#{1,6}[ \t]+\S/.test(line[0])) block ??= line.index;
        else {
          if (prose && block !== null && block >= MIN_PART_CHARACTERS) heading = block;
          block = null; prose = true;
        }
      }
      if (prose && block !== null && block >= MIN_PART_CHARACTERS) heading = block;
      let paragraph = 0, whitespace = 0;
      if (!heading) {
        for (const match of window.matchAll(/\r?\n[ \t]*\r?\n/g)) paragraph = match.index + match[0].length;
        for (const match of window.matchAll(/\s+/g)) whitespace = match.index + match[0].length;
      }
      const boundary = heading || (paragraph >= MIN_PART_CHARACTERS ? paragraph : whitespace);
      if (boundary >= MIN_PART_CHARACTERS) end = start + boundary;
    }
    if (text[end - 1] === "\r" && text[end] === "\n") end--;
    if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1]!)) end--;
    parts.push(text.slice(start, end));
    start = end;
  }
  return parts;
}
