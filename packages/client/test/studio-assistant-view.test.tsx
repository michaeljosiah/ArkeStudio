import assert from "node:assert/strict";
import { it } from "node:test";
import { act, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { parseHTML } from "linkedom";
import type { StudioAssistantCommand, StudioAssistantSnapshot } from "@arke-studio/contracts";
import { StudioConversationClient } from "../src/lib/studio-assistant.js";
import { StudioAssistantProvider, StudioAssistantView } from "../src/components/studio-assistant.js";
import { StudioAssistantContext } from "../src/components/studio-assistant-context.js";
import { GlobalChatContext } from "../src/components/global-chat-context.js";
import { GlobalChatController } from "../src/lib/global-chat.js";
import { AppChrome } from "../src/components/chrome.js";
import { closeSystemPanel } from "../src/lib/system-panel.js";
import { __handleFrameForTest, __setBridgeForTest, __setStateForTest } from "../src/lib/store.js";
import { FIXTURE_STATE } from "./fixture-state.js";

const dom = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(globalThis, { window: dom.window, document: dom.document, HTMLElement: dom.HTMLElement, Node: dom.Node, Element: dom.Element, Event: dom.Event, IS_REACT_ACT_ENVIRONMENT: true });
Object.defineProperty(dom.HTMLElement.prototype, "innerText", { configurable: true, get() { return this.textContent; }, set(value) { this.textContent = value; } });
Object.defineProperty(dom.document, "activeElement", { configurable: true, value: null, writable: true });
dom.HTMLElement.prototype.focus = function () { Object.assign(dom.document, { activeElement: this }); };
Object.assign(dom.HTMLElement.prototype, { showModal(this: HTMLElement) { this.setAttribute("open", ""); }, show(this: HTMLElement) { this.setAttribute("open", ""); }, close(this: HTMLElement) { this.removeAttribute("open"); } });
const threadId = "01J8F3K2QW9VZX4N7M0RTYB6HC", runId = "01J8F3K2QW9VZX4N7M0RTYB6HD";
const initial = (): StudioAssistantSnapshot => ({ audit: "available", accepting: true, busy: false, threads: [], share: null, ephemeralReply: null });
function fixture() {
  let id = 0; const sent: StudioAssistantCommand[] = [];
  const client = new StudioConversationClient({ id: () => String(++id), send(message) { sent.push(message); return true; } });
  client.setConnected(true); client.open();
  const deliver = (state: StudioAssistantSnapshot) => client.receive({ requestId: sent.findLast(message => message.command.action === "watch")!.requestId, response: { type: "state", state } });
  deliver(initial());
  return { client, sent, deliver };
}
function View({ client }: { client: StudioConversationClient }) {
  const view = useSyncExternalStore(client.subscribe, client.getSnapshot, client.getSnapshot);
  return <StudioAssistantView view={view} client={client} appState={FIXTURE_STATE} model="provider/model" pickModel={client.pickModel} />;
}
it("the production provider opens lazily, watches the private reply path and returns focus without resending", async () => {
  const sent: StudioAssistantCommand[] = [], world = new GlobalChatController(), container = document.createElement("div"); document.body.append(container);
  __setStateForTest({ ...FIXTURE_STATE, world: null }, { connection: "open" });
  __setBridgeForTest({ appVersion: "test", platform: "test", connect() {}, subscribe() {}, send(json) { sent.push(JSON.parse(json)); } });
  const root = createRoot(container);
  try {
    await act(async () => root.render(<MemoryRouter><GlobalChatContext.Provider value={world}><StudioAssistantProvider><AppChrome /></StudioAssistantProvider></GlobalChatContext.Provider></MemoryRouter>));
    assert.equal(sent.length, 0); assert.equal(document.querySelector(".fy-studio-assistant"), null);
    const trigger = container.querySelector<HTMLButtonElement>('[data-studio-chat-trigger]')!; trigger.focus();
    await act(async () => trigger.click());
    assert.equal(sent[0]?.command.action, "watch");
    await act(async () => __handleFrameForTest({ kind: "studio-assistant", seq: 1, requestId: sent[0]!.requestId, response: { type: "state", state: initial() } }));
    const dialog = document.querySelector<HTMLElement>(".fy-studio-assistant")!; assert(dialog.hasAttribute("open"));
    assert(dialog.textContent?.includes("Setup, local AI & help"));
    await act(async () => dialog.querySelector<HTMLButtonElement>('[aria-label="Close Studio assistant"]')!.click());
    assert.equal(document.activeElement, trigger); assert.equal(sent.at(-1)?.command.action, "unwatch");
    assert.equal(sent.filter(message => message.command.action === "send").length, 0);
  } finally { await act(async () => root.unmount()); container.remove(); __setBridgeForTest(null); }
});
it("quick prompts and private history only change the Studio draft; titlebar opens Studio and closes contextual chat", async () => {
  __setStateForTest(FIXTURE_STATE, { connection: "open" });
  const h = fixture(), world = new GlobalChatController(), container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<MemoryRouter><GlobalChatContext.Provider value={world}><StudioAssistantContext.Provider value={h.client}><AppChrome /><View client={h.client} /></StudioAssistantContext.Provider></GlobalChatContext.Provider></MemoryRouter>));
    await act(async () => container.querySelector<HTMLButtonElement>('.fy-studio-prompts button:nth-child(2)')!.click());
    assert.equal(h.client.getSnapshot().draft, "Review storage"); assert.deepEqual(h.sent.map(message => message.command.action), ["watch"]);
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Studio conversations"]')!.click());
    assert(container.querySelector('[aria-label="Studio conversations"].fy-studio-history'));
    assert.equal(h.client.getSnapshot().draft, "Review storage");
    await act(async () => container.querySelector<HTMLButtonElement>('[data-studio-chat-trigger]')!.click());
    assert.equal(h.client.getSnapshot().open, false); assert.equal(h.client.getSnapshot().draft, "Review storage");
    await act(async () => container.querySelector<HTMLButtonElement>('[data-studio-chat-trigger]')!.click());
    assert.equal(h.client.getSnapshot().open, true); assert.equal(world.getSnapshot().open, false);
    await act(async () => container.querySelector<HTMLButtonElement>('[data-system-trigger]')!.click());
    assert.equal(h.client.getSnapshot().open, false); assert.equal(h.sent.some(message => message.command.action === "send"), false);
  } finally { await act(async () => { root.unmount(); closeSystemPanel(); }); h.client.dispose(); container.remove(); }
});
it("shows the complete app disclosure and never carries cloud consent into a replacement disclosure", async () => {
  const h = fixture(), container = document.createElement("div"); document.body.append(container); const root = createRoot(container);
  const snapshot = initial(); snapshot.busy = true;
  snapshot.threads = [{ id: threadId, createdAt: 1, updatedAt: 1, archived: false, messages: [], pending: { id: runId, phase: "main", state: "preparing", startedAt: 1, model: "provider/model", destination: null, disclosure: null } }];
  snapshot.share = { id: threadId, runId, threadId, digest: "a".repeat(64), role: "studio-assistant", phase: "main", model: "provider/model", provider: "Example provider", destination: "b".repeat(64), prompt: "Actual disclosed prompt", customBrief: "Private custom instructions", variant: "high" };
  h.deliver(snapshot);
  try {
    await act(async () => root.render(<MemoryRouter><View client={h.client} /></MemoryRouter>));
    assert(container.textContent?.includes("Actual disclosed prompt")); assert(container.textContent?.includes("Private custom instructions")); assert(container.textContent?.includes("Effort: high"));
    let approve = [...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === "Approve this request")!;
    assert(approve.disabled); const check = container.querySelector<HTMLInputElement>('.fy-studio-consent input')!;
    await act(async () => { check.checked = true; check.dispatchEvent(new dom.Event("click", { bubbles: true })); });
    assert.equal(approve.disabled, false, "approval requires this disclosure’s explicit checked consent");
    await act(async () => h.deliver({ ...snapshot, share: { ...snapshot.share!, id: runId, digest: "c".repeat(64), phase: "answer" } }));
    approve = [...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === "Approve this request")!;
    assert(approve.disabled); assert.equal(container.querySelector<HTMLInputElement>('.fy-studio-consent input')!.checked, false);
    assert.equal(h.sent.filter(message => message.command.action === "approve-cloud").length, 0);
  } finally { await act(async () => root.unmount()); h.client.dispose(); container.remove(); }
});
