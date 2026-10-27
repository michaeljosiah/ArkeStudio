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
/** Review and approval are separate host commands. No path, launch setting or arbitrary action. */
export const RecoveryActionCommandSchema = z.object({ kind: z.literal("recovery-action"), requestId: UlidSchema,
  command: z.discriminatedUnion("action", [
    z.object({ action: z.literal("preview-retry"), resourceKey: digest }).strict(),
    z.object({ action: z.literal("approve-retry"), planId: digest }).strict(),
    z.object({ action: z.literal("cancel"), planId: digest }).strict(),
  ]),
}).strict();
export type RecoveryActionCommand = z.infer<typeof RecoveryActionCommandSchema>;
export const RecoveryActionResultSchema = z.object({ requestId: UlidSchema,
  status: z.enum(["preview", "accepted", "verified", "failed", "unknown", "refused", "cancelled"]),
  plan: RecoveryRetryPlanSchema.optional(),
  reason: z.enum(["unavailable", "stale", "busy", "cancelled"]).optional(),
}).strict();
export type RecoveryActionResult = z.infer<typeof RecoveryActionResultSchema>;
