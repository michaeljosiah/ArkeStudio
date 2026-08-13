import { z } from "zod";
import { IsoDateTimeSchema } from "./ids.js";

/**
 * What a file actually is, measured rather than assumed (#253).
 *
 * A track whose length is unknown cannot be a clock, and a take whose length is unknown cannot be
 * checked against the window it was cut for — so both the spine and the cut refuse to guess here.
 * Nothing in this shape is declared by a user or inferred from a filename: it is ffprobe's answer,
 * parsed at a strict boundary, or it is absent.
 */
export const MediaInfoSchema = z
  .object({
    durationSec: z.number().positive(),
    hasAudio: z.boolean(),
    audioChannels: z.number().int().positive().optional(),
    audioSampleRateHz: z.number().int().positive().optional(),
  })
  .strict();
export type MediaInfo = z.infer<typeof MediaInfoSchema>;

/**
 * A probe result for one take's media, stored beside the take and never inside it.
 *
 * `take.json` is immutable — it is the record of what was dispatched and what came back, and a
 * measurement taken afterwards is neither. Writing the duration into it would also make a failed
 * probe indistinguishable from a take that was never probed, and turn a retry into a rewrite of
 * paid history. So this lands at
 * `productions/<productionId>/takes/<sourceTakeId>/media-info.json` instead, and a take with no
 * record is simply one nobody has measured yet.
 *
 * `sourceHash` is the full hash of the bytes that were measured, so a record that outlived its
 * media — or was copied beside different media — is detectable rather than quietly believed.
 */
export const TakeMediaInfoRecordSchema = z
  .object({
    sourceHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    mediaInfo: MediaInfoSchema,
    probedAt: IsoDateTimeSchema,
  })
  .strict();
export type TakeMediaInfoRecord = z.infer<typeof TakeMediaInfoRecordSchema>;
