import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { MemoryRouter, Route, Routes } from "react-router";
import { defaultEffectClip, seedStoryPictureTimeline, type ClientMessage, type ClientState } from "@arke-studio/contracts";
import { __clearWorldChatHoldsForTest, __setBridgeForTest, __setStateForTest } from "../src/lib/store.js";
import { CutScreen } from "../src/screens/cut.js";
import { FIXTURE_STATE } from "./fixture-state.js";

const dom = parseHTML("<!doctype html><html><body></body></html>");
let compact = false;
Object.assign(dom.window, { innerWidth: 1400, innerHeight: 900,
  matchMedia: (query: string) => ({ matches: compact && query === "(max-width: 1099px)", media: query }) });
Object.assign(dom.HTMLElement.prototype, { focus() {}, scrollIntoView() {}, setPointerCapture() {}, releasePointerCapture() {},
  showModal(this: HTMLElement) { this.setAttribute("open", ""); }, close(this: HTMLElement) { this.removeAttribute("open"); } });
Object.defineProperty(dom.HTMLElement.prototype, "innerText", { configurable: true,
  get(this: HTMLElement) { return this.textContent ?? ""; }, set(this: HTMLElement, value: string) { this.textContent = value; } });
Object.assign(Object.getPrototypeOf(dom.document.createElement("video")), { pause() {}, play: () => Promise.resolve(), load() {} });
Object.assign(globalThis, { window: dom.window, document: dom.document, HTMLElement: dom.HTMLElement,
  HTMLMediaElement: dom.HTMLMediaElement, Element: dom.Element, Node: dom.Node, Event: dom.Event,
  IS_REACT_ACT_ENVIRONMENT: true, requestAnimationFrame: () => 1, cancelAnimationFrame() {} });
const CV = "cv_01J8F3K2QW9VZX4N7M0RTYB6HC";
const roots: Root[] = [];

afterEach(async () => {
  await act(async () => { for (const root of roots.splice(0)) root.unmount(); });
  __clearWorldChatHoldsForTest(); __setBridgeForTest(null); __setStateForTest(FIXTURE_STATE);
  document.body.replaceChildren(); compact = false;
});

function fixture(): ClientState {
  const state = structuredClone(FIXTURE_STATE) as ClientState, production = state.world!.productions[0]!;
  production.timeline = { status: "ready", timeline: seedStoryPictureTimeline(production) };
  state.app.health.harness = { status: "healthy" };
  state.world!.conversations = [{ id: CV, title: "Production conversation", status: "open", updatedAt: "2026-10-11T00:00:00Z",
    pointCount: 0, openProposalCount: 0, notCarried: [], entryContext: { kind: "cut", productionId: production.meta.id } }];
  state.worldChat = null;
  return state;
}
async function mount(state: ClientState, sent: ClientMessage[]) {
  __setBridgeForTest({ appVersion: "test", platform: "test", connect() {}, subscribe() {},
    send: json => sent.push(JSON.parse(json) as ClientMessage) });
  __setStateForTest(state);
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container); roots.push(root);
  await act(async () => root.render(<MemoryRouter initialEntries={[
    `/w/${state.world!.meta.worldId}/p/${state.world!.productions[0]!.meta.id}/cut`,
  ]}><Routes><Route path="/w/:worldId/p/:prodId/cut" element={<CutScreen />} /></Routes></MemoryRouter>));
  return container;
}
const button = (name: string) => {
  const found = [...document.querySelectorAll<HTMLButtonElement>("button")].find(node => node.textContent?.trim() === name);
  assert.ok(found, name); return found;
};
async function click(node: HTMLElement) { await act(async () => node.click()); }

