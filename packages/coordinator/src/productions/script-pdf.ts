/**
 * A performer's script as a PDF (design turn 155d, SPEC-047 R-39): text only, Helvetica, A4,
 * wrapped and paged. Written by hand rather than through a library because the script is lines
 * of text and a little grey — a PDF of that is a few objects, and the app ships no PDF writer.
 *
 * The standard fonts speak WinAnsi, so text is encoded to it: the typographer's quotes, dashes
 * and ellipsis a manuscript is full of have code points there; anything else is replaced with
 * `?` rather than dropped, so a line never silently loses a word.
 */

export interface ScriptRun {
  text: string;
  /** Bold for the line itself, regular for its id and note, grey for the narration before it. */
  style: "title" | "meta" | "id" | "context" | "line" | "note";
}

const PAGE = { width: 595, height: 842, margin: 56 } as const;
const STYLE: Record<ScriptRun["style"], { font: "F1" | "F2"; size: number; grey: number; before: number }> = {
  title: { font: "F2", size: 18, grey: 0, before: 0 },
  meta: { font: "F1", size: 9, grey: 0.45, before: 4 },
  id: { font: "F2", size: 9, grey: 0.35, before: 16 },
  context: { font: "F1", size: 10, grey: 0.5, before: 3 },
  line: { font: "F2", size: 12, grey: 0, before: 4 },
  note: { font: "F1", size: 9, grey: 0.35, before: 3 },
};

/** WinAnsi (cp1252) bytes for the characters above 0x7E that it holds. */
const WIN_ANSI: Record<string, number> = {
  "€": 0x80, "‚": 0x82, "ƒ": 0x83, "„": 0x84, "…": 0x85, "†": 0x86, "‡": 0x87, "ˆ": 0x88, "‰": 0x89, "Š": 0x8a, "‹": 0x8b,
  "Œ": 0x8c, "Ž": 0x8e, "‘": 0x91, "’": 0x92, "“": 0x93, "”": 0x94, "•": 0x95, "–": 0x96, "—": 0x97, "˜": 0x98, "™": 0x99,
  "š": 0x9a, "›": 0x9b, "œ": 0x9c, "ž": 0x9e, "Ÿ": 0x9f,
};

function winAnsi(text: string): number[] {
  const out: number[] = [];
  for (const char of text.normalize("NFC")) {
    const code = char.codePointAt(0)!;
    if (code >= 0x20 && code <= 0x7e) out.push(code);
    else if (code >= 0xa0 && code <= 0xff) out.push(code);
    else if (WIN_ANSI[char] !== undefined) out.push(WIN_ANSI[char]!);
    else if (char === "\t") out.push(0x20);
    else out.push(0x3f);
  }
  return out;
}

/** A PDF string literal of WinAnsi bytes, with the three bytes that must be escaped escaped. */
function literal(bytes: number[]): string {
  let out = "(";
  for (const byte of bytes) {
    if (byte === 0x28 || byte === 0x29 || byte === 0x5c) out += `\\${String.fromCharCode(byte)}`;
    else if (byte < 0x20 || byte > 0x7e) out += `\\${byte.toString(8).padStart(3, "0")}`;
    else out += String.fromCharCode(byte);
  }
  return `${out})`;
}

/** Helvetica's advance is close enough at an average of 0.52 em for wrapping; bold runs a little wider. */
function wrap(text: string, size: number, bold: boolean, width: number): string[] {
  const perChar = size * (bold ? 0.56 : 0.52);
  const max = Math.max(8, Math.floor(width / perChar));
  const lines: string[] = [];
  // A block keeps the manuscript's own line wraps; the page wraps it afresh, so they go. Emphasis
  // marks are the manuscript's Markdown, not words a performer says, so they go too.
  // Nested or unbalanced emphasis can leave a stray asterisk behind, and an asterisk is never spoken.
  const plain = text.replace(/(\*{1,2}|_{1,2})(\S(?:.*?\S)?)\1/g, "$2").replace(/\*/g, "").replace(/\s+/g, " ").trim();
  for (const paragraph of [plain]) {
    let current = "";
    for (const word of paragraph.split(/\s+/).filter((w) => w !== "")) {
      if (current === "") current = word;
      else if (current.length + 1 + word.length <= max) current += ` ${word}`;
      else {
        lines.push(current);
        current = word;
      }
      while (current.length > max) {
        lines.push(current.slice(0, max));
        current = current.slice(max);
      }
    }
    lines.push(current);
  }
  return lines;
}

/** The PDF's bytes for these runs, top to bottom, paged as they fill. */
export function writeScriptPdf(runs: readonly ScriptRun[], info: { title: string }): Buffer {
  const width = PAGE.width - PAGE.margin * 2;
  const pages: string[][] = [[]];
  let y = PAGE.height - PAGE.margin;
  for (const run of runs) {
    const style = STYLE[run.style];
    const lead = style.size * 1.35;
    const lines = wrap(run.text, style.size, style.font === "F2", width);
    y -= style.before;
    for (const line of lines) {
      if (y - lead < PAGE.margin) {
        pages.push([]);
        y = PAGE.height - PAGE.margin;
      }
      y -= lead;
      pages.at(-1)!.push(`BT /${style.font} ${style.size} Tf ${style.grey} g ${PAGE.margin} ${y.toFixed(1)} Td ${literal(winAnsi(line))} Tj ET`);
    }
  }
  // Objects: 1 catalog, 2 pages, 3-4 fonts, 5 info, then a page and its content per page.
  const objects: string[] = [];
  const kids = pages.map((_, index) => `${6 + index * 2} 0 R`).join(" ");
  objects.push("<< /Type /Catalog /Pages 2 0 R >>");
  objects.push(`<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`);
  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>");
  objects.push(`<< /Title ${literal(winAnsi(info.title))} /Producer (Arke Studio) >>`);
  for (const [index, page] of pages.entries()) {
    const content = page.join("\n");
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE.width} ${PAGE.height}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${7 + index * 2} 0 R >>`);
    objects.push(`<< /Length ${Buffer.byteLength(content, "latin1")} >>\nstream\n${content}\nendstream`);
  }
  let body = "%PDF-1.4\n%\xe2\xe3\xcf\xd3\n";
  const offsets: number[] = [];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(body, "latin1"));
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(body, "latin1");
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info 5 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, "latin1");
}
