import { z } from "zod";
import { IsoDateTimeSchema, JobIdSchema, ShotIdSchema, SlugSchema, UlidSchema } from "./ids.js";
import { CapabilitySchema } from "./provider.js";

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

/**
 * Reference kits assembled from a landed artifact: finalization copies the file into a take and
 * records its provenance.
 */
export const REFERENCE_FINALIZATION_TARGETS: ReadonlySet<string> = new Set([
  "main-photo-candidate",
  "establish-candidate",
  "character-sheet",
  "character-look",
  "location-view-candidate",
]);

/**
 * Finalizations the queue may replay: re-running one touches no provider and spends nothing, so a
 * failed one can always be handed back to the user as a retry.
 *
 * Every kind listed here MUST be offered `retry-finalization` by `computeNeedsYou`. A failed
 * finalization is undeletable by `canDeleteJob` — deliberately, since it still owes the user an
 * outcome — so a replayable kind with no retry action strands the row in Needs You forever with
 * nothing the user can do about it. The two lists are asserted equal in the activity tests.
 */
export const REPLAYABLE_FINALIZATION_TARGETS: ReadonlySet<string> = new Set([
  ...REFERENCE_FINALIZATION_TARGETS,
  "voice-preview",
]);

export const JobFinalizationSchema = z
  .object({
    status: z.enum(["pending", "complete", "failed"]),
    error: z.string().nullable(),
    updatedAt: IsoDateTimeSchema,
  })
  .strict();
export type JobFinalization = z.infer<typeof JobFinalizationSchema>;

export const JobSchema = z
  .object({
    id: JobIdSchema,
    /** Generated before any network call; attached to the provider request where honoured (§10.1). */
    idempotencyKey: UlidSchema,
    worldId: UlidSchema,
    productionId: SlugSchema.optional(),
    target: JobTargetSchema,
    capability: CapabilitySchema,
    provider: z.string().min(1),
    model: z.string().min(1),
    params: z.record(z.string(), z.unknown()).default({}),
    /** Manifest-derived pre-dispatch estimate in integer micro-dollars (R-PROV-4, SPEC-008 R-14). */
    estimatedMicroUsd: z.number().int().min(0),
    status: JobStatusSchema,
    /** The provider's own job id, recorded before the state moves to running. */
    providerJobId: z.string().nullable().default(null),
    /** Physical submission calls authorized, persisted before provider I/O (SPEC-009 R-9). */
    attempt: z.number().int().min(0).default(0),
    /** Where artifacts land, world-relative — the caller's meaning, not this spec's (§1.2). */
    landing: z
      .object({
        dir: z.string().min(1),
        /** Rename the first artifact on landing (cache-keyed previews, SPEC-011 R-10). */
        name: z.string().min(1).optional(),
      })
      .strict()
      .optional(),
    /** Files landed on success, world-relative, in artifact order. */
    landedFiles: z.array(z.string()).optional(),
    /** Domain follow-on after provider success, durable and retryable without another charge. */
    finalization: JobFinalizationSchema.optional(),
    error: z.string().nullable().default(null),
    /**
     * The user removed this job from Activity's history. A deletion is a record like any other
     * transition — the journal stays append-only, and the fold drops the id rather than the file
     * losing lines. The ledger entry is untouched: what was spent stays spent (SPEC-008 R-15).
     */
    deletedAt: IsoDateTimeSchema.optional(),
    createdAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema,
  })
  .strict();
export type Job = z.infer<typeof JobSchema>;

/** One provider's queue state (SPEC-009 R-8, R-11): paused-with-reason, and what is held. */
export const QueueStatusSchema = z
  .object({
    provider: z.string().min(1),
    paused: z.boolean(),
    pauseKind: z.enum(["fault", "offline", "credential"]).optional(),
    /** Why: "FAL rejected the key (HTTP 401)", "offline", "no credential stored" … */
    reason: z.string().optional(),
    /** Non-terminal jobs currently held behind the pause or awaiting the user. */
    held: z.number().int().min(0),
  })
  .strict();
export type QueueStatus = z.infer<typeof QueueStatusSchema>;

/** What start-up reconciliation did to one job (SPEC-009 R-18). */
export const ReconcileActionSchema = z
  .object({
    jobId: JobIdSchema,
    action: z.enum(["adopted", "resubmitted", "held-for-user", "resumed-polling", "ledger-completed", "requeued"]),
    detail: z.string().optional(),
  })
  .strict();
export type ReconcileAction = z.infer<typeof ReconcileActionSchema>;

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
