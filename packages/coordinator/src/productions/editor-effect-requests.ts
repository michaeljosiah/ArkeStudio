import { readFile } from "node:fs/promises";
import { createHash, randomInt } from "node:crypto";
import { join } from "node:path";
import {
  ProductionTimelineSchema, migrateLegacyCut, ulid, replayEffectProposal, effectCandidateTimeline,
  effectCandidateContentMaterial, effectCandidateFingerprintMaterial, finalizeEffectProposal,
  compileEffectModelRevision, compileEffectHumanAdjustment, compileEffectPendingHistory, compileEffectDependencyRevision, rebaseEffectProposal,
  createEffectProposalFamily, allocateEffectProposalIdentities, retainEditorRequestFile,
  ModelEffectProposalSchema, EffectArrangementScopeSchema, EffectHumanIntentSchema, EffectProposalDependenciesSchema,
  EFFECT_PROPOSAL_BOUNDS,
  type EffectApplyReceipt, type EffectHumanIntent, type EffectProposalDependencies,
  type EffectProposalFamily, type EffectProposalVersion, type EffectVersionRef, type EffectReviewGrant,
  type EditorRequestFile, type ProductionBundle, type ProductionTimeline, type ModelEffectProposal,
  type EffectArrangementScope, type ConversationActionId, type ConversationId,
} from "@arke-studio/contracts";
import { editorRequestHistoryPins, readRequestFile, requestFileInput } from "./editor-request-file.js";
import { requestBase } from "./editor-requests.js";
import { refuseUnknownEffectAudioBindings, refuseUnsupportedEffectRender } from "./effect-bindings.js";
import type { WorldStore } from "../world/store.js";
import { EDITOR_EFFECT_PROPOSALS_SCHEMA_VERSION } from "../world/commit.js";
import { fromPortable, toExtendedLength } from "../world/paths.js";
import { sha256 } from "../world/text-files.js";

/** Native preparation is deliberately separate from the exact, validation-only Apply boundary. */
export interface EffectRequestDependencies {
  captureDependencies(input: {
    store: WorldStore; productionId: string; baseTimelineHash: string;
    candidate: ProductionTimeline; candidateBasisHash: string; signal?: AbortSignal;
  }): Promise<EffectProposalDependencies>;
  validateDependencies(input: {
    store: WorldStore; productionId: string; current: ProductionTimeline; candidate: ProductionTimeline;
    candidateHash: string; expectedFence: EffectProposalDependencies; phase: "gate" | "precommit";
    requireReady?: boolean; signal?: AbortSignal;
  }): Promise<void>;
}

export class EffectProposalRefused extends Error {
  constructor(readonly reason: string, readonly kind: "stale" | "conflict" | "unavailable" | "bounds" | "invalid" = "conflict") {
    super(reason); this.name = "EffectProposalRefused";
  }
}

export interface EffectProposalSelection { family: EffectProposalFamily; version: EffectProposalVersion }
export interface EffectHumanRequest {
  productionId: string; ref: EffectVersionRef; intent: EffectHumanIntent; actionId: string; now: string; reviewId?: string;
}
export interface EffectApplyRequest {
  productionId: string; familyId: string; versionId: string; candidateHash: string;
  reviewId: string; requestId: string; now: string;
}

/** Read-only inspection never migrates, prepares analysis or grants review authority. */
export async function readEffectProposalFamilies(store: WorldStore, productionId: string): Promise<EffectProposalFamily[]> {
  const { file } = await readRequestFile(store, productionId);
  return file.schemaVersion === 2 ? file.effectFamilies : [];
}

export async function readEffectProposalVersion(store: WorldStore, input: {
  productionId: string; familyId: string; versionId: string;
}): Promise<EffectProposalSelection | null> {
  const family = (await readEffectProposalFamilies(store, input.productionId)).find(row => row.id === input.familyId);
  const version = family?.versions.find(row => row.id === input.versionId);
  return family && version ? { family, version } : null;
}

interface RequestSnapshot {
  production: ProductionBundle; current: ProductionTimeline; timelineRaw: string | null; timelineHash: string;
  requestRaw: string | null; file: EditorRequestFile;
}
const timelinePath = (productionId: string) => `productions/${productionId}/timeline.json`;
const missing = (error: unknown) => error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";

