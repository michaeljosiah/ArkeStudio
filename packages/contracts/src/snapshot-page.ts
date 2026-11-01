import { z } from "zod";
import { ArtifactSidecarSchema } from "./artifact.js";
import { JobSummarySchema } from "./job-summary.js";
import { LedgerEntrySchema } from "./job.js";
import { valueSchema } from "./value-schema.js";

const position = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const base = { offset: position, length: position, reset: z.boolean() };
/** Ordered collection patches preceding one atomic snapshot. Indexes preserve ledger rows
 * even when several receipts name the same job. No history or provenance is discarded. */
export const SnapshotPageSchema = valueSchema(z.discriminatedUnion("collection", [
  z.object({ ...base, collection: z.literal("artifacts"), rows: z.array(ArtifactSidecarSchema).max(256) }).strict(),
  z.object({ ...base, collection: z.literal("jobs"), rows: z.array(JobSummarySchema).max(256) }).strict(),
  z.object({ ...base, collection: z.literal("ledger"), rows: z.array(LedgerEntrySchema).max(256) }).strict(),
]).refine(page => page.offset + page.rows.length <= page.length, "Page exceeds collection length."));
export type SnapshotPage = z.infer<typeof SnapshotPageSchema>;
