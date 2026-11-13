import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { EFFECT_PROPOSAL_BOUNDS, defaultEffectClip, ProductionTimelineSchema, storyTimelineFingerprint,
  type EffectArrangementScope, type EffectVersionRef, type ModelEffectProposal } from "@arke-studio/contracts";
import { EditorRequestFileInvalid, readRequestFile, serialiseRequestFile } from "../../src/productions/editor-request-file.js";
import { stageEffectProposals, readEffectProposalFamilies, reviewEffectProposal, editEffectProposal, moveEffectProposalHistory,
  updateEffectProposal, retryEffectProposalDependencies, applyReviewedEffectVersion, discardEffectProposal,
  type EffectProposalSelection, type EffectRequestDependencies } from "../../src/productions/editor-effect-requests.js";
import { applyHumanTimelineCommand } from "../../src/productions/timeline.js";
import { stageEditorRequests, decideEditorRequest } from "../../src/productions/editor-requests.js";
import { readWorldMeta } from "../../src/world/scan.js";
import { CrashSignal } from "../../src/world/commit.js";
import { WorldStore } from "../../src/world/store.js";
import { makeTempWorld } from "../world/helpers.js";
import { closeOnCleanup } from "../tmp.js";

const PRODUCTION = "saltlight";
const NOW = "2026-10-11T18:00:00.000Z";
const CONVERSATION = "cv_01J8G0000000000000000000C1";
const HASH = "a".repeat(64);
const path = (store: WorldStore) => join(store.dir, "productions", PRODUCTION, "editor-requests.json");
const timelinePath = (store: WorldStore) => join(store.dir, "productions", PRODUCTION, "timeline.json");
const timeline = async (store: WorldStore) => ProductionTimelineSchema.parse(JSON.parse(await readFile(timelinePath(store), "utf8")));
const scope: EffectArrangementScope = { kind: "effects-only", target: { kind: "composition" }, range: { startFrame: 0, endFrame: 240 },
  audio: { kind: "off" }, direction: "Gentle dust", palette: [{ id: "dust", version: 1 }] };
const ref = ({ family, version }: EffectProposalSelection): EffectVersionRef => ({ familyId: family.id, versionId: version.id,
  candidateHash: version.candidateHash, decisionRevision: family.decisionRevision });
const model = (amount = 0.3): ModelEffectProposal => ({ summary: "Gentle dust", identities: [],
  commands: [{ kind: "effect-patch", clipId: "cl_dust", patch: { appearance: { amount } } }] });
function host() {
  const activity = { captures: 0, validations: [] as string[], issue: false, refuse: "", capture: undefined as undefined | (() => Promise<void>) };
  const dependencies: EffectRequestDependencies = {
    async captureDependencies(input) {
      activity.captures++; await activity.capture?.();
      return { schemaVersion: 1, base: { revision: input.candidate.revision, timelineHash: input.baseTimelineHash }, resolutionHash: HASH,
        profiles: { rendererVersion: "test-renderer", catalogueHash: HASH, analysisProfileId: "test-analysis" },
        sources: [], protection: [], reactions: [], issues: activity.issue ? [{ kind: "analysis", reason: "Audio analysis unavailable" }] : [] };
    },
    async validateDependencies(input) {
      activity.validations.push(`${input.phase}:${input.requireReady !== false ? "apply" : "prepare"}`);
      if (activity.refuse === input.phase) throw new Error(`Source changed at ${input.phase}`);
      if (input.requireReady !== false && input.expectedFence.issues.length) throw new Error(input.expectedFence.issues[0]!.reason);
    },
  };
  return { dependencies, activity };
}
async function withEffect() {
  const store = await open();
  const production = store.getBundle().productions.find(row => row.meta.id === PRODUCTION)!;
  const effect = defaultEffectClip({ id: "cl_dust", lineageId: "ef_dust", startFrame: 0, durationFrames: 240, seed: 7 });
  effect.appearance.amount = 0.6;
  await applyHumanTimelineCommand(store, PRODUCTION, { kind: "commands", baseRevision: null, sourceFingerprint: storyTimelineFingerprint(production),
    commands: [{ kind: "add-track", trackKind: "effect", trackId: "tr_fx", name: "Effects" },
      { kind: "effect-create", trackId: "tr_fx", effect }] });
  return store;
}
async function stage(store: WorldStore, dependencies: EffectRequestDependencies, proposals = [model()]) {
  return (await stageEffectProposals(store, { productionId: PRODUCTION, conversationId: CONVERSATION, scope, proposals, now: NOW }, dependencies))[0]!;
}
const amountOf = ({ version }: EffectProposalSelection) => version.state.tracks.flatMap(track => track.effects).find(effect => effect.id === "cl_dust")!.appearance.amount;
async function open() {
  const store = await WorldStore.open(await makeTempWorld(), { clock: () => NOW });
  closeOnCleanup(() => store.close()); return store;
}

