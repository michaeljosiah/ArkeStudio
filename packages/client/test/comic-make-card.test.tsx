import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { MemoryRouter } from "react-router";
import { DEFAULT_COMIC_SETTINGS, EMPTY_COMIC_PAGE_RECORD, comicPanelStates, ulid, type ClientMessage, type ClientState, type ComicPage, type ComicPageRecord, type ConversationActionCard } from "@arke-studio/contracts";
import { ComicMakeCardBody } from "../src/components/comic-make-card.js";
import { __setBridgeForTest, __setStateForTest } from "../src/lib/store.js";
import type { ArkeBridge } from "../src/arke-bridge.js";
import { FIXTURE_STATE } from "./fixture-state.js";

/** The Make card (design turn 270a – 270c): what it asks, what it counts, and what it leaves the author. */
const dom = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(dom.window, { getComputedStyle: () => ({ direction: "ltr" }), innerWidth: 1440, innerHeight: 900 });
Object.assign(dom.HTMLElement.prototype, { focus() {}, scrollIntoView() {} });
Object.assign(globalThis, { window: dom.window, document: dom.document, HTMLElement: dom.HTMLElement, Node: dom.Node, Event: dom.Event, IS_REACT_ACT_ENVIRONMENT: true });

const AT = "2026-11-06T09:00:00.000Z";
const ARTIFACT = "ar_01J8G0000000000000000000P1";
const SETTINGS = { ...DEFAULT_COMIC_SETTINGS, mode: "overlay" as const };
const reviewer = { id: "harness-vision", version: "1:Claude" };
const clean = { status: "compared", reviewer, references: [], findings: [], cleared: [], at: AT };
const faulty = { ...clean, findings: [{ id: "review:f1", kind: "defect", note: "Left eye sits low." }] };

function sheet(): ComicPage {
  return { id: ulid(), layout: "splash", status: "ready", panels: [{ id: ulid(), description: "Maren.", characters: [], lettering: [{ id: ulid(), kind: "caption", text: "Line" }] }] };
}
function book(pages: Array<{ page: ComicPage; review: unknown; accepted: boolean; placed?: boolean }>): ClientState {
  const state = structuredClone(FIXTURE_STATE);
  const base = state.world!.productions[0]!;
  const comicPages = pages.map(({ page, review, accepted, placed }) => {
    const entry = comicPanelStates(page, undefined, SETTINGS)[0]!;
    const take = { id: ulid(), panel: entry.panel.id, artifact: ARTIFACT, hash: entry.hash, model: "image", usd: 0.22, at: AT, review };
    const record = { ...EMPTY_COMIC_PAGE_RECORD, panelTakes: [take], panelAccepted: accepted ? { [entry.panel.id]: take.id } : {},
      placements: placed ? [{ item: page.panels[0]!.lettering[0]!.id, box: { x: 0.1, y: 0.1, w: 0.2, h: 0.1 } }] : [] } as ComicPageRecord;
    return { page: page.id, hash: `sha256:${page.id}`, record };
  });
  state.world!.productions = [{ ...structuredClone(base), meta: { ...base.meta, id: "low-water-drawn", kind: "graphic-novel", medium: "story" }, takes: [], scenes: [], episodes: [],
    chapters: [{ id: "the-tide", order: 1, title: "The tide", file: "01.md", words: 0, version: 1, hash: "sha256:c", status: "draft" }], comic: SETTINGS,
    comicScripts: [{ chapter: "the-tide", hash: "sha256:b", script: { version: 1, pages: pages.map((entry) => entry.page) } }], comicPages }] as never;
  return state;
}
function card(status: ConversationActionCard["status"], pages: ComicPage[]): ConversationActionCard {
  return { actionId: "act_1", actionKind: "world-chat-production-comic-make", productionId: "low-water-drawn", status, worldId: "w", conversationId: "c",
    authority: { kind: "job-queue", id: "run-1" }, availableDecisions: [],
    ...(status === "pending" ? {} : { decision: { actorId: "local-user", decision: "approve", decidedAt: "2026-11-06T08:00:00.000Z" } }),
    shown: { title: "Make chapter 1", consequence: "", affectedTargets: [], ripples: ["No picture of Old Tam"], permissionReason: "spend-and-compute",
      body: { family: "generation", medium: "image", purpose: "Panels", prompt: "p", references: [], provider: "openai", model: "GPT Image 2", quantity: 13, output: "o", cost: "Up to $4.18",
        options: [{ label: "Panels", value: "13" }, { label: "Redraws", value: "Up to 6" }], enforceableCapMicroUsd: 4_180_000, deterministicInputs: pages.map((page) => page.id) } } } as unknown as ConversationActionCard;
}