test("ordinary Cut chat carries the selected authored effect without fabricating a review or sending a preparation request", async () => {
  const state = fixture(), sent: ClientMessage[] = [], production = state.world!.productions[0]!;
  assert.equal(production.timeline?.status, "ready");
  if (production.timeline?.status !== "ready") return;
  production.timeline.timeline.tracks.push({ id: "tr_fx", kind: "effect", name: "Effects", order: 10, muted: false, clips: [],
    effects: [defaultEffectClip({ id: "cl_dust", lineageId: "ef_dust", startFrame: 0, durationFrames: 240, seed: 7 })] });
  state.worldChat = { conversationId: CV as never, status: "open", initiative: "collaborate", hasMore: false, runStatus: null,
    runStartedAt: null, retrievalUnavailable: false, attachments: [], seq: 1, actions: [], messages: [], points: [] };
  const before = JSON.stringify(production.timeline), container = await mount(state, sent);
  const effect = container.querySelector<HTMLButtonElement>('[data-effect="cl_dust"]'); assert.ok(effect); await click(effect);
  const arke = container.querySelector<HTMLButtonElement>('#cut-arke-tab'); assert.ok(arke); await click(arke);
  assert.equal(sent.some(message => message.kind === "world-chat-send"), false);
  const composer = container.querySelector<HTMLElement>('[role="textbox"][aria-label="Ask Arke about this production…"]'); assert.ok(composer);
  await act(async () => {
    composer.textContent = "Make this effect more pronounced";
    composer.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const send = container.querySelector<HTMLButtonElement>('[aria-label="Send"]'); assert.ok(send); assert.equal(send.disabled, false); await click(send);
  const request = sent.find(message => message.kind === "world-chat-send"); assert.ok(request);
  assert.deepEqual(request.subject, { kind: "timeline-clip", clipId: "cl_dust" });
  assert.equal(container.querySelector('[aria-label="Effects arrangement review"]'), null);
  assert.equal(sent.some(message => message.kind === "timeline-command" || message.kind === "editor-effect-proposal"), false);
  assert.equal(JSON.stringify(production.timeline), before);
});

for (const width of [1400, 810]) for (const playing of [false, true]) {
  test(`preparing an arrangement keeps Current, selection, panels and ${playing ? "playing" : "paused"} transport at ${width}px`, async () => {
    compact = width < 1100; dom.window.innerWidth = width;
    const state = fixture(), sent: ClientMessage[] = [], authored = JSON.stringify(state.world!.productions[0]!.timeline);
    const container = await mount(state, sent);
    const selected = container.querySelector<HTMLButtonElement>('[data-clip="cl_sh-12"]'); assert.ok(selected);
    await click(selected);
    const playhead = container.querySelector<HTMLElement>('[aria-label="Playhead"]'); assert.ok(playhead);
    const seek = new Event("keydown", { bubbles: true, cancelable: true }); Object.assign(seek, { key: "ArrowRight" });
    await act(async () => { playhead.dispatchEvent(seek); });
    if (playing) { const play = container.querySelector<HTMLButtonElement>('[aria-label="Play"]'); assert.ok(play); await click(play); }
    if (compact) await click(button("Library"));
    await click(button("Effects")); await click(button("Suggest arrangement"));

    const snapshot = () => ({
      playhead: container.querySelector('[aria-label="Playhead"]')!.getAttribute("aria-valuenow"),
      playing: !!container.querySelector('[aria-label="Pause"]'),
      selected: container.querySelector('[data-clip][aria-pressed="true"]')?.getAttribute("data-clip"),
      detailTab: container.querySelector('#cut-inspector-tab')?.getAttribute("aria-selected"),
      details: container.querySelector('#cut-right-pane')?.getAttribute("data-open"),
      arkeSheet: document.querySelector('.fy-cut-arke-sheet')?.hasAttribute("open"),
      review: container.querySelector('[aria-label="Effects arrangement review"]') !== null,
    });
    const before = snapshot();
    assert.ok(Number(before.playhead) > 0); assert.equal(before.playing, playing);
    assert.equal(before.selected, "cl_sh-12"); assert.equal(before.arkeSheet, false); assert.equal(before.review, false);
    const form = document.querySelector('.fx-arrangement'); assert.ok(form);
    await act(async () => { form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
    assert.equal(document.querySelector('.fx-arrangement'), null, "Prepare closes only its own dialog");
    assert.deepEqual(snapshot(), before, "preparation cannot choose another panel or move the transport");
    assert.equal(sent.filter(message => message.kind === "world-chat-send").length, 0, "the request waits for its existing conversation");

    // The closed compact sheet keeps the real ProductionConversation mounted. Once its load
    // arrives, the ordinary DockAsk queue must dispatch without first showing the conversation.
    const ready = structuredClone(state);
    ready.worldChat = { conversationId: CV as never, status: "open", initiative: "collaborate", hasMore: false, runStatus: null,
      runStartedAt: null, retrievalUnavailable: false, attachments: [], seq: 1, actions: [], messages: [], points: [] };
    await act(async () => __setStateForTest(ready));
    const requests = sent.filter(message => message.kind === "world-chat-send");
    assert.equal(requests.length, 1, "the hidden conversation sends the queued request exactly once");
    const request = requests[0]!; assert.equal(request.kind, "world-chat-send");
    if (request.kind !== "world-chat-send") return;
    assert.equal(request.conversationId, CV); assert.equal(request.subject?.kind, "effect-arrangement");
    if (request.subject?.kind === "effect-arrangement") {
      assert.deepEqual(request.subject.scope.target, { kind: "composition" });
      assert.deepEqual(request.subject.scope.audio, { kind: "off" });
      assert.ok(request.subject.scope.range.endFrame > request.subject.scope.range.startFrame);
    }
    assert.deepEqual(snapshot(), before, "dispatch does not activate Suggested or reveal Arke");
    assert.equal(sent.some(message => message.kind === "timeline-command" || message.kind === "timeline-history"), false);
    assert.equal(JSON.stringify(ready.world!.productions[0]!.timeline), authored);
  });
}
