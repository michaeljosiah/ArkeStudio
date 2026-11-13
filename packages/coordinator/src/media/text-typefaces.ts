import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { create, type Font, type Glyph } from "fontkit";
import { textTypefaceFile, type TextFace, type TextGlyph, type TextOutlineCommand, type TextTypefaceId } from "@arke-studio/contracts";

/**
 * The font-file half of the text painter (SPEC-065 §2.2, §2.5): a shipped typeface file read into
 * the `TextFace` the layout and the painter in contracts draw from. Everything a face answers
 * comes from the file's own bytes through fontkit, which is plain JavaScript — no system font,
 * font configuration, locale or environment is read, so one file shapes alike on every machine
 * (R-19).
 */

export type TextFaceLoad = { ok: true; face: TextFace } | { ok: false; reason: string };

/** The two ligature features fontkit applies unasked. A face's required ones (`rlig`) are not ours to drop. */
const LIGATURE_FEATURES = ["liga", "clig"] as const;

/** A face from the bytes of a `.ttf`. `name` is the one a refusal uses. */
export function textFaceFromBytes(bytes: Uint8Array, name: string): TextFace {
  // A copy: fontkit decodes a table when it is first asked for, so bytes the caller went on to
  // change would change the face after the hash was checked.
  const font = create(Buffer.from(bytes)) as Font;
  // fontkit keeps one object per glyph and gives it the characters of whoever asked first — and
  // the parts of a composite are first asked for with none. Left alone, the "e" of a line reports
  // no characters, and a dot below is no mark, once any dotted e has been drawn: a face that
  // shapes by what it shaped before (R-19). Forgetting the kept object before each asking gives
  // every glyph the characters of its own place in the line. `_glyphs` is fontkit's private
  // store, one reason the package is pinned to an exact version; without it this throws.
  const store = (font as unknown as { _glyphs: Record<number, Glyph> })._glyphs, getGlyph = font.getGlyph.bind(font);
  font.getGlyph = (id, codePoints) => { delete store[id]; return getGlyph(id, codePoints); };
  // One copy per glyph, made once: fontkit hands out its own cached arrays, and a caller that
  // changed one would change every later drawing of that letter.
  const outlines = new Map<number, readonly TextOutlineCommand[]>();
  const outline = (glyph: Glyph): readonly TextOutlineCommand[] => {
    let commands = outlines.get(glyph.id);
    if (!commands) outlines.set(glyph.id, commands = glyph.path.commands.map(({ command, args }) => ({ command, args: [...args] })));
    return commands;
  };
  // The OS/2 cap height is absent from some files, so it is measured: the highest point a flat
  // capital's outline passes through. Control points are left out; they can lie above the ink.
  let capHeight = font.ascent;
  if (font.hasGlyphForCodePoint(0x48)) {
    const tops = outline(font.glyphForCodePoint(0x48)).filter(({ args }) => args.length >= 2).map(({ args }) => args[args.length - 1]!);
    if (tops.length) capHeight = Math.max(...tops);
  }
  return {
    name, unitsPerEm: font.unitsPerEm, ascent: font.ascent, descent: font.descent, capHeight,
    has: codePoint => font.hasGlyphForCodePoint(codePoint),
    shape(line, { ligatures }) {
      // A new object on every call: fontkit writes the features it applied back into the one it
      // is given, and a second line shaped with that object would have fractions and every other
      // feature of the first forced on. Naming a feature false removes it; kerning (`kern`) and
      // mark placement (`mark`, `mkmk`) are not named, so they stay.
      const run = font.layout(line, ligatures ? undefined : Object.fromEntries(LIGATURE_FEATURES.map(tag => [tag, false])));
      return run.glyphs.map((glyph, index): TextGlyph => {
        const at = run.positions[index]!;
        return { codePoints: [...glyph.codePoints], mark: glyph.isMark, advance: at.xAdvance, dx: at.xOffset, dy: at.yOffset, outline: outline(glyph) };
      });
    },
  };
}

/**
 * The build copies the fonts beside the bundle, so `../publications/fonts` is only right from
 * source (issue 2528 was this same lookup, wrong when packaged).
 */
function textFacePath(beside: URL, file: string, from: string): string {
  return fileURLToPath(existsSync(beside) ? beside : new URL("../publications/fonts/" + file, from));
}

const loaded = new Map<string, TextFace>();

export type TextFaceBytes = { ok: true; bytes: Buffer } | { ok: false; reason: string };

/**
 * A shipped typeface file's bytes, checked against its recorded hash. A file that is missing or
 * changed refuses by its own name (R-21). The painter reads a face through this, and so does the
 * Typeface menu's copy of each Regular (§2.5), so the menu never shows a face the painter refuses.
 */
export function readTextFaceFile(file: string, sha256: string, from: string = import.meta.url): TextFaceBytes {
  let bytes: Buffer;
  try { bytes = readFileSync(textFacePath(new URL("./fonts/" + file, from), file, from)); }
  catch { return { ok: false, reason: `${file} is missing` }; }
  if (createHash("sha256").update(bytes).digest("hex") !== sha256) return { ok: false, reason: `${file} is not the file this app shipped with` };
  return { ok: true, bytes };
}

/**
 * A shipped typeface file, checked against its recorded hash before a glyph is read from it. A
 * file that is missing or changed refuses by its own name (R-21); nothing else is tried in its
 * place. A face is parsed once and kept, so painting does not read the disk again.
 */
export function loadTextFaceFile(file: string, sha256: string, name: string, from: string = import.meta.url): TextFaceLoad {
  // Kept under where the bundle would hold the file, not where it was found: which of the two
  // places answers depends on the disk, and a kept face has to be found without asking it.
  const beside = new URL("./fonts/" + file, from), key = [beside.href, sha256, name].join("\n");
  const kept = loaded.get(key);
  if (kept) return { ok: true, face: kept };
  const read = readTextFaceFile(file, sha256, from);
  if (!read.ok) return read;
  const face = textFaceFromBytes(read.bytes, name);
  loaded.set(key, face);
  return { ok: true, face };
}

/** The face a look names. A weight or slant the typeface lacks refuses in the table's words (R-7). */
export function loadTextFace(typeface: TextTypefaceId, weight: "regular" | "bold", italic: boolean, from?: string): TextFaceLoad {
  const choice = textTypefaceFile(typeface, weight, italic);
  return choice.ok ? loadTextFaceFile(choice.file.file, choice.file.sha256, choice.typeface.name, from) : choice;
}
