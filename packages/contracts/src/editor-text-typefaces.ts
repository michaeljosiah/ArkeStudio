/**
 * The typefaces a text clip may be drawn in (SPEC-065 R-7, R-22). Each ships inside the app as a
 * whole file pinned by its hash; the painter reads no face from the machine it runs on, which is
 * what lets one record draw the same picture everywhere (R-19). An id is never removed once a
 * timeline could hold it.
 *
 * The table holds only faces whose files are in the repository. The other approved faces join it
 * as their files arrive; until then they are not ids at all, so nothing can be saved in them.
 */

/** Raised whenever the same words and look would lay ink differently (R-23). It is part of a kept picture's name. */
export const TEXT_PAINTER_VERSION = "text-painter-v1";

export const TEXT_TYPEFACE_IDS = ["geist"] as const;
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
    files: { regular: { file: "Geist-Regular.ttf", sha256: "85a1c6b18a6b0a06dfe9fd4f6d6a5d4979f74ec861eaef4bc7868b5492b8a117" } },
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
