import { z } from "zod";
import { ArtifactIdSchema } from "./ids.js";

/**
 * What a take records of a grouped read (design turn 185, SPEC-047): the request it was cut from,
 * the blocks that request carried — its neighbours, which shaped how it was read — how the turns
 * were packed, and where in the request's audio the take sits. The take's direction stays the
 * block's own, so a regrouping never makes a take stale; this says how it was made.
 */
export const AudiobookGroupedSchema = z
  .object({
    /** The request's job. */
    request: z.string().min(1),
    /** Every block the request carried, in reading order: the take's block and its neighbours. */
    blocks: z.array(z.string().min(1)).min(2).max(400),
    packing: z.enum(["full", "deltas", "merged"]),
    /** Where the cut sits in the request's audio, in seconds. */
    offsetSec: z.number().min(0),
    durationSec: z.number().positive(),
  })
  .strict();
export type AudiobookGrouped = z.infer<typeof AudiobookGroupedSchema>;

/**
 * The loudness a take was filed at (design turn 185): its integrated loudness as measured
 * (BS.1770, null for a take too quiet or short to gate), the gain applied to reach the speech
 * target, and the sample peak after it. A grouped take carries its request's measurement: the
 * request is one performance, gained as one, so a whisper inside it stays a whisper.
 */
export const AudiobookLoudnessSchema = z
  .object({
    integratedLufs: z.number().nullable(),
    gainDb: z.number(),
    peakDbfs: z.number().nullable(),
  })
  .strict();
export type AudiobookLoudness = z.infer<typeof AudiobookLoudnessSchema>;

/** The loudness every take is filed at: about −18 LUFS integrated, with the peak held under −1 dB. */
export const TAKE_LOUDNESS_TARGET = { integratedLufs: -18, peakDbfs: -1 } as const;

/**
 * A cut whose words did not match (design turn 185c): filed on the shelf, not chosen — the
 * flag holds it with what was heard, until the author keeps it or reads the block again.
 */
export const AudiobookSplitFlagSchema = z
  .object({
    artifactId: ArtifactIdSchema,
    heard: z.string().max(4000),
    request: z.string().min(1),
    offsetSec: z.number().min(0),
    durationSec: z.number().positive(),
  })
  .strict();
export type AudiobookSplitFlag = z.infer<typeof AudiobookSplitFlagSchema>;

/** The reason a mismatched split is flagged with, which the panel recognises by its opening. */
export const SPLIT_DID_NOT_MATCH = "split did not match";
