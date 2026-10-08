import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, it } from "node:test";
import { act, useEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { parseHTML } from "linkedom";
import { migrateLegacyScene, newId, orderedShots, type ConversationActionCard, type HumanDecisionCard, type WorldChatWorkspace } from "@arke-studio/contracts";
import { ProductionStudio } from "../src/components/production-studio.js";
import { StudioCard, StudioInlineContext, StudioSidebar, StudioToggle, useProductionStudio } from "../src/components/production-studio-context.js";
import { ConversationPermissionCard } from "../src/components/conversation.js";
import { HumanDecisionCardView } from "../src/components/human-decision-card.js";
import { studioActionFocus } from "../src/lib/production-studio.js";
import { __setBridgeForTest, __setStateForTest } from "../src/lib/store.js";
import type { ArkeBridge } from "../src/arke-bridge.js";
import { FIXTURE_STATE } from "./fixture-state.js";

const dom = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(dom.window, { innerWidth: 1200, innerHeight: 900, getComputedStyle: () => ({ direction: "ltr" }) });
Object.assign(dom.HTMLElement.prototype, { getBoundingClientRect: () => ({ left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0 }) });
Object.assign(globalThis, { window: dom.window, document: dom.document, HTMLElement: dom.HTMLElement, Node: dom.Node, Event: dom.Event,
  IS_REACT_ACT_ENVIRONMENT: true, requestAnimationFrame: (cb: () => void) => setTimeout(cb, 0), cancelAnimationFrame: clearTimeout });
const roots: Root[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await act(async () => root.unmount()); dom.document.body.innerHTML = ""; __setStateForTest(FIXTURE_STATE); });
const state = structuredClone(FIXTURE_STATE), world = state.world!, production = world.productions[0]!, scene = production.scenes[0]!;
const after = migrateLegacyScene({ id: scene.id, slug: scene.slug, number: scene.number, order: scene.order, title: "All forty shots", status: "draft", version: scene.version + 1,
  shots: Array.from({ length: 40 }, (_, i) => ({ id: `sh_review_${i}`, number: i + 1, title: `Picture ${i + 1}`, description: "A quiet room", durationSec: 4 })) });
function card(): ConversationActionCard {
  return { actionId: newId("act"), conversationId: newId("cv"), turnId: newId("turn"), worldId: world.meta.worldId, productionId: production.meta.id,
    actorId: "local-user", scope: "production", actionKind: "world-chat-production-scene-command", authorityKind: "scene-store", cardFamily: "command",
    targets: [{ kind: "scene", id: scene.id }], payloadDigest: "a".repeat(64), baseObservations: [], dependencies: [], createdAt: "2026-10-04T12:00:00Z",
    authority: { kind: "scene-store", id: scene.id }, authorityRevision: scene.version, previewDigest: "b".repeat(64),
    shown: { title: "Review forty shots", consequence: "Updates this scene", affectedTargets: [], ripples: [], permissionReason: "authored-change",
      body: { family: "command", commands: [{ label: "Edit shots" }], expectedResult: "Scene updated", undoAvailable: true }, productionPreview: { kind: "scene", before: scene, after } },
    status: "pending", preparedAt: "2026-10-04T12:00:00Z", availableDecisions: ["approve", "deny"] };
}
function workspace(actions: ConversationActionCard[]): WorldChatWorkspace {
  return { conversationId: actions[0]!.conversationId, status: "open", initiative: "collaborate", hasMore: false, runStatus: null,
    runStartedAt: null, retrievalUnavailable: false, attachments: [], seq: 1, actions, points: [], messages: [] };
}
let mounts = 0, unmounts = 0;
const decision: HumanDecisionCard = { id: "decision_probe", worldId: world.meta.worldId, conversationId: newId("cv"), title: "Staged scene", status: "pending",
  body: { family: "human-decision", reason: "Review this scene", control: { kind: "proposal", proposalId: newId("pr") } } };
