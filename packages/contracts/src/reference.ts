import { z } from "zod";
import { IsoDateTimeSchema, SlugSchema, TakeIdSchema } from "./ids.js";

/**
 * Reference kits and model sheets (master spec §6). `references/<sheet>/kit.json` is the tile
 * inventory; tiles are unversioned but carry the sheet version they were made against, which
 * is what makes "14 reference images predate v5" computable.
 */

export const ReferenceAngleSchema = z.enum([
  "head-front",
  "head-left-three-quarter",
  "head-right-three-quarter",
  "head-profile",
  "body-full",
  "body-back",
  "detail",
  "expression",
]);
export type ReferenceAngle = z.infer<typeof ReferenceAngleSchema>;

export const ReferenceTileStatusSchema = z.enum(["empty", "draft", "locked"]);
export type ReferenceTileStatus = z.infer<typeof ReferenceTileStatusSchema>;

export const ReferenceTileSchema = z
  .object({
    angle: ReferenceAngleSchema,
    status: ReferenceTileStatusSchema,
    /** Filename within the kit directory; absent while the slot is empty. */
    file: z.string().optional(),
    /** The take that produced the tile, when generated rather than uploaded. */
    sourceTakeId: TakeIdSchema.optional(),
    /** The sheet version the tile was made against. */
    sheetVersion: z.number().int().min(1).optional(),
  })
  .strict();
export type ReferenceTile = z.infer<typeof ReferenceTileSchema>;

export const ReferenceKitSchema = z
  .object({
    sheetId: SlugSchema,
    tiles: z.array(ReferenceTileSchema),
    /** The compiled model sheet, when one has been compiled (§6.2). */
    modelSheet: z
      .object({
        file: z.string().min(1),
        sheetVersion: z.number().int().min(1),
        compiledAt: IsoDateTimeSchema,
        /** The angles compiled in, in layout order. */
        tiles: z.array(ReferenceAngleSchema),
      })
      .strict()
      .optional(),
  })
  .strict();
export type ReferenceKit = z.infer<typeof ReferenceKitSchema>;
