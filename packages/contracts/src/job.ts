import { z } from "zod";
import { JobEngineIdentitySchema, RecipeIdentitySchema } from "./comfyui.js";
import { GenesisIdSchema, IsoDateTimeSchema, JobIdSchema, ShotIdSchema, SlugSchema, UlidSchema } from "./ids.js";
import { CapabilitySchema } from "./provider.js";

/**
 * What a job or a ledger entry is scoped to (SPEC-031 R-55, amending SPEC-009): a world, or —
 * for the one generation that exists before any world does, the founding look preview — the
 * genesis conversation it was made in. Never a placeholder world. When the conversation
 * becomes a world at Begin, the job is re-associated; a ledger entry keeps the scope the money
 * was actually spent under, joinable to the world through its build record's genesisId.
 */
export const JobScopeSchema = z.union([UlidSchema, GenesisIdSchema]);

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

/** SPEC-009's retry vocabulary, retained on a job so every consumer reaches the same decision. */
export const JobFailureClassSchema = z.enum(["transient", "terminal", "provider-fault", "offline"]);
export type JobFailureClass = z.infer<typeof JobFailureClassSchema>;

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
  "character-voice-sample",
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
  "performance-conversion",
  ...REFERENCE_FINALIZATION_TARGETS,
  "voice-line",
  "voice-preview",
  /** A bench take (issue 305): media lands in the session, the log records hash/info/cost. */
  "bench-take",
]);

/**
 * Whether a job's finalization can be replayed — the set above by target kind, plus the one
 * parameterised case: a shot job that asked for frame-slot landing (SPEC-036 §2.8). Its
 * finalization is pure local filing — the take rejoins by job id, the filing is fenced — so a
 * retry touches no provider and spends nothing. Bare `shot` stays out: a clip's finalization
 * moves media through a window a replay cannot re-enter.
 */
export function isReplayableFinalization(job: {
  target: { kind: string };
  params: Record<string, unknown>;
}): boolean {
  if (REPLAYABLE_FINALIZATION_TARGETS.has(job.target.kind)) return true;
  return (job.target.kind === "shot" || job.target.kind === "board-sheet") && job.params["landing"] === "frame-slot";
}

export const JobFinalizationSchema = z
  .object({
    status: z.enum(["pending", "complete", "failed"]),
    error: z.string().nullable(),
    /** Operational cause retained separately from the stable user-facing recovery copy. */
    cause: z.string().min(1).optional(),
    updatedAt: IsoDateTimeSchema,
  })
  .strict();
export type JobFinalization = z.infer<typeof JobFinalizationSchema>;

export const JobSchema = z
  .object({
    id: JobIdSchema,
    /** Generated before any network call; attached to the provider request where honoured (§10.1). */
    idempotencyKey: UlidSchema,
    worldId: JobScopeSchema,
    productionId: SlugSchema.optional(),
    target: JobTargetSchema,
    capability: CapabilitySchema,
    provider: z.string().min(1),
    model: z.string().min(1),
    params: z.record(z.string(), z.unknown()).default({}),
    /** Manifest-derived pre-dispatch estimate in integer micro-dollars (R-PROV-4, SPEC-008 R-14). */
    estimatedMicroUsd: z.number().int().min(0),
    /**
     * Which recipe, exactly, a local-recipe job was dispatched as (SPEC-021 §2.11, R-15).
     * Frozen at enqueue: a job that outlives an app update executes and is recorded as what it
     * was dispatched as, never as whatever the catalogue holds by the time it lands.
     */
    recipe: RecipeIdentitySchema.optional(),
    /**
     * Which engine it was dispatched against, as source kind, opaque instance digest and (for
     * spawned engines) process epoch — job rows reach the renderer, so never a path
     * (SPEC-021 §2.11). Recovery policy reads this; an old prompt id is never polled against a
     * different engine, including a replacement process launched from the same path.
     */
    engine: JobEngineIdentitySchema.optional(),
    /** Opaque engine instance explicitly approved for a biometric voice upload. */
    voiceUploadConfirmedFor: z.string().min(1).optional(),
    status: JobStatusSchema,
    /**
     * What the engine is counting right now (SPEC-021 D16), or null when it counts nothing.
     *
     * Carried with its stage rather than as a bare fraction: a recipe is a graph, and one node's
     * steps are not the job's own percentage. Transient — it is whatever the last poll saw, and
     * it goes back to null the moment the job stops running.
     */
    step: z
      .object({ stage: z.string().min(1), done: z.number().int().min(0), total: z.number().int().min(1) })
      .strict()
      .nullable()
      .optional(),
    /** The provider's own job id, recorded before the state moves to running. */
    providerJobId: z.string().nullable().default(null),
    /** Physical submission calls authorized, persisted before provider I/O (SPEC-009 R-9). */
    attempt: z.number().int().min(0).default(0),
    /** The last submit response proved that attempt was rejected, so cancellation cannot imply a charge. */
    submissionRejected: z.boolean().optional(),
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
    /** The last classified failure, durable even when its handling puts the job back in a queue. */
    failureClass: JobFailureClassSchema.nullable().optional(),
    /** Exact provider-reported terminal charge, persisted across the terminal-row/ledger window. */
    providerCostMicroUsd: z.number().int().min(0).optional(),
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

/** The output format frozen in a voice job, with legacy provider defaults for older journals. */
export function voiceJobFormat(job: Pick<Job, "provider" | "params">): "wav" | "mp3" | "flac" {
  const format = job.params["audioFormat"];
  if (format === "wav" || format === "mp3" || format === "flac") return format;
  return job.provider === "kokoro" ? "wav" : job.provider === "comfyui" ? "flac" : "mp3";
}

/** Rebuild the document identity frozen into a durable voice-preview job. */
export function voiceJobReadIdentity(job: Pick<Job, "params">): {
  purpose: "candidate-preview" | "sheet-section" | "bible-section";
  sheetId?: string;
} {
  const rawPurpose = job.params["purpose"];
  const purpose = rawPurpose === "sheet-section" || rawPurpose === "bible-section"
    ? rawPurpose
    : "candidate-preview";
  if (purpose === "bible-section") return { purpose };
  const sheetId = job.params["sheetId"];
  return typeof sheetId === "string" && sheetId.length > 0 ? { purpose, sheetId } : { purpose };
}

/** Only character auditions feed `voice.preview`; document reads feed `voice.audio` alone. */
export function voiceJobIsCandidatePreview(job: Pick<Job, "params">): boolean {
  return voiceJobReadIdentity(job).purpose === "candidate-preview";
}

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
    action: z.enum(["adopted", "resubmitted", "held-for-user", "resumed-polling", "ledger-completed", "requeued", "failed"]),
    detail: z.string().optional(),
  })
  .strict();
export type ReconcileAction = z.infer<typeof ReconcileActionSchema>;

/** ledger.jsonl — one line per completed job (§14.4). Estimate and actual recorded separately. */
export const LedgerEntrySchema = z
  .object({
    ts: IsoDateTimeSchema,
    worldId: JobScopeSchema,
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
