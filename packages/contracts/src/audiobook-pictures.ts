import { z } from "zod";
import { IsoDateTimeSchema } from "./ids.js";

/**
 * A picture set on a block (design turn 186c, SPEC-047 R-57): it shows from that block until the
 * next picture, in the player and the package. Optional and sparse — most blocks carry none.
 *
 * Where it came from is the tab it was chosen on: the world's art and uploads, the cast's and
 * places' pictures, frames and takes from scenes, or one generated for the book. `file` is the
 * picture's world-relative path, as `worldImageReferences` lists it, and `textHash` the block's
 * words when it was set, so a paragraph inserted above moves the key and the picture can still
 * follow its words.
 *
 * Read permissively on purpose: this rides on the chapter's audiobook record, and a record that
 * fails to parse is a record whose every take reads as lost. A path that is no image, or no
 * longer on the shelf, is skipped where the picture is used rather than refused here.
 */
export const AudiobookPictureSourceSchema = z.enum(["world", "cast", "scenes", "generated"]);
export type AudiobookPictureSource = z.infer<typeof AudiobookPictureSourceSchema>;

export const AudiobookPictureSchema = z
  .object({
    file: z.string().min(1).max(1000),
    source: AudiobookPictureSourceSchema,
    textHash: z.string().min(1),
    at: IsoDateTimeSchema,
  })
  .strict();
export type AudiobookPicture = z.infer<typeof AudiobookPictureSchema>;

/** A picture stays at least this long (turn 186): a shorter hold is flagged in the chapter's view, never dropped. */
export const PICTURE_MIN_HOLD_SEC = 20;
/** One picture gives way to the next over this long. */
export const PICTURE_CROSSFADE_SEC = 1;
