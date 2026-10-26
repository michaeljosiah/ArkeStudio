import { z } from "zod";
import { RecoveryModeSchema, RECOVERY_POLICY } from "./recovery-policy.js";

/** SPEC-061 R-7/R-18/R-25. Presentation of policy carries no intent/capability or repair grant. */
export const RecoveryPolicySnapshotSchema = z.object({
  audit: z.enum(["starting", "available", "unavailable"]), accepting: z.boolean(), mode: RecoveryModeSchema,
  reason: z.enum(["invalid", "permission", "disk-full", "read-failed", "write-failed"]).optional(),
  targets: z.array(z.object({ key: z.string().regex(/^[a-f0-9]{64}$/), service: z.enum(["comfyui", "ollama", "ming", "voice", "harness"]),
    stoppedByUser: z.boolean(), circuitOpen: z.boolean(), pendingOutcome: z.boolean(),
  }).strict()).max(RECOVERY_POLICY.maxTargets),
}).strict();
export type RecoveryPolicySnapshot = z.infer<typeof RecoveryPolicySnapshotSchema>;
export const RecoveryHistoryCommandSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("acknowledge"), incidentId: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
  z.object({ action: z.literal("snooze-hour"), incidentId: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
  z.object({ action: z.literal("snooze-session"), incidentId: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
  z.object({ action: z.literal("clear-resolved") }).strict(),
]);
export const RecoveryCommandResultSchema = z.object({
  requestId: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/),
  operation: z.enum(["recovery-set-mode", "recovery-set-preferences", "recovery-history-control"]),
  status: z.enum(["saved", "refused"]), reason: z.enum(["unavailable", "not-applicable"]).optional(),
}).strict();
export type RecoveryCommandResult = z.infer<typeof RecoveryCommandResultSchema>;