let root: Root | null = null;
afterEach(async () => {
  await act(async () => root?.unmount());
  root = null; __setBridgeForTest(null); __setStateForTest(FIXTURE_STATE);
  dom.document.body.innerHTML = "";
});
async function mount(state: ClientState, action: ConversationActionCard) {
  const sent: ClientMessage[] = [];
  __setBridgeForTest({ appVersion: "test", platform: "test", connect() {}, subscribe() {}, send: (json: string) => { sent.push(JSON.parse(json)); } } satisfies ArkeBridge);
  const container = dom.document.createElement("div") as unknown as HTMLElement;
  dom.document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    __setStateForTest(state, { connection: "open" });
    root!.render(<MemoryRouter><ComicMakeCardBody action={action} /></MemoryRouter>);
  });
  return { container, sent };
}
const props = (el: Element) => (el as unknown as Record<string, Record<string, any>>)[Object.keys(el).find((key) => key.startsWith("__reactProps$"))!]!;
const button = (container: HTMLElement, text: string) => [...container.querySelectorAll("button")].find((entry) => entry.textContent?.trim() === text);

describe("the Make card (turn 270)", () => {
  it("asks with the counts, the limit and who has no picture", async () => {
    const page = sheet();
    const m = await mount(book([{ page, review: clean, accepted: false }]), card("pending", [page]));
    assert.match(m.container.textContent!, /Panels13/);
    assert.match(m.container.textContent!, /RedrawsUp to 6/);
    assert.match(m.container.textContent!, /PriceUp to \$4\.18/);
    assert.match(m.container.textContent!, /No picture of Old Tam/);
  });

  it("counts from the pages while running, against the price approved, and can be stopped", async () => {
    const page = sheet();
    const m = await mount(book([{ page, review: clean, accepted: true }]), card("running", [page]));
    assert.match(m.container.textContent!, /Page 1.*1 of 1/);
    assert.match(m.container.textContent!, /Spent\$0\.22 of \$4\.18/);
    await act(async () => props(button(m.container, "Stop")!).onClick({}));
    assert.deepEqual(m.sent.find((message) => message.kind === "stop-comic-make"), { kind: "stop-comic-make", worldId: FIXTURE_STATE.world!.meta.worldId, run: "run-1" });
  });

  it("finishes on only what needs the author, and accepts nothing by itself", async () => {
    const done = sheet(), fault = sheet();
    const m = await mount(book([{ page: done, review: clean, accepted: true, placed: true }, { page: fault, review: faulty, accepted: false }]), card("completed", [done, fault]));
    assert.match(m.container.querySelector(".fy-comicmake__needs")!.textContent!, /Page 2 · panel 1.*Defect/);
    assert.ok(button(m.container, "Accept 1 page"));
    assert.equal(m.sent.some((message) => message.kind === "finish-comic-page" || message.kind === "accept-comic-take"), false);
    assert.match(m.container.textContent!, /Lines placed1 of 2/);
    assert.doesNotMatch(m.container.textContent!, /Spent/, "what was spent is the receipt's");
  });
});
