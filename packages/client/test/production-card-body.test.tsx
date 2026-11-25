import assert from "node:assert/strict";
import { it, afterEach } from "node:test";
import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { parseHTML } from "linkedom";
import { migrateLegacyScene, orderedShots, stageShot, newId, ulid, type ConversationActionCard } from "@arke-studio/contracts";
import { StagePlayblastReceipt } from "../src/components/production-stage-card.js";
import { ProductionCardBody } from "../src/components/production-card-body.js";
import { __setStateForTest } from "../src/lib/store.js";
import { approveConversationGroup, type GroupApprovalPort, type GroupApprovalSnapshot } from "../src/lib/conversation-group-approval.js";
import { FIXTURE_STATE } from "./fixture-state.js";
import { preloadScreens } from "../src/lib/preloadable.js";

// The Stage loads on demand (issue 2797); renderToString draws it once it has arrived.
await preloadScreens();

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

it("renders all forty shots as the review's shot list, with frozen script changes and removed ghosts", () => {
  __setStateForTest(state);
  const before = { ...scene, script: { blocks: [{ id: "blk_line", kind: "dialogue" as const, speaker: "maren-kest", text: "Before." }, { id: "blk_removed", kind: "action" as const, text: "Removed action." }] } };
  const after = { ...scene, script: { blocks: [{ id: "blk_line", kind: "dialogue" as const, speaker: "maren-kest", text: "After." }] } };
  const action = card();
  const { document } = parseHTML(renderToString(<MemoryRouter><ProductionCardBody action={action} preview={{ kind: "scene", before, after }} /></MemoryRouter>));
  assert.equal(document.querySelectorAll('[aria-label="Resulting shot list"] > li').length, 40);
  assert.equal(document.querySelectorAll('[data-testid^="workspace-row-"]').length, 0);
  assert.match(document.toString(), /Picture 40/);
  assert.equal(document.querySelector('[aria-label="Resulting screenplay"] [data-changed] del')?.textContent, "Before.");
  assert.equal(document.querySelector('[aria-label="Resulting screenplay"] [data-removed] del')?.textContent, "Removed action.");
});

it("shows the look a shot card puts each person in beside their name (issue 3178)", () => {
  const copy = structuredClone(state);
  copy.world!.referenceKits.find((kit) => kit.sheetId === "maren-kest")!.looks = [
    { id: "storm-oilskin", file: "looks/storm-oilskin.png", kind: "costume", name: "Storm oilskin", prompt: "Oilskin", acceptedAt: "2026-07-15T09:00:00Z" },
  ];
  __setStateForTest(copy);
  const after = migrateLegacyScene({ ...scene, shots: [
    { id: "sh_1", number: 1, title: "Dressed", description: "@maren-kest waits by the gate.", durationSec: 4, looks: [{ sheetId: "maren-kest", lookId: "storm-oilskin" }] },
    { id: "sh_2", number: 2, title: "Gone", description: "@maren-kest turns.", durationSec: 4, looks: [{ sheetId: "maren-kest", lookId: "gone" }] },
    { id: "sh_3", number: 3, title: "Plain", description: "@maren-kest leaves.", durationSec: 4 },
  ] });
  const { document } = parseHTML(renderToString(<MemoryRouter><ProductionCardBody action={card()} preview={{ kind: "scene", before: null, after }} /></MemoryRouter>));
  // The review's compact rows (issue 3145) say the cast on a line of its own, each person with their look.
  const cast = [...document.querySelectorAll('[aria-label="Resulting shot list"] > li')].map((li) => li.querySelector("[data-cast]")?.textContent);
  assert.deepEqual(cast, ["Maren Kest · Storm oilskin", "Maren Kest · look missing", "Maren Kest"]);
});

const few = (ids: number[]) => migrateLegacyScene({ id: "sc_review", slug: "review", number: 1, order: 1, title: "Review", status: "draft", version: 1,
  shots: ids.map((id, i) => ({ id: `sh_${id}`, number: i + 1, title: `Picture ${id}`, description: "Maren waits by the gate.", durationSec: 4 })) });
