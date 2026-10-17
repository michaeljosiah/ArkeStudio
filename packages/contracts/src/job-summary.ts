import { JobSchema, type Job } from "./job.js";
import { z } from "zod";

/** Wire-only projection. The queue journal retains the complete dispatch parameters. */
export const JobSummarySchema = JobSchema.extend({ omittedParams: z.array(z.string()).optional() });
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
