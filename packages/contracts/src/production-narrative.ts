import { z } from "zod";

/** SPEC-012 §4: a film's arc has an authored home without acquiring a fake season. */
export const PRODUCTION_SETUP_SCHEMA_VERSION = 19;
export const NarrativeFieldsSchema = z.object({
  question: z.string().max(20_000).optional(),
  direction: z.string().max(20_000).optional(),
  ending: z.string().max(20_000).optional(),
  arcNotes: z.string().max(20_000).optional(),
}).strict();
export const ProductionNarrativeSchema = NarrativeFieldsSchema.extend({
  version: z.number().int().min(1),
}).strict();
export type ProductionNarrative = z.infer<typeof ProductionNarrativeSchema>;