describe("bounded effects request authority (SPEC-053 R-38)", () => {
  it("reads absent/v1 state without migration and preserves its exact raw CAS bytes", async () => {
    const store = await open();
    const absent = await readRequestFile(store, PRODUCTION);
    assert.deepEqual(absent, { raw: null, file: { schemaVersion: 1, requests: [] } });
    await assert.rejects(readFile(path(store)), { code: "ENOENT" });
    const raw = '{ "schemaVersion": 1, "requests": [] }\n';
    await writeFile(path(store), raw);
    assert.deepEqual(await readRequestFile(store, PRODUCTION), { raw, file: { schemaVersion: 1, requests: [] } });
    assert.equal(await readFile(path(store), "utf8"), raw);
    assert.equal(serialiseRequestFile(absent.file), '{\n  "schemaVersion": 1,\n  "requests": []\n}\n');
  });

  it("refuses invalid/future files rather than interpreting them as empty authority", async () => {
    const store = await open();
    for (const raw of ['{"schemaVersion":999,"requests":[]}', '{"schemaVersion":1,"requests":[],"unrecognized":true}', '{']) {
      await writeFile(path(store), raw);
      await assert.rejects(readRequestFile(store, PRODUCTION), EditorRequestFileInvalid);
      assert.equal(await readFile(path(store), "utf8"), raw);
    }
  });

  it("enforces the exact UTF-8 file bound before parsing without rewriting oversized work", async () => {
    const store = await open();
    const valid = '{"schemaVersion":1,"requests":[]}';
    const raw = valid + " ".repeat(EFFECT_PROPOSAL_BOUNDS.requestFileBytes + 1 - Buffer.byteLength(valid));
    await writeFile(path(store), raw);
    await assert.rejects(readRequestFile(store, PRODUCTION), error => error instanceof EditorRequestFileInvalid && /exceeds.*bytes/.test(error.reason));
    assert.equal((await readFile(path(store))).length, EFFECT_PROPOSAL_BOUNDS.requestFileBytes + 1);
  });
});

