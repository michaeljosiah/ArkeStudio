import assert from "node:assert/strict";
import { it, afterEach } from "node:test";
import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { parseHTML } from "linkedom";
import { newId, ulid, type ConversationActionCard, type Job } from "@arke-studio/contracts";
import { generationCardView } from "../src/lib/generation-card-view.js";
import { generationResultUses } from "../src/lib/generation-result-use.js";
import { GenerationReferences, GenerationResults } from "../src/components/generation-card-body.js";
import { TakeComparisonCard } from "../src/components/take-comparison-card.js";
import { __setStateForTest } from "../src/lib/store.js";
import { FIXTURE_STATE } from "./fixture-state.js";

afterEach(() => __setStateForTest(FIXTURE_STATE));
const state = structuredClone(FIXTURE_STATE), world = state.world!, production = world.productions[0]!;
const take = production.takes.find(t => t.kind === "clip")!;
function card(): ConversationActionCard {
  return { actionId: newId("act"), conversationId: newId("cv"), turnId: newId("turn"), worldId: world.meta.worldId,
    productionId: production.meta.id, actorId: "local-user", scope: "production", actionKind: "world-chat-production-take-generation",
    authorityKind: "job-queue", cardFamily: "generation", targets: [], payloadDigest: "a".repeat(64), baseObservations: [], dependencies: [],
    createdAt: "2026-10-04T12:00:00Z", authority: { kind: "job-queue", id: "quote" }, authorityRevision: 1, previewDigest: "b".repeat(64),
    shown: { title: "Generate", consequence: "Candidate", affectedTargets: [], ripples: [], permissionReason: "spend-and-compute",
      body: { family: "generation", medium: "video", purpose: "Shot", prompt: "The scene", references: [], provider: "fal", model: "test", quantity: 2, output: "Candidates", cost: "$1", cancellationSupported: true } },
    status: "running", preparedAt: "2026-10-04T12:00:00Z", availableDecisions: [],
    generationWork: { jobKeys: [ulid(), ulid()], media: [{ kind: "image", path: "references/maren-kest/main-photo-v1.png", alt: "Maren", role: "Identity" }] } };
}
function jobs(action: ConversationActionCard): Job[] {
  const base = state.app.jobs[0]!;
  return [{ ...base, id: take.jobId!, idempotencyKey: action.generationWork!.jobKeys[0]!, status: "succeeded", finalization: { status: "complete", error: null, updatedAt: base.updatedAt } },
    { ...base, id: newId("jb"), idempotencyKey: action.generationWork!.jobKeys[1]!, status: "running", step: { stage: "Sampling", done: 2, total: 5 } }];
}

it("folds only the sealed purchase, publishes a filed result during running work and reports known cost", () => {
  const action = card(), owned = jobs(action);
  const foreign = { ...owned[0]!, worldId: ulid() };
  const unrelated = { ...owned[0]!, idempotencyKey: ulid() };
  const view = generationCardView(action, world, [...owned, foreign, unrelated], state.app.ledger);
  assert.equal(view.authorized, 2); assert.equal(view.completed, 1); assert.equal(view.jobs.length, 2);
  assert.equal(view.results[0]!.id, take.id); assert.equal(view.results[0]!.shotIds[0], take.coversShots[0]);
  assert.equal(view.actualMicroUsd, null, "an in-flight item has no reported charge");
  owned[1]!.providerCostMicroUsd = 100;
  owned[0]!.providerCostMicroUsd = 200;
  assert.equal(generationCardView(action, world, owned).actualMicroUsd, 300);
  owned[0]!.finalization!.status = "pending";
  assert.equal(generationCardView(action, world, owned).results.length, 0, "provider success waits for local filing");
});

it("renders reference roles, native result controls and Select while the other item is in flight", () => {
  const action = card(); __setStateForTest({ ...state, app: { ...state.app, jobs: jobs(action) } });
  const { document } = parseHTML(renderToString(<MemoryRouter><GenerationReferences action={action} /><GenerationResults action={action} /></MemoryRouter>));
  assert.equal(document.querySelectorAll("video[controls]").length, 1);
  assert.match(document.toString(), /Identity|1 \/ 2 completed/); assert.match(document.toString(), /Sampling 2\/5/);
  assert.ok([...document.querySelectorAll("button")].some(button => button.textContent === "Select"));
  assert.ok([...document.querySelectorAll("button")].some(button => button.textContent === "Cancel"));
  assert.ok(document.querySelector('a[target="_blank"]'));
});

