import { z } from "zod";
import { FINDING_KIND_IDS, FindingSeveritySchema, FINDING_SEVERITY_RANK, type Finding } from "./diagnostics.js";

export const RECOVERY_HISTORY_LIMITS = Object.freeze({ maxIncidents: 1000, maxBytes: 10 * 1024 ** 2, retentionMs: 30 * 86400_000, advisoryIntervalMs: 86400_000 });
const instant = z.number().int().nonnegative().safe().max(8_640_000_000_000_000), digest = z.string().regex(/^[a-f0-9]{64}$/);
const count = z.number().int().nonnegative().safe();
export const RecoveryIncidentPhaseSchema = z.enum(["observing", "action-available", "recovering", "verifying", "recovered", "needs-user", "unresolved"]);
export const RecoveryEvidenceStateSchema = z.enum(["fresh", "stale", "unavailable"]);
/** Closed operational facts only. Free-form causes, paths, titles and worker output are never
 * copied from a diagnostic finding into saved history or an assistant's evidence payload. */
export const RECOVERY_FACT_NAMES = ["held-jobs", "disabled-recipes", "download-mb", "needs-mb", "volume-free-mb", "fault-count", "waiting",
  "destinations", "available-bytes", "reserve-bytes", "warning-floor-bytes", "estimated-time-to-reserve-ms", "forecast-window-ms", "uncertain-reservations", "reviewable-previews"] as const;
