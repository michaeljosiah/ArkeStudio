import { z } from "zod";
import { IsoDateTimeSchema } from "./ids.js";
import { BenchVideoParamsSchema } from "./bench.js";

/** A dispatch quote may depend on Bench; portable picture records must not. */
export const AudiobookMotionQuoteSchema = z
  .object({
    sourceFile: z.string().min(1),
    sourceAt: IsoDateTimeSchema,
    sourceHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    model: z
      .object({ provider: z.string().min(1), id: z.string().min(1), label: z.string().min(1) })
      .strict(),
    params: BenchVideoParamsSchema,
    prompt: z.string().min(1).max(10000),
    estimatedMicroUsd: z.number().int().min(0),
    typicalRunSec: z.number().positive().optional(),
  })
  .strict();
export type AudiobookMotionQuote = z.infer<typeof AudiobookMotionQuoteSchema>;

