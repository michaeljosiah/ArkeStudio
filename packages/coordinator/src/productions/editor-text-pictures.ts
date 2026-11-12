import { createHash } from "node:crypto";
import { TEXT_PAINTER_VERSION, TextLookSchema, canonicalJson, paintText, textTypefaceFile, textWords, type TextLook } from "@arke-studio/contracts";
import { loadTextFaceFile } from "../media/text-typefaces.js";
import { encodePng } from "../references/png.js";

/**
 * A text clip's picture, painted in the coordinator (SPEC-065 R-18, §2.3): the look's typeface
 * file is read and checked, the painter in contracts draws the whole frame, and the picture is
 * given the name a kept copy would be found by. Nothing is written and nothing is kept here; a
 * caller that wants the picture again asks again.
 */

/** The words, the look they are drawn in, and the frame's size in whole pixels. */
export interface TextPictureAsk { text: string; look: TextLook; width: number; height: number }
export type TextPicturePaint =
  | { ok: true; name: string; width: number; height: number; /** Straight alpha, row by row from the top. */ rgba: Uint8Array; /** The look's size after Fit (R-10). */ drawnSize: number }
  | { ok: false; reason: string };

/**
 * The name a painted picture is kept under (R-20): everything that decides a pixel, and nothing
 * else. The typeface goes in as its file's hash, so a kept picture is found by this name and no
 * file's bytes are ever compared; a changed painter (R-23) or a changed file is a different name,
 * and the old picture is simply never asked for again. The words go in as the painter reads them,
 * in NFC, so two spellings of one accented letter are one picture; a colour goes in in lower
 * case, because "#FFFFFF" and "#ffffff" are one colour and a second name for it would paint the
 * same picture twice.
 */
export function textPictureName({ text, look, width, height, fileSha256 }: TextPictureAsk & { fileSha256: string }): string {
  const lower = <Part extends { color: string }>(part: Part): Part => ({ ...part, color: part.color.toLowerCase() });
  const named: TextLook = {
    ...look, fill: look.fill.kind === "solid" ? lower(look.fill) : { ...look.fill, stops: look.fill.stops.map(lower) },
    ...(look.edge ? { edge: lower(look.edge) } : {}), ...(look.shadow ? { shadow: lower(look.shadow) } : {}), ...(look.backing ? { backing: lower(look.backing) } : {}),
  };
  return createHash("sha256").update(canonicalJson({ painter: TEXT_PAINTER_VERSION, file: fileSha256, width, height, text: text.normalize("NFC"), look: named })).digest("hex");
}

/** A look the record refuses (R-26), by the field that is wrong, in the look's own names: "fill.stops", "shadow.blur". */
function lookRefusal(issues: readonly { code: string; path: readonly (string | number)[]; keys?: readonly string[] }[]): string {
  const issue = issues[0];
  if (issue?.code === "unrecognized_keys") return `A text look has no ${[...issue.path, issue.keys?.[0]].join(".")}`;
  return issue?.path.length ? `A text look's ${issue.path.join(".")} is out of range` : "A text look cannot be read";
}

/**
 * Paints one picture. This is the door a clip's words and look come through, so it asks what the
 * record asks (R-4, R-26) before anything is drawn: words that are empty or too many, an unknown
 * field and a value outside its range refuse here, and nothing is clamped to fit. A blank picture
 * with a name of its own would be kept and shown as if it were the clip (R-3). The words are
 * painted and named as they are stored, so a Windows line end or a blank line typed above them is
 * not a second picture. After that a weight or slant the typeface lacks, a file that is missing
 * or is not the one shipped, a character the face cannot draw and a frame the painter will not
 * make each refuse in their own words (R-7, R-21), and no picture comes back with a refusal.
 * `from` is where the fonts folder is looked for, as `loadTextFaceFile` reads it.
 */
export function paintTextPicture(ask: TextPictureAsk, from?: string): TextPicturePaint {
  const { width, height } = ask, words = textWords(ask.text);
  if (!words.ok) return words;
  const read = TextLookSchema.safeParse(ask.look);
  if (!read.success) return { ok: false, reason: lookRefusal(read.error.issues) };
  const look = read.data, text = words.text;
  const choice = textTypefaceFile(look.typeface, look.weight, look.italic);
  if (!choice.ok) return choice;
  const loaded = loadTextFaceFile(choice.file.file, choice.file.sha256, choice.typeface.name, from);
  if (!loaded.ok) return loaded;
  // The painter reads the look's ink and the face it is handed; the typeface, weight and slant were settled above.
  const picture = paintText(text, look, { width, height }, loaded.face);
  if (!picture.ok) return picture;
  return { ok: true, name: textPictureName({ text, look, width, height, fileSha256: choice.file.sha256 }), width, height, rgba: picture.rgba, drawnSize: picture.drawnSize };
}

/**
 * The picture as a PNG file's bytes. Only the pixels are the same on every machine (R-19): the
 * file is deflated, and two builds of zlib may pack the same pixels differently, so a picture is
 * compared by its pixels and never by its file.
 */
export const textPicturePng = (picture: { width: number; height: number; rgba: Uint8Array }): Uint8Array =>
  encodePng({ width: picture.width, height: picture.height, pixels: picture.rgba });