function DecisionProbe() {
  const studio = useProductionStudio();
  useEffect(() => { mounts++; return () => { unmounts++; }; }, []);
  return <StudioCard id="decision_probe"><div><input aria-label="Unsaved review" defaultValue="Keep this draft" />
    <button onClick={() => studio?.showDecision(decision)}>Show review</button></div></StudioCard>;
}
function Thread({ action }: { action: ConversationActionCard }) {
  const [draft, setDraft] = useState("");
  return <aside className="fy-arke"><header className="fy-arke__head"><StudioToggle /></header><div className="fy-arke__log">
    <ConversationPermissionCard action={action} conversationSeq={1} /><DecisionProbe /></div>
    <StudioSidebar /><textarea aria-label="Unsent words" value={draft} onInput={e => setDraft(e.currentTarget.value)} /></aside>;
}
async function click(text: string) {
  const button = [...dom.document.querySelectorAll("button")].find(b => b.textContent === text);
  assert.ok(button, text); await act(async () => button.dispatchEvent(new dom.window.Event("click", { bubbles: true })));
}
async function setup(action = card(), docked = true) {
  const sent: unknown[] = [];
  __setBridgeForTest({ send: (message: unknown) => sent.push(message), connect() {} } as unknown as ArkeBridge); __setStateForTest(state);
  const container = dom.document.createElement("div"); dom.document.body.append(container);
  const root = createRoot(container); roots.push(root);
  let current = workspace([action]);
  const render = async () => act(async () => root.render(<MemoryRouter><ProductionStudio world={state.world} productionId={production.meta.id}
    entry={{ kind: "production", productionId: production.meta.id }} workspace={current} docked={docked}
    understanding={<input aria-label="Understanding note" defaultValue="Current notes" />} proposal={<input aria-label="Proposal draft" defaultValue="Staged work" />}>
    <Thread action={current.actions[0]!} /></ProductionStudio></MemoryRouter>));
  await render();
  return { action, sent, update: async (actions: ConversationActionCard[]) => { current = { ...current, actions }; await render(); } };
}

it("Show opens all forty pending shots without a decision and preserves the same conversation draft", async () => {
  const made = await setup();
  const input = dom.document.querySelector('[aria-label="Unsent words"]') as unknown as HTMLTextAreaElement;
  await act(async () => { input.value = "Still typing"; input.dispatchEvent(new dom.window.Event("input", { bubbles: true })); });
  await click("Show");
  assert.equal(dom.document.querySelectorAll('[data-pending-preview] [data-testid^="workspace-row-"]').length, 40);
  assert.equal(made.sent.length, 0, "Show grants no authority");
  assert.equal(dom.document.querySelector('[aria-label="Unsent words"]'), input);
  assert.equal(input.value, "Still typing");
  await click("Back to card"); await click("Close Studio");
  assert.equal(dom.document.querySelector('[aria-label="Unsent words"]'), input);
  assert.equal(input.value, "Still typing");
});

it("a full-size permission card and human review each move their one mounted instance", async () => {
  const beforeMounts = mounts, beforeUnmounts = unmounts, made = await setup();
  const article = dom.document.querySelector(`[data-action-id="${made.action.actionId}"]`);
  await click("Open full size");
  assert.equal(dom.document.querySelector('.fy-production-studio__full-card article'), article);
  assert.equal(dom.document.querySelectorAll(`[data-action-id="${made.action.actionId}"]`).length, 1);
  await click("Approve"); assert.equal(made.sent.length, 1);
  await click("Back to card"); await click("Show review");
  assert.equal(mounts - beforeMounts, 1); assert.equal(unmounts - beforeUnmounts, 0, "opening a host review cannot repeat its mount side effect");
  assert.equal(dom.document.querySelectorAll('[aria-label="Unsaved review"]').length, 1);
  assert.ok(dom.document.querySelector('.fy-production-studio__full-card [aria-label="Unsaved review"]'));
});

it("pinning holds a target as new cards arrive and settled previews return to live authoritative scenes", async () => {
  const made = await setup(); await click("Show"); await click("Pin canvas");
  const next = { ...card(), conversationId: made.action.conversationId, actionKind: "world-chat-production-metadata", targets: [{ kind: "production", id: production.meta.id }] };
  await made.update([made.action, next]);
  assert.ok(dom.document.querySelector('[data-pending-preview]'));
  assert.equal(dom.document.querySelectorAll('[data-pending-preview] [data-testid^="workspace-row-"]').length, 40);
  await made.update([{ ...made.action, status: "completed" }]);
  assert.equal(dom.document.querySelector('[data-pending-preview]'), null);
  assert.equal(dom.document.querySelectorAll('.fy-production-studio__canvas [data-testid^="workspace-row-"]').length, orderedShots(scene).length);
});

