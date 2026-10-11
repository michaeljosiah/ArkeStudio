import { z } from "zod";
import { ConversationActionIdSchema, ConversationIdSchema, SlugSchema } from "./ids.js";
import { EditorRequestIdSchema } from "./editor-request-vocabulary.js";
import { EffectClipSchema, EffectTargetSchema, EffectAudioInputSchema, EffectPresetSchema } from "./editor-effects.js";
import { EffectCommandSchema } from "./editor-effect-commands.js";
import { EffectProtectedPropertySchema, EffectProtectionInputSchema, EffectProtectionRuleSchema } from "./editor-effect-protection.js";
import { ProductionTimelineSchema, TimelineTrackIdSchema } from "./timeline.js";

/** SPEC-053 R-26–38: operational proposal records, never executable model authority. */
export const EFFECT_PROPOSAL_BOUNDS = Object.freeze({ commands: 50, perTurn: 2, kept: 200,
  requestFileBytes: 32 * 1024 * 1024, decisionsPerFamily: 4000, identitiesPerFamily: 8000, traceCommandsPerFamily: 10000 });
const id = z.string().min(1).max(160), at = z.string().min(1).max(80), hash = z.string().regex(/^[a-f0-9]{64}$/);
const fileHash = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const frame = z.number().int().nonnegative().safe(), clipId = z.string().regex(/^cl_[A-Za-z0-9][A-Za-z0-9_-]*$/);
const trackId = TimelineTrackIdSchema, ruleId = z.string().regex(/^pr_[A-Za-z0-9][A-Za-z0-9_-]*$/);
const reason = z.string().min(1).max(1000);
export const EffectProposalRangeSchema = z.object({ startFrame: frame, endFrame: frame }).strict().refine(range => range.endFrame > range.startFrame, "choose a nonempty fixed passage");
export const EffectArrangementScopeSchema = z.object({ kind: z.literal("effects-only"), target: EffectTargetSchema,
  range: EffectProposalRangeSchema, audio: z.discriminatedUnion("kind", [z.object({ kind: z.literal("off") }).strict(),
    z.object({ kind: z.literal("source"), input: EffectAudioInputSchema }).strict()]),
  direction: z.string().trim().min(1).max(2000), palette: z.array(EffectPresetSchema).min(1).max(6),
}).strict();
export type EffectArrangementScope = z.infer<typeof EffectArrangementScopeSchema>;

const effectCommands = EffectCommandSchema.options;
/** Explicit allowlist: permanent protection is an inert model request, never a creative command. */
export const EffectCreativeCommandSchema = z.discriminatedUnion("kind", [
  effectCommands[0], effectCommands[1], effectCommands[2], effectCommands[3], effectCommands[4], effectCommands[5], effectCommands[6], effectCommands[7],
  z.object({ kind: z.literal("add-track"), trackId, trackKind: z.literal("effect"), name: z.string().min(1).max(160), order: frame.optional() }).strict(),
  z.object({ kind: z.literal("set-track"), trackId, name: z.string().min(1).max(160).optional(), order: frame.optional(), muted: z.boolean().optional() }).strict(),
  z.object({ kind: z.literal("remove-track"), trackId }).strict(),
]);
export type EffectCreativeCommand = z.infer<typeof EffectCreativeCommandSchema>;
export const EffectModelIdentityClaimSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("existing"), alias: id, entityId: id }).strict(),
  z.object({ kind: z.literal("split"), alias: id, parentSegmentId: id }).strict(),
  z.object({ kind: z.literal("duplicate"), alias: id, sourceOriginId: id, slotId: id }).strict(),
  z.object({ kind: z.literal("new-effect"), alias: id, slotId: id }).strict(),
  z.object({ kind: z.literal("replacement"), alias: id, replacesEntityId: id }).strict(),
  z.object({ kind: z.literal("new-point"), alias: id, originId: id, grantDecisionId: id.optional() }).strict(),
  z.object({ kind: z.literal("new-cue"), alias: id, originId: id, grantDecisionId: id.optional() }).strict(),
]);
export type EffectModelIdentityClaim = z.infer<typeof EffectModelIdentityClaimSchema>;
export const EffectRequestedHumanActionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("protect"), rule: EffectProtectionInputSchema, reason }).strict(),
  z.object({ kind: z.literal("release"), ruleId, reason }).strict(),
  z.object({ kind: z.literal("new-slot"), count: frame.min(1).max(50), reason }).strict(),
  z.object({ kind: z.literal("identity"), entityId: id, reason }).strict(),
]);
export type EffectRequestedHumanAction = z.infer<typeof EffectRequestedHumanActionSchema>;
export const ModelEffectProposalSchema = z.object({ summary: z.string().min(1).max(500),
  family: z.object({ id: EditorRequestIdSchema, parentVersionId: id, candidateHash: hash }).strict().optional(),
  commands: z.array(EffectCreativeCommandSchema).max(50), identities: z.array(EffectModelIdentityClaimSchema).max(8000),
  requestedActions: z.array(EffectRequestedHumanActionSchema).max(50).optional(),
}).strict().refine(value => value.commands.length > 0 || (value.requestedActions?.length ?? 0) > 0, "a proposal must contain creative intent or an explicit requested human action");
export type ModelEffectProposal = z.infer<typeof ModelEffectProposalSchema>;

