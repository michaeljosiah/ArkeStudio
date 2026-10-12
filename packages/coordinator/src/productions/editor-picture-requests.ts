import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { ProductionTimelineSchema, PictureProposalFamilySchema, PictureProposalVersionSchema, compilePictureProposal,
  finishTrustedTimelineSteps, keepPictureAppearance, pictureStickyEdits, pictureAppearanceState, pictureVersionRef, effectAnalysisCanonicalJson as canonical, ulid,
  type EditorRequestFile, type ModelPictureProposal, type PictureProposalFamily, type PictureProposalVersion,
  retainEditorRequestFile, type PictureReviewCommand, type PictureReviewResult, type PictureSticky } from "@arke-studio/contracts";
import type { WorldStore } from "../world/store.js";
import { fromPortable, toExtendedLength } from "../world/paths.js";
import { sha256 } from "../world/text-files.js";
import { EDITOR_APPEARANCE_SCHEMA_VERSION } from "../world/commit.js";
import { editorRequestHistoryPins, readRequestFile, requestFileInput } from "./editor-request-file.js";
import type { EditorEffectDependencies } from "./editor-effect-dependencies.js";

const digest = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex");
const pathFor = (id: string) => `productions/${id}/timeline.json`;
export async function readPictureFamilies(store: WorldStore, productionId: string): Promise<PictureProposalFamily[]> {
  const { file } = await readRequestFile(store, productionId); return file.schemaVersion === 2 ? file.pictureFamilies ?? [] : [];
}
async function snapshot(store: WorldStore, productionId: string) {
  const production = store.getBundle().productions.find(value => value.meta.id === productionId);
  if (!production) throw new Error("Production is unavailable");
  if (production.timeline?.status !== "ready") throw new Error("Place the images on the timeline before proposing picture appearance");
  const raw = await readFile(toExtendedLength(join(store.dir, fromPortable(pathFor(productionId)))), "utf8");
  const current = ProductionTimelineSchema.parse(JSON.parse(raw)), baseHash = sha256(raw);
  return { production, raw, current, baseHash, options: { sources: { production, artifacts: store.getBundle().artifacts } } };
}
function replace(file: EditorRequestFile, family: PictureProposalFamily): EditorRequestFile {
  const families = file.schemaVersion === 2 ? file.pictureFamilies ?? [] : [];
  const next = { schemaVersion: 2 as const, requests: file.requests, effectFamilies: file.schemaVersion === 2 ? file.effectFamilies : [],
    ...(file.schemaVersion === 2 && file.transitionFamilies ? { transitionFamilies: file.transitionFamilies } : {}),
    pictureFamilies: families.some(value => value.id === family.id) ? families.map(value => value.id === family.id ? family : value) : [...families, family] };
  return next;
}
async function save(store: WorldStore, productionId: string, raw: string | null, file: EditorRequestFile, family: PictureProposalFamily, validateBeforeCommit?: () => Promise<void>) {
  PictureProposalFamilySchema.parse(family);
  const timeline = store.getBundle().productions.find(value => value.meta.id === productionId)?.timeline;
  const next = retainEditorRequestFile(replace(file, family), { requestIds: [family.id, ...editorRequestHistoryPins(timeline?.status === "ready" ? timeline.timeline : undefined)] });
  await store.commitUnserialised({ kind: "editor-picture-request", source: "review", raiseSchemaVersion: EDITOR_APPEARANCE_SCHEMA_VERSION,
    validateBeforeCommit, files: [requestFileInput(productionId, raw, next)] });
}
async function makeVersion(store: WorldStore, productionId: string, family: PictureProposalFamily, model: ModelPictureProposal,
  sticky: PictureSticky[], origin: PictureProposalVersion["origin"], deps: EditorEffectDependencies, base: Awaited<ReturnType<typeof snapshot>>, parent?: PictureProposalVersion, actionId?: string) {
  const compiled = compilePictureProposal(base.current, model, sticky, base.options);
  const dependencies = await deps.captureDependencies({ store, productionId, baseTimelineHash: base.baseHash, candidate: compiled.candidate, candidateBasisHash: digest(compiled.candidate) });
  return PictureProposalVersionSchema.parse({ id: `pv_${ulid()}`, number: family.versions.length + 1, parentVersionId: parent?.id, actionId,
    origin, summary: model.summary, createdAt: store.now(), baseRevision: base.current.revision, baseHash: base.baseHash, model, sticky,
    before: pictureAppearanceState(base.current), pictures: pictureAppearanceState(compiled.candidate), notes: compiled.notes, conflicts: compiled.conflicts,
    dependencies, candidateHash: digest({ baseHash: base.baseHash, model, sticky, pictures: pictureAppearanceState(compiled.candidate), dependencies }) });
}

