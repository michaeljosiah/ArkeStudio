import assert from "node:assert/strict";
import { it } from "node:test";
import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { parseHTML } from "linkedom";
import { newId, WorldChatWorkspaceSchema } from "@arke-studio/contracts";
import { ConversationTranscript } from "../src/components/conversation.js";
import { __setStateForTest } from "../src/lib/store.js";
import { FIXTURE_STATE } from "./fixture-state.js";

it("shows saved replies with non-actionable preparation placeholders (#2802)", () => {
  __setStateForTest(FIXTURE_STATE);
  const workspace = WorldChatWorkspaceSchema.parse({ conversationId: newId("cv"), status: "open", points: [], messages: [{
    id: newId("msg"), turnId: newId("turn"), role: "studio", text: "A tighter opening.", receipts: [], createdAt: "2026-11-13T12:00:00Z",
    preparingActions: [{ actionId: newId("act"), title: "Revise the opening" }],
  }] });
  const render = () => parseHTML(renderToString(<MemoryRouter><ConversationTranscript workspace={workspace} running={false} progress={null} failure={null} canRetry={false} /></MemoryRouter>)).document;
  const card = render().querySelector('[aria-label="Revise the opening, Preparing"]')!;
  assert.ok(card); assert.match(card.textContent!, /ready to review/);
  assert.ok(card.querySelector("button")!.hasAttribute("disabled"));
  assert.doesNotMatch(card.textContent!, /Approve|Accept|Completed/);
  delete workspace.messages[0]!.preparingActions;
  workspace.messages[0]!.refusals = ["The source changed."];
  const next = render();
  assert.equal(next.querySelector('[aria-label="Revise the opening, Preparing"]'), null);
  assert.match(next.toString(), /A tighter opening/); assert.match(next.toString(), /The source changed/);
});
