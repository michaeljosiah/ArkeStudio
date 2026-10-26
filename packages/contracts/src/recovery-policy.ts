import { z } from "zod";

/** SPEC-061 R-7/R-11/R-25. This control state is separate from removable incident history.
 * None of its outcomes establish a job result, a ledger entry or world-write authority. */
export const RECOVERY_POLICY = Object.freeze({ revision: 1, windowMs: 15 * 60_000, maxAutomaticAttempts: 3,
  delaysMs: [1_000, 5_000, 30_000] as const, healthyResetMs: 5 * 60_000, maxTargets: 128 });
const timestamp = z.number().int().nonnegative().safe();
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const RecoveryModeSchema = z.enum(["suggest-only", "automatic"]);
export type RecoveryMode = z.infer<typeof RecoveryModeSchema>;
export const RecoveryTargetSchema = z.object({
  key: digest,
  service: z.enum(["comfyui", "ollama", "ming", "voice", "harness"]),
  lastObservedAt: timestamp,
  stoppedByUser: z.boolean(),
  circuitOpen: z.boolean(),
  consecutiveFailures: z.number().int().min(0).max(3),
  attempts: z.array(timestamp).max(3),
  healthySince: timestamp.nullable(),
  intent: z.object({
    id: digest, action: z.literal("restart-managed-runtime"), generation: timestamp, componentDigest: digest,
    authorizedAt: timestamp, notBefore: timestamp, automatic: z.boolean(),
    phase: z.enum(["intended", "executing", "verifying", "unknown"]),
  }).strict().nullable(),
}).strict();
export type RecoveryTarget = z.infer<typeof RecoveryTargetSchema>;
export const RecoveryControlSchema = z.object({ version: z.literal(1), policyRevision: z.literal(1),
  mode: RecoveryModeSchema, targets: z.array(RecoveryTargetSchema).max(RECOVERY_POLICY.maxTargets),
}).strict().refine(value => new Set(value.targets.map(target => target.key)).size === value.targets.length, "Repeated recovery target");
export type RecoveryControl = z.infer<typeof RecoveryControlSchema>;
export const RecoveryRestartContextSchema = z.object({
  ownership: z.enum(["managed", "external"]), idle: z.boolean(), exitConfirmed: z.boolean(),
  generation: timestamp, componentDigest: digest,
}).strict();
export type RecoveryRestartContext = z.infer<typeof RecoveryRestartContextSchema>;
export type RecoveryHoldReason = "suggest-only" | "user-stopped" | "external" | "busy" | "cleanup-unconfirmed" |
  "pending-outcome" | "circuit-open" | "clock-reversed" | "stopped" | "audit-unavailable" | "target-limit" | "target-changed" | "too-early";
export type RecoveryRestartDecision = { allowed: true; delayMs: number } | { allowed: false; reason: RecoveryHoldReason };

export function emptyRecoveryTarget(key: string, service: RecoveryTarget["service"], now: number): RecoveryTarget {
  return RecoveryTargetSchema.parse({ key, service, lastObservedAt: now, stoppedByUser: false, circuitOpen: false,
    consecutiveFailures: 0, attempts: [], healthySince: null, intent: null });
}

/** Keep future attempts if the clock moves backwards. A clock change must not refill a budget. */
export function recentRecoveryAttempts(target: RecoveryTarget, now: number): number[] {
  return target.attempts.filter(at => now - at < RECOVERY_POLICY.windowMs);
}

export function decideRecoveryRestart(input: {
  target: RecoveryTarget; context: RecoveryRestartContext; mode: RecoveryMode; automatic: boolean; now: number;
}): RecoveryRestartDecision {
  const { target, context, mode, automatic, now } = input;
  if (!Number.isSafeInteger(now) || now < target.lastObservedAt) return { allowed: false, reason: "clock-reversed" };
  if (target.intent) return { allowed: false, reason: "pending-outcome" };
  if (context.ownership !== "managed") return { allowed: false, reason: "external" };
  if (!context.exitConfirmed) return { allowed: false, reason: "cleanup-unconfirmed" };
  if (!context.idle) return { allowed: false, reason: "busy" };
  if (automatic && mode !== "automatic") return { allowed: false, reason: "suggest-only" };
  if (automatic && target.stoppedByUser) return { allowed: false, reason: "user-stopped" };
  if (automatic && (target.circuitOpen || recentRecoveryAttempts(target, now).length >= RECOVERY_POLICY.maxAutomaticAttempts)) return { allowed: false, reason: "circuit-open" };
  return { allowed: true, delayMs: automatic ? RECOVERY_POLICY.delaysMs[Math.min(2, target.consecutiveFailures)]! : 0 };
}