it("understanding and proposal tabs preserve their mounted controls", async () => {
  await setup(); const note = dom.document.querySelector('[aria-label="Understanding note"]'), proposal = dom.document.querySelector('[aria-label="Proposal draft"]');
  await click("Studio"); await click("What it understood"); assert.equal(dom.document.querySelector('[aria-label="Understanding note"]'), note);
  await click("Proposal"); assert.equal(dom.document.querySelector('[aria-label="Proposal draft"]'), proposal);
  await click("Close Studio"); assert.equal(dom.document.querySelector('[aria-label="Proposal draft"]'), proposal);
});

it("the proposal canvas opens the existing human card and returns to live state after settlement", async () => {
  __setStateForTest(state);
  const container = dom.document.createElement("div"); dom.document.body.append(container);
  const root = createRoot(container); roots.push(root);
  const action = card(); let decisions = [decision];
  const render = async () => act(async () => root.render(<MemoryRouter><ProductionStudio world={world} productionId={production.meta.id}
    entry={{ kind: "production", productionId: production.meta.id }} workspace={{ ...workspace([action]), humanDecisions: decisions }}
    docked={false} understanding={<p>Understanding</p>}><aside className="fy-arke"><StudioSidebar />
    {decisions.map(card => <HumanDecisionCardView key={card.id} card={card} />)}</aside></ProductionStudio></MemoryRouter>));
  await render(); const original = dom.document.querySelector('[data-decision="decision_probe"]');
  await click("Proposal"); await click("Staged scene · Open review");
  assert.equal(dom.document.querySelector('.fy-production-studio__full-card [data-decision]'), original);
  assert.equal(dom.document.querySelectorAll('[data-decision="decision_probe"]').length, 1);
  decisions = []; await render();
  assert.equal(dom.document.querySelector('.fy-production-studio__full-card')?.hasAttribute("hidden"), true);
  await click("Production"); assert.ok(dom.document.querySelector('[aria-label="Current production outline"]'));
});

it("a closed Studio draws no canvas, so a docked screen is never rendered twice", async () => {
  // Kept behind `hidden`, the canvas was a second copy of the screen under the dock: a Cut's clips
  // and a storyboard's rows answered twice, and a 200-shot scene paid for both.
  await setup();
  assert.equal(dom.document.querySelector(".fy-production-studio"), null);
  await click("Studio"); assert.ok(dom.document.querySelector(".fy-production-studio"));
  await click("Close Studio"); assert.equal(dom.document.querySelector(".fy-production-studio"), null);
});

it("a page's dock is its column, not a band under the page: only the production page's own Studio spans the grid", async () => {
  // Spanning every column, the owner of a chapter's dock dropped it under the chapter as a
  // full-width band and halved the chapter (0.5.68, 2026-10-08); the master draws the dock as the
  // 331 column at the right (126, 165k, 194c).
  const css = readFileSync(new URL("../src/components/production-studio.css", import.meta.url), "utf8");
  const rules = [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)].map(([, selector, body]) => ({ selector: selector!.trim(), body: body! }));
  const spanning = rules.filter((rule) => /grid-column:\s*1\s*\/\s*-1/.test(rule.body) && rule.selector.includes("fy-production-studio-owner"));
  assert.deepEqual(spanning.map((rule) => rule.selector), ['.fy-production-studio-owner[data-dock-owner="false"]']);
  // With the Studio closed the page's conversation is one row the page's height, so its thread
  // scrolls and the composer holds the foot: an auto row grew to the thread (9,544 on Saltlight),
  // the page clipped it, and the composer was out of reach (installed 0.5.72, design turn 202c).
  // A rule's comment rides in front of its selector here, so the selector is matched at its end.
  const inline = rules.find((rule) => rule.selector.endsWith('.fy-production-studio-owner[data-dock-owner="false"] .fy-production-studio-inline > div'));
  assert.match(inline?.body ?? "", /grid-template-rows:\s*minmax\(0,\s*1fr\)/);
  assert.ok(rules.some((rule) => rule.selector.includes(".fy-production-studio-inline :is(.fy-story__chat, .fy-story__log)") && /min-height:\s*0/.test(rule.body)));
  await setup();
  const owner = dom.document.querySelector(".fy-production-studio-owner")!;
  assert.equal(owner.getAttribute("data-dock-owner"), "true");
  assert.ok(owner.querySelector(".fy-production-studio-chat"), "the dock's mount is named for the page's dock rules");
});

