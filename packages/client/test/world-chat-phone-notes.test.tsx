import assert from "node:assert/strict";
import { it } from "node:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { parseHTML } from "linkedom";
import { App } from "../src/App.js";
import { __applyEventForTest, __clearWorldChatHoldsForTest, __setBridgeForTest, __setStateForTest } from "../src/lib/store.js";
import { chatArtifactsFixture, CHAT_ID } from "./chat-artifacts-fixture.js";

const dom = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(dom.window, {
  matchMedia: (query: string) => ({ matches: query === "(max-width: 599px)", media: query, addEventListener() {}, removeEventListener() {} }),
  getComputedStyle: () => ({ direction: "ltr" }),
});
Object.assign(dom.HTMLElement.prototype, {
  scrollIntoView() {},
  showModal(this: HTMLElement) { this.setAttribute("open", ""); },
  close(this: HTMLElement) { this.removeAttribute("open"); },
});
Object.assign(globalThis, {
  window: dom.window, document: dom.document, HTMLElement: dom.HTMLElement, Node: dom.Node,
  IS_REACT_ACT_ENVIRONMENT: true,
  requestAnimationFrame: (cb: () => void) => setTimeout(cb, 0),
});

it("keeps empty phone notes out of the review while retaining final-point feedback", async () => {
  __clearWorldChatHoldsForTest();
  const state = chatArtifactsFixture(), points = state.worldChat!.points;
  state.worldChat!.points = [];
  const commands: string[] = [];
  __setBridgeForTest({ appVersion: "test", platform: "test", connect() {}, subscribe() {}, send: raw => { commands.push(raw); } });
  __setStateForTest(state);
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  const peek = () => document.querySelector<HTMLButtonElement>(".fy-thread-peek");
  const click = async (node: HTMLElement) => act(async () => node.click());
  try {
    await act(async () => root.render(<MemoryRouter initialEntries={[`/w/${state.world!.meta.worldId}/chat/${CHAT_ID}`]}><App /></MemoryRouter>));
    assert.equal(peek(), null);
    await act(async () => { state.worldChat!.points = points; __setStateForTest({ ...state }); });
    assert.match(peek()!.textContent!, /3 of 5 ready/);
    await click(peek()!);
    assert.match(document.querySelector(".fy-understood-sheet")!.textContent!, /Her aunt taught her the bells/);
    await click(document.querySelector<HTMLButtonElement>('.fy-understood-sheet button[aria-label="Close"]')!);
    await act(async () => {
      state.worldChat!.points = []; __setStateForTest({ ...state });
      __applyEventForTest({ type: "world-chat.ripples", at: "2026-10-21T02:00:00Z", worldId: state.world!.meta.worldId, conversationId: CHAT_ID,
        requestId: "final-point", items: [{ kind: "gains-cross-reference", summary: "The harbour record gains a cross-reference.", targets: ["CANON-018"] }] });
    });
    assert.match(peek()!.textContent!, /What changed elsewhere/);
    await click(peek()!);
    const sheet = document.querySelector(".fy-understood-sheet")!;
    assert.match(sheet.textContent!, /The harbour record gains a cross-reference/);
    await click([...sheet.querySelectorAll<HTMLButtonElement>("button")].find(b => b.textContent === "Dismiss")!);
    assert.equal(peek(), null, "dismissed news does not leave an empty overlay");
    await click(document.querySelector<HTMLButtonElement>('.fy-understood-sheet button[aria-label="Close"]')!);
    await act(async () => __applyEventForTest({ type: "world-chat.wrap-up-refused", at: "2026-10-21T02:00:01Z",
      conversationId: CHAT_ID, requestId: "final-point-refused", reason: "stale", detail: "The world changed; review the remaining notes." }));
    assert.match(peek()!.textContent!, /Review needed/);
    await click(peek()!);
    assert.match(document.querySelector(".fy-understood-sheet")!.textContent!, /The world changed; review the remaining notes/);
    assert.ok(!commands.some(raw => /conversation-action-decide|world-chat-wrap-up|world-chat-point/.test(raw)), "opening and dismissing notes cannot decide or write");
  } finally {
    await act(async () => root.unmount()); container.remove(); __setBridgeForTest(null); __clearWorldChatHoldsForTest();
  }
});