/** Call only inside the already-owned gate, after its fresh rescan. */
async function readSnapshot(store: WorldStore, productionId: string, requests?: { raw: string | null; file: EditorRequestFile }): Promise<RequestSnapshot> {
  const production = store.getBundle().productions.find(row => row.meta.id === productionId);
  if (!production) throw new EffectProposalRefused(`Production ${productionId} is not in this world`, "unavailable");
  let timelineRaw: string | null;
  try { timelineRaw = await readFile(toExtendedLength(join(store.dir, fromPortable(timelinePath(productionId)))), "utf8"); }
  catch (error) { if (!missing(error)) throw error; timelineRaw = null; }
  let current: ProductionTimeline;
  try { current = timelineRaw === null ? requestBase(store, production).timeline : ProductionTimelineSchema.parse(JSON.parse(timelineRaw)); }
  catch (error) { throw new EffectProposalRefused(`The timeline cannot be read: ${error instanceof Error ? error.message : String(error)}`, "invalid"); }
  current = migrateLegacyCut(current, production, store.getBundle().artifacts).timeline;
  const { raw: requestRaw, file } = requests ?? await readRequestFile(store, productionId);
  return { production, current, timelineRaw, timelineHash: sha256(timelineRaw ?? "null"), requestRaw, file };
}

function selectVersion(file: EditorRequestFile, familyId: string, versionId: string): EffectProposalSelection {
  const family = file.schemaVersion === 2 ? file.effectFamilies.find(row => row.id === familyId) : undefined;
  const version = family?.versions.find(row => row.id === versionId);
  if (!family || !version) throw new EffectProposalRefused("This effects proposal version is no longer available; review a retained version", "unavailable");
  return { family, version };
}

function requirePending(selection: EffectProposalSelection, ref: EffectVersionRef): void {
  const { family, version } = selection;
  if (family.status !== "pending") throw new EffectProposalRefused(`This effects arrangement is already ${family.status}`);
  if (version.candidateHash !== ref.candidateHash || family.decisionRevision !== ref.decisionRevision) {
    throw new EffectProposalRefused("The proposal or your retained decisions changed; review the current version before editing it", "stale");
  }
}

/** A landed receipt wins over today's base/readiness, including a retry after ordinary Undo. */
function priorReceipt(file: EditorRequestFile, input: EffectApplyRequest): EffectApplyReceipt | null {
  if (file.schemaVersion !== 2) return null;
  for (const family of file.effectFamilies) {
    const receipt = family.receipt;
    if (!receipt) continue;
    const sameCandidate = receipt.familyId === input.familyId && receipt.versionId === input.versionId && receipt.candidateHash === input.candidateHash;
    if (receipt.applyActionIds.includes(input.requestId) && !sameCandidate) {
      throw new EffectProposalRefused("This Apply request ID already identifies another candidate", "conflict");
    }
  }
  const receipt = file.effectFamilies.find(family => family.id === input.familyId)?.receipt;
  if (!receipt) return null;
  if (receipt.versionId !== input.versionId || receipt.candidateHash !== input.candidateHash) {
    throw new EffectProposalRefused("This arrangement was already applied from another reviewed version", "conflict");
  }
  return receipt;
}

function replaceFamily(file: EditorRequestFile, family: EffectProposalFamily): EditorRequestFile {
  const families = file.schemaVersion === 2 ? file.effectFamilies : [];
  return { schemaVersion: 2, requests: file.requests,
    ...(file.schemaVersion === 2 && file.transitionFamilies ? { transitionFamilies: file.transitionFamilies } : {}),
    ...(file.schemaVersion === 2 && file.pictureFamilies ? { pictureFamilies: file.pictureFamilies } : {}),
    effectFamilies: families.some(row => row.id === family.id) ? families.map(row => row.id === family.id ? family : row) : [...families, family] };
}

/** This records an explicit authenticated Review; arrival/read/list never call it. */
export async function reviewEffectProposal(store: WorldStore, input: {
  productionId: string; ref: EffectVersionRef; now: string;
}): Promise<EffectReviewGrant> {
  return store.gateOp(async () => {
    const { raw, file } = await readRequestFile(store, input.productionId);
    const selection = selectVersion(file, input.ref.familyId, input.ref.versionId);
    requirePending(selection, input.ref);
    const { family, version } = selection;
    const previous = family.reviewGrants.find(grant => grant.versionId === version.id && grant.candidateHash === version.candidateHash && grant.decisionRevision === version.decisionRevision);
    if (previous) return previous;
    const grant: EffectReviewGrant = { id: `review_${ulid()}`, familyId: family.id, branchId: version.branchId,
      versionId: version.id, candidateHash: version.candidateHash, decisionRevision: version.decisionRevision, reviewedAt: input.now };
    const updated = { ...family, reviewGrants: [...family.reviewGrants.filter(row => row.versionId !== version.id), grant] };
    await store.commitUnserialised({ kind: "editor-effect-request", source: "review",
      raiseSchemaVersion: EDITOR_EFFECT_PROPOSALS_SCHEMA_VERSION,
      files: [requestFileInput(input.productionId, raw, replaceFamily(file, updated))] });
    return grant;
  }, () => null);
}

