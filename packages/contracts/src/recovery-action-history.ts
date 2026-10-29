import { z } from "zod";

const instant = z.number().int().nonnegative().safe().max(8_640_000_000_000_000), digest = z.string().regex(/^[a-f0-9]{64}$/);
export const RECOVERY_ACTION_HISTORY_LIMITS = Object.freeze({ maxActions: 1000, retentionMs: 30 * 86400_000 });
/** Removable evidence only. IDs are separately hashed presentation references, never intent,
 * plan or native target capabilities. A closed outcome does not establish a creative result. */
export const RecoveryActionSummarySchema = z.object({
  id: digest, resourceId: digest,
  action: z.enum(["restart-managed-runtime", "cleanup-local-preset-previews", "check-preview-cleanup", "confirm-ming-cleanup"]),
  service: z.enum(["comfyui", "ollama", "ming", "voice", "harness"]).optional(), automatic: z.boolean(),
  authorizedAt: instant.nullable(), outcomeAt: instant,
  outcome: z.enum(["verified", "failed", "not-started", "unknown", "cancelled", "refused"]),
  evidence: z.enum(["owner-receipt", "partial-owner", "executor-result"]),
  cleanup: z.object({ removedFiles: z.number().int().min(0).max(8), logicalBytes: instant.nullable(),
    availableBefore: instant.nullable(), availableAfter: instant.nullable(), reclaimedBytes: z.null() }).strict().optional(),
}).strict().superRefine((row, ctx) => {
  if (row.authorizedAt !== null && row.outcomeAt < row.authorizedAt ||
    (row.action === "restart-managed-runtime") !== (row.service !== undefined) || row.action !== "cleanup-local-preset-previews" && row.cleanup) {
    ctx.addIssue({ code: "custom", message: "Inconsistent recovery action summary." });
  }
});
export type RecoveryActionSummary = z.infer<typeof RecoveryActionSummarySchema>;

export function retainRecoveryActions(rows: readonly RecoveryActionSummary[], incoming: readonly RecoveryActionSummary[], now: number, clearedThrough?: number, clearedIds?: readonly string[]): {
  actions: RecoveryActionSummary[]; pruned: number; coalesced: number;
} {
  instant.parse(now); if (clearedThrough !== undefined) instant.parse(clearedThrough);
  const cleared = clearedThrough ?? -1;
  const wasCleared = (row: RecoveryActionSummary) => row.outcomeAt < cleared || row.outcomeAt === cleared && (clearedIds === undefined || clearedIds.includes(row.id));
  const retained = rows.filter(row => row.outcome === "unknown" || !wasCleared(row) && now - row.outcomeAt <= RECOVERY_ACTION_HISTORY_LIMITS.retentionMs).map(row => structuredClone(row));
  let pruned = rows.length - retained.length, coalesced = 0;
  for (const candidate of incoming) {
    const row = RecoveryActionSummarySchema.parse(candidate);
    if (row.outcomeAt > now || row.outcome !== "unknown" && (wasCleared(row) || now - row.outcomeAt > RECOVERY_ACTION_HISTORY_LIMITS.retentionMs)) continue;
    const index = retained.findIndex(value => value.id === row.id), previous = retained[index];
    if (previous) {
      const rank = { "owner-receipt": 3, "partial-owner": 2, "executor-result": 1 };
      if (previous.resourceId !== row.resourceId || previous.action !== row.action || previous.automatic !== row.automatic || previous.service !== row.service ||
        rank[previous.evidence] > rank[row.evidence] ||
        row.evidence === previous.evidence && row.outcomeAt < previous.outcomeAt) continue;
      retained[index] = { ...row, authorizedAt: previous.authorizedAt ?? row.authorizedAt };
      continue;
    }
    if (retained.length >= RECOVERY_ACTION_HISTORY_LIMITS.maxActions) {
      const oldest = retained.filter(value => value.outcome !== "unknown").sort((a, b) => a.outcomeAt - b.outcomeAt || a.id.localeCompare(b.id))[0];
      if (!oldest) { coalesced++; continue; }
      retained.splice(retained.indexOf(oldest), 1); pruned++;
    }
    retained.push(row);
  }
  return { actions: retained.sort((a, b) => b.outcomeAt - a.outcomeAt || a.id.localeCompare(b.id)), pruned, coalesced };
}

export function recoveryActionSummaryLabel(row: RecoveryActionSummary): string {
  const action = row.action === "restart-managed-runtime" ? `${({ comfyui: "ComfyUI", ollama: "Ollama", ming: "Ming", voice: "Voice engine", harness: "Writing engine" })[row.service!]} restart`
    : row.action === "cleanup-local-preset-previews" ? "Local preset preview cleanup" : row.action === "confirm-ming-cleanup" ? "Original Ming worker cleanup" : "Preview cleanup outcome check";
  const outcome = { verified: "Verified", failed: "Failed", "not-started": "Not started", unknown: "Unconfirmed", cancelled: "Cancelled", refused: "Refused" }[row.outcome];
  return `${action} · ${outcome}`;
}
