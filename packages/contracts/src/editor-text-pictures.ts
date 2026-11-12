import { canonicalJson } from "./canonical-json.js";
import { sha256Hex } from "./sha256.js";
import type { TextFrame, TextLook } from "./editor-text.js";
import { TEXT_PAINTER_VERSION, textTypefaceFile } from "./editor-text-typefaces.js";

/**
 * Where a text clip's painted picture is kept, and the name it is kept under (SPEC-065 R-20,
 * §2.3). The render plan names the picture and the coordinator paints it, so the name is made
 * here, where both can reach it, and the client's Viewer asks for the very file an export reads.
 * Nothing here paints or reads a file. The layout and the painter are not imported: the client
 * bundles the render plan, the render plan imports this, and a name needs neither of them.
 */

/** Where a world keeps its painted text (SPEC-065 §2.3). Never committed, journaled, listed or packaged. */
export const TEXT_PICTURE_DIR = ".cache/editor-text";
/** A kept picture's world-relative path; group 1 is its name. */
export const TEXT_PICTURE_PATH = /^\.cache\/editor-text\/([0-9a-f]{64})\.png$/;

/** The words, the look they are drawn in, and the frame's size in whole pixels. */
export interface TextPictureAsk { text: string; look: TextLook; width: number; height: number }

/**
 * The name a painted picture is kept under (R-20): everything that decides a pixel, and nothing
 * else. The typeface goes in as its file's hash, so a kept picture is found by this name and no
 * file's bytes are ever compared; a changed painter (R-23) or a changed file is a different name,
 * and the old picture is simply never asked for again. The words go in as the painter reads them,
 * in NFC, so two spellings of one accented letter are one picture; a colour goes in in lower
 * case, because "#FFFFFF" and "#ffffff" are one colour and a second name for it would paint the
 * same picture twice.
 *
 * This is the coordinator's function, moved here with its digest taken by `sha256Hex` in place of
 * node:crypto. The value hashed is the same, so every name the first slice made is still the name.
 */
export function textPictureName({ text, look, width, height, fileSha256 }: TextPictureAsk & { fileSha256: string }): string {
  const lower = <Part extends { color: string }>(part: Part): Part => ({ ...part, color: part.color.toLowerCase() });
  const named: TextLook = {
    ...look, fill: look.fill.kind === "solid" ? lower(look.fill) : { ...look.fill, stops: look.fill.stops.map(lower) },
    ...(look.edge ? { edge: lower(look.edge) } : {}), ...(look.shadow ? { shadow: lower(look.shadow) } : {}), ...(look.backing ? { backing: lower(look.backing) } : {}),
  };
  return sha256Hex(canonicalJson({ painter: TEXT_PAINTER_VERSION, file: fileSha256, width, height, text: text.normalize("NFC"), look: named }));
}

export type TextPictureRef =
  | { ok: true; name: string; path: string; width: number; height: number }
  | { ok: false; reason: string };

/** The kept picture one text source names at one frame size, or the typeface's refusal (R-7). Reads no file. */
export function textPicturePath(source: { text: string; look: TextLook }, frame: TextFrame): TextPictureRef {
  const choice = textTypefaceFile(source.look.typeface, source.look.weight, source.look.italic);
  if (!choice.ok) return choice;
  const name = textPictureName({ text: source.text, look: source.look, width: frame.width, height: frame.height, fileSha256: choice.file.sha256 });
  return { ok: true, name, path: `${TEXT_PICTURE_DIR}/${name}.png`, width: frame.width, height: frame.height };
}
