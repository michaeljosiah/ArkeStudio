import { z } from "zod";
import { IsoDateTimeSchema, JobIdSchema, ShotIdSchema, SlugSchema, UlidSchema } from "./ids.js";

/**
 * The job queue (master spec §10.1). App-level, durable, append-only at
 * `%USERPROFILE%\ArkeStudio\queue\jobs.jsonl` so the Activity screen shows everything at once.
 *
 * States: queued → submitting → running → succeeded | failed | cancelled.
 * A job found `submitting` on restart is of unknown remote state and is never blindly resent;
 * reconciliation either adopts the remote job or parks it `needs-reconciliation` for the user.
 */

export const JobStatusSchema = z.enum([
  "queued",
  "submitting",
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "needs-reconciliation",
]);
export type JobStatus = z.infer<typeof JobStatusSchema>;

export const JobTargetSchema = z
  .object({
    /** What the job produces for: "shot" | "scene-pass" | "model-sheet" | "voice-line" | "extraction" | … */
    kind: z.string().min(1),
    /** The primary target id (shot id, sheet slug, artifact id …), when there is one. */
    id: z.string().optional(),
    coversShots: z.array(ShotIdSchema).optional(),
  })
  .strict();
export type JobTarget = z.infer<typeof JobTargetSchema>;

export const JobSchema = z
  .object({
    id: JobIdSchema,
    /** Generated before any network call; attached to the provider request where honoured (§10.1). */
    idempotencyKey: UlidSchema,
    worldId: UlidSchema,
    productionId: SlugSchema.optional(),
    target: JobTargetSchema,
    provider: z.string().min(1),
    model: z.string().min(1),
    params: z.record(z.string(), z.unknown()).default({}),
    /** Manifest-derived pre-dispatch estimate in integer micro-dollars (R-PROV-4, SPEC-008 R-14). */
    estimatedMicroUsd: z.number().int().min(0),
    status: JobStatusSchema,
    /** The provider's own job id, recorded before the state moves to running. */
    providerJobId: z.string().nullable().default(null),
    error: z.string().nullable().default(null),
    createdAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema,
  })
  .strict();
export type Job = z.infer<typeof JobSchema>;

/** ledger.jsonl — one line per completed job (§14.4). Estimate and actual recorded separately. */
export const LedgerEntrySchema = z
  .object({
    ts: IsoDateTimeSchema,
    worldId: UlidSchema,
    productionId: SlugSchema.optional(),
    jobId: JobIdSchema,
    provider: z.string().min(1),
    model: z.string().min(1),
    outcome: z.enum(["succeeded", "failed", "cancelled"]),
    estimatedMicroUsd: z.number().int().min(0),
    actualMicroUsd: z.number().int().min(0).nullable(),
    actualSource: z.enum(["provider-reported", "manifest-derived", "local-zero"]).optional(),
  })
  .strict();
export type LedgerEntry = z.infer<typeof LedgerEntrySchema>;
