import type { EditorRequestFile } from "./editor-request.js";
import { effectAnalysisCanonicalJson as canonical } from "./editor-effect-analysis.js";
import { EFFECT_PROPOSAL_BOUNDS, EffectProposalFamilySchema, type EffectArrangementScope, type EffectProposalFamily,
  type EffectProposalVersion, type EffectVersionRef, type EffectReviewGrant } from "./editor-effect-proposal.js";
import { seedEffectIdentityLedger } from "./editor-effect-proposal-identity.js";
import type { ProductionTimeline } from "./timeline.js";

/** No read-only upgrade: callers invoke this only while staging an authorized request mutation. */
export function retainEditorRequestFile(file: EditorRequestFile, pins: { requestIds?: readonly string[] } = {}): EditorRequestFile {
  const next = structuredClone(file), pinned = new Set(pins.requestIds ?? []);
  const count = () => next.requests.length + (next.schemaVersion === 2 ? next.effectFamilies.reduce((sum, family) => sum + family.versions.length, 0) : 0);
  const bytes = () => new TextEncoder().encode(`${JSON.stringify(next, null, 2)}\n`).byteLength;
  while (count() > EFFECT_PROPOSAL_BOUNDS.kept || bytes() > EFFECT_PROPOSAL_BOUNDS.requestFileBytes) {
    const eligible = [
      ...next.requests.filter(request => request.status !== "pending" && !pinned.has(request.id)).map(request => ({ kind: "legacy" as const, id: request.id, at: request.createdAt })),
      ...(next.schemaVersion === 2 ? next.effectFamilies.filter(family => family.status !== "pending" && !pinned.has(family.id)).map(family => ({ kind: "effect" as const, id: family.id, at: family.createdAt })) : []),
    ].sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
    const oldest = eligible[0];
    if (!oldest) throw new Error(`Editor requests retain ${count()} records and ${bytes()} bytes; the limits are 200 records and ${EFFECT_PROPOSAL_BOUNDS.requestFileBytes} bytes. Pending work and history receipts remain pinned.`);
    if (oldest.kind === "legacy") next.requests = next.requests.filter(request => request.id !== oldest.id);
    else if (next.schemaVersion === 2) next.effectFamilies = next.effectFamilies.filter(family => family.id !== oldest.id);
  }
  return next;
}

export function createEffectProposalFamily(input: { id: string; productionId: string; conversationId: string; actionId?: string;
  scope: EffectArrangementScope; base: ProductionTimeline; timelineHash: string; at: string; baseId: string }): EffectProposalFamily {
  const { history: _history, ...authored } = input.base;
  return EffectProposalFamilySchema.parse({ id: input.id, productionId: input.productionId, conversationId: input.conversationId,
    ...(input.actionId ? { actionId: input.actionId } : {}), createdAt: input.at, scope: input.scope, status: "pending", decisionRevision: 0,
    bases: [{ id: input.baseId, revision: input.base.revision, timelineHash: input.timelineHash, authored }], identities: seedEffectIdentityLedger(input.base),
    decisions: [], activeDecisionIds: [], steps: [], branches: [], versions: [], reviewGrants: [],
  });
}

export function effectProposalVersionRefusal(family: EffectProposalFamily, ref: EffectVersionRef): string | null {
  if (family.id !== ref.familyId) return "This reference belongs to another effect proposal family.";
  if (family.status !== "pending") return `This arrangement is already ${family.status}.`;
  const version = family.versions.find(row => row.id === ref.versionId);
  if (!version || version.candidateHash !== ref.candidateHash) return "The exact proposed version is unavailable.";
  if (family.decisionRevision !== ref.decisionRevision || version.decisionRevision !== family.decisionRevision) return "Human decisions changed. Prepare and review a compatible version.";
  return null;
}
export function effectProposalApplicableReason(version: EffectProposalVersion): string | null {
  if (version.conflicts.length) return version.conflicts[0]!.reason;
  if (version.dependencies.issues.length) return version.dependencies.issues[0]!.reason;
  const unavailable = version.dependencies.reactions.find(row => row.status !== "off" && row.status !== "ready");
  if (unavailable && "reason" in unavailable) return unavailable.reason;
  return version.delta.length ? null : "No changes to apply.";
}
export function reviewEffectProposalVersion(family: EffectProposalFamily, ref: EffectVersionRef, stamp: { id: string; at: string }): { family: EffectProposalFamily; grant: EffectReviewGrant } {
  const version = family.versions.find(row => row.id === ref.versionId);
  if (family.id !== ref.familyId || family.status !== "pending" || !version || version.candidateHash !== ref.candidateHash || family.decisionRevision !== ref.decisionRevision)
    throw new Error("The exact version or current human decisions changed. Refresh the retained proposal.");
  const grant: EffectReviewGrant = { id: stamp.id, ...ref, branchId: version.branchId, reviewedAt: stamp.at };
  return { family: { ...family, reviewGrants: [...family.reviewGrants.filter(row => row.versionId !== version.id), grant] }, grant };
}
export function effectProposalApplyRefusal(family: EffectProposalFamily, ref: EffectVersionRef, grantId: string): string | null {
  const problem = effectProposalVersionRefusal(family, ref); if (problem) return problem;
  const version = family.versions.find(row => row.id === ref.versionId)!, grant = family.reviewGrants.find(row => row.id === grantId);
  if (!grant || grant.familyId !== family.id || grant.versionId !== version.id || grant.branchId !== version.branchId || grant.candidateHash !== ref.candidateHash || grant.decisionRevision !== family.decisionRevision) return "Choose Review in timeline for this exact version before Apply.";
  return effectProposalApplicableReason(version);
}
export function effectProposalBaseRefusal(family: EffectProposalFamily, version: EffectProposalVersion, timeline: ProductionTimeline): string | null {
  const base = family.bases.find(row => row.id === version.baseId); if (!base) return "The frozen proposal base is missing.";
  const { history: _history, ...authored } = timeline;
  return base.revision !== timeline.revision || canonical(base.authored) !== canonical(authored) ? "Current changed. Update the proposal and review the new version." : null;
}
