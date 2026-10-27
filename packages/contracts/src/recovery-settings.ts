import { z } from "zod";
import { RecoveryModeSchema, RecoveryOutcomeSummarySchema, RECOVERY_POLICY } from "./recovery-policy.js";
import { RecoveryHistorySnapshotSchema, RecoveryIncidentSchema, RECOVERY_HISTORY_LIMITS } from "./recovery-incidents.js";
import { RecoveryCacheMaintenanceSchema, RecoveryCacheScopeSchema } from "./recovery-actions.js";

/** SPEC-061 R-7/R-18/R-25. Presentation of policy carries no intent/capability or repair grant. */
export const RecoveryPolicySnapshotSchema = z.object({
  cleanup: z.object({ available: z.boolean(), pending: z.boolean(), audit: z.enum(["starting", "available", "unavailable"]).optional(),
    maintenance: RecoveryCacheMaintenanceSchema.optional(),
    scope: RecoveryCacheScopeSchema.optional(),
    reason: z.enum(["invalid", "permission", "disk-full", "read-failed", "write-failed", "unsupported"]).optional() }).strict().optional(),
  audit: z.enum(["starting", "available", "unavailable"]), accepting: z.boolean(), mode: RecoveryModeSchema,
  reason: z.enum(["invalid", "permission", "disk-full", "read-failed", "write-failed"]).optional(),
  targets: z.array(z.object({ key: z.string().regex(/^[a-f0-9]{64}$/), service: z.enum(["comfyui", "ollama", "ming", "voice", "harness"]),
    stoppedByUser: z.boolean(), circuitOpen: z.boolean(), pendingOutcome: z.boolean(),
    lastOutcome: RecoveryOutcomeSummarySchema.optional(),
    retryAvailable: z.boolean().optional(),
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
  historyAction: z.enum(["acknowledge", "snooze-hour", "snooze-session", "clear-resolved"]).optional(),
}).strict();
export type RecoveryCommandResult = z.infer<typeof RecoveryCommandResultSchema>;

const digest = z.string().regex(/^[a-f0-9]{64}$/), offset = z.number().int().min(0).max(RECOVERY_HISTORY_LIMITS.maxIncidents);
export const RecoveryHistoryFilterSchema = z.enum(["all", "active", "resolved"]);
export const RecoveryHistoryCursorSchema = z.object({ revision: digest, offset }).strict();
export const RecoveryHistoryQuerySchema = z.object({ filter: RecoveryHistoryFilterSchema, pageSize: z.number().int().min(1).max(100), cursor: RecoveryHistoryCursorSchema.optional() }).strict();
export type RecoveryHistoryQuery = z.infer<typeof RecoveryHistoryQuerySchema>;
export const RecoveryHistoryPageSchema = z.object({
  status: z.enum(["ready", "stale", "unavailable"]), filter: RecoveryHistoryFilterSchema, offset, pageSize: z.number().int().min(1).max(100),
  at: RecoveryHistorySnapshotSchema.shape.at, audit: RecoveryHistorySnapshotSchema.shape.audit, reason: RecoveryHistorySnapshotSchema.shape.reason,
  revision: digest.nullable(), totalCount: offset, incidents: z.array(RecoveryIncidentSchema).max(100),
  nextCursor: RecoveryHistoryCursorSchema.nullable(), previousCursor: RecoveryHistoryCursorSchema.nullable(),
}).strict().superRefine((page, context) => {
  const invalid = () => context.addIssue({ code: "custom", message: "Inconsistent recovery history page." });
  if (page.status !== "ready") {
    if (page.incidents.length || page.nextCursor || page.previousCursor || page.offset !== 0) invalid();
    if (page.status === "stale" ? page.revision === null : page.revision !== null) invalid();
    return;
  }
  if (page.revision === null || page.offset > page.totalCount || page.offset % page.pageSize !== 0 || page.incidents.length !== Math.min(page.pageSize, page.totalCount - page.offset)) invalid();
  const more = page.offset + page.incidents.length < page.totalCount;
  if (more !== (page.nextCursor !== null) || page.nextCursor && (page.nextCursor.revision !== page.revision || page.nextCursor.offset !== page.offset + page.pageSize)) invalid();
  if ((page.offset > 0) !== (page.previousCursor !== null) || page.previousCursor && (page.previousCursor.revision !== page.revision || page.previousCursor.offset !== Math.max(0, page.offset - page.pageSize))) invalid();
});
export type RecoveryHistoryPage = z.infer<typeof RecoveryHistoryPageSchema>;
