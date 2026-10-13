import { z } from "zod";
import { IsoDateTimeSchema, SlugSchema, UlidSchema } from "./ids.js";
import type { Job } from "./job.js";
import { speechSettlement } from "./speech-pricing.js";
import { formatMicroUsd } from "./money.js";

/** The read operation, not a second job/ledger (SPEC-014, turn 206). */
export const AudiobookActivitySchema = z.object({
  id: UlidSchema,
  worldId: UlidSchema,
  productionId: SlugSchema,
  chapterId: SlugSchema,
  chapterFile: z.string().min(1),
  chapterTitle: z.string().min(1),
  chapterOrder: z.number().int().min(0).optional(),
  productionTitle: z.string().min(1),
  worldName: z.string().min(1),
  scope: z.enum(["chapter", "block"]),
  block: z.string().min(1).optional(),
  phase: z.enum(["queued", "reading", "aligning", "stopping", "stopped", "interrupted", "finished", "ready"]),
  startedAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
  toMake: z.number().int().min(0),
  made: z.number().int().min(0),
  flagged: z.number().int().min(0),
  requests: z.number().int().min(0),
  request: z.number().int().min(0),
  estimatedMicroUsd: z.number().int().min(0),
  models: z.array(z.string().min(1)),
  local: z.boolean(),
  plan: z.enum(["free-plan", "free-credit"]).optional(),
  jobs: z.array(z.object({ id: z.string().min(1), index: z.number().int().min(1), reused: z.boolean(), saved: z.number().int().min(0).optional() }).strict()),
  reason: z.string().optional(),
  interruptedDuring: z.enum(["reading", "aligning"]).optional(),
}).strict();
export type AudiobookActivity = z.infer<typeof AudiobookActivitySchema>;
export type AudiobookActivityUpdate = Partial<Pick<AudiobookActivity, "phase" | "toMake" | "made" | "flagged" | "requests" | "request" | "estimatedMicroUsd" | "models" | "local" | "plan" | "reason">> & { job?: AudiobookActivity["jobs"][number] };
export const audiobookActivityLive = (run: AudiobookActivity): boolean => ["queued", "reading", "aligning", "stopping"].includes(run.phase);
export const audiobookActivityPath = (run: AudiobookActivity): string => `/w/${run.worldId}/p/${run.productionId}/story/chapters/${run.chapterId}?view=audiobook${run.scope === "block" && run.block ? `&block=${encodeURIComponent(run.block)}` : ""}`;

export function audiobookActivityTitle(run: AudiobookActivity): string {
  const noun = run.scope === "block" ? "Block re-read" : "Narration";
  const action = run.phase === "reading" ? (run.scope === "block" ? "Re-reading block" : "Reading narration")
    : run.phase === "aligning" ? (run.scope === "block" ? "Aligning block" : "Aligning narration")
    : run.phase === "finished" ? "Reading finished" : `${noun} ${run.phase}`;
  return `${run.chapterTitle} · ${action}`;
}

export function audiobookActivityStage(run: AudiobookActivity): string {
  const phase = run.phase === "aligning" ? "Aligning locally" : run.phase === "queued" ? "Waiting for the reader"
    : run.phase === "stopping" ? "Keeping the blocks already saved" : run.phase === "finished" ? `${run.flagged} block${run.flagged === 1 ? "" : "s"} need review`
    : run.phase === "reading" ? "Reading" : run.phase === "ready" ? "Finished" : run.phase === "stopped" ? "Stopped" : "Interrupted";
  return [phase, run.request > 0 && ["reading", "aligning"].includes(run.phase) ? `request ${run.request} of ${run.requests}` : ""].filter(Boolean).join(" · ");
}

export function audiobookRequestCost(job: Job): { amount: number | null; label: string } {
  const settled = speechSettlement(job);
  const actual = settled.actualMicroUsd;
  if (actual !== null) return { amount: actual, label: `${formatMicroUsd(actual)} ${settled.actualSource === "provider-reported" ? "reported" : settled.actualSource === "free-plan" ? "free plan" : settled.actualSource === "usage-derived" ? "from usage" : "measured"}` };
  const submitted = job.providerJobId !== null || (job.attempt > 0 && job.submissionRejected !== true);
  if (["failed", "cancelled", "needs-reconciliation"].includes(job.status)) return submitted
    ? { amount: null, label: "charge unknown" } : { amount: 0, label: "not charged" };
  return { amount: null, label: `~${formatMicroUsd(job.estimatedMicroUsd)} estimated` };
}

/** Costs are this press's, never the old jobs whose bytes it adopted. */
export function audiobookActivityCost(run: AudiobookActivity, jobs: readonly Job[]): string {
  const scope = run.scope === "block" ? "this re-read" : "this read";
  if (run.local) return "local";
  if (audiobookActivityLive(run) && run.phase !== "stopping") return run.plan === "free-plan" ? `free plan · ${scope}` : `~${formatMicroUsd(run.estimatedMicroUsd)}${run.plan === "free-credit" ? " from free credit" : ""} for ${scope}`;
  const charged = audiobookActivityJobs(run, jobs).filter(j => !j.reused).map(ref => jobs.find(j => j.id === ref.id));
  const values = charged.map(job => job ? run.phase === "stopping" && ["submitting", "running"].includes(job.status) && speechSettlement(job).actualMicroUsd === null ? { amount: null, label: "charge unknown" } : audiobookRequestCost(job) : { amount: null, label: "charge unknown" });
  const unknown = values.filter(value => value.label === "charge unknown").length;
  const measured = values.reduce((sum, value) => sum + (value.amount ?? 0), 0);
  if (unknown) return `${values.some(value => value.amount !== null) ? `${formatMicroUsd(measured)} ${values.filter(value => value.amount !== null).every(value => value.label.endsWith("reported")) ? "reported" : "measured"} · ` : ""}${unknown} request charge${unknown === 1 ? "" : "s"} unknown for ${scope}`;
  if (run.plan === "free-plan" && values.every(value => value.amount === 0)) return `free plan · ${scope}`;
  if (values.every(value => value.amount !== null)) return `${formatMicroUsd(measured)} ${scope}`;
  const estimate = charged.reduce((sum, job) => sum + (job ? audiobookRequestCost(job).amount ?? job.estimatedMicroUsd : 0), 0);
  return `~${formatMicroUsd(estimate)} estimated for ${scope}`;
}

/** The job journal closes the gap if a crash followed enqueue but preceded the progress append. */
export function audiobookActivityJobs(run: AudiobookActivity, jobs: readonly Job[]): AudiobookActivity["jobs"] {
  const refs = new Map(run.jobs.map(ref => [ref.id, ref]));
  for (const job of jobs) if (job.worldId === run.worldId && job.productionId === run.productionId && job.params.audiobookRunId === run.id) {
    const index = job.params.audiobookRequest;
    if (!refs.has(job.id)) refs.set(job.id, { id: job.id, index: typeof index === "number" && Number.isInteger(index) && index > 0 ? index : 1, reused: false });
  }
  return [...refs.values()].sort((a, b) => a.index - b.index);
}

/** Missing/older run records never inherit a new run merely because their chapter matches. */
export function audiobookJobRun(job: Job, runs: readonly AudiobookActivity[]): AudiobookActivity | undefined {
  return runs.find(run => run.worldId === job.worldId && run.productionId === job.productionId && (job.params.audiobookRunId === run.id || run.jobs.some(ref => ref.id === job.id && !ref.reused)));
}