export const EffectIdentityAllocationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("effect"), alias: id, entityId: id, clipId, lineageId: z.string().regex(/^ef_[A-Za-z0-9][A-Za-z0-9_-]*$/), seed: frame.max(0xffffffff), slotId: id }).strict(),
  z.object({ kind: z.literal("segment"), alias: id, entityId: id, clipId }).strict(),
  z.object({ kind: z.literal("point"), alias: id, entityId: id, authoredId: z.string().regex(/^ep_[A-Za-z0-9][A-Za-z0-9_-]*$/) }).strict(),
  z.object({ kind: z.literal("cue"), alias: id, entityId: id, authoredId: z.string().regex(/^ec_[A-Za-z0-9][A-Za-z0-9_-]*$/) }).strict(),
]);
export type EffectIdentityAllocation = z.infer<typeof EffectIdentityAllocationSchema>;
export const EffectIdentityLedgerSchema = z.object({
  origins: z.array(z.object({ originId: id, kind: z.enum(["current", "addition"]), lineageId: id, currentLineageId: id.optional(), slotId: id.optional(), seed: frame.max(0xffffffff),
    derivedFromOriginId: id.optional(), createdByStepId: id, tombstoned: z.boolean() }).strict()).max(8000),
  segments: z.array(z.object({ segmentId: id, clipId, originId: id, parentSegmentId: id.optional(), createdByStepId: id, tombstoned: z.boolean() }).strict()).max(8000),
  points: z.array(z.object({ entityId: id, authoredId: id, originId: id, kind: z.enum(["intensity-point", "reaction-point", "cue"]),
    parentEntityId: id.optional(), createdByStepId: id, tombstoned: z.boolean() }).strict()).max(8000),
  slots: z.array(z.object({ id, originId: id.optional(), grantDecisionId: id }).strict()).max(8000),
}).strict();
export type EffectIdentityLedger = z.infer<typeof EffectIdentityLedgerSchema>;

