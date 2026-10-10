import { z } from "zod";
import { IsoDateTimeSchema } from "./ids.js";
import { PictureLookSchema } from "./audiobook-look.js";
import { PictureShotSchema } from "./audiobook-illustrate.js";
import { AudiobookMotionSchema } from "./audiobook-motion.js";

/**
 * A picture set on a block (design turn 186c, SPEC-047 R-66): it shows from that block until the
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
    /**
     * The look the picture was made under (design turn 191c, SPEC-047 R-98): who was in it and a
     * digest of their lines, so a picture made under a look that has since changed is marked and
     * never remade without asking. Absent on a picture the author chose rather than Arke made.
     */
    look: PictureLookSchema.optional(),
    /**
     * The shot it was made from (design turn 194g, SPEC-047 R-120, R-121): the frame, who was in it
     * and who was not, and the checks as they stood when Generate was pressed — so the block's card
     * still says them once the picture is made, and Make again keeps the frame. Absent on a picture
     * chosen rather than made, and on one made before this was kept: never reconstructed.
     */
    shot: PictureShotSchema.optional(),
    /**
     * Where the picture's subject stands, as shares of its width and height (design turn 197,
     * SPEC-047): the vertical video crops a full-height column around it, and Slow push moves
     * toward it. Kept on the picture, set by dragging in the video's preview; absent is the centre.
     */
    focus: z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) }).strict().optional(),
    /** The source still stays in file. A candidate never changes the visual until explicitly chosen. */
    motion: AudiobookMotionSchema.optional(),
    motionCandidate: AudiobookMotionSchema.optional(),
  })
  .strict();
export type AudiobookPicture = z.infer<typeof AudiobookPictureSchema>;

/** A picture stays at least this long (turn 186): a shorter hold is flagged in the chapter's view, never dropped. */
export const PICTURE_MIN_HOLD_SEC = 20;
/** One picture gives way to the next over this long. */
export const PICTURE_CROSSFADE_SEC = 1;
