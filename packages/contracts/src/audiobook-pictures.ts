import { z } from "zod";
import { IsoDateTimeSchema } from "./ids.js";
import { PictureLookSchema, PictureLookReviewSchema } from "./audiobook-look.js";
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
    /** Same-file picker reaffirmation against a later look; the original look and shot stay intact. */
    lookReview: PictureLookReviewSchema.optional(),
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
    /**
     * The same moment made Tall, 9:16, for a phone (design turn 235, SPEC-047 R-197), made from
     * this picture: `from` is this picture's `file` when it was made, so one made from an earlier
     * picture is marked and still plays until it is made again (the owner's call 3).
     */
    tall: z.object({ file: z.string().min(1).max(1000), at: IsoDateTimeSchema, from: z.string().min(1).max(1000) }).strict().optional(),
    /**
     * A picture set inside its block, at a sentence (design turn 237, SPEC-047 R-202): the hash of
     * that sentence's words, as `sentencesOf` cuts them. Absent, the picture stands at its block's
     * first word, as every picture set before the turn does. Kept under `pictureMarkKey`.
     */
    mark: z.object({ sentence: z.string().min(1).max(64) }).strict().optional(),
  })
  .strict();
export type AudiobookPicture = z.infer<typeof AudiobookPictureSchema>;

/**
 * A mark's key on the chapter's record (design turn 237, SPEC-047 R-202): its block's key, `@`, and
 * the hex of its sentence's hash, so the key alone names the sentence — a window can ask for a
 * picture at a sentence with nothing on the record yet, and every command that names a picture by
 * its block takes a mark's key the same way. A block's own picture keeps the block's key.
 */
export function pictureMarkKey(block: string, sentenceHash: string): string {
  return `${block}@${sentenceHash.replace(/^text-v1:/, "")}`;
}

/** A picture key read back: the block it was set in and, for a mark, its sentence's hash. */
export function pictureKeyParts(key: string): { block: string; sentence?: string } {
  const at = key.lastIndexOf("@");
  if (at <= 0 || at === key.length - 1) return { block: key };
  return { block: key.slice(0, at), sentence: `text-v1:${key.slice(at + 1)}` };
}

/** A picture's Tall, made from an earlier picture than the one it has now (SPEC-047 R-197). */
export const tallFromEarlier = (picture: Pick<AudiobookPicture, "file" | "tall">): boolean => picture.tall !== undefined && picture.tall.from !== picture.file;

/** One picture gives way to the next over this long. A picture holds until the next one, however soon (design turn 237, R-207). */
export const PICTURE_CROSSFADE_SEC = 1;