it("retains playable receipts after jobs disappear and compares the frozen current selection with the candidate", () => {
  const action = card(); action.status = "completed";
  action.receipt = { kind: "generation", id: action.actionId, summary: "Settled", generation: { authorized: 2, completed: 1, failed: 1, cancelled: 0, unattempted: 0, actualMicroUsd: 200,
    results: [{ id: take.id, medium: "video", status: "completed", description: "Candidate", mediaPath: `productions/${production.meta.id}/takes/${take.id}/clip.mp4` }, { id: newId("jb"), medium: "video", status: "failed", description: "Failed" }] } };
  const view = generationCardView(action, world, []);
  assert.equal(view.results[0]!.shotIds[0], take.coversShots[0]); assert.equal(view.actualMicroUsd, 200);
  action.shown.body = { family: "take-review", mediaKind: "video", mediaId: take.id, destination: "Shot", currentSelection: take.id };
  __setStateForTest(state);
  const { document } = parseHTML(renderToString(<MemoryRouter><TakeComparisonCard action={action} /></MemoryRouter>));
  assert.equal(document.querySelectorAll("video").length, 2);
  assert.match(document.toString(), /Current selection/); assert.match(document.toString(), /Candidate/);
});

it("renders finalized live audio and its references while other work runs, and requests voice use through the owning conversation", () => {
  const action = card(); action.actionKind = "world-chat-production-audio-generation";
  if (action.shown.body.family !== "generation") assert.fail("Expected generation");
  action.shown.body.medium = "audio";
  const copy = structuredClone(state), voice = { ...take, kind: "voice" as const, media: "speech.wav" };
  copy.world!.productions[0]!.takes = [voice]; copy.app.jobs = jobs(action);
  action.generationWork!.media = [{ kind: "audio", path: "references/maren-kest/voice/sample.wav", alt: "Maren", role: "Voice reference" }];
  action.generationWork!.results = [{ id: newId("jb"), medium: "audio", status: "completed", description: "Scene rehearsal", mediaPath: ".cache/table-reads/line.wav" }];
  __setStateForTest(copy);
  const view = generationCardView(action, copy.world!, copy.app.jobs);
  assert.equal(view.results.length, 2); assert.deepEqual(view.results[0]!.shotIds, [], "voice never becomes a picture Select gesture");
  const { document } = parseHTML(renderToString(<MemoryRouter><GenerationReferences action={action} /><GenerationResults action={action} /></MemoryRouter>));
  assert.equal(document.querySelectorAll("audio[controls]").length, 3);
  assert.match(document.toString(), /Dialogue cue/); assert.match(document.toString(), /Dialogue timing plan/);
  assert.equal([...document.querySelectorAll("button")].some(button => button.textContent === "Select"), false);
  const use = generationResultUses(action, view.results[0]!, copy.world!)[0]!;
  assert.match(use.request, new RegExp(voice.id)); assert.match(use.request, new RegExp(action.actionId));
  assert.match(use.request, /show the placement for review/); assert.equal(use.request.includes("speech.wav"), false, "intent names the authority's source, never a caller's filesystem path");
  assert.deepEqual(generationResultUses(action, { ...view.results[0]!, status: "failed" }, copy.world!), []);
  assert.deepEqual(generationCardView({ ...action, worldId: ulid() }, copy.world!, copy.app.jobs).results, []);
});

it("keeps non-shot Bench use in its existing approval workflow, including retained results", () => {
  const action = card(); action.actionKind = "world-chat-bench-generation"; action.authority = { kind: "bench", id: newId("sess") };
  const result = { id: newId("tk"), medium: "audio" as const, status: "completed" as const, description: "Music", mediaPath: ".sessions/bench/media/score.wav" };
  const use = generationResultUses(action, result, world)[0]!;
  assert.equal(use.label, "Audio cue"); assert.match(use.request, new RegExp(action.authority.id)); assert.match(use.request, new RegExp(result.id));
  const image = generationResultUses(action, { ...result, medium: "image" }, world)[0]!;
  assert.equal(image.label, "File result"); assert.match(image.request, /show the filing destination for review/);
  assert.deepEqual(generationResultUses({ ...action, status: "pending" }, result, world), []);
  assert.deepEqual(generationResultUses({ ...action, worldId: ulid() }, result, world), []);
});