export async function discardEffectProposal(store: WorldStore, input: {
  productionId: string; ref: EffectVersionRef; now: string;
}): Promise<EffectProposalFamily> {
  return store.gateOp(async () => {
    const { raw, file } = await readRequestFile(store, input.productionId);
    const selection = selectVersion(file, input.ref.familyId, input.ref.versionId);
    if (selection.family.status === "discarded" && selection.version.candidateHash === input.ref.candidateHash) return selection.family;
    requirePending(selection, input.ref);
    const family: EffectProposalFamily = { ...selection.family, status: "discarded", decisionRevision: selection.family.decisionRevision + 1,
      activeDecisionIds: [], reviewGrants: [] };
    await store.commitUnserialised({ kind: "editor-effect-request", source: "discard",
      raiseSchemaVersion: EDITOR_EFFECT_PROPOSALS_SCHEMA_VERSION,
      files: [requestFileInput(input.productionId, raw, replaceFamily(file, family))] });
    return family;
  }, () => null);
}

/** Key order is not authority: hashes name exact semantic history, not serializer insertion order. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.keys(value).sort().filter(key => (value as Record<string, unknown>)[key] !== undefined)
    .map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

const mint = (kind: "clip" | "lineage" | "entity" | "point" | "cue") => `${({ clip: "cl", lineage: "ef", entity: "identity", point: "ep", cue: "ec" } as const)[kind]}_${ulid()}`;
const digest = (material: string) => createHash("sha256").update(material).digest("hex");
type Compilation = ReturnType<typeof compileEffectModelRevision>;
interface VersionPreparation {
  snapshot: RequestSnapshot; previousFamily?: EffectProposalFamily;
  family: EffectProposalFamily; version: EffectProposalVersion; candidate: ProductionTimeline;
}
interface VersionStamp {
  versionId: string; branchId: string; baseId: string; now: string; summary: string;
  origin: EffectProposalVersion["origin"]; parentVersionId?: string; actionId?: ConversationActionId;
  reviewId?: string; historyDirection?: "undo" | "redo"; requestId?: string; requestDecisionRevision?: number;
}

function appendUnique<T extends { id: string }>(before: readonly T[], added: readonly T[]): T[] {
  const result = [...before];
  for (const item of added) {
    const existing = result.find(row => row.id === item.id);
    if (existing && canonical(existing) !== canonical(item)) throw new EffectProposalRefused("An immutable proposal record changed during compilation", "invalid");
    if (!existing) result.push(item);
  }
  return result;
}

async function prepareVersion(store: WorldStore, snapshot: RequestSnapshot, family: EffectProposalFamily,
  result: Compilation, stamp: VersionStamp, dependencies: EffectRequestDependencies,
  previousFamily?: EffectProposalFamily): Promise<VersionPreparation> {
  const basisHash = digest(effectCandidateContentMaterial(result.draft));
  const candidate = effectCandidateTimeline(snapshot.current, result.draft);
  const fence = EffectProposalDependenciesSchema.parse(await dependencies.captureDependencies({ store, productionId: family.productionId,
    baseTimelineHash: snapshot.timelineHash, candidate, candidateBasisHash: basisHash, signal: store.closingSignal }));
  const version: EffectProposalVersion = {
    id: stamp.versionId, number: Math.max(0, ...family.versions.map(row => row.number)) + 1,
    branchId: stamp.branchId, baseId: stamp.baseId, createdAt: stamp.now, origin: stamp.origin, summary: stamp.summary,
    ...(stamp.parentVersionId ? { parentVersionId: stamp.parentVersionId } : {}), ...(stamp.actionId ? { actionId: stamp.actionId } : {}),
    ...(stamp.requestId ? { requestId: stamp.requestId } : {}),
    ...(stamp.requestDecisionRevision !== undefined ? { requestDecisionRevision: stamp.requestDecisionRevision } : {}),
    ...result.draft, dependencies: fence, basisHash, candidateHash: digest(effectCandidateFingerprintMaterial(result.draft, fence)),
  };
  const parent = family.versions.find(row => row.id === stamp.parentVersionId);
  const previousBranch = family.branches.find(row => row.id === stamp.branchId);
  const branch = { id: stamp.branchId, headVersionId: version.id,
    undoVersionIds: stamp.historyDirection === "undo" ? previousBranch!.undoVersionIds.slice(0, -1)
      : [...(previousBranch?.undoVersionIds ?? []), ...(parent ? [parent.id] : [])],
    redoVersionIds: stamp.historyDirection === "undo" ? [...previousBranch!.redoVersionIds, parent!.id]
      : stamp.historyDirection === "redo" ? previousBranch!.redoVersionIds.slice(0, -1) : [],
  };
  let next: EffectProposalFamily = { ...family, decisionRevision: version.decisionRevision,
    identities: result.ledger, decisions: appendUnique(family.decisions, result.decisions), activeDecisionIds: version.decisionIds,
    steps: appendUnique(family.steps, [result.step]), versions: [...family.versions, version],
    branches: [...family.branches.filter(row => row.id !== branch.id), branch] };
  if (stamp.reviewId && parent && ["human-adjustment", "undo", "redo"].includes(stamp.origin)) {
    const grant = family.reviewGrants.find(row => row.id === stamp.reviewId && row.versionId === parent.id && row.candidateHash === parent.candidateHash && row.decisionRevision === family.decisionRevision);
    if (!grant) throw new EffectProposalRefused("The active review changed before this adjustment completed", "stale");
    const continued: EffectReviewGrant = { id: `review_${ulid()}`, familyId: family.id, branchId: version.branchId,
      versionId: version.id, candidateHash: version.candidateHash, decisionRevision: version.decisionRevision, reviewedAt: stamp.now };
    next = { ...next, reviewGrants: [...next.reviewGrants, continued] };
  }
  return { snapshot, previousFamily, family: next, version, candidate };
}

function familyCas(family: EffectProposalFamily): string {
  const { reviewGrants: _viewOnly, ...authority } = family;
  return canonical(authority);
}

async function storePreparedVersions(store: WorldStore, productionId: string, prepared: readonly VersionPreparation[],
  dependencies: EffectRequestDependencies): Promise<EffectProposalSelection[]> {
  return store.gateOp(async () => {
    const snapshot = await readSnapshot(store, productionId);
    let file = snapshot.file;
    for (const item of prepared) {
      if (snapshot.timelineHash !== item.snapshot.timelineHash || snapshot.current.revision !== item.snapshot.current.revision) {
        throw new EffectProposalRefused("Current changed during preparation; Update proposal against the new timeline", "stale");
      }
      const live = file.schemaVersion === 2 ? file.effectFamilies.find(row => row.id === item.family.id) : undefined;
      if (item.previousFamily ? !live || familyCas(live) !== familyCas(item.previousFamily) : live !== undefined) {
        throw new EffectProposalRefused("The arrangement changed during preparation; retain the current decisions and prepare again", "stale");
      }
      await dependencies.validateDependencies({ store, productionId, current: snapshot.current, candidate: item.candidate,
        candidateHash: item.version.candidateHash, expectedFence: item.version.dependencies, phase: "gate", requireReady: false, signal: store.closingSignal });
      const family = live ? { ...item.family, reviewGrants: appendUnique(live.reviewGrants, item.family.reviewGrants) } : item.family;
      file = replaceFamily(file, family);
    }
    file = retainEditorRequestFile(file, { requestIds: editorRequestHistoryPins(snapshot.current) });
    await store.commitUnserialised({ kind: "editor-effect-request", source: "prepare", raiseSchemaVersion: EDITOR_EFFECT_PROPOSALS_SCHEMA_VERSION,
      validateBeforeCommit: async () => {
        for (const item of prepared) await dependencies.validateDependencies({ store, productionId, current: snapshot.current, candidate: item.candidate,
          candidateHash: item.version.candidateHash, expectedFence: item.version.dependencies, phase: "precommit", requireReady: false, signal: store.closingSignal });
      }, files: [requestFileInput(productionId, snapshot.requestRaw, file)] });
    return prepared.map(item => selectVersion(file, item.family.id, item.version.id));
  }, () => null);
}

function modelActionReceipt(file: EditorRequestFile, input: {
  conversationId: ConversationId; actionId?: ConversationActionId; scope: EffectArrangementScope; proposals: readonly ModelEffectProposal[];
}): EffectProposalSelection[] | null {
  if (!input.actionId || file.schemaVersion !== 2) return null;
  const saved = file.effectFamilies.flatMap(family => family.versions.filter(version => version.actionId === input.actionId && version.origin === "model")
    .map(version => ({ family, version })));
  if (!saved.length) return null;
  const models = [...input.proposals];
  for (const { family, version } of saved) {
    const step = family.steps.find(row => row.id === version.stepIds.at(-1));
    const index = step?.kind === "model" ? models.findIndex(model => canonical(model) === canonical(step.model)) : -1;
    if (index < 0 || family.conversationId !== input.conversationId || canonical(family.scope) !== canonical(input.scope)) {
      throw new EffectProposalRefused("This model action already identifies a different arrangement", "conflict");
    }
    models.splice(index, 1);
  }
  if (models.length) throw new EffectProposalRefused("This model action already identifies a different arrangement count", "conflict");
  return saved;
}

export async function stageEffectProposals(store: WorldStore, input: {
  productionId: string; conversationId: ConversationId; actionId?: ConversationActionId; scope: EffectArrangementScope;
  proposals: readonly ModelEffectProposal[]; now: string;
}, dependencies: EffectRequestDependencies): Promise<EffectProposalSelection[]> {
  if (input.proposals.length === 0 || input.proposals.length > EFFECT_PROPOSAL_BOUNDS.perTurn) {
    throw new EffectProposalRefused(`This turn contains ${input.proposals.length} arrangements; the limit is ${EFFECT_PROPOSAL_BOUNDS.perTurn}`, "bounds");
  }
  const models = input.proposals.map(model => ModelEffectProposalSchema.parse(model));
  const scope = EffectArrangementScopeSchema.parse(input.scope);
  const snapshot = await store.gateOp(() => readSnapshot(store, input.productionId), () => null);
  const receipt = modelActionReceipt(snapshot.file, { ...input, scope, proposals: models });
  if (receipt) return receipt;
  const prepared: VersionPreparation[] = [];
  for (const model of models) {
    let family: EffectProposalFamily, previousFamily: EffectProposalFamily | undefined;
    if (model.family) {
      const selected = selectVersion(snapshot.file, model.family.id, model.family.parentVersionId);
      family = selected.family; previousFamily = family;
      if (family.productionId !== input.productionId || family.conversationId !== input.conversationId || canonical(family.scope) !== canonical(scope)) {
        throw new EffectProposalRefused("The revision must stay within its original production, conversation and explicit arrangement scope");
      }
      requirePending(selected, { familyId: family.id, versionId: selected.version.id, candidateHash: model.family.candidateHash, decisionRevision: family.decisionRevision });
      const base = family.bases.find(row => row.id === selected.version.baseId)!;
      if (base.timelineHash !== snapshot.timelineHash) throw new EffectProposalRefused("Current changed; Update proposal before preparing a revision", "stale");
    } else family = createEffectProposalFamily({ id: `req_${ulid()}`, productionId: input.productionId, conversationId: input.conversationId,
      ...(input.actionId ? { actionId: input.actionId } : {}), scope, base: snapshot.current, timelineHash: snapshot.timelineHash, at: input.now, baseId: `base_${ulid()}` });
    if (prepared.some(item => item.family.id === family.id)) throw new EffectProposalRefused("A turn may prepare only one descendant of each arrangement family", "bounds");
    const versionId = `version_${ulid()}`, branchId = `branch_${ulid()}`, stepId = `step_${ulid()}`;
    const result = compileEffectModelRevision({ base: snapshot.current, family, ...(model.family ? { parentVersionId: model.family.parentVersionId } : {}),
      model, allocations: allocateEffectProposalIdentities(model, mint, () => randomInt(0x1_0000_0000)), stamp: { stepId, versionId, branchId, at: input.now } });
    const baseId = model.family ? family.versions.find(row => row.id === model.family!.parentVersionId)!.baseId : family.bases[0]!.id;
    prepared.push(await prepareVersion(store, snapshot, family, result, { versionId, branchId, baseId, now: input.now, summary: model.summary,
      origin: "model", ...(model.family ? { parentVersionId: model.family.parentVersionId } : {}), ...(input.actionId ? { actionId: input.actionId } : {}) }, dependencies, previousFamily));
  }
  try { return await storePreparedVersions(store, input.productionId, prepared, dependencies); }
  catch (error) {
    // A concurrent retry may have completed while this copy prepared native dependencies.
    // Resolve its exact saved action before reporting a stale preparation; never prepare twice.
    const landed = await store.gateOp(async () => modelActionReceipt((await readRequestFile(store, input.productionId)).file,
      { ...input, scope, proposals: models }), () => null);
    if (landed) return landed;
    throw error;
  }
}

function requireCurrentBase(snapshot: RequestSnapshot, selection: EffectProposalSelection): void {
  const base = selection.family.bases.find(row => row.id === selection.version.baseId);
  if (!base || base.timelineHash !== snapshot.timelineHash || base.revision !== snapshot.current.revision) {
    throw new EffectProposalRefused("Current changed; Update proposal before changing this pending arrangement", "stale");
  }
}

function humanActionReceipt(family: EffectProposalFamily, input: EffectHumanRequest): EffectProposalSelection | null {
  const step = family.steps.find(row => row.kind === "human" && row.action.id === input.actionId);
  if (!step || step.kind !== "human") return null;
  if (canonical(step.action.ref) !== canonical(input.ref) || canonical(step.action.intent) !== canonical(input.intent)) {
    throw new EffectProposalRefused("This human action already identifies another adjustment", "conflict");
  }
  // Release can be inserted before a blocked model step, so the last step is not its identity.
  const authored = family.decisions.find(row => row.actionId === input.actionId);
  const version = family.versions.find(row => row.id === authored?.versionId);
  if (!version) throw new EffectProposalRefused("The saved adjustment has no retained version", "invalid");
  return { family, version };
}

export async function editEffectProposal(store: WorldStore, input: EffectHumanRequest,
  dependencies: EffectRequestDependencies): Promise<EffectProposalSelection> {
  const intent = EffectHumanIntentSchema.parse(input.intent);
  const snapshot = await store.gateOp(() => readSnapshot(store, input.productionId), () => null);
  const selected = selectVersion(snapshot.file, input.ref.familyId, input.ref.versionId);
  const receipt = humanActionReceipt(selected.family, { ...input, intent });
  if (receipt) return receipt;
  requirePending(selected, input.ref); requireCurrentBase(snapshot, selected);
  const { family, version: parent } = selected;
  const branch = family.branches.find(row => row.id === parent.branchId)!;
  const branchId = branch.headVersionId === parent.id ? branch.id : `branch_${ulid()}`;
  const versionId = `version_${ulid()}`, stepId = `step_${ulid()}`;
  const result = compileEffectHumanAdjustment({ base: snapshot.current, family, fromVersionId: parent.id,
    action: { id: input.actionId, at: input.now, ref: input.ref, intent }, allocations: [],
    stamp: { versionId, stepId, branchId, at: input.now } });
  const prepared = await prepareVersion(store, snapshot, family, result, { versionId, branchId, baseId: parent.baseId,
    now: input.now, summary: parent.summary, origin: intent.kind === "release" ? "release" : "human-adjustment", parentVersionId: parent.id,
    ...(input.reviewId ? { reviewId: input.reviewId } : {}) }, dependencies, family);
  return (await storePreparedVersions(store, input.productionId, [prepared], dependencies))[0]!;
}

export interface EffectVersionActionRequest {
  productionId: string; ref: EffectVersionRef; actionId: string; now: string;
}

function versionActionReceipt(family: EffectProposalFamily, input: EffectVersionActionRequest,
  origin: EffectProposalVersion["origin"]): EffectProposalSelection | null {
  const version = family.versions.find(row => row.requestId === input.actionId);
  if (!version) return null;
  const parent = family.versions.find(row => row.id === version.parentVersionId);
  if (version.origin !== origin || parent?.id !== input.ref.versionId || parent.candidateHash !== input.ref.candidateHash ||
    version.requestDecisionRevision !== input.ref.decisionRevision) {
    throw new EffectProposalRefused("This pending action already identifies a different version", "conflict");
  }
  return { family, version };
}

export async function moveEffectProposalHistory(store: WorldStore, input: EffectVersionActionRequest & {
  direction: "undo" | "redo"; reviewId?: string;
}, dependencies: EffectRequestDependencies): Promise<EffectProposalSelection> {
  const snapshot = await store.gateOp(() => readSnapshot(store, input.productionId), () => null);
  const selected = selectVersion(snapshot.file, input.ref.familyId, input.ref.versionId);
  const receipt = versionActionReceipt(selected.family, input, input.direction);
  if (receipt) return receipt;
  requirePending(selected, input.ref); requireCurrentBase(snapshot, selected);
  const { family, version: parent } = selected;
  const branch = family.branches.find(row => row.id === parent.branchId)!;
  if (branch.headVersionId !== parent.id) throw new EffectProposalRefused("Review this branch's latest version before changing its pending history", "stale");
  if (!(input.direction === "undo" ? branch.undoVersionIds : branch.redoVersionIds).length) {
    throw new EffectProposalRefused(`This review has no pending ${input.direction === "undo" ? "Undo" : "Redo"}`);
  }
  const versionId = `version_${ulid()}`, stepId = `step_${ulid()}`;
  const result = compileEffectPendingHistory({ base: snapshot.current, family, fromVersionId: parent.id, direction: input.direction,
    stamp: { versionId, stepId, at: input.now } });
  const prepared = await prepareVersion(store, snapshot, family, result, { versionId, branchId: parent.branchId, baseId: parent.baseId,
    now: input.now, summary: parent.summary, origin: input.direction, parentVersionId: parent.id, requestId: input.actionId, requestDecisionRevision: input.ref.decisionRevision,
    historyDirection: input.direction, ...(input.reviewId ? { reviewId: input.reviewId } : {}) }, dependencies, family);
  return (await storePreparedVersions(store, input.productionId, [prepared], dependencies))[0]!;
}

export async function updateEffectProposal(store: WorldStore, input: EffectVersionActionRequest,
  dependencies: EffectRequestDependencies): Promise<EffectProposalSelection> {
  const snapshot = await store.gateOp(() => readSnapshot(store, input.productionId), () => null);
  const selected = selectVersion(snapshot.file, input.ref.familyId, input.ref.versionId);
  const receipt = versionActionReceipt(selected.family, input, "update");
  if (receipt) return receipt;
  requirePending(selected, input.ref);
  const { family, version: parent } = selected;
  const baseId = `base_${ulid()}`, versionId = `version_${ulid()}`, stepId = `step_${ulid()}`, branchId = `branch_${ulid()}`;
  const { history: _history, ...authored } = snapshot.current;
  const working = { ...family, bases: [...family.bases, { id: baseId, revision: snapshot.current.revision,
    timelineHash: snapshot.timelineHash, authored }] };
  const result = rebaseEffectProposal({ base: snapshot.current, family: working, fromVersionId: parent.id, newBaseId: baseId,
    stamp: { versionId, stepId, at: input.now } });
  const prepared = await prepareVersion(store, snapshot, working, result, { versionId, branchId, baseId,
    now: input.now, summary: parent.summary, origin: "update", parentVersionId: parent.id, requestId: input.actionId, requestDecisionRevision: input.ref.decisionRevision }, dependencies, family);
  return (await storePreparedVersions(store, input.productionId, [prepared], dependencies))[0]!;
}

/** Readiness completion freezes another version; it never mutates a reviewed hash in place. */
export async function retryEffectProposalDependencies(store: WorldStore, input: EffectVersionActionRequest,
  dependencies: EffectRequestDependencies): Promise<EffectProposalSelection> {
  const snapshot = await store.gateOp(() => readSnapshot(store, input.productionId), () => null);
  const selected = selectVersion(snapshot.file, input.ref.familyId, input.ref.versionId);
  const receipt = versionActionReceipt(selected.family, input, "analysis");
  if (receipt) return receipt;
  requirePending(selected, input.ref); requireCurrentBase(snapshot, selected);
  const { family, version: parent } = selected;
  const versionId = `version_${ulid()}`, stepId = `step_${ulid()}`, branchId = `branch_${ulid()}`;
  const result = compileEffectDependencyRevision({ base: snapshot.current, family, fromVersionId: parent.id,
    stamp: { versionId, stepId, at: input.now } });
  const prepared = await prepareVersion(store, snapshot, family, result, { versionId, branchId, baseId: parent.baseId,
    now: input.now, summary: parent.summary, origin: "analysis", parentVersionId: parent.id, requestId: input.actionId, requestDecisionRevision: input.ref.decisionRevision }, dependencies, family);
  return (await storePreparedVersions(store, input.productionId, [prepared], dependencies))[0]!;
}

