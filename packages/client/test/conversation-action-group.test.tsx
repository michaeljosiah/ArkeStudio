import assert from "node:assert/strict";
import { afterEach, it } from "node:test";
import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { parseHTML } from "linkedom";
import { CARD_WAITS_ON_EARLIER_CARD, newId, type ConversationActionCard } from "@arke-studio/contracts";
import { ConversationActionGroup } from "../src/components/conversation-action-group.js";
import { ConversationPermissionCard } from "../src/components/conversation.js";
import { __setStateForTest } from "../src/lib/store.js";
import { FIXTURE_STATE } from "./fixture-state.js";

afterEach(() => __setStateForTest(FIXTURE_STATE));
const world = FIXTURE_STATE.world!, production = world.productions[0]!;
const turnId = newId("turn"), conversationId = newId("cv");
/** A song card, as the chain in issue 3143 was made of: it draws no preview, only its lines. */
function card(title: string, after: readonly ConversationActionCard[] = [], patch: Partial<ConversationActionCard> = {}): ConversationActionCard {
  return { actionId: newId("act"), conversationId, turnId, worldId: world.meta.worldId, productionId: production.meta.id,
    actorId: "local-user", scope: "production", actionKind: "world-chat-audio-spine-command", authorityKind: "production-store", cardFamily: "command",
    targets: [], payloadDigest: "a".repeat(64), baseObservations: [], dependencies: after.map(one => one.actionId), createdAt: "2026-11-15T05:16:00Z",
    authority: { kind: "production-store", id: production.meta.id }, authorityRevision: 1, previewDigest: "b".repeat(64),
    shown: { title, consequence: "Changes where shots sit in the song.", affectedTargets: [], ripples: [], permissionReason: "authored-change",
      body: { family: "command", commands: [{ label: "Unpin" }], expectedResult: "The song keeps its sections.", undoAvailable: true } },
    status: "pending", preparedAt: "2026-11-15T05:16:00Z",
    ...(after.length ? { availableDecisions: ["deny"], blockedReason: CARD_WAITS_ON_EARLIER_CARD } : { availableDecisions: ["approve", "deny"] }), ...patch };
}
/** Each row of the list as a person reads it: what the row holds, the card's title, and its notices. */
function rows(actions: readonly ConversationActionCard[], known?: readonly ConversationActionCard[]) {
  __setStateForTest(FIXTURE_STATE);
  const html = renderToString(<MemoryRouter><ConversationActionGroup actions={actions} conversationSeq={1} {...(known ? { known } : {})} /></MemoryRouter>);
  const { document } = parseHTML(html);
  return { html, rows: [...document.querySelectorAll(".fy-actiongroup__sequence > li")].map(li => ({
    holds: [...li.children].map(child => child.className),
    title: li.querySelector("h3")?.textContent,
    notices: [...li.querySelectorAll(".fy-actioncard__notice")].map(line => line.textContent),
  })) };
}

it("leaves the list's number to the card's title and says what a card waits for inside it (issue 3143)", () => {
  const one = card("Unpin shot 1"), two = card("Unpin shot 2", [one]), three = card("Unpin shot 3", [two]), four = card("Unpin shot 4", [three]);
  const edit = card("Edit Intro: the lagoon", [one, two, three, four]);
  const shown = rows([edit, three, one, four, two]);
  assert.deepEqual(shown.rows, [
    { holds: ["fy-actioncard"], title: "Unpin shot 1", notices: [] },
    { holds: ["fy-actioncard"], title: "Unpin shot 2", notices: ["After 1"] },
    { holds: ["fy-actioncard"], title: "Unpin shot 3", notices: ["After 2"] },
    { holds: ["fy-actioncard"], title: "Unpin shot 4", notices: ["After 3"] },
    { holds: ["fy-actioncard"], title: "Edit Intro: the lagoon", notices: ["After 1 to 4"] },
  ]);
  assert.doesNotMatch(shown.html, /Requires|Waiting for the card before it/);
});

it("still says so once the cards have run", () => {
  const ran = ({ blockedReason: _waited, ...action }: ConversationActionCard): ConversationActionCard => ({ ...action, status: "completed", availableDecisions: [] });
  const one = ran(card("Unpin shot 1")), two = ran(card("Unpin shot 2", [one]));
  assert.deepEqual(rows([one, two]).rows.map(row => row.notices), [[], ["After 1"]]);
});

it("folds three or more neighbours into a range and keeps two apart", () => {
  const one = card("One"), two = card("Two"), three = card("Three", [two, one]), four = card("Four"), five = card("Five");
  const six = card("Six", [five, one, three, two, one]);
  assert.deepEqual(rows([one, two, three, four, five, six]).rows.map(row => row.notices), [[], [], ["After 1, 2"], [], [], ["After 1 to 3, 5"]]);
});

it("keeps a reason the numbers do not give", () => {
  const one = card("Unpin shot 1", [], { status: "denied", availableDecisions: [] });
  const two = card("Unpin shot 2", [one], { blockedReason: "The card this waits on was denied." });
  assert.deepEqual(rows([one, two]).rows[1]!.notices, ["After 1", "The card this waits on was denied."]);
});

it("names a card the list leaves out by its title, and never by its id", () => {
  const pin = card("Pin the chorus", [], { status: "completed", availableDecisions: [] }), unpin = card("Unpin shot 2");
  const edit = card("Edit Intro: the lagoon", [pin, unpin]);
  // Earlier actions keeps what is unsettled: the completed card is in the conversation, not in the list.
  assert.deepEqual(rows([unpin, edit], [pin, unpin, edit]).rows.map(row => row.notices), [[], ["After 1 · Pin the chorus"]]);
  assert.deepEqual(rows([edit], [pin, unpin, edit]).rows[0]!.notices, ["After Pin the chorus · Unpin shot 2"]);
  const one = card("Unpin shot 1");
  const lost = card("Edit Intro: the lagoon", [one], { blockedReason: "A required action is no longer available." });
  const alone = rows([lost]);
  assert.deepEqual(alone.rows[0]!.notices, ["A required action is no longer available."]);
  assert.equal(alone.html.includes(one.actionId), false);
});

it("keeps the coordinator's sentence on a card drawn outside a list", () => {
  __setStateForTest(FIXTURE_STATE);
  const waiting = card("Unpin shot 2", [card("Unpin shot 1")]);
  const { document } = parseHTML(renderToString(<MemoryRouter><ConversationPermissionCard action={waiting} conversationSeq={1} /></MemoryRouter>));
  assert.deepEqual([...document.querySelectorAll(".fy-actioncard__notice")].map(line => line.textContent), ["Waiting for the card before it."]);
});