describe("durable effects proposal review (SPEC-053 R-26–38)", () => {
  it("requires explicit exact Review, applies one history entry, and retries its receipt after Undo and restart", async () => {
    const store = await withEffect(), { dependencies, activity } = host();
    const before = await readFile(timelinePath(store), "utf8");
    const selected = await stage(store, dependencies);
    assert.equal(selected.version.conflicts.length, 0);
    assert.equal(selected.family.reviewGrants.length, 0);
    assert.equal(await readFile(timelinePath(store), "utf8"), before);
    assert.equal((await readWorldMeta(store.dir)).schemaVersion, 75);
    const input = { productionId: PRODUCTION, familyId: selected.family.id, versionId: selected.version.id,
      candidateHash: selected.version.candidateHash, reviewId: "not-reviewed", requestId: "apply-one", now: NOW };
    await assert.rejects(applyReviewedEffectVersion(store, input, dependencies), /Review in timeline/);
    const review = await reviewEffectProposal(store, { productionId: PRODUCTION, ref: ref(selected), now: NOW });
    assert.equal(await readFile(timelinePath(store), "utf8"), before);
    const captures = activity.captures;
    const receipt = await applyReviewedEffectVersion(store, { ...input, reviewId: review.id }, dependencies);
    assert.equal(activity.captures, captures, "Apply validates frozen work without preparing native analysis");
    const applied = await timeline(store);
    assert.equal(applied.revision, 2); assert.equal(applied.history.undo.length, 2);
    assert.equal(applied.history.undo.at(-1)?.kind, "change");
    assert.equal(applied.tracks.find(track => track.id === "tr_fx")!.effects![0]!.appearance.amount, 0.3);
    await applyHumanTimelineCommand(store, PRODUCTION, { kind: "undo", baseRevision: 2 });
    assert.equal((await readEffectProposalFamilies(store, PRODUCTION))[0]!.receipt!.undoneAt, NOW);
    await store.close();
    const reopened = await WorldStore.open(store.dir, { clock: () => NOW }); closeOnCleanup(() => reopened.close());
    activity.refuse = "gate";
    const undone = await readFile(timelinePath(reopened), "utf8");
    const retried = await applyReviewedEffectVersion(reopened, { ...input, reviewId: review.id }, dependencies);
    assert.equal(retried.historyEntryDigest, receipt.historyEntryDigest); assert.equal(retried.undoneAt, NOW);
    assert.equal(await readFile(timelinePath(reopened), "utf8"), undone, "a receipt retry never reapplies an undone arrangement");
    await applyHumanTimelineCommand(reopened, PRODUCTION, { kind: "redo", baseRevision: 3 });
    assert.equal((await readEffectProposalFamilies(reopened, PRODUCTION))[0]!.receipt!.undoneAt, undefined);
    assert.equal((await timeline(reopened)).tracks.find(track => track.id === "tr_fx")!.effects![0]!.appearance.amount, 0.3);
  });

  it("continues only an explicit active human review and keeps manual values across model arrival and pending Undo/Redo", async () => {
    const store = await withEffect(), { dependencies } = host();
    const initial = await stage(store, dependencies), before = await readFile(timelinePath(store), "utf8");
    const grant = await reviewEffectProposal(store, { productionId: PRODUCTION, ref: ref(initial), now: NOW });
    const edited = await editEffectProposal(store, { productionId: PRODUCTION, ref: ref(initial), actionId: "manual-amount", now: NOW,
      reviewId: grant.id, intent: { kind: "adjust", commands: [{ kind: "effect-patch", clipId: "cl_dust", patch: { appearance: { amount: 0.75 } } }] } }, dependencies);
    assert.equal(amountOf(edited), 0.75);
    const continued = edited.family.reviewGrants.find(row => row.versionId === edited.version.id)!;
    assert.ok(continued);
    const revisedModel: ModelEffectProposal = { ...model(0.1), family: { id: edited.family.id, parentVersionId: edited.version.id, candidateHash: edited.version.candidateHash } };
    const arrived = await stage(store, dependencies, [revisedModel]);
    assert.equal(amountOf(arrived), 0.75, "manual adjustment overlays a later model's value");
    assert.notEqual(arrived.version.branchId, edited.version.branchId);
    assert.deepEqual(arrived.family.reviewGrants, edited.family.reviewGrants, "arrival cannot activate Suggested or transfer review");
    const undone = await moveEffectProposalHistory(store, { productionId: PRODUCTION, ref: ref({ family: arrived.family, version: edited.version }),
      actionId: "pending-undo", now: NOW, direction: "undo", reviewId: continued.id }, dependencies);
    assert.equal(amountOf(undone), 0.3);
    const redone = await moveEffectProposalHistory(store, { productionId: PRODUCTION, ref: ref(undone), actionId: "pending-redo", now: NOW, direction: "redo" }, dependencies);
    assert.equal(amountOf(redone), 0.75);
    assert.equal(await readFile(timelinePath(store), "utf8"), before, "pending edits and history never change Current");
    const old = { family: redone.family, version: initial.version };
    const inspection = await reviewEffectProposal(store, { productionId: PRODUCTION, ref: ref(old), now: NOW });
    await assert.rejects(applyReviewedEffectVersion(store, { productionId: PRODUCTION, familyId: old.family.id, versionId: old.version.id,
      candidateHash: old.version.candidateHash, reviewId: inspection.id, requestId: "old-apply", now: NOW }, dependencies), /Review in timeline/);
  });

  it("retains unavailable work and creates an unreviewed immutable readiness version on Retry", async () => {
    const store = await withEffect(), { dependencies, activity } = host(); activity.issue = true;
    const first = await stage(store, dependencies);
    assert.equal(first.version.dependencies.issues[0]!.kind, "analysis");
    const review = await reviewEffectProposal(store, { productionId: PRODUCTION, ref: ref(first), now: NOW });
    await assert.rejects(applyReviewedEffectVersion(store, { productionId: PRODUCTION, familyId: first.family.id, versionId: first.version.id,
      candidateHash: first.version.candidateHash, reviewId: review.id, requestId: "blocked-apply", now: NOW }, dependencies), /analysis unavailable/);
    activity.issue = false;
    const ready = await retryEffectProposalDependencies(store, { productionId: PRODUCTION, ref: ref(first), actionId: "retry-analysis", now: NOW }, dependencies);
    assert.notEqual(ready.version.id, first.version.id); assert.notEqual(ready.version.candidateHash, first.version.candidateHash);
    assert.deepEqual(ready.family.versions[0], first.version);
    assert.equal(ready.family.reviewGrants.some(row => row.versionId === ready.version.id), false);
    const repeated = await retryEffectProposalDependencies(store, { productionId: PRODUCTION, ref: ref(first), actionId: "retry-analysis", now: NOW }, dependencies);
    assert.equal(repeated.version.id, ready.version.id);
  });

  it("rolls back Apply when a frozen dependency changes after staging", async () => {
    const store = await withEffect(), { dependencies, activity } = host();
    const selected = await stage(store, dependencies);
    const review = await reviewEffectProposal(store, { productionId: PRODUCTION, ref: ref(selected), now: NOW });
    const before = await readFile(timelinePath(store), "utf8"), requests = await readFile(path(store), "utf8");
    activity.refuse = "precommit";
    await assert.rejects(applyReviewedEffectVersion(store, { productionId: PRODUCTION, familyId: selected.family.id, versionId: selected.version.id,
      candidateHash: selected.version.candidateHash, reviewId: review.id, requestId: "staging-race", now: NOW }, dependencies), /Source changed at precommit/);
    assert.equal(await readFile(timelinePath(store), "utf8"), before); assert.equal(await readFile(path(store), "utf8"), requests);
    assert.ok(activity.validations.includes("gate:apply") && activity.validations.includes("precommit:apply"));
  });

  it("rejects stale preparation, requires explicit Update, and preserves effects through generic request writes", async () => {
    const store = await withEffect(), { dependencies, activity } = host();
    const first = await stage(store, dependencies);
    const picture = (await timeline(store)).tracks.find(track => track.kind === "picture")!;
    const generic = await stageEditorRequests(store, { conversationId: CONVERSATION, entryContext: { kind: "production", productionId: PRODUCTION },
      requests: [{ summary: "Name pictures", commands: [{ kind: "set-track", trackId: picture.id, name: "Pictures renamed" }] }], now: NOW });
    assert.deepEqual((await readEffectProposalFamilies(store, PRODUCTION))[0], first.family);
    await decideEditorRequest(store, { productionId: PRODUCTION, requestId: generic[0]!.id, decision: "accept", now: NOW });
    assert.deepEqual((await readEffectProposalFamilies(store, PRODUCTION))[0], first.family);
    await assert.rejects(editEffectProposal(store, { productionId: PRODUCTION, ref: ref(first), actionId: "stale-edit", now: NOW,
      intent: { kind: "adjust", commands: model(0.8).commands } }, dependencies), /Current changed/);
    const updated = await updateEffectProposal(store, { productionId: PRODUCTION, ref: ref(first), actionId: "explicit-update", now: NOW }, dependencies);
    assert.equal(updated.version.origin, "update"); assert.equal(updated.family.reviewGrants.length, 0);
    assert.equal(updated.family.bases.length, 2); assert.equal((await readRequestFile(store, PRODUCTION)).file.requests[0]!.status, "accepted");
    const requests = await readFile(path(store), "utf8");
    activity.capture = async () => {
      activity.capture = undefined;
      await applyHumanTimelineCommand(store, PRODUCTION, { kind: "commands", baseRevision: (await timeline(store)).revision, sourceFingerprint: "",
        commands: [{ kind: "effect-patch", clipId: "cl_dust", patch: { appearance: { opacity: 0.8 } } }] });
    };
    await assert.rejects(editEffectProposal(store, { productionId: PRODUCTION, ref: ref(updated), actionId: "preparation-race", now: NOW,
      intent: { kind: "adjust", commands: model(0.8).commands } }, dependencies), /Current changed during preparation/);
    assert.equal(await readFile(path(store), "utf8"), requests);
  });

  it("recovers the exact model action version and rejects different intent under the same action", async () => {
    const store = await withEffect(), { dependencies, activity } = host();
    const input = { productionId: PRODUCTION, conversationId: CONVERSATION, actionId: "act_01J8G0000000000000000000A1" as const,
      scope, proposals: [model()], now: NOW };
    const first = (await stageEffectProposals(store, input, dependencies))[0]!;
    const captures = activity.captures;
    const repeated = (await stageEffectProposals(store, input, dependencies))[0]!;
    assert.equal(repeated.version.id, first.version.id); assert.equal(activity.captures, captures);
    assert.equal(repeated.version.actionId, input.actionId);
    await assert.rejects(stageEffectProposals(store, { ...input, proposals: [model(0.6)] }, dependencies), /already identifies/);
    const before = await readFile(timelinePath(store), "utf8");
    await discardEffectProposal(store, { productionId: PRODUCTION, ref: ref(first), now: NOW });
    assert.equal(await readFile(timelinePath(store), "utf8"), before);
    assert.equal((await readEffectProposalFamilies(store, PRODUCTION))[0]!.status, "discarded");
  });

  it("requires a named Release version to be reviewed, then restores its exact protection with ordinary Undo", async () => {
    const store = await withEffect(), { dependencies } = host();
    await applyHumanTimelineCommand(store, PRODUCTION, { kind: "commands", baseRevision: 1, sourceFingerprint: "", commands: [
      { kind: "effect-protect", rule: { id: "pr_amount", lineageId: "ef_dust", kind: "property", property: "appearance.amount", scope: { kind: "whole" } } },
    ] });
    const protectedTimeline = await timeline(store);
    const blocked = await stage(store, dependencies);
    assert.ok(blocked.version.conflicts.some(row => row.kind === "protection"), JSON.stringify(blocked.version.conflicts));
    const oldReview = await reviewEffectProposal(store, { productionId: PRODUCTION, ref: ref(blocked), now: NOW });
    const releaseInput = { productionId: PRODUCTION, ref: ref(blocked), actionId: "named-release", now: NOW,
      reviewId: oldReview.id, intent: { kind: "release" as const, ruleId: "pr_amount" } };
    const released = await editEffectProposal(store, releaseInput, dependencies);
    assert.equal(released.version.origin, "release"); assert.equal(released.version.conflicts.length, 0);
    assert.equal(released.version.state.protection.length, 0);
    assert.equal(released.family.reviewGrants.some(row => row.versionId === released.version.id), false, "Release never silently switches active review");
    assert.equal((await editEffectProposal(store, releaseInput, dependencies)).version.id, released.version.id, "Release retry resolves its inserted human step");
    const apply = { productionId: PRODUCTION, familyId: released.family.id, versionId: released.version.id,
      candidateHash: released.version.candidateHash, requestId: "apply-released", now: NOW };
    await assert.rejects(applyReviewedEffectVersion(store, { ...apply, reviewId: oldReview.id }, dependencies), /Review in timeline/);
    const reviewed = await reviewEffectProposal(store, { productionId: PRODUCTION, ref: ref(released), now: NOW });
    const receipt = await applyReviewedEffectVersion(store, { ...apply, reviewId: reviewed.id }, dependencies);
    assert.deepEqual(receipt.releasedRuleIds, ["pr_amount"]);
    assert.equal((await timeline(store)).revision, 3);
    await applyHumanTimelineCommand(store, PRODUCTION, { kind: "undo", baseRevision: 3 });
    assert.deepEqual((await timeline(store)).effectProtection, protectedTimeline.effectProtection);
    assert.deepEqual((await timeline(store)).tracks, protectedTimeline.tracks);
  });

  it("replays authority and rejects a tampered stored candidate instead of applying its effect snapshot", async () => {
    const store = await withEffect(), { dependencies } = host();
    const selected = await stage(store, dependencies);
    const review = await reviewEffectProposal(store, { productionId: PRODUCTION, ref: ref(selected), now: NOW });
    const saved = await readRequestFile(store, PRODUCTION); assert.equal(saved.file.schemaVersion, 2);
    if (saved.file.schemaVersion !== 2) throw new Error("fixture did not stage v2");
    saved.file.effectFamilies[0]!.versions[0]!.state.tracks[0]!.effects[0]!.appearance.amount = 0.99;
    await writeFile(path(store), serialiseRequestFile(saved.file));
    const before = await readFile(timelinePath(store), "utf8"), requests = await readFile(path(store), "utf8");
    await assert.rejects(applyReviewedEffectVersion(store, { productionId: PRODUCTION, familyId: selected.family.id, versionId: selected.version.id,
      candidateHash: selected.version.candidateHash, reviewId: review.id, requestId: "forged-snapshot", now: NOW }, dependencies), /does not match the frozen/);
    assert.equal(await readFile(timelinePath(store), "utf8"), before); assert.equal(await readFile(path(store), "utf8"), requests);
  });

  it("recovers timeline and receipt together after the committing marker without revalidating obsolete sources", async context => {
    const store = await withEffect(), { dependencies, activity } = host();
    const selected = await stage(store, dependencies);
    const review = await reviewEffectProposal(store, { productionId: PRODUCTION, ref: ref(selected), now: NOW });
    const commit = store.commitUnserialised.bind(store);
    context.mock.method(store, "commitUnserialised", (input: Parameters<WorldStore["commitUnserialised"]>[0]) => commit(input, {
      at(point) { if (input.kind === "editor-effect-apply" && point === "committing-marked") throw new CrashSignal(); },
    }));
    const input = { productionId: PRODUCTION, familyId: selected.family.id, versionId: selected.version.id,
      candidateHash: selected.version.candidateHash, reviewId: review.id, requestId: "crash-apply", now: NOW };
    await assert.rejects(applyReviewedEffectVersion(store, input, dependencies), CrashSignal);
    await store.close();
    activity.refuse = "gate";
    const checks = activity.validations.length;
    const recovered = await WorldStore.open(store.dir, { clock: () => NOW }); closeOnCleanup(() => recovered.close());
    const receipt = await applyReviewedEffectVersion(recovered, input, dependencies);
    assert.equal(receipt.resultRevision, 2); assert.equal((await timeline(recovered)).revision, 2);
    assert.equal((await timeline(recovered)).history.undo.length, 2);
    assert.equal((await readEffectProposalFamilies(recovered, PRODUCTION))[0]!.status, "applied");
    assert.equal(activity.validations.length, checks, "recovery completes the validated transaction, and retry reads its receipt");
  });

  it("reopens pending versions for read-only inspection without preparing or granting Review", async () => {
    const store = await withEffect(), { dependencies, activity } = host();
    const selected = await stage(store, dependencies);
    const raw = await readFile(path(store), "utf8"); await store.close();
    const readonly = await WorldStore.open(store.dir, { clock: () => NOW, readOnly: true }); closeOnCleanup(() => readonly.close());
    assert.deepEqual((await readEffectProposalFamilies(readonly, PRODUCTION))[0], selected.family);
    const captures = activity.captures;
    await assert.rejects(reviewEffectProposal(readonly, { productionId: PRODUCTION, ref: ref(selected), now: NOW }), /read.only/i);
    await assert.rejects(retryEffectProposalDependencies(readonly, { productionId: PRODUCTION, ref: ref(selected), actionId: "readonly-retry", now: NOW }, dependencies), /read.only/i);
    assert.equal(activity.captures, captures); assert.equal(await readFile(path(readonly), "utf8"), raw);
  });
});
