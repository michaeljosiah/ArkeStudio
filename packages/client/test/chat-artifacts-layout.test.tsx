import assert from "node:assert/strict";
import { afterEach, it } from "node:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router";
import { parseHTML } from "linkedom";
import type { ClientMessage } from "@arke-studio/contracts";
import type { ArkeBridge } from "../src/arke-bridge.js";
import { ArtifactsScreen } from "../src/screens/world.js";
import { WorldChatScreen } from "../src/screens/world-chat.js";
import { __connectionStatusForTest, __setBridgeForTest, __setStateForTest } from "../src/lib/store.js";
import { CHAT_ID, chatArtifactsFixture } from "./chat-artifacts-fixture.js";

const dom = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(dom.window, {
  innerWidth: 390, innerHeight: 797,
  matchMedia: (query: string) => ({ matches: !query.includes("min-width") && query.includes("max-width"), addEventListener() {}, removeEventListener() {} }),
  getComputedStyle: () => ({ direction: "ltr" }),
});
Object.assign(dom.HTMLElement.prototype, {
  focus() {}, scrollIntoView() {},
  showModal(this: HTMLElement) { this.setAttribute("open", ""); },
  close(this: HTMLElement) { this.removeAttribute("open"); this.dispatchEvent(new dom.window.Event("close")); },
});
Object.assign(globalThis, { window: dom.window, document: dom.document, HTMLElement: dom.HTMLElement, Node: dom.Node, Event: dom.Event, IS_REACT_ACT_ENVIRONMENT: true });
const sent: ClientMessage[] = [];
let root: Root | undefined;
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined; dom.document.body.replaceChildren(); sent.length = 0;
  __setBridgeForTest(null); __setStateForTest(chatArtifactsFixture());
});
const button = (text: string, within = dom.document as unknown as ParentNode) => [...within.querySelectorAll<HTMLButtonElement>("button")].find(node => node.textContent === text)!;
const click = async (node: Element | null) => { assert.ok(node); await act(async () => (node as HTMLButtonElement).click()); };
async function mount(route: string) {
  const state = chatArtifactsFixture();
  __setStateForTest(state);
  __setBridgeForTest({ connect() {}, subscribe() { return () => {}; }, send(raw: string) { sent.push(JSON.parse(raw)); } } as unknown as ArkeBridge);
  __connectionStatusForTest("open");
  const container = dom.document.createElement("div");dom.document.body.append(container);
  root = createRoot(container as unknown as HTMLElement);
  await act(async () => root!.render(<MemoryRouter initialEntries={[`/w/${state.world!.meta.worldId}/${route}`]}><Routes>
    <Route path="/w/:worldId/chat" element={<WorldChatScreen />} />
    <Route path="/w/:worldId/chat/:conversationId" element={<WorldChatScreen />} />
    <Route path="/w/:worldId/artifacts" element={<ArtifactsScreen />} />
  </Routes></MemoryRouter>));
  return state;
}

it("lists phone conversations, keeps row actions in a sheet, and creates only on New", async () => {
  const state = await mount("chat");
  assert.match(dom.document.querySelector("h1")!.textContent!, /Conversations/);
  assert.equal(dom.document.querySelector(".fy-cx"), null);
  assert.ok(!sent.some(command => command.kind === "world-chat-create"));
  await click(dom.document.querySelector(".fy-chatnav__more") as unknown as Element);
  assert.ok(dom.document.querySelector(".fy-page-sheet[open]"));
  await click(button("Archive"));
  assert.ok(sent.some(command => command.kind === "world-chat-archive"));
  assert.equal(dom.document.querySelector(".fy-page-sheet"), null);
  await click(button("New"));
  assert.equal(sent.filter(command => command.kind === "world-chat-create").length, 1);
  const next = structuredClone(state);
  next.worldChat!.conversationId = "cv_01J8F3K2QW9VZX4N7M0RTYB6HN";
  next.world!.conversations.push({ ...next.world!.conversations[0]!, id: next.worldChat!.conversationId, title: "New conversation" });
  await act(async () => __setStateForTest(next));
  assert.ok(dom.document.querySelector('[data-screen="world-chat-conversation"]'));
});

