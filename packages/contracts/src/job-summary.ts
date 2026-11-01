import { JobSchema, type Job } from "./job.js";
import { z } from "zod";
import { IsoDateTimeSchema } from "./ids.js";
import { StorageRootRoleSchema } from "./storage-health.js";

/** Current queue observation, never persisted as dispatch/retry authority. */
export const JobStorageWaitSchema = z.object({
  phase: z.enum(["submission", "result"]),
  reason: z.enum(["space", "unavailable"]),
  observedAt: IsoDateTimeSchema,
  checking: z.boolean().optional(),
  detail: z.object({
    code: z.enum(["capacity-unavailable", "capacity-stale", "mapping-changed", "unbounded-output", "space", "audit-unavailable", "reconciliation-required", "reservation-limit", "stopped", "destination-unavailable", "different-volumes"]),
    roles: z.array(StorageRootRoleSchema).max(5),
    measuredAt: z.number().int().nonnegative().safe().optional(),
    availableBytes: z.number().int().nonnegative().safe().optional(),
    deficitBytes: z.number().int().nonnegative().safe().optional(),
  }).strict().optional(),
}).strict();
export type JobStorageWait = z.infer<typeof JobStorageWaitSchema>;

/** Wire-only projection. The queue journal retains the complete dispatch parameters. */
export const JobSummarySchema = JobSchema.extend({ omittedParams: z.array(z.string()).optional(), storageWait: JobStorageWaitSchema.optional() });
export type JobSummary = z.infer<typeof JobSummarySchema>;

// Screens use routing, recovery, reference and cost metadata, not these provider payloads.
// Keep voice-design text: its candidate chooser displays that audition transcript.
export function jobSummary(job: Job): JobSummary {
  const params = { ...job.params };
  const omittedParams: string[] = [];
  for (const key of ["prompt", "text", "turns", "instructions", "authoredText", "lookPrompt"]) {
    if (key === "text" && job.target.kind === "voice-design") continue;
    if (Object.hasOwn(params, key)) { delete params[key]; omittedParams.push(key); }
  }
  return omittedParams.length ? { ...job, params, omittedParams } : job;
}