const familyAuthority = (family: PictureProposalFamily) => { const { grants: _views, ...authority } = family; return canonical(authority); };
/** Native audio preparation writes derived cache data through the world gate. Capture outside
 * that gate, then compare Current and human decisions before installing a prepared version. */
async function savePrepared(store: WorldStore, productionId: string, family: PictureProposalFamily, version: PictureProposalVersion,
  prior: PictureProposalFamily | undefined, deps: EditorEffectDependencies) {
  return store.gateOp(async () => {
    const base = await snapshot(store, productionId), { raw, file } = await readRequestFile(store, productionId);
    if (base.baseHash !== version.baseHash || base.current.revision !== version.baseRevision) throw new Error("Current changed during preparation. Update proposal and review the new version.");
    const live = file.schemaVersion === 2 ? file.pictureFamilies?.find(value => value.id === family.id) : undefined;
    if (prior ? !live || familyAuthority(live) !== familyAuthority(prior) : live !== undefined) throw new Error("Your pending decisions changed during preparation. Review the latest version and try again.");
    const candidate = compilePictureProposal(base.current, version.model, version.sticky, base.options).candidate;
    const validate = (phase: "gate" | "precommit") => deps.validateDependencies({ store, productionId, current: base.current, candidate,
      candidateHash: version.candidateHash, expectedFence: version.dependencies, phase, requireReady: false, signal: store.closingSignal });
    await validate("gate");
    if (live) family.grants = [...new Map([...live.grants, ...family.grants].map(grant => [grant.id, grant])).values()].slice(-100);
    await save(store, productionId, raw, file, family, () => validate("precommit"));
    return { family, version };
  });
}

/** Model preparation owns no Review grant and no timeline write (SPEC-055 R-10). */
export async function stagePictureProposal(store: WorldStore, input: { productionId: string; conversationId: string; actionId: string; proposal: ModelPictureProposal }, deps: EditorEffectDependencies) {
  const receiptFor = (families: PictureProposalFamily[]) => {
    for (const family of families) {
      const version = family.versions.find(value => value.actionId === input.actionId);
      if (!version) continue;
      if (family.conversationId !== input.conversationId || canonical(version.model) !== canonical(input.proposal)) throw new Error("This action already prepared a different picture appearance request");
      return { family, version };
    }
    return undefined;
  };
  const preparation = await store.gateOp(async () => {
    const base = await snapshot(store, input.productionId);
    const { file } = await readRequestFile(store, input.productionId), families = file.schemaVersion === 2 ? file.pictureFamilies ?? [] : [];
    const receipt = receiptFor(families); if (receipt) return receipt;
    const ref = input.proposal.family, prior = ref ? families.find(value => value.id === ref.id) : undefined;
    const parent = prior?.versions.find(value => value.id === ref?.parentVersionId && value.candidateHash === ref.candidateHash);
    if (ref && (!prior || !parent || prior.status !== "pending" || prior.conversationId !== input.conversationId)) throw new Error("Revise an exact pending version in this conversation");
    const family: PictureProposalFamily = prior ? structuredClone(prior) : { id: `er_${ulid()}`, productionId: input.productionId, conversationId: input.conversationId,
      status: "pending", headVersionId: "pending", versions: [], grants: [], undo: [], redo: [] };
    // Human decisions newer than the requested ancestor remain authoritative in every revision.
    const latest = family.versions.find(value => value.id === family.headVersionId);
    return async () => {
    const version = await makeVersion(store, input.productionId, family, input.proposal, latest?.sticky ?? [], "model", deps, base, parent, input.actionId);
    if (version.conflicts.length) throw new Error(version.conflicts.join("; "));
    family.versions.push(version); if (latest) family.undo.push(latest.id); family.redo = []; family.headVersionId = version.id;
    try { return await savePrepared(store, input.productionId, family, version, prior, deps); }
    catch (error) {
      const receipt = await store.gateOp(async () => {
        return receiptFor(await readPictureFamilies(store, input.productionId));
      });
      if (receipt) return receipt;
      throw error;
    }
    };
  });
  return typeof preparation === "function" ? preparation() : preparation;
}