export const EffectStickyScopeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("property"), property: EffectProtectedPropertySchema }).strict(),
  z.object({ kind: z.literal("point"), curve: z.enum(["intensityCurve", "reactionCurve"]), entityId: id,
    fields: z.array(z.enum(["offsetFrames", "value", "interpolation", "presence"])).min(1).max(4) }).strict(),
  z.object({ kind: z.literal("cue"), entityId: id, fields: z.array(z.enum(["frame", "strength", "durationFrames", "kind", "presence"])).min(1).max(5) }).strict(),
  z.object({ kind: z.literal("placement"), fields: z.array(z.enum(["outer-start", "outer-end", "simulation-origin", "fade-start", "fade-end", "order"])).min(1).max(6) }).strict(),
  z.object({ kind: z.literal("presence") }).strict(), z.object({ kind: z.literal("whole-effect") }).strict(),
]);
export type EffectStickyScope = z.infer<typeof EffectStickyScopeSchema>;
export const EffectVersionRefSchema = z.object({ familyId: EditorRequestIdSchema, versionId: id, candidateHash: hash, decisionRevision: frame }).strict();
export type EffectVersionRef = z.infer<typeof EffectVersionRefSchema>;
export const EffectHumanIntentSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("adjust"), commands: z.array(EffectCreativeCommandSchema).min(1).max(50) }).strict(),
  z.object({ kind: z.literal("protect"), rule: EffectProtectionInputSchema }).strict(),
  z.object({ kind: z.literal("release"), ruleId }).strict(),
  z.object({ kind: z.literal("keep-current"), entityId: id, scope: EffectStickyScopeSchema }).strict(),
  z.object({ kind: z.literal("exclude"), originId: id }).strict(),
  z.object({ kind: z.literal("permit-revision"), adjustmentIds: z.array(id).min(1).max(4000), scopes: z.array(EffectStickyScopeSchema).min(1).max(50) }).strict(),
  z.object({ kind: z.literal("grant-new-slot"), target: EffectTargetSchema, range: EffectProposalRangeSchema, count: frame.min(1).max(50) }).strict(),
  z.object({ kind: z.literal("resolve-identity"), conflictId: id, resolution: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("map"), entityId: id, replacementEntityId: id }).strict(),
    z.object({ kind: z.literal("independent"), originId: id }).strict(),
    z.object({ kind: z.literal("retain") }).strict(),
  ]) }).strict(),
]);
export type EffectHumanIntent = z.infer<typeof EffectHumanIntentSchema>;
export const AuthenticatedEffectHumanActionSchema = z.object({ id, at, ref: EffectVersionRefSchema, intent: EffectHumanIntentSchema }).strict();
export type AuthenticatedEffectHumanAction = z.infer<typeof AuthenticatedEffectHumanActionSchema>;
export const EffectPendingReleaseSchema = z.object({ id, actionId: id, at, familyId: EditorRequestIdSchema, branchId: id,
  authorizingVersionId: id, ruleId, scopeFingerprint: z.string().min(1).max(8192),
  currentRule: z.object({ fingerprint: z.string().max(4 * 1024 * 1024), revision: frame }).strict().nullable(),
  authorizingRule: z.object({ fingerprint: z.string().max(4 * 1024 * 1024), revision: frame }).strict(),
}).strict();
export type EffectPendingRelease = z.infer<typeof EffectPendingReleaseSchema>;
const decisionBase = { id, actionId: id, at, branchId: id, versionId: id };
export const EffectStickyChangeSchema = z.object({ originId: id, segmentId: id, scopes: z.array(EffectStickyScopeSchema).min(1).max(8000),
  before: EffectClipSchema.nullable(), after: EffectClipSchema.nullable() }).strict();
export type EffectStickyChange = z.infer<typeof EffectStickyChangeSchema>;
export const EffectHumanDecisionSchema = z.discriminatedUnion("kind", [
  z.object({ ...decisionBase, kind: z.literal("adjust"), changes: z.array(EffectStickyChangeSchema).min(1).max(50) }).strict(),
  z.object({ ...decisionBase, kind: z.literal("keep-current"), changes: z.array(EffectStickyChangeSchema).min(1).max(50), baseValueFingerprint: z.string().min(1).max(4_000_000) }).strict(),
  z.object({ ...decisionBase, kind: z.literal("exclude"), originId: id }).strict(),
  z.object({ ...decisionBase, kind: z.literal("protect"), rule: EffectProtectionInputSchema }).strict(),
  z.object({ ...decisionBase, kind: z.literal("release"), release: EffectPendingReleaseSchema }).strict(),
  z.object({ ...decisionBase, kind: z.literal("permit-revision"), adjustmentIds: z.array(id).min(1).max(4000), scopes: z.array(EffectStickyScopeSchema).min(1).max(50) }).strict(),
  z.object({ ...decisionBase, kind: z.literal("identity"), intent: z.union([EffectHumanIntentSchema.options[6], EffectHumanIntentSchema.options[7]]) }).strict(),
]);
export type EffectHumanDecision = z.infer<typeof EffectHumanDecisionSchema>;

