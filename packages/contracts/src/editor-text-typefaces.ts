/**
 * The typefaces a text clip may be drawn in (SPEC-065 R-7, R-22). Each ships inside the app as a
 * whole file pinned by its hash; the painter reads no face from the machine it runs on, which is
 * what lets one record draw the same picture everywhere (R-19). An id is never removed once a
 * timeline could hold it.
 *
 * The six faces design turn 277 approved. Each has Regular and, where its publisher draws them,
 * Bold, Italic and Bold Italic; nothing else is offered, so a look can only name a file that is
 * here.
 */

/**
 * Raised whenever the same words and look would lay ink differently (R-23). It is part of a kept
 * picture's name. v2: a glyph that stands for no character of its own is no longer tracked apart
 * from the one before it, which moves a tracked line holding Geist's fi or fl character.
 */
export const TEXT_PAINTER_VERSION = "text-painter-v2";

export const TEXT_TYPEFACE_IDS = ["geist", "jost", "comic-neue", "bangers", "eb-garamond", "cinzel"] as const;
export type TextTypefaceId = (typeof TEXT_TYPEFACE_IDS)[number];
export const TEXT_TYPEFACE_STYLES = ["regular", "bold", "italic", "bold-italic"] as const;
export type TextTypefaceStyle = (typeof TEXT_TYPEFACE_STYLES)[number];
/** `file` is a name in the coordinator's fonts folder and `sha256` the hex digest of its bytes. */
export interface TextTypefaceFile { file: string; sha256: string }
export interface TextTypeface {
  id: TextTypefaceId;
  /** The name an author reads, and the one a refusal uses. */
  name: string;
  /** The licence text kept beside the files. */
  licence: string;
  files: { regular: TextTypefaceFile } & Partial<Record<Exclude<TextTypefaceStyle, "regular">, TextTypefaceFile>>;
}

export const TEXT_TYPEFACES: Readonly<Record<TextTypefaceId, TextTypeface>> = {
  geist: {
    id: "geist", name: "Geist", licence: "Geist-OFL.txt",
    files: {
      regular: { file: "Geist-Regular.ttf", sha256: "85a1c6b18a6b0a06dfe9fd4f6d6a5d4979f74ec861eaef4bc7868b5492b8a117" },
      bold: { file: "Geist-Bold.ttf", sha256: "3f21f02b827228c3f0c5fb230d027b5a1a263013618e8052bc1b3c5692812c88" },
    },
  },
  jost: {
    id: "jost", name: "Jost", licence: "Jost-OFL.txt",
    files: {
      regular: { file: "Jost-400-Book.ttf", sha256: "3fda07bcb2fe66667798f45dd2fc3834586a15fc6b6df7da36422b459b5a117c" },
      bold: { file: "Jost-700-Bold.ttf", sha256: "95f16d07698549232a121443d9fdef129de15b209d70c8804f28df49bf594838" },
      italic: { file: "Jost-400-BookItalic.ttf", sha256: "295fdb0fe7d66e10480813b619499d14516af20878aaff0246dc28377713cefa" },
      "bold-italic": { file: "Jost-700-BoldItalic.ttf", sha256: "5430d1114cc0267f56908eae988196f4a1ed4d55adce02931be4181de0ae25ca" },
    },
  },
  "comic-neue": {
    id: "comic-neue", name: "Comic Neue", licence: "ComicNeue-OFL.txt",
    files: {
      regular: { file: "ComicNeue-Regular.ttf", sha256: "a0ee5a37c8b27c4db0700137d928598b1e23b0089e1546a8961909176b779360" },
      bold: { file: "ComicNeue-Bold.ttf", sha256: "3e7e5fccfd7e0788f317b43312151c1bd5cf058c9697a8d83eac3939050bd61e" },
      italic: { file: "ComicNeue-Italic.ttf", sha256: "e06bfd1552f5c9464c5665733ffd69239b0593885dbb9e059688a5900f78cf98" },
      "bold-italic": { file: "ComicNeue-BoldItalic.ttf", sha256: "5c312c2a2fa64eee82f3b87fcfab8f3b12a5e59b043124401d322eb323cfbf16" },
    },
  },
  // A display face of capitals drawn in one weight: bold and italic refuse by name (R-7).
  bangers: {
    id: "bangers", name: "Bangers", licence: "Bangers-OFL.txt",
    files: { regular: { file: "Bangers-Regular.ttf", sha256: "4160a7311de9342674cce9160cde9fcbb30f48190397d86ff1b70b455af65824" } },
  },
  // The book serif with a true italic, and the one face of the six that draws the dotted letters
  // of Yoruba (ẹ, ọ, ṣ).
  "eb-garamond": {
    id: "eb-garamond", name: "EB Garamond", licence: "EBGaramond-OFL.txt",
    files: {
      regular: { file: "EBGaramond-Regular.ttf", sha256: "2028dc06d3c130b4761693481436a32a8e35ed500bf58c25c53de004106125b8" },
      bold: { file: "EBGaramond-Bold.ttf", sha256: "0cfed122e51e3fd44ccedaef7637efed6d5bdc4ad89a6117d70241510309a186" },
      italic: { file: "EBGaramond-Italic.ttf", sha256: "d4ad1d0a9390d26d6d3f176117a1d121441edb8c8632bfca52cfad084b9059cb" },
      "bold-italic": { file: "EBGaramond-BoldItalic.ttf", sha256: "3437cf76a720b01580218614e7f0ce9d66035a075c34a98394cec9a888cf38d6" },
    },
  },
  // Capitals only, and no italic.
  cinzel: {
    id: "cinzel", name: "Cinzel", licence: "Cinzel-OFL.txt",
    files: {
      regular: { file: "Cinzel-Regular.ttf", sha256: "af0031129f27dc752e8629a80b793d27abea94027faa27cc660c3fc33f607a1f" },
      bold: { file: "Cinzel-Bold.ttf", sha256: "0c23ec565db45c5508ee95889c60ad87debd167ca07167a43a5d68572b4e2eac" },
    },
  },
};

export const textTypefaceStyle = (weight: "regular" | "bold", italic: boolean): TextTypefaceStyle =>
  weight === "bold" ? italic ? "bold-italic" : "bold" : italic ? "italic" : "regular";

export type TextTypefaceChoice = { ok: true; typeface: TextTypeface; style: TextTypefaceStyle; file: TextTypefaceFile } | { ok: false; reason: string };
/**
 * The file a weight and slant are drawn from. A combination the face lacks refuses by name and is
 * never made by thickening or slanting the one it has (R-7).
 */
export function textTypefaceFile(id: TextTypefaceId, weight: "regular" | "bold", italic: boolean): TextTypefaceChoice {
  const typeface = TEXT_TYPEFACES[id], style = textTypefaceStyle(weight, italic), file = typeface.files[style];
  if (file) return { ok: true, typeface, style, file };
  const lacks = !italic || typeface.files.italic ? weight === "bold" && !typeface.files.bold ? "bold" : "bold italic" : "italic";
  return { ok: false, reason: `${typeface.name} has no ${lacks}` };
}