/** Sole mutation endpoint for authenticated editor intent; never registered as a model tool. */
export async function handlePictureReview(store: WorldStore, command: PictureReviewCommand, deps: EditorEffectDependencies): Promise<{ result: PictureReviewResult; conversationId?: string }> {
  const op = command.operation;
  const response = { type: "editor-picture.proposal-result" as const, at: store.now(), worldId: command.worldId, productionId: command.productionId, requestId: command.requestId, ref: op.ref };
  try { const preparation = await store.gateOp(async () => {
    if (store.worldId !== command.worldId) throw new Error("The owning world is no longer open");
    const { raw, file } = await readRequestFile(store, command.productionId);
    const retained = file.schemaVersion === 2 ? file.pictureFamilies?.find(value => value.id === op.ref.familyId) : undefined;
    if (!retained) throw new Error("Picture arrangement is unavailable");
    const family = structuredClone(retained), version = family.versions.find(value => value.id === op.ref.versionId && value.candidateHash === op.ref.candidateHash);
    if (!version) throw new Error("The exact picture appearance version is unavailable");
    const result = (outcome: PictureReviewResult["outcome"], fields: Partial<PictureReviewResult> = {}) => ({ result: { ...response, outcome, ...fields }, conversationId: family.conversationId });
    if (op.kind === "apply" && family.receipt?.versionId === version.id && family.receipt.candidateHash === version.candidateHash) return result("applied");
    if (family.status !== "pending") throw new Error(`Arrangement is ${family.status}`);
    if (op.kind === "discard") { family.status = "discarded"; await save(store, command.productionId, raw, file, family); return result("discarded"); }
    const base = await snapshot(store, command.productionId);
    const stale = base.baseHash !== version.baseHash || base.current.revision !== version.baseRevision;
    if (op.kind !== "update" && stale) throw new Error("Current changed. Update proposal and review the new version.");
    if (op.kind === "review") {
      const compiled = compilePictureProposal(base.current, version.model, version.sticky, base.options);
      await deps.validateDependencies({ store, productionId: command.productionId, current: base.current, candidate: compiled.candidate,
        candidateHash: version.candidateHash, expectedFence: version.dependencies, phase: "gate", requireReady: false });
      const grant = { id: command.requestId, versionId: version.id, candidateHash: version.candidateHash };
      if (!family.grants.some(value => value.id === grant.id)) family.grants = [...family.grants, grant].slice(-100);
      await save(store, command.productionId, raw, file, family); return result("reviewed", { reviewId: grant.id });
    }
    if (op.kind === "apply") {
      if (!family.grants.some(grant => grant.id === op.reviewId && grant.versionId === version.id && grant.candidateHash === version.candidateHash)) throw new Error("Review this exact version before Apply");
      // A later human decision cannot be bypassed by applying an older reviewed version.
      const head = family.versions.find(value => value.id === family.headVersionId)!;
      if (canonical(head.sticky) !== canonical(version.sticky)) throw new Error("Your pending decisions changed. Review the latest version before Apply.");
      const compiled = compilePictureProposal(base.current, version.model, version.sticky, base.options);
      if (!compiled.reduction || compiled.conflicts.length || version.conflicts.length || canonical(pictureAppearanceState(compiled.candidate)) !== canonical(version.pictures)) throw new Error("The reviewed candidate cannot be reproduced. Update and review again.");
      if (digest({ baseHash: base.baseHash, model: version.model, sticky: version.sticky, pictures: version.pictures, dependencies: version.dependencies }) !== version.candidateHash) throw new Error("The candidate fingerprint changed");
      const validate = (phase: "gate" | "precommit") => deps.validateDependencies({ store, productionId: command.productionId, current: base.current,
        candidate: compiled.candidate, candidateHash: version.candidateHash, expectedFence: version.dependencies, phase });
      await validate("gate");
      const finished = finishTrustedTimelineSteps(base.current, compiled.reduction, { label: version.summary, requestId: family.id });
      if (finished.kind === "unchanged") throw new Error("No changes to apply");
      family.status = "applied"; family.receipt = { versionId: version.id, candidateHash: version.candidateHash, resultRevision: finished.timeline.revision,
        historyEntryDigest: digest(finished.entry), appliedAt: store.now() };
      await store.commitUnserialised({ kind: "editor-picture-request", source: "apply", raiseSchemaVersion: EDITOR_APPEARANCE_SCHEMA_VERSION,
        validateBeforeCommit: () => validate("precommit"), files: [
          { path: pathFor(command.productionId), action: "replace", baseHash: base.baseHash, content: `${JSON.stringify(finished.timeline, null, 2)}\n` },
          requestFileInput(command.productionId, raw, replace(file, family)),
        ] }); return result("applied");
    }
    if (!family.grants.some(value => value.versionId === version.id && value.candidateHash === version.candidateHash) && op.kind !== "update") throw new Error("Review this version before adjusting it");
    if (op.kind !== "update" && family.headVersionId !== version.id) throw new Error("A newer version is ready. Review it before adjusting this arrangement.");
    const updateBase = op.kind === "update" ? family.versions.find(value => value.id === family.headVersionId)! : version;
    let sticky = [...updateBase.sticky], origin: PictureProposalVersion["origin"] = "adjustment", model = updateBase.model;
    if (op.kind === "edit") {
      sticky = pictureStickyEdits(op.commands, sticky, version.pictures, base.current);
      if (op.commands.some(value => value.kind === "picture-release")) origin = "release";
    } else if (op.kind === "keep") {
      sticky = keepPictureAppearance(base.current, op.clipId, sticky);
    } else if (op.kind === "history") {
      const stack = family[op.direction], target = stack.pop();
      const previous = family.versions.find(value => value.id === target);
      if (!previous) throw new Error(`No pending ${op.direction}`);
      family[op.direction === "undo" ? "redo" : "undo"].push(version.id); sticky = previous.sticky; model = previous.model; origin = "history";
    } else origin = "update";
    return async () => {
    const next = await makeVersion(store, command.productionId, family, model, sticky, origin, deps, base, updateBase);
    if (op.kind !== "update" && next.conflicts.length) throw new Error(next.conflicts.join("; "));
    if (op.kind !== "history") { family.undo.push(updateBase.id); family.redo = []; }
    family.versions.push(next); family.headVersionId = next.id;
    // Ordinary manual adjustments keep the user in their pending edit; release/update always
    // require a new explicit Review and never grant themselves application authority.
    let reviewId: string | undefined;
    const restoredRelease = next.sticky.some(row => row.commands.some(command => command.kind === "picture-release") && !version.sticky.some(before => canonical(before) === canonical(row)));
    if ((origin === "adjustment" || origin === "history") && !restoredRelease) { reviewId = command.requestId; family.grants = [...family.grants, { id: reviewId, versionId: next.id, candidateHash: next.candidateHash }].slice(-100); }
    await savePrepared(store, command.productionId, family, next, retained, deps);
    return result("updated", { ref: pictureVersionRef(family.id, next), ...(reviewId ? { reviewId } : {}) });
    };
  }); return typeof preparation === "function" ? await preparation() : preparation; } catch (error) { return { result: { ...response, outcome: "refused", reason: (error instanceof Error ? error.message : "Picture review failed").slice(0, 1000) } }; }
}