export const EffectProposalDependenciesSchema = z.object({ schemaVersion: z.literal(1),
  base: z.object({ revision: frame, timelineHash: fileHash }).strict(), resolutionHash: hash,
  profiles: z.object({ rendererVersion: id, catalogueHash: hash, analysisProfileId: id }).strict(),
  issues: z.array(z.object({ kind: z.enum(["missing-media", "profile", "analysis", "source-changed"]), reason }).strict()).max(128).default([]),
  sources: z.array(z.object({ path: z.string().min(1).max(4096), sha256: hash }).strict()).max(8000),
  protection: z.array(z.object({ ruleId, scopeFingerprint: hash, baselineFingerprint: z.string().max(4 * 1024 * 1024), baselineRevision: frame }).strict()).max(4000),
  reactions: z.array(z.discriminatedUnion("status", [
    z.object({ effectId: clipId, status: z.literal("off") }).strict(),
    z.object({ effectId: clipId, status: z.literal("ready"), binding: EffectAudioInputSchema, requestFingerprint: reason, manifestKey: hash, sourceFingerprint: hash,
      decoder: z.object({ versionConfigHash: hash, executableHash: hash }).strict() }).strict(),
    ...(["required", "analysing", "unavailable", "failed"] as const).map(status => z.object({ effectId: clipId, status: z.literal(status), binding: EffectAudioInputSchema.optional(), requestFingerprint: reason.optional(), reason }).strict()),
  ])).max(1000),
}).strict();
export type EffectProposalDependencies = z.infer<typeof EffectProposalDependenciesSchema>;
export const EffectProposalConflictSchema = z.object({ id, kind: z.enum(["identity", "sticky", "protection", "scope", "stale", "readiness", "bounds", "invalid"]),
  reason, stepId: id.optional(), entityId: id.optional(), decisionId: id.optional(), remedies: z.array(z.string().min(1).max(200)).max(8) }).strict();
export type EffectProposalConflict = z.infer<typeof EffectProposalConflictSchema>;
export const EffectTrackHeaderSchema = z.object({ id: trackId, name: z.string().min(1).max(160), order: frame, muted: z.boolean() }).strict();
export type EffectTrackHeader = z.infer<typeof EffectTrackHeaderSchema>;
export const EffectAuthoredStateSchema = z.object({ tracks: z.array(EffectTrackHeaderSchema.extend({ effects: z.array(EffectClipSchema).max(1000) }).strict()).max(1000),
  protection: z.array(EffectProtectionRuleSchema).max(4000) }).strict();
export type EffectAuthoredState = z.infer<typeof EffectAuthoredStateSchema>;
const provenance = z.array(z.object({ stepId: id, authority: z.enum(["human", "suggestion"]), paths: z.array(id).max(8000) }).strict()).max(200);
export const EffectFinalDeltaSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("effect-result"), trackId, before: EffectClipSchema.nullable(), after: EffectClipSchema.nullable(), provenance }).strict(),
  z.object({ kind: z.literal("effect-track-result"), trackId, before: EffectTrackHeaderSchema.nullable(), after: EffectTrackHeaderSchema.nullable(), provenance }).strict(),
  z.object({ kind: z.literal("protect-result"), ruleId, after: EffectProtectionRuleSchema, decisionId: id }).strict(),
  z.object({ kind: z.literal("release-result"), ruleId, before: EffectProtectionRuleSchema, decisionId: id }).strict(),
]);
export type EffectFinalDelta = z.infer<typeof EffectFinalDeltaSchema>;
export const EffectProposalBaseSchema = z.object({ id, revision: frame, timelineHash: fileHash,
  authored: ProductionTimelineSchema.innerType().omit({ history: true }) }).strict();