export const RecoveryFactSchema = z.object({ name: z.enum(RECOVERY_FACT_NAMES), value: z.number().finite().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable(), measuredAt: instant }).strict();
export type RecoveryFact = z.infer<typeof RecoveryFactSchema>;
export const RecoveryObservationSchema = z.object({
  key: digest, kind: z.enum(FINDING_KIND_IDS), evidenceRevision: digest, observedAt: instant,
  severity: FindingSeveritySchema, phase: RecoveryIncidentPhaseSchema, evidence: RecoveryEvidenceStateSchema,
  facts: z.array(RecoveryFactSchema).max(24),
  /** Resolution needs an explicit current owner/measurement proof. An absent finding is not one. */
  resolution: z.enum(["verified-readiness", "verified-capacity", "verified-condition-clear"]).optional(),
}).strict().superRefine((value, ctx) => {
  if (value.phase === "recovered" && (!value.resolution || value.evidence !== "fresh")) ctx.addIssue({ code: "custom", message: "Recovery requires current verification." });
  if (value.phase !== "recovered" && value.resolution) ctx.addIssue({ code: "custom", message: "Resolution proof belongs to recovered observations." });
});
export type RecoveryObservation = z.infer<typeof RecoveryObservationSchema>;
export const RecoveryIncidentSchema = z.object({
  id: digest, key: digest, kind: z.enum(FINDING_KIND_IDS), previousId: digest.optional(),
  firstObservedAt: instant, lastObservedAt: instant, evidenceRevision: digest,
  severity: FindingSeveritySchema, phase: RecoveryIncidentPhaseSchema, evidence: RecoveryEvidenceStateSchema,
  facts: z.array(RecoveryFactSchema).max(24), resolution: z.enum(["verified-readiness", "verified-capacity", "verified-condition-clear"]).optional(),
  everHeldWork: z.boolean(), acknowledgedAt: instant.nullable(),
  severityTransition: count,
  delivery: z.object({ lastAt: instant.nullable(), lastSeverity: FindingSeveritySchema.nullable(), lastPhase: RecoveryIncidentPhaseSchema.nullable(),
    lastCriticalTransition: count.nullable(), snoozedUntil: instant.nullable(), snoozedSession: digest.nullable() }).strict(),
}).strict().superRefine((value, ctx) => {
  if (value.lastObservedAt < value.firstObservedAt) ctx.addIssue({ code: "custom", message: "Incident observation moved backwards." });
  if (value.phase === "recovered" && (!value.resolution || value.evidence !== "fresh")) ctx.addIssue({ code: "custom", message: "Recovery requires current verification." });
  if (value.phase !== "recovered" && value.resolution) ctx.addIssue({ code: "custom", message: "Resolution proof belongs to recovered incidents." });
});
export type RecoveryIncident = z.infer<typeof RecoveryIncidentSchema>;
export const RecoveryHistorySchema = z.object({
  version: z.literal(1), lastObservedAt: instant,
  preferences: z.object({ transientMuted: z.boolean(), desktopOptIn: z.boolean() }).strict(),
  incidents: z.array(RecoveryIncidentSchema).max(RECOVERY_HISTORY_LIMITS.maxIncidents),
  overflow: z.object({ coalescedObservations: count, prunedSummaries: count, lostDetail: z.boolean() }).strict(),
}).strict().superRefine((value, ctx) => {
  if (new Set(value.incidents.map(incident => incident.id)).size !== value.incidents.length) ctx.addIssue({ code: "custom", message: "Repeated incident ID." });
  const active = value.incidents.filter(incident => incident.phase !== "recovered");
  if (new Set(active.map(incident => incident.key)).size !== active.length) ctx.addIssue({ code: "custom", message: "Repeated active resource." });
});
export type RecoveryHistory = z.infer<typeof RecoveryHistorySchema>;
export const RecoveryHistorySnapshotSchema = z.object({
  at: instant,
  audit: z.enum(["starting", "available", "unavailable"]), reason: z.enum(["invalid", "permission", "disk-full", "read-failed", "write-failed"]).optional(),
  incidents: z.array(RecoveryIncidentSchema).max(100), activeCount: count, resolvedCount: count, limited: z.boolean(),
  preferences: z.object({ transientMuted: z.boolean(), desktopOptIn: z.boolean() }).strict(),
  overflow: z.object({ coalescedObservations: count, prunedSummaries: count, lostDetail: z.boolean() }).strict(),
}).strict();
export type RecoveryHistorySnapshot = z.infer<typeof RecoveryHistorySnapshotSchema>;
export const RecoveryNoticeReasonSchema = z.enum(["first-actionable", "severity-escalated", "recovery-failed", "recovered", "advisory-reminder"]);
export const RecoveryNoticeSchema = z.object({ incidentId: digest, reason: RecoveryNoticeReasonSchema, at: instant }).strict();
export type RecoveryNotice = z.infer<typeof RecoveryNoticeSchema>;
export function emptyRecoveryHistory(): RecoveryHistory {
  return { version: 1, lastObservedAt: 0, preferences: { transientMuted: false, desktopOptIn: false }, incidents: [], overflow: { coalescedObservations: 0, prunedSummaries: 0, lostDetail: false } };
}
const increment = (value: number) => Math.min(Number.MAX_SAFE_INTEGER, value + 1);
export function recoveryFindingFacts(finding: Finding): RecoveryFact[] {
  const result: RecoveryFact[] = [];
  for (const fact of finding.facts) {
    if (!RECOVERY_FACT_NAMES.includes(fact.name as typeof RECOVERY_FACT_NAMES[number])) continue;
    if (fact.value !== null && (typeof fact.value !== "number" || !Number.isFinite(fact.value) || fact.value < 0)) continue;
    const measuredAt = Date.parse(fact.measuredAt); if (!Number.isSafeInteger(measuredAt) || measuredAt < 0) continue;
    if (result.some(value => value.name === fact.name)) continue;
    result.push({ name: fact.name as RecoveryFact["name"], value: fact.value, measuredAt });
    if (result.length === 24) break;
  }
  return result.sort((a, b) => a.name.localeCompare(b.name));
}

/** No disappearing-source inference: callers provide verified clears from their owning domain.
 * Retry budgets/approvals are not fields of this removable presentation history. */
