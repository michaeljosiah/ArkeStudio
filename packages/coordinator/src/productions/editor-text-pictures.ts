import { TextLookSchema, layoutText, paintText, textPictureName, textTypefaceFile, textWords,
  type TextDraftField, type TextFace, type TextLook, type TextPictureAsk } from "@arke-studio/contracts";
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
/**
 * A refusal with the control it belongs under (R-21, R-32): the words, the typeface or the look's
 * values. The Inspector shows a refusal of a change under the control that made it; this is for a
 * refusal of what a clip already holds, where nothing was just changed to say which.
 */
export type TextPictureRefused = { ok: false; reason: string; field: TextDraftField };
export type TextPictureMeasure = { ok: true; drawnSize: number } | TextPictureRefused;

/** A look the record refuses (R-26), by the field that is wrong, in the look's own names: "fill.stops", "shadow.blur". */
function lookRefusal(issues: readonly { code: string; path: readonly (string | number)[]; keys?: readonly string[] }[]): string {
  const issue = issues[0];
  if (issue?.code === "unrecognized_keys") return `A text look has no ${[...issue.path, issue.keys?.[0]].join(".")}`;
  return issue?.path.length ? `A text look's ${issue.path.join(".")} is out of range` : "A text look cannot be read";
}

type Ready = { ok: true; text: string; look: TextLook; face: TextFace; fileSha256: string };

/**
 * The door a clip's words and look come through, so it asks what the record asks (R-4, R-26)
 * before anything is laid out: words that are empty or too many, an unknown field and a value
 * outside its range refuse here, and nothing is clamped to fit. A blank picture with a name of
 * its own would be kept and shown as if it were the clip (R-3). The words come out as they are
 * stored, so a Windows line end or a blank line typed above them is not a second picture. After
 * that a weight or slant the typeface lacks and a file that is missing or is not the one shipped
 * each refuse in their own words (R-7, R-21). `from` is where the fonts folder is looked for, as
 * `loadTextFaceFile` reads it.
 */
function ready(ask: TextPictureAsk, from?: string): Ready | TextPictureRefused {
  const words = textWords(ask.text);
  if (!words.ok) return { ...words, field: "words" };
  const read = TextLookSchema.safeParse(ask.look);
  if (!read.success) return { ok: false, reason: lookRefusal(read.error.issues), field: "look" };
  const look = read.data;
  const choice = textTypefaceFile(look.typeface, look.weight, look.italic);
  if (!choice.ok) return { ...choice, field: "typeface" };
  const loaded = loadTextFaceFile(choice.file.file, choice.file.sha256, choice.typeface.name, from);
  if (!loaded.ok) return { ...loaded, field: "typeface" };
  return { ok: true, text: words.text, look, face: loaded.face, fileSha256: choice.file.sha256 };
}

/**
 * Past the door, the painter refuses only through its layout: a frame it will not make, a
 * character the face lacks or a mark it cannot place, and a face it cannot measure. The first
 * three are the words' to fix (a draft's frame is always one the painter makes); a face that
 * cannot be measured is the typeface's. The layout's sentence for that one is matched whole, and
 * its test holds the sentence.
 */
const laidRefusal = (reason: string, face: TextFace): TextPictureRefused =>
  ({ ok: false, reason, field: reason === `${face.name} cannot be measured` ? "typeface" : "words" });

/**
 * Paints one picture, and when it cannot, says why and under which control (R-21, R-32). A
 * draft is this function with words not yet saved (§2.3), so a draft shows exactly the picture a
 * commit would keep, and refuses exactly where a command would.
 */
export function paintTextDraft(ask: TextPictureAsk, from?: string): Extract<TextPicturePaint, { ok: true }> | TextPictureRefused {
  const door = ready(ask, from);
  if (!door.ok) return door;
  const { width, height } = ask, { text, look, face, fileSha256 } = door;
  // The painter reads the look's ink and the face it is handed; the typeface, weight and slant were settled above.
  const picture = paintText(text, look, { width, height }, face);
  if (!picture.ok) return laidRefusal(picture.reason, face);
  return { ok: true, name: textPictureName({ text, look, width, height, fileSha256 }), width, height, rgba: picture.rgba, drawnSize: picture.drawnSize };
}

/**
 * Paints one picture to keep, or refuses in the painter's words and hands back no picture. The
 * refusal is the reason alone: a kept picture is refused to an export or the media route, and
 * neither names a control.
 */
export function paintTextPicture(ask: TextPictureAsk, from?: string): TextPicturePaint {
  const painted = paintTextDraft(ask, from);
  return painted.ok ? painted : { ok: false, reason: painted.reason };
}

/**
 * The size Fit would draw this picture at, or why it cannot be drawn and under which control
 * (R-10, R-21). The painter refuses only through its layout, so this is the painter's own answer
 * without the ink: the same checks in the same order and the same words, for the cost of laying a
 * clip out against the cost of painting one. Nothing is painted, named or kept.
 */
export function measureTextPicture(ask: TextPictureAsk, from?: string): TextPictureMeasure {
  const door = ready(ask, from);
  if (!door.ok) return door;
  const laid = layoutText(door.text, door.look, { width: ask.width, height: ask.height }, door.face);
  return laid.ok ? { ok: true, drawnSize: laid.layout.drawnSize } : laidRefusal(laid.reason, door.face);
}

/**
 * Why this picture cannot be drawn, or null when it can (R-21): `measureTextPicture`'s reason. It
 * is what a command asks before it writes words a film could not show, where painting every clip
 * of a batch would hold the coordinator's loop for the length of the batch. `from` is where the
 * fonts folder is looked for, as the painter reads it.
 */
export function textPictureRefusal(ask: TextPictureAsk, from?: string): string | null {
  const measured = measureTextPicture(ask, from);
  return measured.ok ? null : measured.reason;
}

/**
 * The picture as a PNG file's bytes. Only the pixels are the same on every machine (R-19): the
 * file is deflated, and two builds of zlib may pack the same pixels differently, so a picture is
 * compared by its pixels and never by its file. `level` is a draft's alone (`encodePng`).
 */
export const textPicturePng = (picture: { width: number; height: number; rgba: Uint8Array }, options: { level?: number } = {}): Uint8Array =>
  encodePng({ width: picture.width, height: picture.height, pixels: picture.rgba }, options);
