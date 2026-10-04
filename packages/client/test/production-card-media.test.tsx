import assert from "node:assert/strict";
import { it, afterEach } from "node:test";
import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { parseHTML } from "linkedom";
import { newId, ulid, type ConversationActionCard, type Job } from "@arke-studio/contracts";
import { generationCardView } from "../src/lib/generation-card-view.js";
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
