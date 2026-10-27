import { z } from "zod";
import { UlidSchema } from "./ids.js";
const digest = z.string().regex(/^[a-f0-9]{64}$/), instant = z.number().int().nonnegative().safe();
export const RECOVERY_ACTION_LIMITS = Object.freeze({ previews: 64, previewMs: 5 * 60_000 });
export const RecoveryRetryPlanSchema = z.object({
  id: digest, action: z.literal("retry-managed-runtime"), resourceKey: digest,
  service: z.enum(["ollama", "comfyui", "harness", "voice", "ming"]), evidence: digest,
  policyRevision: z.literal(1), preparedAt: instant, expiresAt: instant,
  downloadBytes: z.literal(0), diskBytes: z.null(), interruptsWork: z.literal(false), replaysJobs: z.literal(false),
}).strict().refine(value => value.expiresAt > value.preparedAt && value.expiresAt - value.preparedAt <= RECOVERY_ACTION_LIMITS.previewMs);
export type RecoveryRetryPlan = z.infer<typeof RecoveryRetryPlanSchema>;
export const CACHE_CLEANUP_POLICY = Object.freeze({ revision: 1, minAgeMs: 7 * 24 * 60 * 60_000, maxFiles: 8, maxBytes: 2 * 1024 ** 3 });
export const RecoveryCachePlanSchema = z.object({
  id: digest, action: z.literal("cleanup-local-preset-previews"), evidence: digest, policyRevision: z.literal(1),
  preparedAt: instant, expiresAt: instant, category: z.literal("fixed-local-preset-previews"),
  files: z.number().int().min(1).max(CACHE_CLEANUP_POLICY.maxFiles), logicalBytes: instant.max(CACHE_CLEANUP_POLICY.maxBytes),
  targets: z.array(z.object({ resourceKey: digest, createdAt: instant, logicalBytes: instant.min(1), allocatedBytes: instant.nullable() }).strict()).min(1).max(CACHE_CLEANUP_POLICY.maxFiles),
  allocatedBytes: instant.nullable(), minAgeMs: z.literal(CACHE_CLEANUP_POLICY.minAgeMs),
  stopAtAvailableBytes: instant.nullable(),
  replaysJobs: z.literal(false), interruptsWork: z.literal(false), undoable: z.literal(false),
}).strict().refine(value => value.expiresAt > value.preparedAt && value.expiresAt - value.preparedAt <= RECOVERY_ACTION_LIMITS.previewMs &&
  value.files === value.targets.length && new Set(value.targets.map(row => row.resourceKey)).size === value.targets.length &&
  value.targets.every(row => row.createdAt <= value.preparedAt - CACHE_CLEANUP_POLICY.minAgeMs) &&
  value.logicalBytes === value.targets.reduce((sum, row) => sum + row.logicalBytes, 0) &&
  (value.targets.some(row => row.allocatedBytes === null) ? value.allocatedBytes === null : value.allocatedBytes === value.targets.reduce((sum, row) => sum + row.allocatedBytes!, 0)));
export type RecoveryCachePlan = z.infer<typeof RecoveryCachePlanSchema>;
export const RecoveryCacheOutcomeSchema = z.object({
  removedFiles: z.number().int().min(0).max(CACHE_CLEANUP_POLICY.maxFiles), logicalBytes: instant,
  availableBefore: instant.nullable(), availableAfter: instant.nullable(), reclaimedBytes: z.null(),
}).strict();
export type RecoveryCacheOutcome = z.infer<typeof RecoveryCacheOutcomeSchema>;
export const CACHE_MAINTENANCE_POLICY = Object.freeze({ revision: 1, intervalMs: 5 * 60_000 });
export const RecoveryCacheMaintenanceRunSchema = z.object({ at: instant,
  status: z.enum(["verified", "refused", "unknown", "cancelled"]), cleanup: RecoveryCacheOutcomeSchema }).strict();
export type RecoveryCacheMaintenanceRun = z.infer<typeof RecoveryCacheMaintenanceRunSchema>;
export const RecoveryCacheMaintenanceSchema = z.object({ enabled: z.boolean(), rootScope: z.literal("fixed-local-preset-previews"),
  minAgeMs: z.literal(CACHE_CLEANUP_POLICY.minAgeMs), maxFiles: z.literal(CACHE_CLEANUP_POLICY.maxFiles), maxBytes: z.literal(CACHE_CLEANUP_POLICY.maxBytes),
  nextAttemptAt: instant, lastRun: RecoveryCacheMaintenanceRunSchema.optional() }).strict();
export const RecoveryCacheReconciliationSchema = z.object({ outcome: z.enum(["removed", "retained", "unconfirmed"]),
  availableBytes: instant.nullable() }).strict();
export type RecoveryCacheReconciliation = z.infer<typeof RecoveryCacheReconciliationSchema>;
/** Review and approval are separate host commands. No path, launch setting or arbitrary action. */
export const RecoveryActionCommandSchema = z.object({ kind: z.literal("recovery-action"), requestId: UlidSchema,
  command: z.discriminatedUnion("action", [
    z.object({ action: z.literal("preview-retry"), resourceKey: digest }).strict(),
    z.object({ action: z.literal("approve-retry"), planId: digest }).strict(),
    z.object({ action: z.literal("preview-cleanup") }).strict(),
    z.object({ action: z.literal("approve-cleanup"), planId: digest }).strict(),
    z.object({ action: z.literal("reconcile-cleanup") }).strict(),
    z.object({ action: z.literal("set-cleanup-maintenance"), enabled: z.boolean() }).strict(),
    z.object({ action: z.literal("cancel"), planId: digest }).strict(),
  ]),
}).strict();
export type RecoveryActionCommand = z.infer<typeof RecoveryActionCommandSchema>;
export const RecoveryActionResultSchema = z.object({ requestId: UlidSchema,
  status: z.enum(["preview", "accepted", "verified", "failed", "unknown", "refused", "cancelled"]),
  plan: RecoveryRetryPlanSchema.optional(),
  cleanupPlan: RecoveryCachePlanSchema.optional(), cleanup: RecoveryCacheOutcomeSchema.optional(),
  reconciliation: RecoveryCacheReconciliationSchema.optional(),
  maintenanceSaved: z.boolean().optional(),
  reason: z.enum(["unavailable", "stale", "busy", "cancelled"]).optional(),
}).strict().refine(value => !(value.plan && value.cleanupPlan) && (!value.cleanup || value.cleanupPlan !== undefined) &&
  (!value.reconciliation || !value.plan && !value.cleanupPlan && !value.cleanup) &&
  (value.maintenanceSaved === undefined || value.status === "verified" && !value.plan && !value.cleanupPlan && !value.cleanup && !value.reconciliation));
export type RecoveryActionResult = z.infer<typeof RecoveryActionResultSchema>;
