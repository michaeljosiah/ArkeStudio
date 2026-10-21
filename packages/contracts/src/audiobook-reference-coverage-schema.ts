import { z } from "zod";

/** Current authored evidence, not a claim that every manuscript identity has been discovered. */
export const ReferenceCoverageRowSchema = z.object({
  kind: z.enum(["character", "place"]),
  key: z.string(), name: z.string(), blocks: z.array(z.string()),
  state: z.enum(["ready", "missing-reference", "unlinked", "ambiguous", "needs-review", "not-depicted"]),
  sheet: z.string().optional(), reference: z.string().optional(), billing: z.string().optional(), aliases: z.array(z.string()).optional(),
}).strict();
export type ReferenceCoverageRow = z.infer<typeof ReferenceCoverageRowSchema>;
const CoverageBoundSchema = z.object({ limit: z.number().int().min(0), omitted: z.number().int().min(0) }).strict();
export const ChapterReferenceCoverageSchema = z.object({
  chapterId: z.string(), file: z.string(), title: z.string(), order: z.number().int().min(0),
  preparation: z.enum(["current", "missing", "stale", "unreadable", "unavailable"]),
  rows: z.array(ReferenceCoverageRowSchema),
  bounds: z.object({ people: CoverageBoundSchema, places: CoverageBoundSchema, text: CoverageBoundSchema }).strict(),
}).strict();
export type ChapterReferenceCoverage = z.infer<typeof ChapterReferenceCoverageSchema>;

