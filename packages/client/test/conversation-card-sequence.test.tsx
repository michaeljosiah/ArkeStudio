import assert from "node:assert/strict";
import { afterEach, it } from "node:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { parseHTML } from "linkedom";
import { newId, type ConversationActionCard } from "@arke-studio/contracts";
import { ConversationPermissionCard } from "../src/components/conversation.js";
import { __applyEventForTest, __setBridgeForTest, __setStateForTest } from "../src/lib/store.js";
import type { ArkeBridge } from "../src/arke-bridge.js";
import { FIXTURE_STATE } from "./fixture-state.js";

/*
 * An Approve pressed as Arke's turn ends (0.5.134): the turn's completion lands just after its
 * card, so the press carries an older conversation position and is refused for that alone. The
 * card sends the same decision once more at the newer position, while it is still the card that
 * was pressed.
 */

const dom = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(dom.window, { innerWidth: 1200, innerHeight: 900, getComputedStyle: () => ({ direction: "ltr" }) });
Object.assign(globalThis, { window: dom.window, document: dom.document, HTMLElement: dom.HTMLElement, Node: dom.Node, Event: dom.Event,
  IS_REACT_ACT_ENVIRONMENT: true, requestAnimationFrame: (cb: () => void) => setTimeout(cb, 0), cancelAnimationFrame: clearTimeout });

const roots: Root[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await act(async () => root.unmount()); dom.document.body.innerHTML = ""; __setBridgeForTest(null); __setStateForTest(FIXTURE_STATE); });

const world = FIXTURE_STATE.world!, production = world.productions[0]!;
function card(): ConversationActionCard {
  return { actionId: newId("act"), conversationId: newId("cv"), turnId: newId("turn"), worldId: world.meta.worldId, productionId: production.meta.id,
    actorId: "local-user", scope: "production", actionKind: "world-chat-scene-edit", authorityKind: "scene-store", cardFamily: "command",
    targets: [], payloadDigest: "a".repeat(64), baseObservations: [], dependencies: [], createdAt: "2026-11-25T12:00:00Z",
    authority: { kind: "scene-store", id: "sc_01" }, authorityRevision: 1, previewDigest: "b".repeat(64),
    shown: { title: "Set the look", consequence: "Updates the production", affectedTargets: [], ripples: [], permissionReason: "authored-change",
      body: { family: "command", commands: [{ label: "Set the look" }], expectedResult: "Look set", undoAvailable: true } },
    status: "pending", preparedAt: "2026-11-25T12:00:00Z", availableDecisions: ["approve", "deny"] };
}

async function setup(action: ConversationActionCard) {
  const sent: Array<{ kind: string; expectedConversationSeq?: number; requestId?: string; decision?: string }> = [];
  __setBridgeForTest({ send: (json: string) => sent.push(JSON.parse(json)), connect() {} } as unknown as ArkeBridge);
  __setStateForTest(FIXTURE_STATE, { connection: "open" });
  const container = dom.document.createElement("div"); dom.document.body.append(container);
  const root = createRoot(container); roots.push(root);
  const render = (shown: ConversationActionCard, seq: number) => act(async () => root.render(<MemoryRouter><ConversationPermissionCard action={shown} conversationSeq={seq} /></MemoryRouter>));
  await render(action, 4);
  const answer = (requestId: string, disposition: "recorded" | "refused", reason?: string) => act(async () => __applyEventForTest({
    type: "conversation-action.decision-result", at: action.createdAt, worldId: action.worldId, conversationId: action.conversationId, actionId: action.actionId,
    requestId, decision: "approve", disposition, ...(reason ? { reason } : {}), status: "pending", deduplicated: false,
    ...(disposition === "refused" ? { detail: "The conversation changed. Review the latest card and try again." } : {}) } as never));
  return { sent, render, answer, container };
}
const approve = async () => {
  const button = [...dom.document.querySelectorAll("button")].find(b => b.textContent === "Approve");
  assert.ok(button, "Approve"); await act(async () => button.dispatchEvent(new dom.window.Event("click", { bubbles: true })));
};
const decisions = (sent: Array<{ kind: string }>) => sent.filter(message => message.kind === "conversation-action-decide") as unknown as Array<{ expectedConversationSeq: number; requestId: string; decision: string }>;

it("sends the same decision again at the newer position when only the position moved", async () => {
  const action = card();
  const { sent, render, answer, container } = await setup(action);
  await approve();
  const first = decisions(sent)[0]!;
  assert.equal(first.expectedConversationSeq, 4);
  await answer(first.requestId, "refused", "sequence-mismatch");
  assert.equal(decisions(sent).length, 1, "it waits for the newer conversation");
  assert.doesNotMatch(container.textContent ?? "", /conversation changed/, "and says nothing yet");
  await render(action, 6);
  const second = decisions(sent)[1]!;
  assert.deepEqual([second.expectedConversationSeq, second.decision], [6, "approve"]);
  await answer(second.requestId, "recorded");
  assert.match(container.textContent ?? "", /Set the look: approved\./);
});

it("does not send again when the card itself changed, and says so", async () => {
  const action = card();
  const { sent, render, answer, container } = await setup(action);
  await approve();
  await answer(decisions(sent)[0]!.requestId, "refused", "sequence-mismatch");
  await render({ ...action, shown: { ...action.shown, consequence: "Updates the production and its scenes" } }, 6);
  assert.equal(decisions(sent).length, 1);
  assert.match(container.textContent ?? "", /The conversation changed\. Review the latest card and try again\./);
});

it("tries again once only", async () => {
  const action = card();
  const { sent, render, answer, container } = await setup(action);
  await approve();
  await answer(decisions(sent)[0]!.requestId, "refused", "sequence-mismatch");
  await render(action, 6);
  await answer(decisions(sent)[1]!.requestId, "refused", "sequence-mismatch");
  await render(action, 8);
  assert.equal(decisions(sent).length, 2);
  assert.match(container.textContent ?? "", /The conversation changed\./);
});
