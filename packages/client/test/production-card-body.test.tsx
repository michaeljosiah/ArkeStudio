import assert from "node:assert/strict";
import { it, afterEach } from "node:test";
import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { parseHTML } from "linkedom";
import { migrateLegacyScene, newId, ulid, type ConversationActionCard } from "@arke-studio/contracts";
import { ProductionCardBody } from "../src/components/production-card-body.js";
import { __setStateForTest } from "../src/lib/store.js";
import { approveConversationGroup, type GroupApprovalPort, type GroupApprovalSnapshot } from "../src/lib/conversation-group-approval.js";
import { FIXTURE_STATE } from "./fixture-state.js";

const state = structuredClone(FIXTURE_STATE), world = state.world!, production = world.productions[0]!;
const scene = migrateLegacyScene({ id: "sc_review", slug: "review", number: 1, order: 1, title: "Review", status: "draft", version: 1,
  shots: Array.from({ length: 40 }, (_, i) => ({ id: `sh_${i + 1}`, number: i + 1, title: `Picture ${i + 1}`, description: "Maren waits by the gate.", durationSec: 4 })) });
function card(patch: Partial<ConversationActionCard> = {}): ConversationActionCard {
  return { actionId: newId("act"), conversationId: newId("cv"), turnId: newId("turn"), worldId: world.meta.worldId,
    productionId: production.meta.id, actorId: "local-user", scope: "world", actionKind: "world-chat-production-scene-command",
    authorityKind: "scene-store", cardFamily: "command", targets: [{ kind: "scene", id: scene.id }], payloadDigest: "a".repeat(64),
    baseObservations: [], dependencies: [], createdAt: "2026-10-04T12:00:00Z", authority: { kind: "scene-store", id: "scene" }, authorityRevision: 1,
    previewDigest: "b".repeat(64), shown: { title: "Review scene", consequence: "Edit scene", affectedTargets: [{ kind: "scene", id: scene.id }],
      ripples: [], permissionReason: "authored-change", body: { family: "command", commands: [{ label: "Edit" }], expectedResult: "Scene updated", undoAvailable: true },
      productionPreview: { kind: "scene", before: null, after: scene } }, status: "pending", preparedAt: "2026-10-04T12:00:00Z", availableDecisions: ["approve", "deny"], ...patch };
}
afterEach(() => __setStateForTest(FIXTURE_STATE));

it("renders all forty shots through the native rows, with frozen script changes and removed ghosts", () => {
  __setStateForTest(state);
  const before = { ...scene, script: { blocks: [{ id: "blk_line", kind: "dialogue" as const, speaker: "maren-kest", text: "Before." }, { id: "blk_removed", kind: "action" as const, text: "Removed action." }] } };
  const after = { ...scene, script: { blocks: [{ id: "blk_line", kind: "dialogue" as const, speaker: "maren-kest", text: "After." }] } };
  const action = card();
  const { document } = parseHTML(renderToString(<MemoryRouter><ProductionCardBody action={action} preview={{ kind: "scene", before, after }} /></MemoryRouter>));
  assert.equal(document.querySelectorAll('[data-testid^="workspace-row-"]').length, 40);
  assert.match(document.toString(), /Picture 40/);
  assert.equal(document.querySelector('[aria-label="Resulting screenplay"] [data-changed] del')?.textContent, "Before.");
  assert.equal(document.querySelector('[aria-label="Resulting screenplay"] [data-removed] del')?.textContent, "Removed action.");
});

it("deduplicates a group gesture, waits for completion and leaves generation for an individual decision", async () => {
  const first = card(), second = card({ turnId: first.turnId, conversationId: first.conversationId, dependencies: [first.actionId] });
  const generation = card({ turnId: first.turnId, conversationId: first.conversationId, actionKind: "world-chat-production-take-generation", cardFamily: "generation" });
  const snapshot: GroupApprovalSnapshot = { worldId: world.meta.worldId, conversationId: first.conversationId, seq: 1, actions: [second, generation, first] };
  const sent: string[] = [], requests: string[] = [];
  let finish: (() => void) | undefined;
  const port: GroupApprovalPort = { read: () => snapshot,
    decide: async (action, seq, requestId) => {
      assert.equal(seq, snapshot.seq); sent.push(action.actionId); requests.push(requestId);
      action = snapshot.actions.find(one => one.actionId === action.actionId)!;
      action.status = "approved"; snapshot.seq++;
      return { worldId: world.meta.worldId, conversationId: first.conversationId, actionId: action.actionId, requestId, disposition: "recorded", decision: "approve", status: "approved", deduplicated: false };
    }, changed: async () => { const pending = snapshot.actions.find(one => one.status === "approved")!;
      if (pending === first) await new Promise<void>(resolve => { finish = resolve; });
      pending.status = "completed"; snapshot.seq++;
    } };
  const abort = new AbortController();
  const work = approveConversationGroup(port, first.turnId, abort.signal);
  assert.equal(approveConversationGroup(port, first.turnId, abort.signal), work);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(sent, [first.actionId]); finish!();
  assert.deepEqual(await work, { approved: 2, left: 0, detail: "Eligible cards approved." });
  assert.deepEqual(sent, [first.actionId, second.actionId]); assert.equal(new Set(requests).size, 2); assert.equal(generation.status, "pending");
});

it("stops at refusal and retains every later pending card", async () => {
  const first = card(), second = card({ turnId: first.turnId, conversationId: first.conversationId });
  let sent = 0;
  const result = await approveConversationGroup({ read: () => ({ worldId: world.meta.worldId, conversationId: first.conversationId, seq: 1, actions: [first, second] }),
    decide: async action => { sent++; return { worldId: world.meta.worldId, conversationId: first.conversationId, actionId: action.actionId, requestId: ulid(), disposition: "refused", reason: "stale", detail: "Stale", deduplicated: false }; }, changed: async () => {} }, first.turnId, new AbortController().signal);
  assert.equal(sent, 1); assert.equal(result.left, 2); assert.equal(second.status, "pending");
});