export function observeRecoveryIncident(history: RecoveryHistory, observation: RecoveryObservation, id: string, now: number): RecoveryHistory {
  return applyRecoveryIncident(structuredClone(history), observation, id, now);
}
export function observeRecoveryIncidents(history: RecoveryHistory, observations: readonly { observation: RecoveryObservation; id: string }[], now: number): RecoveryHistory {
  let next = pruneRecoveryHistory(history, now);
  for (const item of observations) next = applyRecoveryIncident(next, item.observation, item.id, now);
  return next;
}
export function pruneRecoveryHistory(history: RecoveryHistory, now: number): RecoveryHistory {
  instant.parse(now); const next = structuredClone(history); if (now < history.lastObservedAt) return next;
  const retained = next.incidents.filter(incident => incident.phase !== "recovered" || now - incident.lastObservedAt <= RECOVERY_HISTORY_LIMITS.retentionMs);
  next.overflow.prunedSummaries = Math.min(Number.MAX_SAFE_INTEGER, next.overflow.prunedSummaries + next.incidents.length - retained.length);
  next.incidents = retained; return next;
}
function applyRecoveryIncident(history: RecoveryHistory, observation: RecoveryObservation, id: string, now: number): RecoveryHistory {
  const value = RecoveryObservationSchema.parse(observation); instant.parse(now); digest.parse(id);
  if (now < history.lastObservedAt || value.observedAt > now || value.facts.some(fact => fact.measuredAt > now)) return history;
  const next = history; next.lastObservedAt = now;
  const expired = next.incidents.filter(incident => incident.phase === "recovered" && now - incident.lastObservedAt > RECOVERY_HISTORY_LIMITS.retentionMs);
  next.incidents = next.incidents.filter(incident => !expired.includes(incident));
  for (const _ of expired) next.overflow.prunedSummaries = increment(next.overflow.prunedSummaries);
  let incident = next.incidents.find(incident => incident.key === value.key && incident.phase !== "recovered");
  if (incident && incident.kind !== value.kind) return history;
  const previous = [...next.incidents].reverse().find(incident => incident.key === value.key);
  if (!incident && value.phase === "recovered") return history; // A healthy idle resource creates no incident.
  if (incident && value.observedAt < incident.lastObservedAt) return history;
  if (!incident) {
    if (next.incidents.length === RECOVERY_HISTORY_LIMITS.maxIncidents) {
      const retired = next.incidents.filter(value => value.phase === "recovered").sort((a, b) => a.lastObservedAt - b.lastObservedAt)[0];
      if (retired) { next.incidents = next.incidents.filter(value => value !== retired); next.overflow.prunedSummaries = increment(next.overflow.prunedSummaries); next.overflow.lostDetail = true; }
      else { next.overflow.coalescedObservations = increment(next.overflow.coalescedObservations); next.overflow.lostDetail = true; return next; }
    }
    incident = { id, key: value.key, kind: value.kind, ...(previous ? { previousId: previous.id } : {}),
      firstObservedAt: value.observedAt, lastObservedAt: value.observedAt, evidenceRevision: value.evidenceRevision,
      severity: value.severity, phase: value.phase, evidence: value.evidence, facts: value.facts,
      everHeldWork: false, acknowledgedAt: null, severityTransition: 0,
      delivery: { lastAt: null, lastSeverity: null, lastPhase: null, lastCriticalTransition: null, snoozedUntil: null, snoozedSession: null } };
    next.incidents.push(incident);
  }
  if (incident.severity !== value.severity) incident.severityTransition = increment(incident.severityTransition);
  Object.assign(incident, { lastObservedAt: value.observedAt, evidenceRevision: value.evidenceRevision, severity: value.severity, phase: value.phase, evidence: value.evidence, facts: value.facts });
  if (value.resolution) incident.resolution = value.resolution; else delete incident.resolution;
  incident.everHeldWork ||= value.facts.some(fact => fact.name === "held-jobs" && fact.value !== null && fact.value > 0);
  return next;
}