export type EffectProposalBase = z.infer<typeof EffectProposalBaseSchema>;
export const EffectProposalStepSchema = z.discriminatedUnion("kind", [
  z.object({ id, kind: z.literal("model"), parentVersionId: id.optional(), model: ModelEffectProposalSchema,
    admittedCommands: z.array(EffectCreativeCommandSchema).max(50), allocations: z.array(EffectIdentityAllocationSchema).max(8000) }).strict(),
  z.object({ id, kind: z.literal("human"), action: AuthenticatedEffectHumanActionSchema,
    admittedCommands: z.array(z.union([EffectCreativeCommandSchema, EffectCommandSchema.options[8], EffectCommandSchema.options[9]])).max(50), decisionIds: z.array(id).max(4000),
    allocations: z.array(EffectIdentityAllocationSchema).max(8000) }).strict(),
  z.object({ id, kind: z.literal("rebase"), ancestorVersionId: id, newBaseId: id }).strict(),
  z.object({ id, kind: z.literal("dependency"), basisVersionId: id }).strict(),
]);
export type EffectProposalStep = z.infer<typeof EffectProposalStepSchema>;
export const EffectProposalVersionSchema = z.object({ id, number: frame.min(1), branchId: id, parentVersionId: id.optional(), baseId: id, createdAt: at,
  actionId: ConversationActionIdSchema.optional(), requestId: id.optional(), requestDecisionRevision: frame.optional(),
  origin: z.enum(["model", "human-adjustment", "update", "release", "undo", "redo", "analysis"]), summary: z.string().min(1).max(500),
  stepIds: z.array(id).max(200), decisionRevision: frame, decisionIds: z.array(id).max(4000), state: EffectAuthoredStateSchema,
  delta: z.array(EffectFinalDeltaSchema).max(50), conflicts: z.array(EffectProposalConflictSchema).max(200),
  requestedActions: z.array(EffectRequestedHumanActionSchema).max(50).default([]),
  dependencies: EffectProposalDependenciesSchema, basisHash: hash, candidateHash: hash,
}).strict();
export type EffectProposalVersion = z.infer<typeof EffectProposalVersionSchema>;
export const EffectReviewGrantSchema = z.object({ id, familyId: EditorRequestIdSchema, branchId: id, versionId: id, candidateHash: hash, decisionRevision: frame, reviewedAt: at }).strict();
export type EffectReviewGrant = z.infer<typeof EffectReviewGrantSchema>;
export const EffectApplyReceiptSchema = z.object({ familyId: EditorRequestIdSchema, versionId: id, candidateHash: hash, branchId: id, decisionRevision: frame,
  applyActionIds: z.array(id).min(1).max(200), resultRevision: frame, historyEntryDigest: hash,
  adjustmentIds: z.array(id).max(4000), releaseDecisionIds: z.array(id).max(4000),
  bindings: z.array(z.object({ effectId: clipId, target: EffectTargetSchema, audioInput: EffectAudioInputSchema.optional() }).strict()).max(1000),
  preservedRuleIds: z.array(ruleId).max(4000), releasedRuleIds: z.array(ruleId).max(4000), appliedAt: at, undoneAt: at.optional(),
}).strict();
export type EffectApplyReceipt = z.infer<typeof EffectApplyReceiptSchema>;
const EffectProposalFamilyObjectSchema = z.object({ id: EditorRequestIdSchema, productionId: SlugSchema, conversationId: ConversationIdSchema,
  actionId: ConversationActionIdSchema.optional(), createdAt: at, scope: EffectArrangementScopeSchema, status: z.enum(["pending", "applied", "discarded"]),
  decisionRevision: frame, bases: z.array(EffectProposalBaseSchema).min(1).max(200), identities: EffectIdentityLedgerSchema,
  decisions: z.array(EffectHumanDecisionSchema).max(4000), activeDecisionIds: z.array(id).max(4000), steps: z.array(EffectProposalStepSchema).max(200),
  branches: z.array(z.object({ id, headVersionId: id, undoVersionIds: z.array(id).max(200), redoVersionIds: z.array(id).max(200) }).strict()).max(200),
  versions: z.array(EffectProposalVersionSchema).max(200), reviewGrants: z.array(EffectReviewGrantSchema).max(200), receipt: EffectApplyReceiptSchema.optional(),
}).strict();
export type EffectProposalFamily = z.output<typeof EffectProposalFamilyObjectSchema>;
type EffectProposalFamilyInput = z.input<typeof EffectProposalFamilyObjectSchema>;
// Keep the large replay schema behind a named boundary when bundled into transport/file declarations.
// Input remains distinct from output so nested defaults retain their accepted optional input fields.
export const EffectProposalFamilySchema: z.ZodType<EffectProposalFamily, z.ZodTypeDef, EffectProposalFamilyInput> = EffectProposalFamilyObjectSchema.superRefine((family, ctx) => {
  const problem = (message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, message });
  const ids = (rows: readonly { id: string }[], label: string) => { const found = new Set(rows.map(row => row.id)); if (found.size !== rows.length) problem(`${label} IDs must be unique`); return found; };
  const bases = ids(family.bases, "base"), steps = ids(family.steps, "step"), decisions = ids(family.decisions, "decision"), versions = ids(family.versions, "version"), branches = ids(family.branches, "branch");
  ids(family.reviewGrants, "review grant");
  const requireIds = (values: readonly string[], allowed: Set<string>, label: string) => { if (new Set(values).size !== values.length || values.some(value => !allowed.has(value))) problem(`${label} references are missing or duplicated`); };
  requireIds(family.activeDecisionIds, decisions, "active decision");
  const earlier = new Set<string>();
  for (const version of family.versions) {
    if (!bases.has(version.baseId) || !branches.has(version.branchId)) problem("version must reference its base and branch");
    if (version.parentVersionId && !earlier.has(version.parentVersionId)) problem("version ancestry must refer to an earlier version");
    if (version.decisionRevision > family.decisionRevision) problem("version cannot claim a future decision revision");
    requireIds(version.stepIds, steps, "version step"); requireIds(version.decisionIds, decisions, "version decision"); earlier.add(version.id);
  }
  for (const branch of family.branches) { if (!versions.has(branch.headVersionId)) problem("branch head version is missing"); requireIds(branch.undoVersionIds, versions, "pending Undo"); requireIds(branch.redoVersionIds, versions, "pending Redo"); }
  for (const grant of family.reviewGrants) if (grant.familyId !== family.id || !versions.has(grant.versionId) || !branches.has(grant.branchId)) problem("review grant refers to another family or a missing version");
  if (family.receipt && (family.receipt.familyId !== family.id || !versions.has(family.receipt.versionId))) problem("receipt must refer to this family's retained version");
  const commandCount = family.steps.reduce((sum, step) => sum + ("admittedCommands" in step ? step.admittedCommands.length : 0), 0);
  if (commandCount > EFFECT_PROPOSAL_BOUNDS.traceCommandsPerFamily) problem("proposal replay exceeds its command budget");
});
/** Read projection excludes historical Current snapshots and executable replay authority. */
export type EffectProposalFamilyView = Omit<EffectProposalFamily, "bases" | "steps">;
type EffectProposalFamilyViewInput = Omit<EffectProposalFamilyInput, "bases" | "steps">;
export const EffectProposalFamilyViewSchema: z.ZodType<EffectProposalFamilyView, z.ZodTypeDef, EffectProposalFamilyViewInput> =
  EffectProposalFamilyObjectSchema.omit({ bases: true, steps: true });
export function effectProposalFamilyView(family: EffectProposalFamily): EffectProposalFamilyView {
  const { bases: _bases, steps: _steps, ...view } = family;
  return view;
}