const rows = (document: Document, label: string) => [...document.querySelectorAll(`[aria-label="${label}"] > li`)].map(li => [li.getAttribute("value"), li.textContent]);
// A shot's row in the review: its head line, then cast and words on lines of their own.
const heads = (document: Document) => [...document.querySelectorAll('[aria-label="Resulting shot list"] > li')].map(li => [li.getAttribute("value"), li.querySelector("p")?.textContent]);

it("numbers a removed shot once, by the number it had (issue 3138)", () => {
  __setStateForTest(state);
  const { document } = parseHTML(renderToString(<MemoryRouter><ProductionCardBody action={card()} preview={{ kind: "scene", before: few([1, 2, 3, 4, 5]), after: few([1, 3, 4]) }} /></MemoryRouter>));
  assert.deepEqual(rows(document, "Removed shots"), [["2", "Picture 2 · Removed"], ["5", "Picture 5 · Removed"]]);
});

it("numbers the shot list once when the card's world is not the open one (issue 3138)", () => {
  __setStateForTest(state);
  const { document } = parseHTML(renderToString(<MemoryRouter><ProductionCardBody action={card({ worldId: ulid() })} preview={{ kind: "scene", before: few([1, 2]), after: few([2, 1]) }} /></MemoryRouter>));
  assert.deepEqual(heads(document), [["1", "Picture 2 · 4s · Moved ↑ 2 → 1"], ["2", "Picture 1 · 4s · Moved ↑ 1 → 2"]]);
  assert.deepEqual([...document.querySelectorAll('[aria-label="Resulting shot list"] > li > p:last-child')].map(p => p.textContent), ["Maren waits by the gate.", "Maren waits by the gate."]);
});

it("reads a storyboard card's shots as compact rows, with a picture only where one is filed (issue 3145)", () => {
  const copy = structuredClone(state), frame = "ar_01J8E0000000000000000000F1";
  copy.world!.artifacts.push({ id: frame, kind: "image", file: "phone-frame.png", hash: "sha256:0123456789abcdef", origin: { by: "user" }, links: [production.meta.id, "sh_1"], production: production.meta.id as never, created: "2026-11-15T12:00:00Z" });
  copy.world!.productions[0]!.selections.sh_1 = { trimInSec: 0, startFrameArtifactId: frame };
  __setStateForTest(copy);
  const head = { id: "sc_review", slug: "review", number: 1, order: 1, title: "Review", status: "draft" as const, version: 1 };
  const phone = { id: "sh_1", number: 1, title: "The phone lights", description: "@maren-kest reads the message.", durationSec: 4 };
  const before = migrateLegacyScene({ ...head, shots: [phone] });
  const after = migrateLegacyScene({ ...head, shots: [phone,
    { id: "sh_2", number: 2, title: "She runs", description: "@maren-kest runs for the door.", durationSec: 3, framing: { size: "WS", movement: "handheld" } },
    { id: "sh_3", number: 3, title: "The street", description: "Rain on an empty street.", durationSec: 5 }] });
  const { document } = parseHTML(renderToString(<MemoryRouter><ProductionCardBody action={card()} preview={{ kind: "scene", before, after }} /></MemoryRouter>));
  const shown = document.querySelector('[aria-label="Resulting scene"]')!;
  const items = [...shown.querySelectorAll('[aria-label="Resulting shot list"] > li')];
  assert.deepEqual(heads(document), [["1", "The phone lights · 4s"], ["2", "She runs · 3s · WS · handheld · Inserted"], ["3", "The street · 5s · Inserted"]]);
  assert.deepEqual(items.map(li => li.getAttribute("data-review-change")), [null, "inserted", "inserted"]);
  assert.deepEqual(items.map(li => li.querySelector("[data-cast]")?.textContent ?? null), ["Maren Kest", "Maren Kest", null]);
  // A mention reads as the name, never the sheet's id.
  assert.deepEqual(items.map(li => li.querySelector("p:last-child")?.textContent), ["Maren Kest reads the message.", "Maren Kest runs for the door.", "Rain on an empty street."]);
  assert.doesNotMatch(shown.textContent ?? "", /maren-kest|Needs frame|Spend unavailable|Reading history|16:9/);
  // The one picture is the frame the first shot already has; a new shot shows none and no placeholder.
  assert.deepEqual(items.map(li => li.querySelectorAll("img").length), [1, 0, 0]);
  assert.match(items[0]!.querySelector("img")!.getAttribute("src")!, /phone-frame\.png/);
  assert.equal(shown.querySelectorAll('[data-testid^="workspace-row-"], .fy-swrow__grip, .fy-swrow__frame, .fy-swrow__hatch, .fy-swchip').length, 0);
  assert.equal(shown.querySelectorAll("button").length, 0);
  // A board card is about its boards, and keeps the grid that draws them (SPEC-051 R-54).
  const board = parseHTML(renderToString(<MemoryRouter><ProductionCardBody action={card({ actionKind: "world-chat-production-board-compile" })} preview={{ kind: "scene", before, after }} /></MemoryRouter>)).document;
  assert.equal(board.querySelectorAll('[aria-label="Resulting board grid"] [data-testid^="workspace-row-"]').length, 3);
});