export type RecoveryNoticeReason = z.infer<typeof RecoveryNoticeReasonSchema>;
export function recoveryNoticeDecision(incident: RecoveryIncident, previous: RecoveryIncident | undefined, history: RecoveryHistory, now: number, session: string): RecoveryNoticeReason | null {
  if (history.preferences.transientMuted || now < history.lastObservedAt || incident.evidence !== "fresh") return null;
  const delivered = incident.delivery, critical = incident.severity === "blocking" && delivered.lastCriticalTransition !== incident.severityTransition;
  const snoozed = delivered.snoozedSession === session || delivered.snoozedUntil !== null && now < delivered.snoozedUntil;
  if (snoozed && !critical) return null;
  if (incident.phase === "recovered") return incident.everHeldWork && previous?.phase !== "recovered" && delivered.lastPhase !== "recovered" ? "recovered" : null;
  if (!["advisory", "degraded", "blocking"].includes(incident.severity) || ["observing", "recovering", "verifying"].includes(incident.phase)) return null;
  if (delivered.lastAt === null) return "first-actionable";
  if (critical || delivered.lastSeverity !== null && FINDING_SEVERITY_RANK[incident.severity] < FINDING_SEVERITY_RANK[delivered.lastSeverity]) return "severity-escalated";
  if (previous && ["recovering", "verifying"].includes(previous.phase) && ["needs-user", "unresolved"].includes(incident.phase)) return "recovery-failed";
  return incident.severity === "advisory" && now - delivered.lastAt >= RECOVERY_HISTORY_LIMITS.advisoryIntervalMs ? "advisory-reminder" : null;
}
export function recordRecoveryNotice(incident: RecoveryIncident, now: number): void {
  incident.delivery.lastAt = now; incident.delivery.lastSeverity = incident.severity; incident.delivery.lastPhase = incident.phase;
  if (incident.severity === "blocking") incident.delivery.lastCriticalTransition = incident.severityTransition;
}

/** Deterministic, generic copy suitable for application-global attention. Detailed current
 * evidence/remedies still come from Diagnostics; a notification never approves a repair. */
export function recoveryIncidentSummary(incident: RecoveryIncident): { title: string; detail: string } {
  const title = incident.kind.startsWith("storage-") || incident.kind === "component-disk-short" ? "Storage needs attention"
    : incident.kind.startsWith("comfyui-") || incident.kind === "work-held-by-engine" ? "Local AI needs attention" : "Studio needs attention";
  if (incident.evidence !== "fresh") return { title, detail: "Current evidence is unavailable. Refresh Diagnostics before taking action." };
  if (incident.phase === "recovered") return incident.resolution === "verified-capacity"
    ? { title: "Storage space has recovered", detail: "Fresh measurements confirm available space above the recovery threshold. Held work still needs fresh admission checks." }
    : { title: "Capability is available again", detail: "Service readiness does not establish a completed creative result. Check held work." };
  if (incident.kind === "storage-pressure") {
    const available = incident.facts.find(fact => fact.name === "available-bytes"), estimate = incident.facts.find(fact => fact.name === "estimated-time-to-reserve-ms");
    const review = incident.phase === "action-available" && incident.facts.some(fact => fact.name === "reviewable-previews" && fact.value !== null && fact.value > 0);
    return { title, detail: `${available?.value !== null && available?.value !== undefined ? `${(available.value / 1024 ** 3).toFixed(1)} GiB available. ` : ""}${estimate?.value !== null && estimate?.value !== undefined ? `The reserve may be reached in ${Math.max(1, Math.round(estimate.value / 60000))} min at the recent rate. ` : ""}${review ? "A preview cleanup review is available in Diagnostics. Cleanup needs your approval." : "You need to free space on the affected drive, then refresh."} Creative media is kept.` };
  }
  if (incident.phase === "recovering") return { title: "Local AI recovery is running", detail: "Arke is restoring the service. Submitted work still needs its own reconciliation." };
  if (incident.phase === "verifying") return { title: "Local AI recovery is being checked", detail: "Readiness has not yet been verified." };
  return { title, detail: "Review current evidence and the next action in Diagnostics. Opening it does not approve a repair." };
}
