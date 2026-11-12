import { TextLookSchema, layoutText, paintText, textPictureName, textTypefaceFile, textWords, type TextPictureAsk } from "@arke-studio/contracts";
import { loadTextFaceFile } from "../media/text-typefaces.js";
import { encodePng } from "../references/png.js";

/**
 * A text clip's picture, painted in the coordinator (SPEC-065 R-18, §2.3): the look's typeface
 * file is read and checked, the painter in contracts draws the whole frame, and the picture is
 * given the name a kept copy would be found by. Nothing is written and nothing is kept here; a
 * caller that wants the picture again asks again.
 */

// The ask and the name a picture is kept under are made in contracts, where the render plan and
// the client's Viewer can reach them too (R-20): a second copy here could name a picture the plan
// never asks for. They are handed on so everything that took them from this module still does.
export { textPictureName, type TextPictureAsk } from "@arke-studio/contracts";
export type TextPicturePaint =
  | { ok: true; name: string; width: number; height: number; /** Straight alpha, row by row from the top. */ rgba: Uint8Array; /** The look's size after Fit (R-10). */ drawnSize: number }
  | { ok: false; reason: string };

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
 * Why this picture cannot be drawn, or null when it can (R-21). The painter refuses only through
 * its layout, so this is the painter's own answer without the ink: the same checks in the same
 * order and the same words, for the cost of measuring a clip against the cost of painting one.
 * It is what a command asks before it writes words a film could not show, where painting every
 * clip of a batch would hold the coordinator's loop for the length of the batch. Nothing is
 * painted, named or kept. `from` is where the fonts folder is looked for, as the painter reads it.
 */
export function textPictureRefusal(ask: TextPictureAsk, from?: string): string | null {
  const words = textWords(ask.text);
  if (!words.ok) return words.reason;
  const read = TextLookSchema.safeParse(ask.look);
  if (!read.success) return lookRefusal(read.error.issues);
  const choice = textTypefaceFile(read.data.typeface, read.data.weight, read.data.italic);
  if (!choice.ok) return choice.reason;
  const loaded = loadTextFaceFile(choice.file.file, choice.file.sha256, choice.typeface.name, from);
  if (!loaded.ok) return loaded.reason;
  const laid = layoutText(words.text, read.data, { width: ask.width, height: ask.height }, loaded.face);
  return laid.ok ? null : laid.reason;
}

/**
 * The picture as a PNG file's bytes. Only the pixels are the same on every machine (R-19): the
 * file is deflated, and two builds of zlib may pack the same pixels differently, so a picture is
 * compared by its pixels and never by its file.
 */
export const textPicturePng = (picture: { width: number; height: number; rgba: Uint8Array }): Uint8Array =>
  encodePng({ width: picture.width, height: picture.height, pixels: picture.rgba });