it("says No shots for an emptied scene and offers nothing to build it with (issue 3139)", () => {
  __setStateForTest(state);
  for (const before of [few([1, 2]), few([])]) {
    const { document } = parseHTML(renderToString(<MemoryRouter><ProductionCardBody action={card()} preview={{ kind: "scene", before, after: few([]) }} /></MemoryRouter>));
    const shown = document.querySelector('[aria-label="Resulting scene"]')!;
    assert.deepEqual([...shown.querySelectorAll(":scope > p")].map(p => p.textContent), ["No shots"]);
    assert.equal(shown.querySelector('[data-testid="workspace-empty"]'), null);
    assert.equal(shown.querySelectorAll("button").length, 0);
    assert.doesNotMatch(shown.textContent ?? "", /Build this scene|Talk to Arke|Add first shot|0 shots/);
    assert.equal(rows(document, "Removed shots").length, orderedShots(before).length);
  }
});

/**
 * A prepared scene says who a shot names with no picture going, before it is approved (issue
 * 3155). Six sections of a music video were approved with shots that named their people in plain
 * words, and every face in their frames was invented.
 */
it("flags a shot that names someone with a sheet without citing them, and not the scene's own place", () => {
  __setStateForTest(state);
  const after = migrateLegacyScene({ id: "sc_named", slug: "named", number: 2, order: 2, title: "Named", status: "draft", version: 1,
    inherits: { location: "the-vigil" },
    shots: [
      { id: "sh_plain", number: 1, title: "Plain", description: "Maren Kest grips the rail of The Vigil.", durationSec: 4 },
      { id: "sh_cited", number: 2, title: "Cited", description: "@maren-kest grips the rail of The Vigil.", durationSec: 4 },
    ] });
  const { document } = parseHTML(renderToString(<MemoryRouter><ProductionCardBody action={card()} preview={{ kind: "scene", before: null, after }} /></MemoryRouter>));
  // The review's compact rows carry no test id (issue 3145): a shot's row is found by its number.
  const unseen = (number: number) => [...document.querySelectorAll(`[aria-label="Resulting shot list"] > li[value="${number}"] .fy-production-preview__unseen`)].map(node => node.textContent);
  assert.deepEqual(unseen(1), ["Names Maren Kest · no picture"]);
  assert.deepEqual(unseen(2), [], "a cited person rides, and the scene's place rides whatever is said");
  // The words stay the row's last line, under the flag.
  assert.equal(document.querySelector('[aria-label="Resulting shot list"] > li[value="1"] > p:last-child')?.textContent, "Maren Kest grips the rail of The Vigil.");
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

it("sends again once at the newer position when the turn's summary moved the conversation on (0.5.141)", async () => {
  const first = card();
  const snapshot: GroupApprovalSnapshot = { worldId: world.meta.worldId, conversationId: first.conversationId, seq: 5, actions: [first] };
  const seqs: number[] = [];
  const answer = (requestId: string, refused: boolean) => ({ worldId: world.meta.worldId, conversationId: first.conversationId, actionId: first.actionId, requestId,
    ...(refused ? { disposition: "refused" as const, reason: "sequence-mismatch" as const, detail: "The conversation changed. Review the latest card and try again." }
      : { disposition: "recorded" as const, decision: "approve" as const, status: "approved" as const }), deduplicated: false });
  const result = await approveConversationGroup({ read: () => snapshot,
    decide: async (_action, seq, requestId) => { seqs.push(seq);
      // The server is already at 6: the summary written after the turn. The client hears of it a moment later.
      if (seq < 6) return answer(requestId, true);
      first.status = "approved"; return answer(requestId, false);
    },
    changed: async () => { if (snapshot.seq < 6) snapshot.seq = 6; else first.status = "completed"; } }, first.turnId, new AbortController().signal);
  assert.deepEqual(seqs, [5, 6]);
  assert.deepEqual(result, { approved: 1, left: 0, detail: "Eligible cards approved." });

  // Once only, and never for a card that changed meanwhile.
  const second = card(), moved: GroupApprovalSnapshot = { worldId: world.meta.worldId, conversationId: second.conversationId, seq: 5, actions: [second] };
  let sent = 0;
  const changed = await approveConversationGroup({ read: () => moved,
    decide: async (_action, _seq, requestId) => { sent++; return { ...answer(requestId, true), actionId: second.actionId, conversationId: second.conversationId }; },
    changed: async () => { moved.seq = 6; moved.actions = [{ ...second, previewDigest: "c".repeat(64) }]; } }, second.turnId, new AbortController().signal);
  assert.equal(sent, 1); assert.equal(changed.detail, "A card changed. Review the remaining cards.");
  const third = card(), still: GroupApprovalSnapshot = { worldId: world.meta.worldId, conversationId: third.conversationId, seq: 5, actions: [third] };
  sent = 0;
  const twice = await approveConversationGroup({ read: () => still,
    decide: async (_action, _seq, requestId) => { sent++; return { ...answer(requestId, true), actionId: third.actionId, conversationId: third.conversationId }; },
    changed: async () => { still.seq++; } }, third.turnId, new AbortController().signal);
  assert.equal(sent, 2); assert.equal(twice.left, 1); assert.match(twice.detail, /conversation changed/);
});

it("shows the frozen target Stage before host approval and only the correlated completed video", () => {
  const copy = structuredClone(state), shot = orderedStageShot();
  __setStateForTest(copy);
  const after = migrateLegacyScene({ ...scene, shots: [{ ...shot, staging: stageShot(shot, { cast: [], sets: [], durationSec: 4 }) }] });
  const action = card({ actionKind: "world-chat-production-stage-construct", targets: [{ kind: "shot", id: shot.id }] });
  const { document } = parseHTML(renderToString(<MemoryRouter><ProductionCardBody action={action} preview={{ kind: "scene", before: after, after }} /></MemoryRouter>));
  assert.equal(document.querySelectorAll('[data-testid="workspace-stage"]').length, 1);
  assert.match(document.toString(), /Stage review preview/);
  const id = newId("ar");
  copy.world!.artifacts.push({ id, kind: "video", file: "playblast.mp4", hash: "sha256:1234567890abcdef", origin: { by: "system", producedBy: `stage:${shot.id}` }, links: [production.meta.id, scene.id, shot.id], production: production.meta.id as never, created: "2026-10-04T12:00:00Z" });
  __setStateForTest(copy);
  const complete = { ...action, status: "completed" as const, receipt: { kind: "stage-playblast", id, summary: "Filed" } };
  const render = (value: ConversationActionCard) => parseHTML(renderToString(<MemoryRouter><StagePlayblastReceipt action={value} /></MemoryRouter>)).document;
  assert.equal(render(complete).querySelectorAll("video").length, 1);
  assert.ok(render(complete).querySelector('[aria-label^="Play Stage playblast"]'));
  assert.equal(render({ ...complete, receipt: { ...complete.receipt, id: newId("ar") } }).querySelector("video"), null);
  assert.equal(render({ ...complete, worldId: ulid() }).querySelector("video"), null);
});
function orderedStageShot() { return { id: "sh_stage", number: 1, title: "Stage shot", description: "A room", durationSec: 4 }; }
