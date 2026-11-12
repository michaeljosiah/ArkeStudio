import { createHash } from "node:crypto";
import { StudioDiagnosticEvidenceSchema, STUDIO_ASSISTANT_LIMITS, FINDING_SEVERITY_RANK,
  type Job, type RecoveryHistorySnapshot, type RecoveryPolicySnapshot, type StorageHealthSnapshot,
  type StudioDiagnosticEvidence, type StudioDiagnosticTopic } from "@arke-studio/contracts";

export interface StudioEvidenceSources {
  history?: RecoveryHistorySnapshot | null;
  policy?: RecoveryPolicySnapshot | null;
  storage?: StorageHealthSnapshot | null;
  jobs?: readonly Pick<Job, "id" | "capability" | "status" | "attempt" | "providerJobId" | "updatedAt">[];
}
const opaque = (kind: string, value: string) => createHash("sha256").update(`studio-${kind}\0${value}`).digest("hex");
const current = (at: number, now: number) => at <= now && now - at <= 60_000;
const instant = (text: string, now: number) => { const value = Date.parse(text); return Number.isSafeInteger(value) && value >= 0 && value <= now ? value : null; };

/** This is the specialist's entire input, assembled from narrow published facts. Never pass
 * a diagnostic finding's free-text cause, a job's params or the Studio transcript through. */
export function studioDiagnosticEvidence(topic: StudioDiagnosticTopic, sources: StudioEvidenceSources, now: number): StudioDiagnosticEvidence {
  const relevant = (kind: string) => topic === "storage" ? kind.startsWith("storage-") : topic === "jobs" ? kind.includes("held") || kind.includes("job")
    : topic === "setup" ? kind.includes("setup") || kind.includes("download") || kind.includes("missing") || kind.includes("integrity")
      : !kind.startsWith("storage-");
  const sourceIncidents = (sources.history?.incidents ?? []).filter(value => relevant(value.kind));
  const incidents = sourceIncidents.slice().sort((a, b) => FINDING_SEVERITY_RANK[b.severity] - FINDING_SEVERITY_RANK[a.severity] || b.lastObservedAt - a.lastObservedAt).slice(0, 16);
  const roots = topic === "storage" ? sources.storage?.roots ?? [] : [];
  // Published summaries are already in memory. Bound work before selecting a window; an
  // incomplete window never establishes that all jobs or destinations are healthy.
  const jobs = topic === "jobs" || topic === "local-ai" ? (sources.jobs ?? []).slice(0, 256).filter(job => ["queued", "submitting", "running", "needs-reconciliation"].includes(job.status)) : [];
  const result: StudioDiagnosticEvidence = {
    version: 1, at: now, topic,
    audit: { history: sources.history?.audit ?? "unavailable", recovery: sources.policy?.audit ?? "unavailable", storage: sources.storage?.admission?.state ?? "unavailable" },
    incidents: incidents.map(value => ({ id: value.id, kind: value.kind, revision: value.evidenceRevision,
      phase: value.phase, severity: value.severity, evidence: value.lastObservedAt > now || value.facts.some(fact => fact.measuredAt > now) ? "unavailable"
        : current(value.lastObservedAt, now) && value.facts.every(fact => current(fact.measuredAt, now)) ? value.evidence : "stale",
      observedAt: value.lastObservedAt, factsLimited: value.facts.length > 12,
      facts: value.facts.slice(0, 12).map(fact => ({ name: fact.name, value: fact.measuredAt > now ? null : fact.value, measuredAt: fact.measuredAt })),
    })),
    storage: roots.slice(0, 16).map(value => {
      const capacity = value.capacity, future = capacity && capacity.measuredAt > now;
      return { id: opaque("root", value.rootId), role: value.role, source: value.source, limitations: [...value.limitations],
        state: future ? "unavailable" : value.state === "measured" && capacity && !current(capacity.measuredAt, now) ? "stale" : value.state,
        capacity: capacity && !future ? { volumeId: opaque("volume", capacity.volumeId), mappingRevision: opaque("mapping", capacity.mappingRevision),
          measuredAt: capacity.measuredAt, availableBytes: capacity.availableBytes, totalBytes: capacity.totalBytes } : null,
      };
    }),
    jobs: jobs.slice(0, 16).map(job => ({ ref: opaque("job", job.id), capability: job.capability, status: job.status,
      attempt: job.attempt, accepted: job.providerJobId !== null && job.providerJobId !== undefined, updatedAt: instant(job.updatedAt, now) })),
    limited: { incidents: sourceIncidents.length > 16 || sources.history?.limited === true,
      storage: roots.length > 16 || sources.storage?.limited === true, jobs: jobs.length > 16 || (sources.jobs?.length ?? 0) > 256 },
  };
  while (Buffer.byteLength(JSON.stringify(result)) > STUDIO_ASSISTANT_LIMITS.evidenceBytes) {
    if (result.jobs.length) { result.jobs.pop(); result.limited.jobs = true; }
    else if (result.storage.length) { result.storage.pop(); result.limited.storage = true; }
    else if (result.incidents.length) { result.incidents.pop(); result.limited.incidents = true; }
    else break;
  }
  return StudioDiagnosticEvidenceSchema.parse(result);
}
