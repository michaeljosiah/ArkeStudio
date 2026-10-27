import { createHash } from "node:crypto";
import type { RecoveryActionResult, RecoveryActionSummary, RecoveryCacheMaintenanceRun, RecoveryControl } from "@arke-studio/contracts";

const hash = (...values: string[]) => createHash("sha256").update(JSON.stringify(["recovery-history-v1", ...values])).digest("hex");
export const previewHistoryResource = hash("fixed-local-preset-previews");
export function restartActionHistory(control: RecoveryControl): RecoveryActionSummary[] {
  return control.targets.flatMap(target => target.lastOutcome ? [{
    id: hash("restart", target.key, target.lastOutcome.intentId), resourceId: target.key,
    action: "restart-managed-runtime" as const, service: target.service, automatic: target.lastOutcome.automatic,
    authorizedAt: target.lastOutcome.authorizedAt, outcomeAt: target.lastOutcome.settledAt,
    outcome: target.lastOutcome.outcome, evidence: "owner-receipt" as const,
  }] : []);
}
export function cleanupActionHistory(planId: string, automatic: boolean, run: RecoveryCacheMaintenanceRun): RecoveryActionSummary {
  return { id: hash("preview-cleanup", planId), resourceId: previewHistoryResource, action: "cleanup-local-preset-previews", automatic,
    authorizedAt: null, outcomeAt: run.at, outcome: run.status, evidence: "owner-receipt", cleanup: {
      removedFiles: run.cleanup.removedFiles, logicalBytes: run.cleanup.logicalBytes, availableBefore: run.cleanup.availableBefore,
      availableAfter: run.cleanup.availableAfter, reclaimedBytes: null,
    } };
}
export function cleanupCheckHistory(requestId: string, at: number, confirmed: boolean): RecoveryActionSummary {
  return { id: hash("preview-check", requestId), resourceId: previewHistoryResource, action: "check-preview-cleanup", automatic: false,
    authorizedAt: null, outcomeAt: at, outcome: confirmed ? "verified" : "unknown", evidence: "executor-result" };
}
export function partialCleanupHistory(pending: { planId: string; key: string; at: number; automatic?: boolean } | null,
  outcomes: readonly { planId: string; key: string; at: number; status: "removed" | "retained" | "not-started" | "unknown"; automatic?: boolean }[]): RecoveryActionSummary[] {
  const plans = new Map<string, { at: number; automatic: boolean; files: Map<string, boolean> }>();
  for (const row of outcomes) {
    const plan = plans.get(row.planId) ?? { at: row.at, automatic: row.automatic === true, files: new Map() };
    plan.at = Math.max(plan.at, row.at); plan.files.set(row.key, row.status === "removed"); plans.set(row.planId, plan);
  }
  if (pending) {
    const plan = plans.get(pending.planId) ?? { at: pending.at, automatic: pending.automatic === true, files: new Map() };
    plan.at = Math.max(plan.at, pending.at); plans.set(pending.planId, plan);
  }
  return [...plans].map(([planId, plan]): RecoveryActionSummary => {
    const removed = [...plan.files.values()].filter(Boolean).length;
    return { id: hash("preview-cleanup", planId), resourceId: previewHistoryResource, action: "cleanup-local-preset-previews", automatic: plan.automatic,
      authorizedAt: null, outcomeAt: plan.at, outcome: "unknown", evidence: "partial-owner",
      ...(removed <= 8 ? { cleanup: { removedFiles: removed, logicalBytes: null, availableBefore: null, availableAfter: null, reclaimedBytes: null } } : {}) };
  });
}
export function reviewedActionHistory(result: RecoveryActionResult, at: number): RecoveryActionSummary[] {
  if (result.status === "preview" || result.status === "accepted") return [];
  if (result.reconciliation) return [cleanupCheckHistory(result.requestId, at, result.status === "verified")];
  if (!result.cleanupPlan) return [];
  return [{ id: hash("preview-cleanup", result.cleanupPlan.id), resourceId: previewHistoryResource, action: "cleanup-local-preset-previews",
    automatic: false, authorizedAt: null, outcomeAt: at, outcome: result.status, evidence: "executor-result",
    ...(result.cleanup ? { cleanup: { removedFiles: result.cleanup.removedFiles, logicalBytes: result.cleanup.logicalBytes,
      availableBefore: result.cleanup.availableBefore, availableAfter: result.cleanup.availableAfter, reclaimedBytes: null } } : {}) }];
}