/** Apply references an exact coordinator-owned record; no incoming commands acquire human authority. */
export async function applyReviewedEffectVersion(store: WorldStore, input: EffectApplyRequest,
  dependencies: EffectRequestDependencies): Promise<EffectApplyReceipt> {
  return store.gateOp(async () => {
    const requests = await readRequestFile(store, input.productionId);
    const landed = priorReceipt(requests.file, input);
    if (landed) {
      if (landed.applyActionIds.includes(input.requestId)) return landed;
      if (landed.applyActionIds.length >= 200) throw new EffectProposalRefused("This arrangement has reached its 200 Apply request identities; use its existing receipt", "bounds");
      const { family } = selectVersion(requests.file, input.familyId, input.versionId);
      const receipt = { ...landed, applyActionIds: [...landed.applyActionIds, input.requestId] };
      // A new transport retry identity is operational bookkeeping only, including after Undo.
      await store.commitUnserialised({ kind: "editor-effect-request", source: "apply-retry", requestId: input.requestId,
        raiseSchemaVersion: EDITOR_EFFECT_PROPOSALS_SCHEMA_VERSION,
        files: [requestFileInput(input.productionId, requests.raw, replaceFamily(requests.file, { ...family, receipt }))] });
      return receipt;
    }
    const { family, version } = selectVersion(requests.file, input.familyId, input.versionId);
    if (family.status !== "pending") throw new EffectProposalRefused(`This arrangement is already ${family.status}`);
    const grant = family.reviewGrants.find(row => row.id === input.reviewId);
    if (!grant || grant.versionId !== version.id || grant.branchId !== version.branchId || grant.candidateHash !== input.candidateHash ||
      version.candidateHash !== input.candidateHash || grant.decisionRevision !== family.decisionRevision || version.decisionRevision !== family.decisionRevision) {
      throw new EffectProposalRefused("Choose Review in timeline for this exact version before applying it", "stale");
    }
    if (version.conflicts.length) throw new EffectProposalRefused(version.conflicts.map(row => row.reason).join("; ").slice(0, 1000));
    const snapshot = await readSnapshot(store, input.productionId, requests);
    const base = family.bases.find(row => row.id === version.baseId);
    if (!base || base.timelineHash !== snapshot.timelineHash || base.revision !== snapshot.current.revision) {
      throw new EffectProposalRefused("Current changed after this version was prepared; Update proposal and review the new version", "stale");
    }
    const replayed = replayEffectProposal({ base: snapshot.current, family, versionId: version.id });
    if (!replayed.ok) throw new EffectProposalRefused(replayed.conflicts.map(row => row.reason).join("; ").slice(0, 1000));
    if (digest(effectCandidateContentMaterial(replayed.compiled)) !== version.basisHash ||
      digest(effectCandidateFingerprintMaterial(replayed.compiled, version.dependencies)) !== version.candidateHash ||
      canonical(replayed.draft.state) !== canonical(version.state) || canonical(replayed.draft.delta) !== canonical(version.delta)) {
      throw new EffectProposalRefused("The replayed arrangement does not match the frozen reviewed candidate", "stale");
    }
    const candidate = effectCandidateTimeline(snapshot.current, replayed.compiled);
    refuseUnknownEffectAudioBindings(snapshot.current, candidate, snapshot.production, store.getBundle().artifacts);
    refuseUnsupportedEffectRender(candidate, snapshot.production, store.getBundle().artifacts);
    const validate = (phase: "gate" | "precommit") => dependencies.validateDependencies({ store, productionId: input.productionId,
      current: snapshot.current, candidate, candidateHash: version.candidateHash, expectedFence: version.dependencies,
      phase, requireReady: true, signal: store.closingSignal });
    await validate("gate");
    const finalized = finalizeEffectProposal(snapshot.current, replayed.compiled, { label: version.summary, requestId: family.id });
    if (finalized.kind === "unchanged") throw new EffectProposalRefused("There are no changes to apply; Current and its history remain unchanged");
    const decisions = family.decisions.filter(row => version.decisionIds.includes(row.id));
    const receipt: EffectApplyReceipt = {
      familyId: family.id, versionId: version.id, candidateHash: version.candidateHash, branchId: version.branchId,
      decisionRevision: version.decisionRevision, applyActionIds: [input.requestId], resultRevision: finalized.timeline.revision,
      historyEntryDigest: digest(canonical(finalized.entry)),
      adjustmentIds: decisions.filter(row => row.kind !== "release").map(row => row.id),
      releaseDecisionIds: decisions.filter(row => row.kind === "release").map(row => row.id),
      bindings: version.state.tracks.flatMap(track => track.effects.map(effect => ({ effectId: effect.id, target: effect.target,
        ...(effect.audioInput ? { audioInput: effect.audioInput } : {}) }))),
      preservedRuleIds: (snapshot.current.effectProtection ?? []).filter(rule => finalized.timeline.effectProtection?.some(row => row.id === rule.id)).map(rule => rule.id),
      releasedRuleIds: decisions.flatMap(row => row.kind === "release" ? [row.release.ruleId] : []), appliedAt: input.now,
    };
    await store.commitUnserialised({ kind: "editor-effect-apply", source: "reviewed-version", requestId: input.requestId,
      raiseSchemaVersion: EDITOR_EFFECT_PROPOSALS_SCHEMA_VERSION, validateBeforeCommit: () => validate("precommit"),
      files: [{ path: timelinePath(input.productionId), action: snapshot.timelineRaw === null ? "create" : "replace",
        baseHash: snapshot.timelineRaw === null ? null : snapshot.timelineHash, content: `${JSON.stringify(finalized.timeline, null, 2)}\n` },
      requestFileInput(input.productionId, requests.raw, replaceFamily(requests.file, { ...family, status: "applied", receipt }))] });
    return receipt;
  }, () => null);
}