it("opens on a staged proposal, the newest thing a wrap-up leaves", async () => {
  await setup(); await click("Studio");
  const view = (text: string) => [...dom.document.querySelectorAll('.fy-production-studio nav button')].find(b => b.textContent === text);
  assert.equal(view("Proposal")?.getAttribute("aria-pressed"), "true");
  assert.equal(view("What it understood")?.getAttribute("aria-pressed"), "false");
});

it("renders to a string beside a global document, its side holding what a closed Studio rests there", () => {
  // The string-rendering screen tests run with this linkedom document installed globally; a
  // portal host made because `document` existed sent a portal to the server renderer, which throws.
  const html = (proposal?: string) => renderToString(<MemoryRouter><ProductionStudio world={state.world} productionId={production.meta.id}
    entry={{ kind: "production", productionId: production.meta.id }} workspace={workspace([card()])} docked
    understanding={<p>Current notes</p>} {...(proposal ? { proposal: <p>{proposal}</p> } : {})}><aside><StudioSidebar /></aside></ProductionStudio></MemoryRouter>);
  assert.match(html(), /<aside><div><p>Current notes<\/p><\/div><\/aside>/);
  assert.doesNotMatch(html(), /class="fy-production-studio"/, "and no canvas behind it");
  assert.match(html("Staged work"), /<aside><div><p>Staged work<\/p><\/div><\/aside>/, "the understanding gives way to a decision");
});

// A phone Stage's Conversation press (R-68) lives in the shot page's head, as design 196q draws it,
// not on the dock's floating rail: scenes-layout.test.tsx drives it on the real page.

it("Stage, board, take and Cut targets choose their native canvas level", () => {
  const action = card();
  assert.equal(studioActionFocus({ ...action, actionKind: "world-chat-production-stage-playblast" }, production, { view: "production" }).view, "stage");
  assert.equal(studioActionFocus({ ...action, actionKind: "world-chat-production-board-compile" }, production, { view: "production" }).view, "board");
  assert.equal(studioActionFocus({ ...action, shown: { ...action.shown, productionPreview: undefined }, targets: [{ kind: "shot", id: orderedShots(scene)[0]!.id }] }, production, { view: "production" }).sceneId, scene.id);
  assert.equal(studioActionFocus({ ...action, actionKind: "world-chat-production-cut-export" }, production, { view: "production" }).view, "cut");
});

it("tells the shell while it is open inside the page, and drops Back to card until a card sent it (design turn 196o)", async () => {
  // On a Fold the shell folds its rail for an open Studio, so the canvas can take the rest of the
  // width; it can only do that if the Studio says so, and stops saying so when it closes.
  const reports: boolean[] = [];
  __setBridgeForTest({ send: () => {}, connect() {} } as unknown as ArkeBridge); __setStateForTest(state);
  const container = dom.document.createElement("div"); dom.document.body.append(container);
  const root = createRoot(container); roots.push(root);
  const action = card();
  await act(async () => root.render(<MemoryRouter><StudioInlineContext.Provider value={open => { reports.push(open); }}>
    <ProductionStudio world={state.world} productionId={production.meta.id} entry={{ kind: "production", productionId: production.meta.id }}
      workspace={workspace([action])} docked={false} understanding={<p>Notes</p>}><Thread action={action} /></ProductionStudio>
  </StudioInlineContext.Provider></MemoryRouter>));
  assert.equal(reports.at(-1), true, "an inline Studio opens, and says so");
  assert.equal(dom.document.querySelector(".fy-production-studio__back"), null, "no card sent the canvas here");
  assert.match(dom.document.querySelector(".fy-production-studio__breadcrumb")?.textContent ?? "", /› [A-Z]/, "the view by its name, not its id (it read › production)");
  await click("Show");
  assert.ok(dom.document.querySelector(".fy-production-studio__back"), "a card did, so it can be gone back to");
  await click("Close Studio");
  assert.equal(reports.at(-1), false, "closed, the rail is the person's again");
});