it("keeps Save, Reject and Accept all bound to their displayed revisions in the understood sheet", async () => {
  await mount(`chat/${CHAT_ID}`);
  assert.equal(dom.document.querySelector(".fy-gate__side"), null);
  assert.equal(dom.document.querySelector(".fy-chat__composernote,.fy-panel__caption"), null);
  await click(dom.document.querySelector(".fy-thread-peek") as unknown as Element);
  const sheet = dom.document.querySelector(".fy-page-sheet[open]")!;
  await click(button("Save", sheet as unknown as ParentNode));
  const save = sent.find(command => command.kind === "world-chat-save-point");
  assert.ok(save?.kind === "world-chat-save-point");
  assert.equal(save.conversationId, CHAT_ID);
  assert.equal(save.expectedCandidateRevision, 1);
  const rejects = [...sheet.querySelectorAll("button")].filter(node => node.textContent === "Reject");
  await click(rejects[1] as unknown as Element);
  assert.ok(sent.some(command => command.kind === "world-chat-reject-point"));
  await click(sheet.querySelector(".fy-page-sheet__foot button") as unknown as Element);
  const wrap = sent.find(command => command.kind === "world-chat-wrap-up");
  assert.ok(wrap?.kind === "world-chat-wrap-up");
  assert.equal(wrap.conversationId, CHAT_ID);
});

it("navigates the viewer within the filtered shelf and closes Details without closing the artifact", async () => {
  const state = await mount("artifacts");
  assert.equal(dom.document.querySelector(".fy-artifact-grid")?.getAttribute("style"), null);
  await click(button("Images 2"));
  await click(dom.document.querySelector(".fy-gridcard__open") as unknown as Element);
  assert.match(dom.document.querySelector(".fy-artview__head")!.textContent!, /key.art/i);
  assert.equal(dom.document.querySelector(".fy-artview__foot > span")!.textContent, "1 of 2");
  await click(dom.document.querySelector('[aria-label="Next artifact"]') as unknown as Element);
  assert.match(dom.document.querySelector(".fy-artview__head")!.textContent!, /drowned.quarter/i);
  assert.equal(dom.document.querySelector(".fy-artview__foot > span")!.textContent, "2 of 2");
  assert.ok(dom.document.querySelector('[aria-label="Next artifact"]')!.hasAttribute("disabled"));
  // A live filing can change positions without changing which artifact the viewer names.
  state.world!.artifacts.unshift({ ...state.world!.artifacts[3]!, id: "ar_01J8G0000000000000000000X9", file: "another.png" });
  await act(async () => __setStateForTest(state));
  assert.match(dom.document.querySelector(".fy-artview__head")!.textContent!, /drowned.quarter/i);
  assert.equal(dom.document.querySelector(".fy-artview__foot > span")!.textContent, "3 of 3");
  await click(button("Details"));
  assert.ok(dom.document.querySelector(".fy-page-sheet .fy-artview__meta"));
  await click(dom.document.querySelector('.fy-page-sheet [aria-label="Close"]') as unknown as Element);
  assert.equal(dom.document.querySelector(".fy-page-sheet"), null);
  assert.ok(dom.document.querySelector(".fy-artview__panel"));
});


it("keeps phone deletion and retirement confirmations before their commands", async () => {
  await mount(`chat/${CHAT_ID}`);
  await click(dom.document.querySelector('[aria-label="Conversation options"]') as unknown as Element);
  assert.ok(dom.document.querySelector(".fy-chat__reply-actions"));
  assert.equal(dom.document.querySelector(".fy-chat__transcript .fy-textactions"), null);
  assert.ok(dom.document.querySelector('.fy-chat__reply-actions [aria-label="Read aloud"]'));
  assert.ok(dom.document.querySelector('.fy-chat__reply-actions [aria-label="Copy"]'));
  await click(button("Delete"));
  assert.ok(!sent.some(command => command.kind === "world-chat-delete"));
  assert.match(dom.document.querySelector(".fy-page-sheet")!.textContent!, /go for good/);
  await click(button("Keep"));
  assert.ok(!sent.some(command => command.kind === "world-chat-delete"));
  await click(dom.document.querySelector('[aria-label="Conversation options"]') as unknown as Element);
  await click(button("Delete"));
  await click(button("Delete"));
  assert.ok(sent.some(command => command.kind === "world-chat-delete" && command.conversationId === CHAT_ID));
  await act(async () => root!.unmount()); root = undefined; dom.document.body.replaceChildren();
  await mount("artifacts");
  await click(dom.document.querySelector(".fy-artifact-more") as unknown as Element);
  await click(button("Remove from shelf"));
  assert.ok(!sent.some(command => command.kind === "retire-artifact"));
  assert.match(dom.document.body.textContent!, /No disk space is freed/);
  await click(button("Cancel"));
  assert.ok(!sent.some(command => command.kind === "retire-artifact"));
  await click(dom.document.querySelector(".fy-artifact-more") as unknown as Element);
  await click(button("Remove from shelf"));
  await click(button("Remove from shelf"));
  assert.ok(sent.some(command => command.kind === "retire-artifact" && command.artifactId === "ar_01J8G0000000000000000000X0"));
});
