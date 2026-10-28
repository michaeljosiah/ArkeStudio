import assert from "node:assert/strict";
import { it } from "node:test";
import { act, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { parseHTML } from "linkedom";
import { CACHE_CLEANUP_POLICY, type ClientMessage, type ClientState, type StudioAssistantCommand, type StudioAssistantSnapshot } from "@arke-studio/contracts";
import { StudioConversationClient } from "../src/lib/studio-assistant.js";
import { StudioAssistantProvider, StudioAssistantView } from "../src/components/studio-assistant.js";
import { StudioAssistantContext } from "../src/components/studio-assistant-context.js";
import { GlobalChatContext } from "../src/components/global-chat-context.js";
import { chatSurfaceForPage, GlobalChatController } from "../src/lib/global-chat.js";
import { AppChrome } from "../src/components/chrome.js";
import { closeSystemPanel } from "../src/lib/system-panel.js";
import { __applyEventForTest, __handleFrameForTest, __setBridgeForTest, __setStateForTest } from "../src/lib/store.js";
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
function View({ client, appState = FIXTURE_STATE }: { client: StudioConversationClient; appState?: ClientState }) {
  const view = useSyncExternalStore(client.subscribe, client.getSnapshot, client.getSnapshot);
  return <StudioAssistantView view={view} client={client} appState={appState} model="provider/model" pickModel={client.pickModel} />;
}
it("focuses the Studio composer once on entry without stealing focus after a busy period", async () => {
  const h = fixture(), container = document.createElement("div"); document.body.append(container); const root = createRoot(container);
  try {
    await act(async () => root.render(<View client={h.client} />));
    assert.equal(container.querySelector(".fy-studio-compose-scope")?.textContent, "Studio");
    assert.equal(document.activeElement, container.querySelector(".fy-cx__editor"));
    await act(async () => h.deliver({ ...initial(), busy: true }));
    const history = container.querySelector<HTMLButtonElement>('[aria-label="Studio conversations"]')!; history.focus();
    await act(async () => h.deliver(initial()));
    assert.equal(document.activeElement, history);
    assert(h.sent.every(message => message.command.action === "watch"));
  } finally { await act(async () => root.unmount()); h.client.dispose(); container.remove(); }
});
it("uses the approved 1100px boundary for native Studio modal behavior", async () => {
  const dialogs = dom.HTMLElement.prototype as HTMLElement & Pick<HTMLDialogElement, "showModal" | "show">;
  const originalMedia = window.matchMedia, originalModal = dialogs.showModal, originalShow = dialogs.show;
  let shown: "modal" | "modeless" | undefined;
  dialogs.showModal = function () { this.setAttribute("open", ""); shown = "modal"; };
  dialogs.show = function () { this.setAttribute("open", ""); shown = "modeless"; };
  try {
    for (const width of [1100, 1099.5, 1099, 1024, 599]) {
      window.matchMedia = ((query: string) => {
        const below = /width < (\d+)px/.exec(query), maximum = /max-width:\s*(\d+)px/.exec(query);
        return { matches: below ? width < Number(below[1]) : maximum ? width <= Number(maximum[1]) : false };
      }) as typeof window.matchMedia;
      shown = undefined;
      const container = document.createElement("div"); document.body.append(container); const root = createRoot(container);
      __setStateForTest({ ...FIXTURE_STATE, world: null }, { connection: "open" });
      __setBridgeForTest({ appVersion: "test", platform: "test", connect() {}, subscribe() {}, send() {} });
      try {
        await act(async () => root.render(<MemoryRouter><GlobalChatContext.Provider value={new GlobalChatController()}><StudioAssistantProvider><AppChrome /></StudioAssistantProvider></GlobalChatContext.Provider></MemoryRouter>));
        await act(async () => container.querySelector<HTMLButtonElement>('[data-studio-chat-trigger]')!.click());
        assert.equal(shown, width < 1100 ? "modal" : "modeless", `Studio at ${width}px`);
      } finally { await act(async () => root.unmount()); container.remove(); __setBridgeForTest(null); }
    }
  } finally { window.matchMedia = originalMedia; dialogs.showModal = originalModal; dialogs.show = originalShow; }
});
it("offers current storage review inside Studio, requires separate approval and never invokes a model to repair", async () => {
  const h = fixture(), container = document.createElement("div"); document.body.append(container); const root = createRoot(container);
  const appState = structuredClone(FIXTURE_STATE), scope = "d".repeat(64), sent: ClientMessage[] = [];
  appState.app.recoveryPolicy = { audit: "available", accepting: true, mode: "suggest-only", targets: [], cleanup: { available: true, pending: false,
    scope: { revision: scope, volumeId: "volume-a", mappingRevision: "mount-a", measuredAt: Date.now(), inventoryAt: Date.now(), candidateFiles: 1, recordedBytes: 60 } } };
  __setStateForTest(appState, { connection: "open" });
  __setBridgeForTest({ appVersion: "test", platform: "test", connect() {}, subscribe() {}, send(json) { sent.push(JSON.parse(json)); } });
  const state = initial(), diagnostic = { evidence: { version: 1 as const, at: 1, topic: "storage" as const,
    audit: { history: "available" as const, recovery: "available" as const, storage: "available" as const }, incidents: [], storage: [], jobs: [],
    limited: { incidents: false, storage: false, jobs: false } }, answer: { explanation: "An old storage observation.", evidenceRefs: [], hypotheses: [] } };
  state.threads = [{ id: threadId, createdAt: 1, updatedAt: 1, archived: false, pending: null, messages: [
    { id: threadId, role: "arke", text: "Earlier diagnosis", at: 1, diagnostic },
    { id: runId, role: "arke", text: "Latest diagnosis", at: 2, diagnostic },
  ] }]; h.deliver(state); h.client.select(threadId);
  const button = (text: string) => [...container.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === text)!;
  try {
    await act(async () => root.render(<MemoryRouter><View client={h.client} appState={appState} /></MemoryRouter>));
    assert.equal(container.querySelectorAll('[aria-label="Review local preview cleanup"]').length, 1);
    assert.equal(container.querySelectorAll('a[href="/settings/diagnostics"]').length, 1);
    assert.equal(sent.length, 0, "opening historical evidence grants no work");
    await act(async () => button("Review previews…").click());
    const review = sent[0]!; assert(review.kind === "recovery-action"); assert.deepEqual(review.command, { action: "preview-cleanup", scope });
    const preparedAt = Date.now(), plan = { id: "b".repeat(64), action: "cleanup-local-preset-previews" as const, evidence: "a".repeat(64), policyRevision: 1 as const,
      scope, preparedAt, expiresAt: preparedAt + 300000, category: "fixed-local-preset-previews" as const,
      files: 1, logicalBytes: 60, allocatedBytes: 4096, minAgeMs: CACHE_CLEANUP_POLICY.minAgeMs, stopAtAvailableBytes: null,
      targets: [{ resourceKey: "c".repeat(64), createdAt: 0, logicalBytes: 60, allocatedBytes: 4096 }],
      replaysJobs: false as const, interruptsWork: false as const, undoable: false as const };
    await act(async () => __applyEventForTest({ type: "recovery.action-result", at: new Date().toISOString(), result: { requestId: review.requestId, status: "preview", cleanupPlan: plan } }));
    assert(container.textContent!.includes("Deletion cannot be undone")); assert.equal(sent.length, 1);
    await act(async () => button("Approve this cleanup").click());
    const approval = sent[1]!; assert(approval.kind === "recovery-action"); assert.deepEqual(approval.command, { action: "approve-cleanup", planId: plan.id });
    assert(h.sent.every(message => message.command.action === "watch"), "the repair follows existing host controls without a model request");
  } finally { await act(async () => root.unmount()); h.client.dispose(); container.remove(); __setBridgeForTest(null); }
});
it("explains an invalid diagnostic answer and acknowledges it without resending", async () => {
  const h = fixture(), container = document.createElement("div"); document.body.append(container); const root = createRoot(container);
  const state = initial();
  state.threads = [{ id: threadId, createdAt: 1, updatedAt: 1, archived: false, messages: [], pending: {
    id: runId, phase: "diagnostic", state: "interrupted", reason: "evidence-invalid", startedAt: 1, model: "ollama/local", destination: null, disclosure: null } }];
  h.deliver(state);
  try {
    await act(async () => root.render(<MemoryRouter><View client={h.client} /></MemoryRouter>));
    assert.match(container.textContent!, /could not be verified against the supplied facts/);
    assert.match(container.textContent!, /Open Diagnostics/);
    assert.match(container.textContent!, /not be sent again automatically/);
    await act(async () => [...container.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "Acknowledge interruption")!.click());
    assert.equal(h.sent.at(-1)!.command.action, "acknowledge");
    assert.equal(h.sent.some(message => message.command.action === "send"), false);
  } finally { await act(async () => root.unmount()); h.client.dispose(); container.remove(); }
});
it("uses the shared attachment controls, previews escaped text and removes unsent documents without filing them", async () => {
  const h = fixture(), container = document.createElement("div"); document.body.append(container); const root = createRoot(container);
  try {
    await act(async () => root.render(<View client={h.client} />));
    assert(container.querySelector('[aria-label="Attach text documents"]'));
    assert(container.querySelector<HTMLInputElement>('[aria-label="Choose Studio text documents"]')!.getAttribute("accept")!.includes(".md"));
    await act(async () => { await h.client.attachText("<script>PRIVATE_TEXT</script>"); });
    const preview = container.querySelector("details pre")!;
    assert.equal(preview.textContent, "<script>PRIVATE_TEXT</script>"); assert.equal(preview.querySelector("script"), null);
    assert(!container.textContent?.includes("File in world"));
    const remove = container.querySelector<HTMLButtonElement>('[aria-label="Stop referring to Pasted text.txt"]')!;
    assert.equal(remove.title, "Remove this unsent document");
    await act(async () => remove.click()); assert.equal(h.client.getSnapshot().attachments.length, 0);
    assert(h.sent.every(row => row.command.action === "watch"));
  } finally { await act(async () => root.unmount()); h.client.dispose(); container.remove(); }
});
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
  const surface = chatSurfaceForPage(FIXTURE_STATE, `/w/${FIXTURE_STATE.world!.meta.worldId}`)!;
  world.setCurrent(surface); world.setValue(surface.key, "draft", "Keep the World draft");
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
    await act(async () => container.querySelector<HTMLButtonElement>('[data-contextual-chat-trigger]')!.click());
    assert.equal(world.getSnapshot().open, true); assert.equal(world.getSnapshot().selected?.key, surface.key); assert.equal(h.client.getSnapshot().open, false);
    assert.equal(world.value(surface.key, "draft", ""), "Keep the World draft"); assert.equal(h.client.getSnapshot().draft, "Review storage");
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
  snapshot.share = { id: threadId, runId, threadId, digest: "a".repeat(64), role: "studio-assistant", phase: "main", model: "provider/model", provider: "Example provider", destination: "b".repeat(64), prompt: "Actual disclosed prompt", customBrief: "Private custom instructions", variant: "high", system: "Complete reviewed system instructions", outputTokenLimit: 4096 };
  h.deliver(snapshot);
  try {
    await act(async () => root.render(<MemoryRouter><View client={h.client} /></MemoryRouter>));
    assert(container.textContent?.includes("Actual disclosed prompt")); assert(container.textContent?.includes("Private custom instructions")); assert(container.textContent?.includes("Effort: high"));
    assert(container.textContent?.includes("Complete reviewed system instructions")); assert(container.textContent?.includes("Answer limit: 4,096 tokens"));
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
